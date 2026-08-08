#!/usr/bin/env node
/**
 * W52 gene-efficacy audit.
 *
 * A search dimension is not allowed merely because it exists in a schema. Each
 * gene must measurably change authoritative simulator outcome/ledger under a
 * deterministic exercise scenario, otherwise GA spends budget on a fake axis.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_MACRO_POLICY, type MacroPolicy } from "../src/runtime/macro-policy.ts";
import { evaluateMacroPolicyTournament } from "../src/sim/evolution/tournament-fitness.ts";
import {
  makeArenaScenarioN,
  makeSafetyEntry,
  type FfaSpawnProfile,
} from "../src/sim/opponent/tournament.ts";
import {
  atomicWriteJson,
  defaultRunId,
  prepareRunDir,
  resolveOutputBase,
  sha256Json,
} from "../src/sim/tools/artifacts.ts";

interface CliOptions {
  readonly ticks: number;
  readonly seeds: readonly number[];
  readonly runId: string | null;
  readonly force: boolean;
}

function findCoordinationRoot(start: string): string {
  let current = start;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, "reference", "arena-evolve")) && existsSync(join(current, "data"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("cannot locate Arena coordination root");
}

function positiveInt(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
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
  const seeds = (values.get("--seeds") ?? "1,2,3")
    .split(/[,\s]+/u)
    .filter(Boolean)
    .map((value) => positiveInt(value, "--seeds"));
  if (seeds.length < 2) throw new Error("dimension audit requires at least 2 seeds");
  return Object.freeze({
    ticks: positiveInt(values.get("--ticks") ?? "32", "--ticks"),
    seeds: Object.freeze(seeds),
    runId: values.get("--run-id") ?? null,
    force,
  });
}

interface DimensionCase {
  readonly name: "workerTarget" | "militaryRatio" | "posture" | "attackPriority";
  readonly left: MacroPolicy;
  readonly right: MacroPolicy;
}

function policy(overrides: Partial<MacroPolicy>): MacroPolicy {
  return Object.freeze({ ...DEFAULT_MACRO_POLICY, ...overrides, focusRegion: null });
}

const CASES: readonly DimensionCase[] = Object.freeze([
  { name: "workerTarget", left: policy({ workerTarget: 5 }), right: policy({ workerTarget: 12 }) },
  { name: "militaryRatio", left: policy({ workerTarget: 7, militaryRatio: 0 }), right: policy({ workerTarget: 7, militaryRatio: 0.7 }) },
  { name: "posture", left: policy({ posture: "harvest" }), right: policy({ posture: "aggressive" }) },
  { name: "attackPriority", left: policy({ posture: "aggressive", attackPriority: "workers" }), right: policy({ posture: "aggressive", attackPriority: "core" }) },
]);

interface MutableExercisePlayer {
  id: string;
  core: { position: [number, number] } | null;
  units: { unitType: string; position: [number, number] }[];
}

interface MutableExerciseScenario {
  players: MutableExercisePlayer[];
  terrain: { obstacles: [number, number][]; resources: [number, number][] };
}

function makeExerciseScenario(
  seed: number,
  entries: readonly ReturnType<typeof makeSafetyEntry>[],
  subjectProfile: FfaSpawnProfile,
  opponentProfile: FfaSpawnProfile,
): unknown {
  const scenario = structuredClone(makeArenaScenarioN(entries, seed, {
    radius: 18,
    spawnProfiles: {
      "audit-subject": subjectProfile,
      "audit-opponent-a": opponentProfile,
      "audit-opponent-b": opponentProfile,
    },
  })) as MutableExerciseScenario;
  const subject = scenario.players.find((player) => player.id === "audit-subject")!;
  const opponentA = scenario.players.find((player) => player.id === "audit-opponent-a")!;
  if (subject.core === null || opponentA.core === null) throw new Error("audit exercise requires active cores");
  const [sx, sy] = subject.core.position;
  // Put the enemy Core east and its Worker west. Both are visible immediately,
  // so attackPriority=core/workers must choose genuinely different targets.
  opponentA.core.position = [sx + 4, sy];
  const enemyWorker = opponentA.units.find((unit) => unit.unitType === "WORKER");
  if (enemyWorker === undefined) throw new Error("audit exercise requires enemy worker");
  enemyWorker.position = [sx - 4, sy];
  // Terrain is intentionally empty: this is a gene-wiring exercise, not a map benchmark.
  scenario.terrain = { obstacles: [], resources: [] };
  return scenario;
}

function evaluationSignature(value: ReturnType<typeof evaluateMacroPolicyTournament>): string {
  return sha256Json({
    score: value.score,
    ledger: value.detail.ledger,
    winner: value.detail.match.winner,
    finalResources: value.detail.match.finalResources,
    finalPopulation: value.detail.match.finalPopulation,
    coreAlive: value.detail.match.coreAlive,
  });
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(scriptDir, "..");
  const coordinationRoot = findCoordinationRoot(packageRoot);
  const dataRoot = join(coordinationRoot, "data");
  const rulesPath = join(packageRoot, "src", "sim", "contracts", "rules-v0.14.json");
  // Pure TS opponents keep this a wiring audit rather than a Python bridge benchmark.
  const opponents = [makeSafetyEntry("audit-opponent-a"), makeSafetyEntry("audit-opponent-b")];
  const subjectExerciseProfile: FfaSpawnProfile = Object.freeze({
    resources: 100,
    workers: 7,
    vanguards: 3,
    rangers: 2,
  });
  const opponentExerciseProfile: FfaSpawnProfile = Object.freeze({
    resources: 40,
    workers: 1,
    vanguards: 1,
    rangers: 1,
  });

  const dimensions = CASES.map((dimension) => {
    const perSeed = cli.seeds.map((seed) => {
      const scenarioEntries = [makeSafetyEntry("audit-subject"), ...opponents];
      const scenario = makeExerciseScenario(seed, scenarioEntries, subjectExerciseProfile, opponentExerciseProfile);
      const common = {
        rulesPath,
        ticks: cli.ticks,
        opponents,
        subjectId: "audit-subject",
        validatePlans: true,
        fitnessMode: "event-ledger" as const,
        // The exercise scenario fixes geometry so a gene delta is the only left/right cause.
        rotateSubjectSlot: false,
        spawnProfileMode: "uniform" as const,
        terrainMode: "fixed" as const,
        scenario,
      };
      const left = evaluateMacroPolicyTournament(dimension.left, seed, common);
      const right = evaluateMacroPolicyTournament(dimension.right, seed, common);
      return Object.freeze({
        seed,
        leftScore: left.score,
        rightScore: right.score,
        scoreDelta: right.score - left.score,
        leftLedger: left.detail.ledger,
        rightLedger: right.detail.ledger,
        changed: evaluationSignature(left) !== evaluationSignature(right),
      });
    });
    const changedSeeds = perSeed.filter((entry) => entry.changed).length;
    return Object.freeze({
      name: dimension.name,
      left: dimension.left,
      right: dimension.right,
      active: changedSeeds > 0,
      changedSeeds,
      totalSeeds: perSeed.length,
      perSeed: Object.freeze(perSeed),
    });
  });

  const inactive = dimensions.filter((dimension) => !dimension.active).map((dimension) => dimension.name);
  const identity = {
    schema: "sim.evolution-dimension-audit.v1",
    ticks: cli.ticks,
    seeds: cli.seeds,
    cases: CASES,
  };
  const runId = cli.runId ?? defaultRunId("evolution-dimension-audit", identity);
  const runDir = prepareRunDir(resolveOutputBase(dataRoot, null), runId, cli.force);
  const report = Object.freeze({
    ...identity,
    createdAt: new Date().toISOString(),
    active: inactive.length === 0,
    inactiveDimensions: inactive,
    dimensions,
    notes: [
      "This audits gene wiring/effect, not whether the right-hand value is strategically better.",
      "All left/right pairs share the same rich exercise world and opponent states; only the audited gene changes.",
      "The subject starts with 100 resources + 7W/3V/2R so worker/military/posture branches are reachable immediately.",
      "Enemy Core and Worker are placed on opposite visible sides of the subject so attackPriority is immediately exercisable.",
      "A dimension is active when at least one authoritative outcome/ledger signature differs.",
    ],
  });
  atomicWriteJson(join(runDir, "report.json"), report);
  console.log(JSON.stringify({ runDir, active: report.active, inactiveDimensions: inactive, dimensions: dimensions.map((d) => ({
    name: d.name,
    active: d.active,
    changedSeeds: d.changedSeeds,
    scoreDeltas: d.perSeed.map((entry) => entry.scoreDelta),
  })) }, null, 2));
  if (inactive.length > 0) {
    process.exitCode = 1;
  }
}

main();
