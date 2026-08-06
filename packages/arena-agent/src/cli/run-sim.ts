/** Offline simulator CLI (S9): doctor, episode, ab, benchmark and calibrate. */

import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCalibrationCase } from "../sim/calibration/calibrate.ts";
import { runCalibrationDataset } from "../sim/calibration/dataset.ts";
import { buildDataset } from "../sim/dataset/builder.ts";
import {
  loadRulesManifest,
  manifestHash,
  RulesManifestError,
  SUPPORTED_RULES_VERSIONS,
} from "../sim/contracts/rules-manifest.ts";
import { compareCodeUnit } from "../sim/deterministic/uuid.ts";
import { runEpisode, type EpisodeConfig, type PlannerKind } from "../sim/harness/episode.ts";
import {
  atomicWriteJson,
  atomicWriteJsonl,
  atomicWriteText,
  defaultRunId,
  prepareRunDir,
  readJsonFile,
  resolveInputPath,
  resolveOutputBase,
  sha256Json,
  sha256Text,
} from "../sim/tools/artifacts.ts";
import {
  episodePerformance,
  runAB,
  runBenchmark,
  summarizeEpisode,
} from "../sim/tools/experiments.ts";
import { canonicalWorldJson } from "../sim/world/canonical.ts";
import { worldFromScenario } from "../sim/world/loaders.ts";
import { resolveArenaDataRoot } from "../app/data-root.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..", "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");
/** 默认规则版本（无 --rules 时使用）；历史 v0.11 case 可用 --rules v0.11 显式回退。 */
const SUPPORTED_RULES_VERSION = "v0.14";
const DEFAULT_RULES_PATH = join(PKG_ROOT, "src", "sim", "contracts", `rules-${SUPPORTED_RULES_VERSION}.json`);

type Command = "doctor" | "episode" | "ab" | "benchmark" | "calibrate" | "calibrate-dataset" | "dataset";

interface ParsedArgs {
  readonly command: Command;
  readonly values: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
}

const BOOLEAN_FLAGS = new Set(["--force", "--help"]);
const KNOWN_FLAGS: Readonly<Record<Command, ReadonlySet<string>>> = {
  doctor: new Set(["--rules", "--data-root", "--help"]),
  episode: new Set([
    "--scenario", "--rules", "--ticks", "--seed", "--planner", "--workers", "--output", "--run-id", "--data-root", "--force", "--help",
  ]),
  ab: new Set([
    "--scenario", "--rules", "--ticks", "--seeds", "--planners", "--workers", "--output", "--run-id", "--data-root", "--force", "--help",
  ]),
  benchmark: new Set([
    "--scenario", "--rules", "--ticks", "--seed", "--planner", "--workers", "--warmup", "--repeats", "--output", "--run-id", "--data-root", "--force", "--help",
  ]),
  calibrate: new Set(["--case", "--rules", "--output", "--run-id", "--data-root", "--force", "--help"]),
  "calibrate-dataset": new Set(["--manifest", "--rules", "--output", "--run-id", "--data-root", "--force", "--help"]),
  dataset: new Set(["--manifest", "--rules", "--data-root", "--dataset-id", "--force", "--help"]),
};

function parseArgs(argv: readonly string[]): ParsedArgs {
  const first = argv[0];
  const command: Command = first === undefined || first.startsWith("--")
    ? "doctor"
    : parseCommand(first);
  const rest = first !== undefined && !first.startsWith("--") ? argv.slice(1) : argv;
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!flag.startsWith("--")) throw new Error(`unexpected positional argument: ${flag}`);
    if (!KNOWN_FLAGS[command].has(flag)) throw new Error(`unknown flag for ${command}: ${flag}`);
    if (values.has(flag) || booleans.has(flag)) throw new Error(`duplicate flag: ${flag}`);
    if (BOOLEAN_FLAGS.has(flag)) {
      booleans.add(flag);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }
  return { command, values, booleans };
}

