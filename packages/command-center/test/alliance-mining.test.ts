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
