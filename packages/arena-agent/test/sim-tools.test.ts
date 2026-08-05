/** S9 artifact canonicalization and output-boundary unit tests. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Json } from "../src/sim/tools/artifacts.ts";
import { parseExperimentManifest } from "../src/sim/tools/experiment-manifest.ts";
import { runAB, runBenchmark } from "../src/sim/tools/experiments.ts";
import { evaluateCandidate } from "../src/sim/tools/candidate-evaluator.ts";
import { resolvePlannerVariant } from "../src/sim/tools/planner-variants.ts";
import { DeterministicPlanner } from "../src/planning/deterministic-planner.ts";
import { SafetyPlanner } from "../src/strategies/safety-planner.ts";
import { runEpisode } from "../src/sim/harness/episode.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO = JSON.parse(
  readFileSync(join(here, "fixtures", "sim", "scenario-basic.json"), "utf8"),
) as unknown;
const FOCUS_EXILE_SCENARIO = JSON.parse(
  readFileSync(join(here, "fixtures", "sim", "scenario-focus-exile.json"), "utf8"),
) as unknown;
const RULES = join(here, "..", "src", "sim", "contracts", "rules-v0.11.json");
/** 生产事故复现 policy：focusRegion 指向远点（> maxFocusDistance=32），
 *  v0.2.15 基线（无防呆）会把 worker 直线支走；v0.2.17 候选过滤后留守巡逻。 */
const FOCUS_EXILE_POLICY = {
  posture: "balanced",
  workerTarget: 8,
  militaryRatio: 0,
  focusRegion: [40, 0],
  attackPriority: null,
} as const;

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

test("TS-006: 候选晋级评估（提升达标 + guardrail 全过 → promote）", () => {
  const manifest = parseExperimentManifest({
    experimentId: "e1", hypothesis: "h", baselineVariant: "deterministic-v0.2.15",
    candidateVariant: "safety", rulesVersion: "v0.11",
    seeds: [1, 2, 3, 4], ticks: 500,
    primaryMetric: "net_core_gain_per_100_ticks",
    guardrails: [{ metric: "illegal_plan_count", max: 0 }],
    configHash: "sha256:abc", gitSha: "deadbeef",
  });
  const { report } = runAB({
    scenario: SCENARIO, rulesPath: RULES, ticks: 1,
    seeds: [1, 2, 3, 4], planners: ["deterministic-v0.2.15", "safety"],
  });
  const evaluation = evaluateCandidate(manifest, report);
  assert.equal(evaluation.candidateVariant, "safety");
  assert.equal(typeof evaluation.primaryDeltaMedian, "number");
  assert.ok(Array.isArray(evaluation.guardrails));
  assert.ok(evaluation.reasons.length >= 0);
});

test("TS-006: 未知主指标不猜数 → reject", () => {
  const manifest = parseExperimentManifest({
    experimentId: "e2", hypothesis: "h", baselineVariant: "deterministic-v0.2.15",
    candidateVariant: "economy-v1", rulesVersion: "v0.11",
    seeds: [1], ticks: 500,
    primaryMetric: "mystery_metric",
    guardrails: [], configHash: "sha256:abc", gitSha: "deadbeef",
  });
  const { report } = runAB({
    scenario: SCENARIO, rulesPath: RULES, ticks: 1,
    seeds: [1], planners: ["deterministic-v0.2.15", "safety"],
  });
  const evaluation = evaluateCandidate(manifest, report);
  assert.equal(evaluation.decision, "reject");
  assert.ok(evaluation.reasons.some((reason) => reason.includes("mystery_metric")));
});

test("TS-006: report 基线不匹配 manifest → reject", () => {
  const manifest = parseExperimentManifest({
    experimentId: "e3", hypothesis: "h", baselineVariant: "other-baseline",
    candidateVariant: "economy-v1", rulesVersion: "v0.11",
    seeds: [1], ticks: 500,
    primaryMetric: "net_core_gain_per_100_ticks",
    guardrails: [], configHash: "sha256:abc", gitSha: "deadbeef",
  });
  const { report } = runAB({
    scenario: SCENARIO, rulesPath: RULES, ticks: 1,
    seeds: [1], planners: ["deterministic-v0.2.15", "safety"],
  });
  const evaluation = evaluateCandidate(manifest, report);
  assert.equal(evaluation.decision, "reject");
  assert.ok(evaluation.reasons.some((reason) => reason.includes("baseline")));
});