function parseCommand(value: string): Command {
  if (["doctor", "episode", "ab", "benchmark", "calibrate", "calibrate-dataset", "dataset"].includes(value)) {
    return value as Command;
  }
  throw new Error(`unknown sim command: ${value}`);
}

function usage(): string {
  return [
    "arena:sim commands:",
    "  doctor [--rules PATH]",
    "  episode --scenario PATH [--planner deterministic|safety] [--ticks N] [--seed N] [--workers 1]",
    "  ab --scenario PATH [--planners deterministic,safety] [--seeds 1,2,3] [--ticks N] [--workers 1]",
    "  benchmark --scenario PATH [--planner deterministic|safety] [--ticks N] [--warmup N] [--repeats N] [--workers 1]",
    "  calibrate --case PATH",
    "  calibrate-dataset --manifest PATH",
    "  dataset --manifest PATH [--dataset-id ID] [--force]",
    "common output flags: --data-root PATH --output runs/sim[/subdir] --run-id ID --force",
  ].join("\n");
}

function required(args: ParsedArgs, flag: string): string {
  const value = args.values.get(flag);
  if (value === undefined) throw new Error(`${flag} is required for ${args.command}`);
  return value;
}

function value(args: ParsedArgs, flag: string, fallback: string): string {
  return args.values.get(flag) ?? fallback;
}

