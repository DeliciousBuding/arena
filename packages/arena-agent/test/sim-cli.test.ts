/** S9 end-to-end CLI artifact and reproducibility tests. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..");
const SCENARIO = join(PKG_ROOT, "test", "fixtures", "sim", "scenario-basic.json");
const CALIBRATION = join(PKG_ROOT, "test", "fixtures", "sim", "calibration-wait-match.json");
const CALIBRATION_DATASET = join(PKG_ROOT, "test", "fixtures", "sim", "calibration-dataset-match", "manifest.json");
const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), "arena-sim-cli-data-"));
const RUN_ROOT = join(TEST_DATA_ROOT, "runs", "sim");

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runSim(args: readonly string[]): CommandResult {
  const quoted = args.map((argument) => `"${argument.replaceAll('"', '\\"')}"`).join(" ");
  try {
    const stdout = execFileSync(`npx tsx src/cli/run-sim.ts ${quoted}`, {
      encoding: "utf8",
      cwd: PKG_ROOT,
      shell: true,
      env: {
        ...process.env,
        ARENA_DATA_ROOT: TEST_DATA_ROOT,
        API_KEY: "",
        BASE_URL: "",
        WEBSOCKET_URL: "",
      },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      code: failure.status ?? 1,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? ""),
    };
  }
}

function runId(label: string): string {
  return `s9-${process.pid}-${label}`;
}

function runDir(id: string): string {
  return join(RUN_ROOT, id);
}

function text(id: string, file: string): string {
  return readFileSync(join(runDir(id), file), "utf8");
}

function json<T>(id: string, file: string): T {
  return JSON.parse(text(id, file)) as T;
}

after(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
});

test("S9: CLI data root overrides ARENA_DATA_ROOT", () => {
  const cliDataRoot = mkdtempSync(join(tmpdir(), "arena-sim-cli-override-"));
  const id = runId("data-root-precedence");
  try {
    const result = runSim([
      "episode", "--scenario", SCENARIO, "--ticks", "1",
      "--data-root", cliDataRoot, "--run-id", id,
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(join(cliDataRoot, "runs", "sim", id, "manifest.json")), true);
    assert.equal(existsSync(runDir(id)), false);
  } finally {
    rmSync(cliDataRoot, { recursive: true, force: true });
  }
});

test("S9: episode writes complete artifacts and deterministic files are byte-identical", () => {
  const first = runId("episode-a");
  const second = runId("episode-b");
  for (const id of [first, second]) {
    const result = runSim([
      "episode", "--scenario", SCENARIO, "--ticks", "30", "--seed", "42",
      "--planner", "deterministic", "--run-id", id,
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /sim episode ok:/);
    for (const file of ["manifest.json", "records.jsonl", "final-world.json", "summary.json", "performance.json"]) {
      assert.ok(existsSync(join(runDir(id), file)), `${file} missing`);
    }
  }
  assert.equal(text(first, "records.jsonl"), text(second, "records.jsonl"));
  assert.equal(text(first, "final-world.json"), text(second, "final-world.json"));
  assert.equal(text(first, "summary.json"), text(second, "summary.json"));
  const firstManifest = json<{ deterministicArtifacts: Record<string, string> }>(first, "manifest.json");
  const secondManifest = json<{ deterministicArtifacts: Record<string, string> }>(second, "manifest.json");
  assert.deepEqual(firstManifest.deterministicArtifacts, secondManifest.deterministicArtifacts);
  const records = text(first, "records.jsonl").trim().split("\n");
  assert.equal(records.length, 30);
});

test("S9: run directory collision fails closed unless --force", () => {
  const id = runId("collision");
  const base = ["episode", "--scenario", SCENARIO, "--ticks", "1", "--run-id", id] as const;
  assert.equal(runSim(base).code, 0);
  const collision = runSim(base);
  assert.equal(collision.code, 1);
  assert.match(collision.stderr, /run directory already exists/);
  assert.equal(runSim([...base, "--force"]).code, 0);
});

test("S9: output symlink/junction escape is rejected", () => {
  const linkName = `s9-${process.pid}-junction`;
  const linkPath = join(RUN_ROOT, linkName);
  const external = mkdtempSync(join(tmpdir(), "arena-sim-output-"));
  try {
    symlinkSync(external, linkPath, "junction");
    const result = runSim([
      "episode", "--scenario", SCENARIO,
      "--output", `runs/sim/${linkName}`, "--run-id", "escape",
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /escapes through symlink\/junction/);
    assert.equal(existsSync(join(external, "escape")), false);
  } finally {
    rmSync(linkPath, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("S9: A/B report is semantic and excludes performance from ranking", () => {
  const id = runId("ab");
  const result = runSim([
    "ab", "--scenario", SCENARIO, "--ticks", "20", "--seeds", "2,1",
    "--planners", "safety,deterministic", "--run-id", id,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const report = json<{
    schema: string;
    seeds: number[];
    planners: string[];
    runs: unknown[];
    pairedDeltas: unknown[];
    pairedAggregates: unknown[];
    rankingStatus: string;
    ranking: string[];
    semanticHash: string;
  }>(id, "ab-report.json");
  assert.equal(report.schema, "sim.ab-report.v1");
  assert.deepEqual(report.seeds, [1, 2]);
  assert.deepEqual(report.planners, ["deterministic", "safety"]);
  assert.equal(report.runs.length, 4);
  assert.equal(report.pairedDeltas.length, 2, "one same-seed pair per seed");
  assert.equal(report.pairedAggregates.length, 1);
  assert.equal(report.rankingStatus, "exploratory", "refill unknown makes ranking advisory");
  assert.match(report.semanticHash, /^[0-9a-f]{64}$/);
  assert.deepEqual([...report.ranking].sort(), ["deterministic", "safety"]);
  assert.ok(existsSync(join(runDir(id), "performance.json")));
});

test("S9: benchmark detects semantic stability and reports throughput", () => {
  const id = runId("benchmark");
  const result = runSim([
    "benchmark", "--scenario", SCENARIO, "--ticks", "100", "--seed", "9",
    "--warmup", "0", "--repeats", "2", "--run-id", id,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const report = json<{
    schema: string;
    finalWorldHash: string;
    traceHash: string;
    economicCurveHash: string;
    economicCurve: unknown[];
    tickLatencyMs: { p50: number; p95: number; max: number };
    semanticStatus: string;
    samples: { ticksPerSecond: number; peakHeapBytes: number; heapStartBytes: number }[];
    medianTicksPerSecond: number;
  }>(id, "benchmark.json");
  assert.equal(report.schema, "sim.benchmark.v1");
  assert.match(report.finalWorldHash, /^[0-9a-f]{64}$/);
  assert.match(report.traceHash, /^[0-9a-f]{64}$/);
  assert.match(report.economicCurveHash, /^[0-9a-f]{64}$/);
  assert.equal(report.economicCurve.length, 100);
  assert.equal(report.semanticStatus, "inconclusive", "refill cadence is explicit unknown");
  assert.equal(report.samples.length, 2);
  assert.ok(report.samples.every((sample) => sample.ticksPerSecond > 0));
  assert.ok(report.samples.every((sample) => sample.peakHeapBytes >= sample.heapStartBytes));
  assert.ok(report.tickLatencyMs.p95 >= report.tickLatencyMs.p50);
  assert.ok(report.medianTicksPerSecond > 0);
});

test("S8b: calibration dataset CLI verifies integrity and 99.9% event gate", () => {
  const id = runId("calibration-dataset");
  const result = runSim([
    "calibrate-dataset", "--manifest", CALIBRATION_DATASET, "--run-id", id,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /sim calibrate-dataset PASS:/);
  const report = json<{
    schema: string;
    integrityVerified: boolean;
    caseCount: number;
    knownEventMatched: number;
    knownEventCompared: number;
    knownEventAccuracy: number;
    accuracyGatePassed: boolean;
    passed: boolean;
  }>(id, "calibration-dataset-report.json");
  assert.equal(report.schema, "runtime-golden-calibration-report-v1");
  assert.equal(report.integrityVerified, true);
  assert.equal(report.caseCount, 1);
  assert.equal(report.knownEventMatched, 1);
  assert.equal(report.knownEventCompared, 1);
  assert.equal(report.knownEventAccuracy, 1);
  assert.equal(report.accuracyGatePassed, true);
  assert.equal(report.passed, true);
});

test("S9: calibration CLI writes MATCH report with CI exit code 0", () => {
  const id = runId("calibration");
  const result = runSim(["calibrate", "--case", CALIBRATION, "--run-id", id]);
  assert.equal(result.code, 0, result.stderr);
  const report = json<{ schema: string; status: string; differences: unknown[] }>(id, "calibration-report.json");
  assert.equal(report.schema, "sim-calibration-report-v1");
  assert.equal(report.status, "MATCH");
  assert.deepEqual(report.differences, []);
});