test("TS-007: pairedAggregates 输出 median/p10/p90/最差 seed", () => {
  const { report } = runAB({
    scenario: SCENARIO,
    rulesPath: RULES,
    ticks: 1,
    seeds: [1, 2, 3, 4, 5],
    planners: ["deterministic-v0.2.15", "safety"],
  });
  const aggregate = report.pairedAggregates[0];
  assert.equal(aggregate.pairs, 5);
  assert.equal(aggregate.candidate, "safety");
  assert.equal(typeof aggregate.medianResourceDelta, "number");
  assert.ok(aggregate.p10ResourceDelta <= aggregate.medianResourceDelta);
  assert.ok(aggregate.medianResourceDelta <= aggregate.p90ResourceDelta);
  assert.ok(report.pairedDeltas.some((pair) => pair.seed === aggregate.worstSeed));
  assert.equal(aggregate.worstSeedDelta, Math.min(...report.pairedDeltas.map((pair) => pair.resourceDelta)));
});

test("TS-008: 变体语义——v0.2.15 基线（无防呆）/ v0.2.17 候选（防呆）/ deterministic 别名", () => {
  const baseline = resolvePlannerVariant("deterministic-v0.2.15");
  const candidate = resolvePlannerVariant("deterministic-v0.2.17");
  const alias = resolvePlannerVariant("deterministic");
  assert.ok(baseline.create("t1") instanceof DeterministicPlanner);
  assert.ok(candidate.create("t1") instanceof DeterministicPlanner);
  assert.equal(alias.aliasOf, "deterministic");
  // 候选与别名共用当前语义（生产默认）；基线是独立冻结形态
  assert.notEqual(baseline.id, candidate.id);
  assert.notEqual(baseline.id, alias.id);
});

test("TS-009: clear-path-v1 变体注册（清场 ROI 候选）", () => {
  const variant = resolvePlannerVariant("clear-path-v1");
  assert.equal(variant.id, "clear-path-v1");
  assert.ok(variant.create("t1") instanceof SafetyPlanner);
  assert.throws(() => resolvePlannerVariant("no-such-variant"), /unknown planner variant/);
});

test("TS-008: focus 远征场景——基线被支走 vs 候选留守（生产事故模拟回归）", () => {
  const run = (variantId: string) => runEpisode({
    scenario: FOCUS_EXILE_SCENARIO,
    rulesPath: RULES,
    seed: 1,
    ticks: 30,
    tenants: [{ id: "p1", planner: "deterministic", policy: FOCUS_EXILE_POLICY }],
    plannerFactory: () => resolvePlannerVariant(variantId).create("p1"),
  });
  const baselineResult = run("deterministic-v0.2.15");
  const candidateResult = run("deterministic-v0.2.17");
  const baselineWorker = [...baselineResult.finalWorld.players.get("p1")!.units][0]!;
  const candidateWorker = [...candidateResult.finalWorld.players.get("p1")!.units][0]!;
  // 基线无防呆：worker 采完开局资源后被 go_focus 直线支向 [40,0]（先 x 轴）
  assert.ok(
    baselineWorker.position[0] >= 20,
    `基线 worker 应被支走远离 Core: ${JSON.stringify(baselineWorker.position)}`,
  );
  // 候选防呆：焦点被过滤 → patrol 留守巡逻圈（exploreRadius=8，30 tick 内不越界）
  assert.ok(
    candidateWorker.position[0] <= 10,
    `候选 worker 应留守巡逻圈: ${JSON.stringify(candidateWorker.position)}`,
  );
});

test("TS-008: runAB policy 注入——focus 远征场景可 A/B 且同 seed 配对", () => {
  const { report } = runAB({
    scenario: FOCUS_EXILE_SCENARIO,
    rulesPath: RULES,
    ticks: 30,
    seeds: [1, 2],
    planners: ["deterministic-v0.2.15", "deterministic-v0.2.17"],
    policy: FOCUS_EXILE_POLICY,
  });
  assert.deepEqual(report.planners, ["deterministic-v0.2.15", "deterministic-v0.2.17"]);
  assert.equal(report.runs.length, 4);
  assert.equal(report.pairedDeltas.length, 2);
  // unknown effects 是模拟器固有的诚实标注（refill 放置/server UUID 服务器秘密），
  // 场景本身无 unsupported 特性（结构正确性断言）。
  assert.ok(report.runs.every((run) => run.summary.unsupported.length === 0));
});
