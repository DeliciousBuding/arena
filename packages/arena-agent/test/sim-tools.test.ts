/** S9 artifact canonicalization and output-boundary unit tests. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Json } from "../src/sim/tools/artifacts.ts";
import { parseExperimentManifest } from "../src/sim/tools/experiment-manifest.ts";
import { runAB, runBenchmark } from "../src/sim/tools/experiments.ts";
import { resolvePlannerVariant } from "../src/sim/tools/planner-variants.ts";
import { DeterministicPlanner } from "../src/planning/deterministic-planner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO = JSON.parse(
  readFileSync(join(here, "fixtures", "sim", "scenario-basic.json"), "utf8"),
) as unknown;
const RULES = join(here, "..", "src", "sim", "contracts", "rules-v0.11.json");

test("S9: canonical JSON/hash is insertion-order independent", () => {
  const a = { z: [3, { b: 2, a: 1 }], a: true };
  const b = { a: true, z: [3, { a: 1, b: 2 }] };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(sha256Json(a), sha256Json(b));
  assert.match(sha256Json(a), /^[0-9a-f]{64}$/);
});

test("S9: canonical JSON rejects values that JSON.stringify would silently corrupt", () => {
  assert.throws(() => canonicalJson({ value: Number.NaN }), /non-finite number/);
  assert.throws(() => canonicalJson({ value: Number.POSITIVE_INFINITY }), /non-finite number/);
  assert.throws(() => canonicalJson({ value: undefined }), /rejects undefined/);
  assert.throws(() => canonicalJson({ value: new Map([["a", 1]]) }), /non-plain object/);
  assert.throws(() => canonicalJson({ value: new Date(0) }), /non-plain object/);
  const sparse = new Array(2);
  sparse[1] = 1;
  assert.throws(() => canonicalJson(sparse), /sparse array/);
});

test("S9: direct A/B API normalizes duplicate seeds and planners", () => {
  const { report } = runAB({
    scenario: SCENARIO,
    rulesPath: RULES,
    ticks: 1,
    seeds: [2, 1, 2],
    planners: ["safety", "safety"],
  });
  assert.deepEqual(report.seeds, [1, 2]);
  assert.deepEqual(report.planners, ["safety"]);
  assert.equal(report.runs.length, 2);
  assert.equal(report.rankingStatus, "conclusive");
  assert.deepEqual(report.pairedDeltas, []);
  assert.deepEqual(report.pairedAggregates, []);
});

test("S9: A/B emits same-seed paired deltas", () => {
  const { report } = runAB({
    scenario: SCENARIO,
    rulesPath: RULES,
    ticks: 1,
    seeds: [1, 2],
    planners: ["safety", "deterministic"],
  });
  assert.equal(report.pairedDeltas.length, 2);
  assert.equal(report.pairedAggregates.length, 1);
  assert.ok(report.pairedDeltas.every((pair) => pair.baseline === "deterministic"));
  assert.ok(report.pairedDeltas.every((pair) => pair.candidate === "safety"));
  assert.deepEqual(report.pairedDeltas.map((pair) => pair.seed), [1, 2]);
});

test("S9: benchmark marks emergency spawn UUID as inconclusive", () => {
  const recoveryScenario = structuredClone(SCENARIO) as {
    players: Array<{ resources: number }>;
  };
  recoveryScenario.players[0]!.resources = 5;
  const report = runBenchmark({
    scenario: recoveryScenario,
    rulesPath: RULES,
    planner: "deterministic",
    seed: 7,
    ticks: 1,
    warmupRuns: 0,
    measuredRuns: 1,
  });
  assert.equal(report.semanticStatus, "inconclusive");
  assert.equal(report.unknownEffectCount, 1);
});

test("S9: benchmark locks final world, trace and semantic summary", () => {
  const report = runBenchmark({
    scenario: SCENARIO,
    rulesPath: RULES,
    planner: "deterministic",
    seed: 7,
    ticks: 1,
    warmupRuns: 0,
    measuredRuns: 2,
  });
  assert.match(report.finalWorldHash, /^[0-9a-f]{64}$/);
  assert.match(report.traceHash, /^[0-9a-f]{64}$/);
  assert.match(report.economicCurveHash, /^[0-9a-f]{64}$/);
  assert.equal(report.semanticStatus, "supported");
  assert.equal(report.samples.length, 2);
  assert.equal(report.economicCurve.length, 1);
  assert.equal(report.economicCurve[0].tick, 1);
  assert.ok(report.tickLatencyMs.p50 >= 0);
  assert.ok(report.tickLatencyMs.p95 >= report.tickLatencyMs.p50);
  assert.ok(report.samples.every((sample) => sample.peakHeapBytes >= sample.heapStartBytes));
});

test("TS-003: 合法 manifest 解析成功并保留字段", () => {
  const manifest = parseExperimentManifest({
    experimentId: "economy-v1-grid",
    hypothesis: "shorter harvest-return-deposit cycle improves net core gain",
    baselineVariant: "deterministic-v0.2.15",
    candidateVariant: "economy-v1",
    rulesVersion: "v0.11",
    seeds: [1, 2, 3],
    ticks: 500,
    primaryMetric: "net_core_gain_per_100_ticks",
    guardrails: [{ metric: "illegal_plan_count", max: 0 }, { metric: "capacity_wait_count", max: 10 }],
    configHash: "sha256:abc",
    gitSha: "deadbeef",
  });
  assert.equal(manifest.experimentId, "economy-v1-grid");
  assert.deepEqual(manifest.seeds, [1, 2, 3]);
  assert.equal(manifest.ticks, 500);
  assert.equal(manifest.guardrails[0].max, 0);
});

test("TS-003: 缺必填字段/非法值 fail-fast", () => {
  assert.throws(
    () => parseExperimentManifest({}),
    /missing required field/,
  );
  assert.throws(
    () => parseExperimentManifest({
      experimentId: "x", hypothesis: "h", baselineVariant: "a", candidateVariant: "b",
      rulesVersion: "v0.11", seeds: [], ticks: 500, primaryMetric: "m",
      guardrails: [], configHash: "sha256:abc", gitSha: "deadbeef",
    }),
    /seeds must be a non-empty array/,
  );
  assert.throws(
    () => parseExperimentManifest({
      experimentId: "x", hypothesis: "h", baselineVariant: "a", candidateVariant: "a",
      rulesVersion: "v0.11", seeds: [1], ticks: 500, primaryMetric: "m",
      guardrails: [], configHash: "sha256:abc", gitSha: "deadbeef",
    }),
    /baselineVariant must differ/,
  );
  assert.throws(
    () => parseExperimentManifest({
      experimentId: "x", hypothesis: "h", baselineVariant: "a", candidateVariant: "b",
      rulesVersion: "v0.11", seeds: [1], ticks: 0, primaryMetric: "m",
      guardrails: [], configHash: "sha256:abc", gitSha: "deadbeef",
    }),
    /ticks must be a positive integer/,
  );
});

test("TS-004: 变体 registry 解析 + 未知 id fail-fast", () => {
  const baseline = resolvePlannerVariant("deterministic-v0.2.15");
  assert.equal(baseline.id, "deterministic-v0.2.15");
  assert.ok(baseline.create("t1") instanceof DeterministicPlanner);
  assert.equal(resolvePlannerVariant("safety").aliasOf, "safety");
  assert.throws(() => resolvePlannerVariant("no-such-variant"), /unknown planner variant/);
});

test("TS-004: runAB 接受命名变体 id（plannerFactory 注入，同策略对局）", () => {
  const { report } = runAB({
    scenario: SCENARIO,
    rulesPath: RULES,
    ticks: 1,
    seeds: [1, 2],
    planners: ["deterministic-v0.2.15", "safety"],
  });
  assert.deepEqual(report.planners, ["deterministic-v0.2.15", "safety"]);
  assert.equal(report.runs.length, 4);
  assert.equal(report.pairedDeltas[0].baseline, "deterministic-v0.2.15");
  assert.equal(report.pairedDeltas[0].candidate, "safety");
});
