/**
 * Benchmark result 单元测试：
 * - createBenchmarkResult 正确生成
 * - validateBenchmarkResult 校验
 * - aggregateMetrics 聚合正确
 * - 确定性
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createBenchmarkResult,
  validateBenchmarkResult,
  type BenchmarkConfig,
  type PolicyUnderTest,
  type BenchmarkEpisodeResult,
} from "../../src/offline-learning/eval/benchmark.ts";
import {
  computeEpisodeMetrics,
  aggregateMetrics,
  type EpisodeMetrics,
} from "../../src/offline-learning/eval/metrics.ts";

const MOCK_POLICY: PolicyUnderTest = {
  policyId: "test-deterministic-v1",
  policyVersion: "abc1234",
  description: "Test deterministic policy",
};

const MOCK_CONFIG: BenchmarkConfig = {
  seeds: [1, 2, 3],
  ticksPerEpisode: 100,
  rulesVersion: "v0.14",
  rulesManifestHash: "sha256:abcd",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  engineVersion: "0.1.0",
};

// ── Metrics tests ──

function makeTickData(overrides: Array<Partial<{
  resources: number; population: number; threatLevel: string;
  resourceCollected: number; deaths: number; spawns: number;
  combatKills: number; coreAlive: boolean;
}>>): Array<{
  tick: number; resources: number; population: number;
  threatLevel: string; resourceCollected: number;
  deaths: number; spawns: number; combatKills: number; coreAlive: boolean;
}> {
  return overrides.map((o, i) => ({
    tick: i + 1,
    resources: o.resources ?? 10,
    population: o.population ?? 5,
    threatLevel: o.threatLevel ?? "NORMAL",
    resourceCollected: o.resourceCollected ?? 2,
    deaths: o.deaths ?? 0,
    spawns: o.spawns ?? 0,
    combatKills: o.combatKills ?? 0,
    coreAlive: o.coreAlive ?? true,
  }));
}

test("computeEpisodeMetrics with normal episode", () => {
  const tickData = makeTickData(Array.from({ length: 100 }, () => ({})));
  const result = { metrics: { illegalPlans: 0, repairedPlans: 0 } } as unknown as import("../../src/sim/harness/episode.ts").EpisodeResult;
  const metrics = computeEpisodeMetrics(result, tickData);
  assert.strictEqual(metrics.survivalTicks, 100);
  assert.strictEqual(metrics.finalResources, 10);
  assert.strictEqual(metrics.finalPopulation, 5);
  assert.strictEqual(metrics.totalResourcesCollected, 200);
  assert.strictEqual(metrics.totalDeaths, 0);
  assert.strictEqual(metrics.coreDestroyed, false);
  assert.strictEqual(metrics.meanThreatLevel, 0); // all NORMAL
  assert.strictEqual(metrics.efficiencyRatio, 2); // 200/100
});

test("computeEpisodeMetrics with deaths and spawns", () => {
  const tickData = makeTickData([
    { resources: 10, population: 5, deaths: 1, spawns: 2, combatKills: 1 },
    { resources: 12, population: 6 },
    { resources: 15, population: 6 },
  ]);
  const result = { metrics: { illegalPlans: 1, repairedPlans: 1 } } as unknown as import("../../src/sim/harness/episode.ts").EpisodeResult;
  const metrics = computeEpisodeMetrics(result, tickData);
  assert.strictEqual(metrics.totalDeaths, 1);
  assert.strictEqual(metrics.totalSpawns, 2);
  assert.strictEqual(metrics.combatKills, 1);
  assert.strictEqual(metrics.illegalPlans, 1);
  assert.strictEqual(metrics.repairedPlans, 1);
});

test("computeEpisodeMetrics core destroyed", () => {
  const tickData = makeTickData([
    { coreAlive: true },
    { coreAlive: false },
  ]);
  const result = { metrics: { illegalPlans: 0, repairedPlans: 0 } } as unknown as import("../../src/sim/harness/episode.ts").EpisodeResult;
  const metrics = computeEpisodeMetrics(result, tickData);
  assert.strictEqual(metrics.coreDestroyed, true);
});

test("computeEpisodeMetrics threat level mean", () => {
  const tickData = makeTickData([
    { threatLevel: "NORMAL" },
    { threatLevel: "ALERT" },
    { threatLevel: "ENGAGED" },
    { threatLevel: "BREAKOUT" },
  ]);
  const result = { metrics: { illegalPlans: 0, repairedPlans: 0 } } as unknown as import("../../src/sim/harness/episode.ts").EpisodeResult;
  const metrics = computeEpisodeMetrics(result, tickData);
  // NORMAL=0, ALERT=1, ENGAGED=2, BREAKOUT=3 → mean = 6/4 = 1.5
  assert.strictEqual(metrics.meanThreatLevel, 1.5);
});

test("computeEpisodeMetrics peak tracking", () => {
  const tickData = makeTickData([
    { resources: 10, population: 5 },
    { resources: 20, population: 8 },
    { resources: 5, population: 3 },
    { resources: 15, population: 10 },
    { resources: 8, population: 4 },
  ]);
  const result = { metrics: { illegalPlans: 0, repairedPlans: 0 } } as unknown as import("../../src/sim/harness/episode.ts").EpisodeResult;
  const metrics = computeEpisodeMetrics(result, tickData);
  assert.strictEqual(metrics.peakResources, 20);
  assert.strictEqual(metrics.peakPopulation, 10);
});

test("computeEpisodeMetrics empty tickData", () => {
  const result = { metrics: { illegalPlans: 0, repairedPlans: 1 } } as unknown as import("../../src/sim/harness/episode.ts").EpisodeResult;
  const metrics = computeEpisodeMetrics(result, []);
  assert.strictEqual(metrics.survivalTicks, 0);
  assert.strictEqual(metrics.coreDestroyed, true);
  assert.strictEqual(metrics.repairedPlans, 1);
});

// ── Aggregate tests ──

test("aggregateMetrics averages correctly", () => {
  const metricsList: EpisodeMetrics[] = [
    { survivalTicks: 100, finalResources: 10, finalPopulation: 5, totalResourcesCollected: 200, totalDeaths: 0, totalSpawns: 5, combatKills: 2, coreDestroyed: false, meanThreatLevel: 0, peakPopulation: 5, peakResources: 10, efficiencyRatio: 2, illegalPlans: 0, repairedPlans: 0 },
    { survivalTicks: 80, finalResources: 5, finalPopulation: 3, totalResourcesCollected: 150, totalDeaths: 2, totalSpawns: 3, combatKills: 1, coreDestroyed: true, meanThreatLevel: 1, peakPopulation: 3, peakResources: 5, efficiencyRatio: 1.875, illegalPlans: 1, repairedPlans: 1 },
  ];
  const agg = aggregateMetrics(metricsList);
  assert.strictEqual(agg.survivalTicks, 90); // (100+80)/2
  assert.strictEqual(agg.finalResources, 7.5);
  assert.strictEqual(agg.totalDeaths, 1);
  assert.strictEqual(agg.coreDestroyed, true); // 1/2 > 0.5
  assert.strictEqual(agg.meanThreatLevel, 0.5);
});

test("aggregateMetrics empty list returns zeros", () => {
  const agg = aggregateMetrics([]);
  assert.strictEqual(agg.survivalTicks, 0);
  assert.strictEqual(agg.coreDestroyed, true);
});

// ── Benchmark tests ──

test("createBenchmarkResult produces valid structure", () => {
  const episodes: BenchmarkEpisodeResult[] = [
    {
      episodeId: "ep-001",
      seed: 1,
      metrics: {
        survivalTicks: 100, finalResources: 10, finalPopulation: 5,
        totalResourcesCollected: 200, totalDeaths: 0, totalSpawns: 5,
        combatKills: 2, coreDestroyed: false, meanThreatLevel: 0,
        peakPopulation: 5, peakResources: 10, efficiencyRatio: 2,
        illegalPlans: 0, repairedPlans: 0,
      },
    },
  ];
  const result = createBenchmarkResult(MOCK_POLICY, MOCK_CONFIG, episodes);
  assert.strictEqual(result.schema, "benchmark-result-v1");
  assert.strictEqual(result.policyId, "test-deterministic-v1");
  assert.strictEqual(result.episodes.length, 1);
  assert.strictEqual(result.config.seeds.length, 3);
});

test("createBenchmarkResult benchmarkId is deterministic", () => {
  const episodes: BenchmarkEpisodeResult[] = [
    {
      episodeId: "ep-001", seed: 1,
      metrics: { survivalTicks: 100, finalResources: 0, finalPopulation: 0, totalResourcesCollected: 0, totalDeaths: 0, totalSpawns: 0, combatKills: 0, coreDestroyed: false, meanThreatLevel: 0, peakPopulation: 0, peakResources: 0, efficiencyRatio: 0, illegalPlans: 0, repairedPlans: 0 },
    },
  ];
  const result1 = createBenchmarkResult(MOCK_POLICY, MOCK_CONFIG, episodes);
  const result2 = createBenchmarkResult(MOCK_POLICY, MOCK_CONFIG, episodes);
  assert.strictEqual(result1.benchmarkId, result2.benchmarkId);
});

test("validateBenchmarkResult accepts valid result", () => {
  const episodes: BenchmarkEpisodeResult[] = [
    {
      episodeId: "ep-001", seed: 1,
      metrics: { survivalTicks: 100, finalResources: 0, finalPopulation: 0, totalResourcesCollected: 0, totalDeaths: 0, totalSpawns: 0, combatKills: 0, coreDestroyed: false, meanThreatLevel: 0, peakPopulation: 0, peakResources: 0, efficiencyRatio: 0, illegalPlans: 0, repairedPlans: 0 },
    },
  ];
  const result = createBenchmarkResult(MOCK_POLICY, MOCK_CONFIG, episodes);
  const problems = validateBenchmarkResult(result);
  assert.deepStrictEqual(problems, [], `Expected no problems, got: ${problems.join("; ")}`);
});

test("validateBenchmarkResult rejects wrong schema", () => {
  const problems = validateBenchmarkResult({ schema: "wrong", benchmarkId: "x", policyId: "y", episodes: [], aggregate: {} });
  assert.ok(problems.length > 0);
});

test("validateBenchmarkResult rejects null", () => {
  const problems = validateBenchmarkResult(null);
  assert.ok(problems.length > 0);
});
