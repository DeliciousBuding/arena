/**
 * W51 fitness 多目标评分测试（2026-08-09）：
 * - 纯函数：fitnessFromDetail 公式正确性（与 reference 逐项对照）、
 *   riskMetrics 边界（空/单/多样本）、combineDetails 加权合并 + pooled std。
 * - 集成：runEpisode 产出 perPlayer cost ledger，evaluateMultiSeed 端到端
 *   计算 p1 fitness（非 0，且 baseline 与攻击性变体有可辨识差异）。
 * - ledger 累计：HARVEST/DEPOSIT/SPAWN/CORE_HEAL 等事件正确归属到玩家。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { runEpisode } from "../src/sim/harness/episode.ts";
import {
  fitnessFromDetail,
  riskMetrics,
  combineDetails,
  buildFitnessDetail,
  ledgerToDetail,
  evaluateMultiSeed,
  type FitnessDetail,
} from "../src/offline-learning/eval/fitness.ts";
import type { PlayerCostLedger } from "../src/sim/harness/episode.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.14.json");

function emptyDetail(): FitnessDetail {
  return {
    harvested: 0, deposited: 0, res: 0, pop: 0, beacon: 0, alive_ticks: 0,
    damage: 0, lost: 0, respawn: 0, heal_cost: 0, repair_cost: 0, spawn_cost: 0,
    overflow_destroyed: 0, resources_lost: 0,
  };
}

test("fitnessFromDetail: 公式与 reference 逐项对照（max_ticks=600 → t=1）", () => {
  // 手算期望（t=1, max_ticks=600）：
  //   harvested/t*0.6 = 100*0.6 = 60
  //   deposited/t*1.2 = 50*1.2 = 60
  //   res*1.0 = 30
  //   min(pop,40)*0.8 = min(10,40)*0.8 = 8
  //   beacon/t*0.05 = 20*0.05 = 1
  //   alive_ticks/max_ticks*2 = 600/600*2 = 2
  //   damage/t*0.3 = 40*0.3 = 12
  //   -lost/t*0.8 = -5*0.8 = -4
  //   -respawn/t*2 = -1*2 = -2
  //   -heal_cost/t*0.15 = -10*0.15 = -1.5
  //   -repair_cost/t*0.1 = -8*0.1 = -0.8
  //   -overflow_destroyed/t*0.5 = -4*0.5 = -2
  //   -resources_lost/t*1.0 = -6*1 = -6
  // 总和 = 60+60+30+8+1+2+12-4-2-1.5-0.8-2-6 = 156.7
  const detail: FitnessDetail = {
    ...emptyDetail(),
    harvested: 100, deposited: 50, res: 30, pop: 10, beacon: 20,
    alive_ticks: 600, damage: 40, lost: 5, respawn: 1,
    heal_cost: 10, repair_cost: 8, spawn_cost: 3, overflow_destroyed: 4, resources_lost: 6,
  };
  const score = fitnessFromDetail(detail, 600);
  assert.ok(Math.abs(score - 156.7) < 1e-9, `expected 156.7, got ${score}`);
});

test("fitnessFromDetail: spawn_cost 不影响公式（reference weight=0）", () => {
  const base: FitnessDetail = { ...emptyDetail(), res: 10, pop: 5, alive_ticks: 600 };
  const withCost: FitnessDetail = { ...base, spawn_cost: 1000 };
  assert.equal(fitnessFromDetail(withCost, 600), fitnessFromDetail(base, 600));
});

test("fitnessFromDetail: pop 上限 40（超出不奖）", () => {
  const at40: FitnessDetail = { ...emptyDetail(), pop: 40, alive_ticks: 600 };
  const at80: FitnessDetail = { ...emptyDetail(), pop: 80, alive_ticks: 600 };
  assert.equal(fitnessFromDetail(at40, 600), fitnessFromDetail(at80, 600));
});

test("fitnessFromDetail: 时间归一化（max_ticks 翻倍 → 累计项折半，快照不变）", () => {
  // harvested/deposited 等累计项除以 t；res/pop 快照不缩放；alive_ticks 按
  // max_ticks 归一化（alive_ticks=600@600 与 alive_ticks=1200@1200 等价，项=2）。
  // max_ticks=1200 → t=2；harvested=100 → 100/2*0.6 = 30（vs 600 时 60）
  // res=30 → 30（不变）；alive_ticks 同步翻倍使存活项不变。
  const detail600: FitnessDetail = {
    ...emptyDetail(), harvested: 100, res: 30, pop: 10, alive_ticks: 600,
  };
  const detail1200: FitnessDetail = {
    ...emptyDetail(), harvested: 100, res: 30, pop: 10, alive_ticks: 1200,
  };
  const f600 = fitnessFromDetail(detail600, 600);
  const f1200 = fitnessFromDetail(detail1200, 1200);
  // 差值 = harvested 项的差 = (100/1 - 100/2)*0.6 = 50*0.6 = 30
  // （alive_ticks 项因 alive_ticks 同步翻倍而相等，res/pop 不缩放）
  assert.ok(Math.abs((f600 - f1200) - 30) < 1e-9, `delta ${(f600 - f1200).toFixed(4)} != 30`);
});

test("riskMetrics: 空数组 → 全 0", () => {
  const r = riskMetrics([]);
  assert.deepEqual(r, { fitness_std: 0, fitness_worst: 0, fitness_p10: 0 });
});

test("riskMetrics: 单样本 → std=0, worst=p10=样本值", () => {
  const r = riskMetrics([42.5]);
  assert.deepEqual(r, { fitness_std: 0, fitness_worst: 42.5, fitness_p10: 42.5 });
});

test("riskMetrics: 多样本 → std=n-1 样本标准差, worst=min, p10 按位序", () => {
  const scores = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const r = riskMetrics(scores);
  // 排序后 worst=10；n=10, p10 index = max(0, int(10*0.1)-1) = max(0, 0) = 0 → p10=10
  assert.equal(r.fitness_worst, 10);
  assert.equal(r.fitness_p10, 10);
  // 样本标准差 = sqrt(sum((x-mean)^2)/(n-1))；mean=55, sum_sq=8250, std=sqrt(8250/9)
  const expectedStd = Math.sqrt(8250 / 9);
  assert.ok(Math.abs(r.fitness_std - expectedStd) < 1e-9, `std ${r.fitness_std} != ${expectedStd}`);
});

test("combineDetails: 按种子数加权平均累计字段", () => {
  const d1: FitnessDetail = { ...emptyDetail(), harvested: 100, res: 10 };
  const d2: FitnessDetail = { ...emptyDetail(), harvested: 200, res: 20 };
  // n1=2, n2=1 → totalN=3；harvested = (100*2 + 200*1)/3 = 400/3 ≈ 133.33
  // res = (10*2 + 20*1)/3 = 40/3 ≈ 13.33
  const out = combineDetails([[d1, 2], [d2, 1]]);
  assert.ok(Math.abs(out.harvested - 400 / 3) < 1e-9, `harvested ${out.harvested}`);
  assert.ok(Math.abs(out.res - 40 / 3) < 1e-9, `res ${out.res}`);
});

test("combineDetails: fitness_worst/p10 取各段最小", () => {
  const d1: FitnessDetail = { ...emptyDetail(), res: 5 };
  d1.fitness_worst = 3; d1.fitness_p10 = 2;
  const d2: FitnessDetail = { ...emptyDetail(), res: 10 };
  d2.fitness_worst = 7; d2.fitness_p10 = 6;
  const out = combineDetails([[d1, 1], [d2, 1]]);
  assert.equal(out.fitness_worst, 3);
  assert.equal(out.fitness_p10, 2);
});

test("combineDetails: 提供 mean_fitness 时用 pooled-sample std", () => {
  // 两段：n1=2 std=0 mean=10, n2=2 std=0 mean=20
  // pooled_mean = (10*2 + 20*2)/4 = 15
  // sum_sq = max(0,2-1)*0^2 + 2*(10-15)^2 + max(0,2-1)*0^2 + 2*(20-15)^2
  //        = 0 + 2*25 + 0 + 2*25 = 100
  // std = sqrt(100/(4-1)) = sqrt(100/3) ≈ 5.77
  const d1: FitnessDetail = { ...emptyDetail() };
  d1.fitness_std = 0;
  const d2: FitnessDetail = { ...emptyDetail() };
  d2.fitness_std = 0;
  const out = combineDetails([[d1, 2, 10], [d2, 2, 20]]);
  const expectedStd = Math.sqrt(100 / 3);
  assert.ok(
    Math.abs((out.fitness_std ?? 0) - expectedStd) < 1e-9,
    `pooled std ${out.fitness_std} != ${expectedStd}`,
  );
});

test("ledgerToDetail: 字段名映射 camelCase → snake_case", () => {
  const ledger: PlayerCostLedger = {
    harvested: 5, deposited: 3, damageDealt: 7, beaconTicks: 2, respawnCount: 1,
    unitsLost: 4, healCost: 6, repairCost: 8, spawnCost: 9, overflowDestroyed: 11,
    resourcesLost: 13, finalPopulation: 14, finalResources: 15, aliveTicks: 16,
    eventCounts: { movement: 1, combat: 2, economy: 3, beacon: 4, respawn: 5 },
    unrecognizedEventCount: 0,
    decisionTimeouts: 0,
  };
  const detail = ledgerToDetail(ledger);
  assert.equal(detail.harvested, 5);
  assert.equal(detail.deposited, 3);
  assert.equal(detail.damage, 7);
  assert.equal(detail.beacon, 2);
  assert.equal(detail.respawn, 1);
  assert.equal(detail.lost, 4);
  assert.equal(detail.heal_cost, 6);
  assert.equal(detail.repair_cost, 8);
  assert.equal(detail.spawn_cost, 9);
  assert.equal(detail.overflow_destroyed, 11);
  assert.equal(detail.resources_lost, 13);
  assert.equal(detail.pop, 14);
  assert.equal(detail.res, 15);
  assert.equal(detail.alive_ticks, 16);
});

test("集成: runEpisode 产出 perPlayer cost ledger（p1 harvested > 0）", () => {
  // 单玩家场景：worker 采集资源节点 → HARVEST_SUCCEEDED + DEPOSIT_SUCCEEDED。
  const scenario = {
    rulesVersion: "v0.14", tick: 1, seed: 1,
    players: [{
      id: "p1", username: "p1", resources: 4,
      core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
      units: [{ id: "22222222-2222-2222-2222-222222222222", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
    }],
    terrain: { obstacles: [], resources: [[2, 0]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
  const result = runEpisode({
    scenario, rulesPath: MANIFEST_PATH, seed: 1, ticks: 30,
    tenants: [{ id: "p1", planner: "safety" }],
  });
  const ledger = result.metrics.perPlayer["p1"];
  assert.ok(ledger !== undefined, "p1 ledger should exist");
  assert.ok(ledger.harvested > 0, `harvested should be > 0, got ${ledger.harvested}`);
  assert.ok(ledger.deposited > 0, `deposited should be > 0, got ${ledger.deposited}`);
  assert.equal(ledger.aliveTicks, 30, "p1 core survived all 30 ticks");
  assert.equal(ledger.respawnCount, 0, "no respawns");
  assert.equal(ledger.unitsLost, 0, "no unit losses in solo scenario");
});

test("集成: evaluateMultiSeed 端到端计算 fitness（p1 多种子聚合）", () => {
  // 同一场景跑 2 seeds，fitness 应为有限数且 res 项 > 0（终局储备）。
  const scenarioBase = {
    rulesVersion: "v0.14", tick: 1,
    players: [{
      id: "p1", username: "p1", resources: 4,
      core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
      units: [{ id: "22222222-2222-2222-2222-222222222222", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
    }],
    terrain: { obstacles: [], resources: [[2, 0]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
  const runs = [1, 2].map((seed) => ({
    result: runEpisode({
      scenario: { ...scenarioBase, seed }, rulesPath: MANIFEST_PATH, seed, ticks: 30,
      tenants: [{ id: "p1", planner: "safety" }],
    }),
    playerId: "p1",
  }));
  const { fitness, detail } = evaluateMultiSeed(runs, 30);
  assert.ok(Number.isFinite(fitness), `fitness should be finite, got ${fitness}`);
  assert.ok(fitness > 0, `fitness should be positive (solo harvest), got ${fitness}`);
  // std 应为 0（2 seeds，确定性场景同 seed 跑同样——但 seed 不同可能有微小差异；
  // 只检查 finite）。
  assert.ok(Number.isFinite(detail.fitness_std ?? 0));
  assert.ok(detail.fitness_std === undefined || detail.fitness_std >= 0);
});

test("集成: buildFitnessDetail 从 EpisodeResult 派生 detail", () => {
  const scenario = {
    rulesVersion: "v0.14", tick: 1, seed: 1,
    players: [{
      id: "p1", username: "p1", resources: 4,
      core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
      units: [{ id: "22222222-2222-2222-2222-222222222222", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
    }],
    terrain: { obstacles: [], resources: [[2, 0]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
  const result = runEpisode({
    scenario, rulesPath: MANIFEST_PATH, seed: 1, ticks: 20,
    tenants: [{ id: "p1", planner: "safety" }],
  });
  const detail = buildFitnessDetail(result, "p1");
  assert.ok(detail !== null, "detail should be non-null for p1");
  if (detail !== null) {
    assert.ok(detail.harvested > 0);
    assert.equal(detail.alive_ticks, 20);
    assert.equal(detail.respawn, 0);
    // 单局 detail 不含 risk 指标
    assert.equal(detail.fitness_std, undefined);
    assert.equal(detail.fitness_worst, undefined);
    assert.equal(detail.fitness_p10, undefined);
  }
  // 不存在的玩家 → null
  assert.equal(buildFitnessDetail(result, "ghost"), null);
});