function integer(args: ParsedArgs, flag: string, fallback: number, minimum: number): number {
  const raw = args.values.get(flag);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${flag} must be a safe integer >= ${minimum}`);
  }
  return parsed;
}

function planner(valueToParse: string): PlannerKind {
  if (valueToParse === "deterministic" || valueToParse === "safety") return valueToParse;
  throw new Error(`invalid planner: ${valueToParse}`);
}

function plannerList(raw: string): PlannerKind[] {
  const parsed = raw.split(",").filter((entry) => entry.length > 0).map(planner);
  const unique = [...new Set(parsed)].sort(compareCodeUnit);
  if (unique.length === 0) throw new Error("planner list cannot be empty");
  return unique;
}

function integerList(raw: string, flag: string): number[] {
  const parsed = raw.split(",").map((entry) => Number(entry));
  if (parsed.length === 0 || parsed.some((entry) => !Number.isSafeInteger(entry) || entry < 0)) {
    throw new Error(`${flag} must be a comma-separated list of non-negative safe integers`);
  }
  return [...new Set(parsed)].sort((a, b) => a - b);
}

function serialWorkers(args: ParsedArgs): 1 {
  const workers = integer(args, "--workers", 1, 1);
  if (workers !== 1) {
    throw new Error("--workers is capped at 1 by the simulator CPU-isolation policy");
  }
  return 1;
}

function rulesPath(args: ParsedArgs): string {
  return args.values.has("--rules")
    ? resolveInputPath(REPO_ROOT, args.values.get("--rules")!)
    : DEFAULT_RULES_PATH;
}

function checkedRules(path: string) {
  const rules = loadRulesManifest(path);
  if (!SUPPORTED_RULES_VERSIONS.includes(rules.rulesVersion)) {
    throw new RulesManifestError(
      `unsupported rules version: ${rules.rulesVersion} (supported: ${SUPPORTED_RULES_VERSIONS.join(", ")})`,
    );
  }
  return rules;
}

function outputSettings(args: ParsedArgs, kind: string, identity: unknown): {
  readonly outputBase: string;
  readonly runId: string;
  readonly force: boolean;
} {
  const dataRoot = resolveArenaDataRoot(
    REPO_ROOT,
    args.values.get("--data-root"),
    process.env.ARENA_DATA_ROOT,
  );
  const outputBase = resolveOutputBase(dataRoot, args.values.get("--output") ?? null);
  const runId = args.values.get("--run-id") ?? defaultRunId(kind, identity);
  return { outputBase, runId, force: args.booleans.has("--force") };
}

function sourceLabel(path: string): string {
  const rel = relative(REPO_ROOT, path);
  return rel.startsWith("..") ? `external:${basename(path)}` : rel.replaceAll("\\", "/");
}

function writeManifest(
  runDir: string,
  record: Record<string, unknown>,
  deterministicArtifacts: Readonly<Record<string, string>>,
  performanceArtifact: string | null,
): void {
  atomicWriteJson(join(runDir, "manifest.json"), {
    schema: "sim.run.v1",
    ...record,
    deterministicArtifacts,
    performanceArtifact,
  });
}

function runDoctor(args: ParsedArgs): number {
  const path = rulesPath(args);
  const rules = checkedRules(path);
  console.log(`sim doctor ok: rules=${rules.rulesVersion} manifest=${manifestHash(rules)}`);
  return 0;
}

function runEpisodeCommand(args: ParsedArgs): number {
  const scenarioPath = resolveInputPath(REPO_ROOT, required(args, "--scenario"));
  const scenario = readJsonFile(scenarioPath);
  const pathToRules = rulesPath(args);
  const rules = checkedRules(pathToRules);
  const ticks = integer(args, "--ticks", 100, 1);
  const seed = integer(args, "--seed", 1, 0);
  const selectedPlanner = planner(value(args, "--planner", "deterministic"));
  const workers = serialWorkers(args);
  const playerIds = [...worldFromScenario(scenario).players.keys()].sort(compareCodeUnit);
  const config: EpisodeConfig = {
    scenario,
    rulesPath: pathToRules,
    ticks,
    seed,
    tenants: playerIds.map((id) => ({ id, planner: selectedPlanner })),
  };
  const result = runEpisode(config);
  const summary = summarizeEpisode(config, result);
  const performance = episodePerformance(config, result);
  const identity = {
    kind: "episode",
    scenarioHash: sha256Json(scenario),
    rulesManifestHash: manifestHash(rules),
    ticks,
    seed,
    planner: selectedPlanner,
    workers,
  };
  const output = outputSettings(args, "episode", identity);
  const runDir = prepareRunDir(output.outputBase, output.runId, output.force);
  const recordsHash = atomicWriteJsonl(join(runDir, "records.jsonl"), result.records);
  const finalWorld = canonicalWorldJson(result.finalWorld);
  atomicWriteText(join(runDir, "final-world.json"), finalWorld);
  const finalWorldFileHash = sha256Text(finalWorld);
  const summaryHash = atomicWriteJson(join(runDir, "summary.json"), summary);
  atomicWriteJson(join(runDir, "performance.json"), performance);
  writeManifest(
    runDir,
    {
      kind: "episode",
      runId: output.runId,
      status: "completed",
      source: sourceLabel(scenarioPath),
      sourceHash: sha256Json(scenario),
      rulesVersion: rules.rulesVersion,
      rulesManifestHash: manifestHash(rules),
      config: { ticks, seed, planner: selectedPlanner, workers, tenants: playerIds },
    },
    {
      "records.jsonl": recordsHash,
      "final-world.json": finalWorldFileHash,
      "summary.json": summaryHash,
    },
    "performance.json",
  );
  console.log(`sim episode ok: hash=${summary.semanticHash} ticks=${ticks} out=${runDir}`);
  return 0;
}

function runABCommand(args: ParsedArgs): number {
  const scenarioPath = resolveInputPath(REPO_ROOT, required(args, "--scenario"));
  const scenario = readJsonFile(scenarioPath);
  const pathToRules = rulesPath(args);
  const rules = checkedRules(pathToRules);
  const ticks = integer(args, "--ticks", 100, 1);
  const seeds = integerList(value(args, "--seeds", "1,2,3"), "--seeds");
  const planners = plannerList(value(args, "--planners", "deterministic,safety"));
  const workers = serialWorkers(args);
  const { report, performance } = runAB({ scenario, rulesPath: pathToRules, ticks, seeds, planners });
  const identity = {
    kind: "ab",
    scenarioHash: sha256Json(scenario),
    rulesManifestHash: manifestHash(rules),
    ticks,
    seeds,
    planners,
    workers,
  };
  const output = outputSettings(args, "ab", identity);
  const runDir = prepareRunDir(output.outputBase, output.runId, output.force);
  const reportHash = atomicWriteJson(join(runDir, "ab-report.json"), report);
  atomicWriteJson(join(runDir, "performance.json"), performance);
  writeManifest(
    runDir,
    {
      kind: "ab",
      runId: output.runId,
      status: "completed",
      source: sourceLabel(scenarioPath),
      sourceHash: sha256Json(scenario),
      rulesVersion: rules.rulesVersion,
      rulesManifestHash: manifestHash(rules),
      config: { ticks, seeds, planners, workers },
    },
    { "ab-report.json": reportHash },
    "performance.json",
  );
  console.log(
    `sim ab ok: status=${report.rankingStatus} ranking=${report.ranking.join(",")} out=${runDir}`,
  );
  return 0;
}

function runBenchmarkCommand(args: ParsedArgs): number {
  const scenarioPath = resolveInputPath(REPO_ROOT, required(args, "--scenario"));
  const scenario = readJsonFile(scenarioPath);
  const pathToRules = rulesPath(args);
  const rules = checkedRules(pathToRules);
  const ticks = integer(args, "--ticks", 1000, 1);
  const seed = integer(args, "--seed", 1, 0);
  const selectedPlanner = planner(value(args, "--planner", "deterministic"));
  const warmupRuns = integer(args, "--warmup", 1, 0);
  const measuredRuns = integer(args, "--repeats", 5, 1);
  const workers = serialWorkers(args);
  const report = runBenchmark({
    scenario,
    rulesPath: pathToRules,
    planner: selectedPlanner,
    seed,
    ticks,
    warmupRuns,
    measuredRuns,
  });
  const identity = {
    kind: "benchmark",
    scenarioHash: sha256Json(scenario),
    rulesManifestHash: manifestHash(rules),
    ticks,
    seed,
    planner: selectedPlanner,
    workers,
    warmupRuns,
    measuredRuns,
  };
  const output = outputSettings(args, "benchmark", identity);
  const runDir = prepareRunDir(output.outputBase, output.runId, output.force);
  atomicWriteJson(join(runDir, "benchmark.json"), report);
  writeManifest(
    runDir,
    {
      kind: "benchmark",
      runId: output.runId,
      status: "completed",
      source: sourceLabel(scenarioPath),
      sourceHash: sha256Json(scenario),
      rulesVersion: rules.rulesVersion,
      rulesManifestHash: manifestHash(rules),
      config: { ticks, seed, planner: selectedPlanner, workers, warmupRuns, measuredRuns },
    },
    {},
    "benchmark.json",
  );
  console.log(
    `sim benchmark ok: status=${report.semanticStatus} median=${report.medianTicksPerSecond.toFixed(1)} tick/s out=${runDir}`,
  );
  return 0;
}

function runCalibrationCommand(args: ParsedArgs): number {
  const casePath = resolveInputPath(REPO_ROOT, required(args, "--case"));
  const calibrationCase = readJsonFile(casePath);
  const pathToRules = rulesPath(args);
  const rules = checkedRules(pathToRules);
  const report = runCalibrationCase(calibrationCase, pathToRules);
  const identity = {
    kind: "calibration",
    caseHash: sha256Json(calibrationCase),
    rulesManifestHash: manifestHash(rules),
  };
  const output = outputSettings(args, "calibration", identity);
  const runDir = prepareRunDir(output.outputBase, output.runId, output.force);
  const reportHash = atomicWriteJson(join(runDir, "calibration-report.json"), report);
  writeManifest(
    runDir,
    {
      kind: "calibration",
      runId: output.runId,
      status: report.status,
      source: sourceLabel(casePath),
      sourceHash: sha256Json(calibrationCase),
      rulesVersion: rules.rulesVersion,
      rulesManifestHash: manifestHash(rules),
    },
    { "calibration-report.json": reportHash },
    null,
  );
  console.log(`sim calibrate ${report.status}: differences=${report.differences.length} out=${runDir}`);
  return report.status === "MATCH" ? 0 : report.status === "INCONCLUSIVE" ? 2 : 3;
}

function runCalibrationDatasetCommand(args: ParsedArgs): number {
  const manifestPath = resolveInputPath(REPO_ROOT, required(args, "--manifest"));
  const pathToRules = rulesPath(args);
  const rules = checkedRules(pathToRules);
  const datasetManifest = readJsonFile(manifestPath);
  const report = runCalibrationDataset(manifestPath, pathToRules);
  const identity = {
    kind: "calibration-dataset",
    datasetManifestHash: sha256Json(datasetManifest),
    rulesManifestHash: manifestHash(rules),
  };
  const output = outputSettings(args, "calibration-dataset", identity);
  const runDir = prepareRunDir(output.outputBase, output.runId, output.force);
  const reportHash = atomicWriteJson(join(runDir, "calibration-dataset-report.json"), report);
  writeManifest(
    runDir,
    {
      kind: "calibration-dataset",
      runId: output.runId,
      status: report.passed ? "PASS" : "FAIL",
      source: sourceLabel(manifestPath),
      sourceHash: sha256Json(datasetManifest),
      rulesVersion: rules.rulesVersion,
      rulesManifestHash: manifestHash(rules),
      config: { accuracyThreshold: report.accuracyThreshold },
    },
    { "calibration-dataset-report.json": reportHash },
    null,
  );
  console.log(
    `sim calibrate-dataset ${report.passed ? "PASS" : "FAIL"}: ` +
      `cases=${report.caseCount} hard=${report.hardMismatchCaseCount} ` +
      `knownEvents=${report.knownEventMatched}/${report.knownEventCompared} ` +
      `accuracy=${report.knownEventAccuracy === null ? "n/a" : report.knownEventAccuracy.toFixed(6)} ` +
      `out=${runDir}`,
  );
  if (report.passed) return 0;
  return report.hardMismatchCaseCount > 0 || report.unclassifiedDifferenceCount > 0 ? 3 : 2;
}

function runDatasetCommand(args: ParsedArgs): number {
  const inputPath = resolveInputPath(REPO_ROOT, required(args, "--manifest"));
  const pathToRules = rulesPath(args);
  const dataRoot = resolveArenaDataRoot(
    REPO_ROOT,
    args.values.get("--data-root"),
    process.env.ARENA_DATA_ROOT,
  );
  const result = buildDataset({
    inputPath,
    rulesPath: pathToRules,
    dataRoot,
    datasetId: args.values.get("--dataset-id") ?? undefined,
    force: args.booleans.has("--force"),
  });
  const report = result.report;
  console.log(
    `sim dataset ${result.gatePassed ? "PASS" : "FAIL"}: ` +
      `dataset=${result.datasetId} samples=${result.sampleCount} ` +
      `quarantined=${report.counts.quarantineTotal} ` +
      `schemaFailures=${report.counts.schemaFailures} ` +
      `splits=train:${report.splits.counts.train.samples}/` +
      `validation:${report.splits.counts.validation.samples}/` +
      `test:${report.splits.counts.test.samples} ` +
      `registry=${report.registry.appended ? "appended" : "skipped"} ` +
      `out=${result.datasetDir}`,
  );
  return result.gatePassed ? 0 : 2;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.booleans.has("--help")) {
    console.log(usage());
    return 0;
  }
  switch (args.command) {
    case "doctor": return runDoctor(args);
    case "episode": return runEpisodeCommand(args);
    case "ab": return runABCommand(args);
    case "benchmark": return runBenchmarkCommand(args);
    case "calibrate": return runCalibrationCommand(args);
    case "calibrate-dataset": return runCalibrationDatasetCommand(args);
    case "dataset": return runDatasetCommand(args);
  }
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`sim: ${(error as Error).message}`);
  process.exitCode = 1;
}
