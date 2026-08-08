#!/usr/bin/env node
/**
 * W53 survey -> generated-world calibration.
 *
 * Read-only: consumes data/runtime/survey/t*.db and writes an auditable
 * data/runs/sim artifact. It never mutates survey DBs or production runtime.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  calibrateWorldDistribution,
  type SurveyWorldCalibrationInput,
} from "../src/sim/world/generator.ts";
import {
  atomicWriteJson,
  defaultRunId,
  prepareRunDir,
  resolveOutputBase,
} from "../src/sim/tools/artifacts.ts";
import type { Position } from "../src/domain/model.ts";

interface CliOptions {
  readonly dataRoot: string | null;
  readonly tenants: readonly string[];
  readonly runId: string | null;
  readonly force: boolean;
}

function findCoordinationRoot(start: string): string {
  let current = start;
  for (let depth = 0; depth < 12; depth += 1) {
    const surveyDir = join(current, "data", "runtime", "survey");
    const hasCanonicalReferences = existsSync(join(current, "reference", "arena-evolve"));
    const hasFourSurveyDbs = ["t1", "t2", "t3", "t4"].every((tenant) =>
      existsSync(join(surveyDir, `${tenant}.db`))
    );
    if (hasCanonicalReferences && hasFourSurveyDbs) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("cannot locate Arena coordination root (requires reference/arena-evolve + t1-t4 survey DBs)");
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--force") {
      force = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} requires a value`);
    values.set(token, value);
    index += 1;
  }
  const tenants = (values.get("--tenants") ?? "t1,t2,t3,t4")
    .split(/[,\s]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (tenants.length === 0 || tenants.some((tenant) => !/^[A-Za-z0-9_-]+$/u.test(tenant))) {
    throw new Error("--tenants must contain simple tenant identifiers");
  }
  if (new Set(tenants).size !== tenants.length) throw new Error("--tenants contains duplicates");
  return Object.freeze({
    dataRoot: values.get("--data-root") ?? null,
    tenants,
    runId: values.get("--run-id") ?? null,
    force,
  });
}

function readSurveyDb(path: string): SurveyWorldCalibrationInput {
  if (!existsSync(path)) throw new Error(`survey DB missing: ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const observedChunkKeys = (db.prepare("SELECT chunk_key FROM chunks").all() as { chunk_key: string }[])
      .map((row) => row.chunk_key);
    const resourceCells = (db.prepare("SELECT x,y FROM resources").all() as { x: number; y: number }[])
      .map((row) => [Number(row.x), Number(row.y)] as Position);
    const obstacleCells = (db.prepare("SELECT x,y FROM obstacles").all() as { x: number; y: number }[])
      .map((row) => [Number(row.x), Number(row.y)] as Position);
    const coreSightings = (db.prepare(
      "SELECT owner,x,y,last_seen_tick FROM core_hunts WHERE owner IS NOT NULL AND owner != ''",
    ).all() as { owner: string; x: number; y: number; last_seen_tick: number }[]).map((row) => ({
      owner: row.owner,
      position: [Number(row.x), Number(row.y)] as Position,
      lastSeenTick: Number(row.last_seen_tick),
    }));
    return { observedChunkKeys, resourceCells, obstacleCells, coreSightings };
  } finally {
    db.close();
  }
}

function mergeInputs(inputs: readonly SurveyWorldCalibrationInput[]): SurveyWorldCalibrationInput {
  const chunks = new Set<string>();
  const resources = new Map<string, Position>();
  const obstacles = new Map<string, Position>();
  const cores: SurveyWorldCalibrationInput["coreSightings"][number][] = [];
  for (const input of inputs) {
    for (const key of input.observedChunkKeys) chunks.add(key);
    for (const position of input.resourceCells) resources.set(`${position[0]},${position[1]}`, position);
    for (const position of input.obstacleCells) obstacles.set(`${position[0]},${position[1]}`, position);
    cores.push(...input.coreSightings);
  }
  return Object.freeze({
    observedChunkKeys: Object.freeze([...chunks]),
    resourceCells: Object.freeze([...resources.values()]),
    obstacleCells: Object.freeze([...obstacles.values()]),
    coreSightings: Object.freeze(cores),
  });
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const coordinationRoot = findCoordinationRoot(packageRoot);
  const dataRoot = cli.dataRoot === null ? join(coordinationRoot, "data") : resolve(cli.dataRoot);
  const surveyDir = join(dataRoot, "runtime", "survey");
  const dbPaths = cli.tenants.map((tenant) => join(surveyDir, `${tenant}.db`));
  const inputs = dbPaths.map(readSurveyDb);
  const merged = mergeInputs(inputs);
  const source = `hybrid:survey:${cli.tenants.join("+")}:union+arena-evolve-live-calibration`;
  const report = calibrateWorldDistribution(merged, source, {
    // Independent explored-chunk estimate in arena-evolve: 121 / 187 chunks contain resources.
    resourceChunkProbability: 0.65,
    // Reference/official-style generator draws obstacle density in every chunk; our survey support is a lower bound.
    obstacleChunkProbability: 1,
  });
  const inputFiles = dbPaths.map((path) => {
    const stat = statSync(path);
    return Object.freeze({ path, bytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
  });
  const identity = {
    schema: "sim.world-calibration-run.v1",
    tenants: cli.tenants,
    inputFiles,
    profile: report.profile,
  };
  const outputBase = resolveOutputBase(dataRoot, null);
  const runId = cli.runId ?? defaultRunId("world-calibration", identity);
  const runDir = prepareRunDir(outputBase, runId, cli.force);
  atomicWriteJson(join(runDir, "profile.json"), report.profile);
  atomicWriteJson(join(runDir, "report.json"), {
    ...report,
    createdAt: new Date().toISOString(),
    tenants: cli.tenants,
    inputFiles,
    notes: [
      "Survey coverage is partial observation, not server ground truth.",
      "Observed resource/obstacle bearing fractions are lower-bound diagnostics; generation support uses independent priors.",
      "Chunk support probability is separated from conditional non-empty density.",
      "Historical resource-site counts are diagnostics only; generated concurrent resources use official chunkQuota.",
      "Generated obstacle component cap remains an engineering constraint even if survey observes larger components.",
    ],
  });
  console.log(JSON.stringify({
    runDir,
    profile: report.profile,
    diagnostics: report.diagnostics,
  }, null, 2));
}

main();
