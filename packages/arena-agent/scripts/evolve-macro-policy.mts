#!/usr/bin/env node
/**
 * Evolution v1 CLI: search transferable MacroPolicy knobs on the canonical
 * Simulator tournament stack. Output is an auditable data/runs/sim artifact.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveOpponent } from "../src/sim/opponent/registry.ts";
import { runMacroPolicyEvolution } from "../src/sim/evolution/macro-policy-search.ts";
import {
  atomicWriteJson,
  defaultRunId,
  prepareRunDir,
  resolveOutputBase,
} from "../src/sim/tools/artifacts.ts";

interface CliOptions {
  readonly opponents: readonly string[];
  readonly ticks: number;
  readonly population: number;
  readonly generations: number;
  readonly trainingSeeds: readonly number[];
  readonly holdoutSeeds: readonly number[];
  readonly rollingSeedPool: readonly number[] | null;
  readonly rollingSeedsPerGeneration: number | undefined;
  readonly seedRolloverGenerations: number;
  readonly riskLambda: number;
  readonly prescreenFraction: number;
  readonly randomSeed: number;
  readonly patience: number;
  readonly rotateSubjectSlot: boolean;
  readonly spawnProfileMode: "uniform" | "live-mixed";
  readonly terrainMode: "fixed" | "generated-survey";
  readonly runId: string | null;
  readonly force: boolean;
  readonly smoke: boolean;
}

function findCoordinationRoot(start: string): string {
  let current = start;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, "reference", "arena-evolve")) && existsSync(join(current, "data"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("cannot locate Arena coordination root (requires reference/arena-evolve + data)");
}

function numbers(raw: string, name: string): number[] {
  const values = raw.split(/[,\s]+/u).filter(Boolean).map(Number);
  if (values.length === 0 || values.some((value) => !Number.isSafeInteger(value))) {
    throw new Error(`${name} must be a comma-separated list of safe integers`);
  }
  return values;
}

function positiveInt(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function finite(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function oneOf<T extends string>(raw: string, name: string, allowed: readonly T[]): T {
  if (!allowed.includes(raw as T)) throw new Error(`${name} must be one of ${allowed.join(",")}`);
  return raw as T;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  let force = false;
  let smoke = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--force") {
      force = true;
      continue;
    }
    if (token === "--smoke") {
      smoke = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} requires a value`);
    values.set(token, value);
    index += 1;
  }
  const opponents = (values.get("--opponents") ?? "arena-evolve,core")
    .split(/[,\s]+/u).map((value) => value.trim()).filter(Boolean);
  if (opponents.length === 0) throw new Error("--opponents requires at least one opponent");
  const trainingSeeds = numbers(values.get("--train-seeds") ?? "1,2,3", "--train-seeds");
  const holdoutSeeds = numbers(values.get("--holdout-seeds") ?? "101,102", "--holdout-seeds");
  if (!smoke && holdoutSeeds.length < 2) {
    throw new Error("non-smoke evolution requires at least 2 holdout seeds (use --smoke for one-seed wiring checks)");
  }
  const rollingRaw = values.get("--seed-pool");
  const rollingSeedPool = rollingRaw === undefined ? null : numbers(rollingRaw, "--seed-pool");
  const rollingCountRaw = values.get("--rolling-seeds");
  return Object.freeze({
    opponents,
    ticks: positiveInt(values.get("--ticks") ?? "200", "--ticks"),
    population: positiveInt(values.get("--population") ?? "12", "--population"),
    generations: positiveInt(values.get("--generations") ?? "8", "--generations"),
    trainingSeeds,
    holdoutSeeds,
    rollingSeedPool,
    rollingSeedsPerGeneration: rollingCountRaw === undefined ? undefined : positiveInt(rollingCountRaw, "--rolling-seeds"),
    seedRolloverGenerations: positiveInt(values.get("--seed-rollover") ?? "2", "--seed-rollover"),
    riskLambda: finite(values.get("--risk-lambda") ?? "0.25", "--risk-lambda"),
    prescreenFraction: finite(values.get("--prescreen") ?? "0.5", "--prescreen"),
    randomSeed: Number(values.get("--random-seed") ?? "0"),
    patience: Number(values.get("--patience") ?? "4"),
    rotateSubjectSlot:
      oneOf(values.get("--slot-rotation") ?? "on", "--slot-rotation", ["on", "off"] as const) === "on",
    spawnProfileMode: oneOf(
      values.get("--spawn-profiles") ?? "uniform",
      "--spawn-profiles",
      ["uniform", "live-mixed"] as const,
    ),
    terrainMode: oneOf(
      values.get("--terrain") ?? "fixed",
      "--terrain",
      ["fixed", "generated-survey"] as const,
    ),
    runId: values.get("--run-id") ?? null,
    force,
    smoke,
  });
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(scriptDir, "..");
  const coordinationRoot = findCoordinationRoot(packageRoot);
  const dataRoot = join(coordinationRoot, "data");
  const rulesPath = join(packageRoot, "src", "sim", "contracts", "rules-v0.14.json");
  const opponentSpecs = cli.opponents.map(resolveOpponent);

  const evolution = {
    populationSize: cli.population,
    elites: Math.min(2, cli.population - 1),
    tournamentSize: Math.min(3, cli.population),
    generations: cli.generations,
    randomSeed: cli.randomSeed,
    trainingSeeds: cli.trainingSeeds,
    holdoutSeeds: cli.holdoutSeeds,
    riskLambda: cli.riskLambda,
    prescreenFraction: cli.prescreenFraction,
    ...(cli.rollingSeedPool === null ? {} : {
      rollingSeedPool: cli.rollingSeedPool,
      rollingSeedsPerGeneration: cli.rollingSeedsPerGeneration ?? Math.min(cli.trainingSeeds.length, cli.rollingSeedPool.length),
      seedRolloverGenerations: cli.seedRolloverGenerations,
    }),
    patience: cli.patience,
  } as const;

  const result = runMacroPolicyEvolution({
    evolution,
    tournament: {
      rulesPath,
      ticks: cli.ticks,
      opponents: opponentSpecs,
      subjectId: "evolve-candidate",
      validatePlans: true,
      rotateSubjectSlot: cli.rotateSubjectSlot,
      spawnProfileMode: cli.spawnProfileMode,
      terrainMode: cli.terrainMode,
    },
  });

  const identity = {
    schema: "sim.macro-policy-evolution.v1",
    opponents: cli.opponents,
    ticks: cli.ticks,
    rotateSubjectSlot: cli.rotateSubjectSlot,
    spawnProfileMode: cli.spawnProfileMode,
    terrainMode: cli.terrainMode,
    smoke: cli.smoke,
    evolution,
  };
  const outputBase = resolveOutputBase(dataRoot, null);
  const runId = cli.runId ?? defaultRunId("macro-evolve", identity);
  const runDir = prepareRunDir(outputBase, runId, cli.force);
  atomicWriteJson(join(runDir, "result.json"), {
    schema: "sim.macro-policy-evolution-result.v1",
    createdAt: new Date().toISOString(),
    rulesVersion: "v0.14",
    simulatorSemantics: "official-defaults-except-tick-acceleration",
    opponents: cli.opponents,
    ticks: cli.ticks,
    rotateSubjectSlot: cli.rotateSubjectSlot,
    spawnProfileMode: cli.spawnProfileMode,
    terrainMode: cli.terrainMode,
    smoke: cli.smoke,
    evolution,
    champion: result.champion,
    history: result.history,
    cacheEntries: result.cacheEntries,
    stoppedEarly: result.stoppedEarly,
    notes: [
      "MacroPolicy v1 excludes focusRegion to reduce simulator/world-coordinate overfit.",
      "Holdout seeds are disjoint from training/rolling seeds and never participate in selection.",
      "Subject slot rotation is seed-driven by default; disable only for historical reproduction.",
      "live-mixed spawn profiles are identity-bound and independent of rotated geometric slots.",
      "generated-survey terrain uses partial-observation survey calibration and must not be treated as server ground truth.",
      "Promotion to production still requires evidence-v1 + real shadow/live gates.",
    ],
  });
  console.log(JSON.stringify({
    runDir,
    champion: result.champion,
    generations: result.history.length,
    cacheEntries: result.cacheEntries,
    stoppedEarly: result.stoppedEarly,
  }, null, 2));
}

main();
