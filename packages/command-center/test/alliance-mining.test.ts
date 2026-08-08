/**
 * 联盟级采矿分工测试（2026-08-08）：
 * - 就近分配：同格多观测 → 离核心最近者；
 * - shared/conflict 标记 + 跨租户去重（同格只分配一次）；
 * - 无观测者/无核心 → unassigned；
 * - perTenant 聚合（assigned/avgDistance/workers）；
 * - buildObserversByCell 分组。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assignAllianceMining, buildObserversByCell } from "../lib/alliance-mining.ts";

test("alliance-mining: 就近分配 + shared/conflict + 去重", () => {
  const cores: Partial<Record<string, [number, number] | null>> = {
    t1: [0, 0], t2: [10, 0], t3: [0, 10], t4: null,
  };
  const workers: Partial<Record<string, number | null>> = { t1: 3, t2: 5, t3: 0, t4: 0 };
  const candidatesByTenant: Record<string, Array<{ cell: string; x: number; y: number; lastSeenTick: number | null }>> = {
    // (1,0)：t1 与 t2 都可见未开采 → 观察者 t1,t2 → 就近 t1（dist1 vs 9）
    t1: [{ cell: "1,0", x: 1, y: 0, lastSeenTick: 100 }],
    // (5,0)：t2 独占候选 → t2（dist5）
    t2: [{ cell: "5,0", x: 5, y: 0, lastSeenTick: 200 }, { cell: "1,0", x: 1, y: 0, lastSeenTick: 100 }],
    // (0,5)：t3 独占但 t3 core (0,10) dist5 → t3
    t3: [{ cell: "0,5", x: 0, y: 5, lastSeenTick: 300 }],
    // (9,9)：t4 候选但 t4 core=null → unassigned
    t4: [{ cell: "9,9", x: 9, y: 9, lastSeenTick: 400 }],
  };
  const observersByCell: Record<string, string[]> = {
    "1,0": ["t1", "t2"], "5,0": ["t2"], "0,5": ["t3"], "9,9": ["t4"],
  };
  const conflictCells = new Set(["0,5"]);
  const a = assignAllianceMining(cores, workers, candidatesByTenant, observersByCell, conflictCells);

  assert.equal(a.global.totalCandidates, 4, "t1 1 + t2 2 + t3 1");
  assert.equal(a.global.assigned, 3, "1,0 去重只算一次；9,9 无观测核心未分配");
  assert.equal(a.global.shared, 1, "1,0 双观测");
  assert.equal(a.global.conflict, 1, "0,5 冲突格");
  assert.equal(a.global.unassigned, 1, "9,9 无核心");

  const c10 = a.assignments.find((x) => x.cell === "1,0");
  assert.equal(c10?.assignedTenant, "t1", "t1 更近");
  assert.equal(c10?.shared, true);
  assert.deepEqual(c10?.observers, ["t1", "t2"]);
  assert.equal(c10?.distanceToCore, 1);

  const c50 = a.assignments.find((x) => x.cell === "5,0");
  assert.equal(c50?.assignedTenant, "t2");
  assert.equal(c50?.distanceToCore, 5);

  const c05 = a.assignments.find((x) => x.cell === "0,5");
  assert.equal(c05?.assignedTenant, "t3");
  assert.equal(c05?.conflict, true);

  assert.equal(a.perTenant.t1?.assigned, 1);
  assert.equal(a.perTenant.t2?.assigned, 1);
  assert.equal(a.perTenant.t3?.assigned, 1);
  assert.equal(a.perTenant.t4?.assigned, 0);
  assert.equal(a.perTenant.t1?.avgDistance, 1);
  assert.equal(a.perTenant.t3?.avgDistance, 5);
  assert.equal(a.perTenant.t1?.workers, 3);
  assert.equal(a.unassigned.length, 1);
  assert.equal(a.unassigned[0]?.cell, "9,9");
});

test("alliance-mining: gapAge 积压优先排序 + 刷新预测字段", () => {
  const cores: Partial<Record<string, [number, number] | null>> = { t1: [0, 0], t2: [50, 0] };
  const workers: Partial<Record<string, number | null>> = { t1: 3, t2: 3 };
  // 两个候选都离 t1 近；但 (9,0) 积压更久（gapAge 9000）应排前
  const candidatesByTenant: Record<string, Array<{ cell: string; x: number; y: number; lastSeenTick: number | null }>> = {
    t1: [
      { cell: "9,0", x: 9, y: 0, lastSeenTick: 1000 },   // gapAge 9000
      { cell: "3,0", x: 3, y: 0, lastSeenTick: 9000 },   // gapAge 1000
    ],
  };
  const metaByCell: Record<string, { gapAgeTicks: number | null; predictedNextTick: number | null; dueInTicks: number | null }> = {
    "9,0": { gapAgeTicks: 9000, predictedNextTick: 12000, dueInTicks: 3000 },
    "3,0": { gapAgeTicks: 1000, predictedNextTick: null, dueInTicks: null },
  };
  const a = assignAllianceMining(cores, workers, candidatesByTenant, { "9,0": ["t1"], "3,0": ["t1"] }, new Set(), metaByCell);
  assert.equal(a.assignments.length, 2);
  assert.equal(a.assignments[0].cell, "9,0", "gapAge 大者排前（积压优先）");
  assert.equal(a.assignments[0].gapAgeTicks, 9000);
  assert.equal(a.assignments[0].predictedNextTick, 12000);
  assert.equal(a.assignments[0].dueInTicks, 3000);
  assert.equal(a.assignments[1].cell, "3,0");
  assert.equal(a.assignments[1].dueInTicks, null);
});

test("alliance-mining: 敌情威胁分级 threatLevel", () => {
  const cores: Partial<Record<string, [number, number] | null>> = { t1: [0, 0] };
  const workers: Partial<Record<string, number | null>> = { t1: 3 };
  const candidatesByTenant: Record<string, Array<{ cell: string; x: number; y: number; lastSeenTick: number | null }>> = {
    t1: [
      { cell: "1,1", x: 1, y: 1, lastSeenTick: 100 },   // bucket (0,0) combat 0 → 无威胁
      { cell: "17,17", x: 17, y: 17, lastSeenTick: 100 }, // bucket (1,1) combat 12 → 高威胁
      { cell: "20,20", x: 20, y: 20, lastSeenTick: 100 }, // bucket (1,1) 同桶
    ],
  };
  const heatByBucket: Record<string, { combatCount: number; count: number; lastTick: number }> = {
    "0,0": { combatCount: 0, count: 5, lastTick: 90 },
    "1,1": { combatCount: 12, count: 20, lastTick: 95 },
  };
  const a = assignAllianceMining(cores, workers, candidatesByTenant, { "1,1": ["t1"], "17,17": ["t1"], "20,20": ["t1"] }, new Set(), {}, heatByBucket);
  const byCell = Object.fromEntries(a.assignments.map((x) => [x.cell, x]));
  assert.equal(byCell["1,1"].threatLevel, 0);
  assert.equal(byCell["17,17"].threatLevel, 3, "combat 12 → 高威胁");
  assert.equal(byCell["17,17"].threatCombat, 12);
  assert.equal(byCell["20,20"].threatLevel, 3, "同桶共享威胁");
});

test("alliance-mining: buildObserversByCell 分组 + 空输入", () => {
  const m = buildObserversByCell([
    { tenant: "t1", x: 1, y: 2 },
    { tenant: "t2", x: 1, y: 2 },
    { tenant: "t3", x: 5, y: 5 },
    { tenant: "t1", x: 5, y: 5 },
  ]);
  assert.deepEqual(m["1,2"], ["t1", "t2"]);
  assert.deepEqual(m["5,5"], ["t3", "t1"]);
  const a = assignAllianceMining({}, {}, {}, {}, new Set());
  assert.equal(a.global.totalCandidates, 0);
  assert.equal(a.assignments.length, 0);
  assert.equal(a.unassigned.length, 0);
});
