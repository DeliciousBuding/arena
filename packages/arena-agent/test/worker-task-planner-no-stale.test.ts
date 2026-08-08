/**
 * worker-task-planner 追空矿冻结修复测试（2026-08-08，t4 生产实证）：
 * worker 已在某格但该矿当前不可见（memory/seed，visible=false——矿 2-6 tick
 * 相位消失）时，不得继续分配该格——否则 GO_RESOURCE 恒 WAIT 永久冻结
 * （t4 3 worker 全部 WAIT+GO_RESOURCE、res=0 连续 100+ tick）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { WorkerTaskPlanner } from "../src/planning/worker-task-planner.ts";
import type { PlanningSnapshot, PlanningUnit } from "../src/planning/planning-snapshot.ts";
import type { Position } from "../src/domain/model.ts";

function unit(id: string, position: Position, cargo = 0): PlanningUnit {
  return { id, unitType: "WORKER", position, hp: 4, cargo };
}

function snapshot(units: PlanningUnit[], cells: [string, { visible?: boolean }][]): PlanningSnapshot {
  return {
    tick: 1,
    resources: 5,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: units.length,
    units,
    resourceCells: new Map(cells.map(([key, info]) => {
      const [x, y] = key.split(",").map(Number);
      return [key, { position: [x!, y!], visible: info.visible ?? true, lastSeenTick: 1, seeded: info.visible === false }];
    })),
    obstacleCells: new Set(),
    enemyCells: new Set(),
    enemyUnits: [],
    corePosition: [0, 0],
    coreHp: 5,
    coreState: "NORMAL",
    beacon: { position: [0, 0], status: "GROUND", carrierId: null },
    threatMap: new Map(),
  };
}

test("追空矿：worker 已在不可见矿格 → 该格不再分配（释放回巡逻）", () => {
  const planner = new WorkerTaskPlanner();
  // w1 在 [5,5]（不可见 seed 矿上）；w2 在 [10,10]；可见矿 [20,20]
  const snap = snapshot(
    [unit("w1", [5, 5]), unit("w2", [10, 10])],
    [["5,5", { visible: false }], ["20,20", { visible: true }]],
  );
  const { assignments } = planner.plan(snap);
  const w1 = assignments.find((a) => a.unitId === "w1");
  const w2 = assignments.find((a) => a.unitId === "w2");
  // w1 不得被派到 [5,5]（释放）
  assert.ok(!(w1 && w1.task.type === "GO_RESOURCE" && w1.task.targetCellKey === "5,5"),
    `w1 不得追空矿 [5,5]，实际 ${JSON.stringify(w1)}`);
  // w2 应被派到可见矿 [20,20]
  assert.ok(w2 && w2.task.type === "GO_RESOURCE" && w2.task.targetCellKey === "20,20",
    `w2 应采可见矿 [20,20]，实际 ${JSON.stringify(w2)}`);
});

test("可见矿正常：worker 在可见矿格 → 强制 HARVEST_CURRENT", () => {
  const planner = new WorkerTaskPlanner();
  const snap = snapshot([unit("w1", [7, 7])], [["7,7", { visible: true }]]);
  const { assignments } = planner.plan(snap);
  const w1 = assignments.find((a) => a.unitId === "w1");
  assert.ok(w1 && w1.task.type === "HARVEST_CURRENT", `可见矿格应强制采集，实际 ${JSON.stringify(w1)}`);
});

test("全不可见：无可见矿时 worker 不被派空矿（释放）", () => {
  const planner = new WorkerTaskPlanner();
  const snap = snapshot(
    [unit("w1", [5, 5]), unit("w2", [6, 6])],
    [["5,5", { visible: false }], ["6,6", { visible: false }]],
  );
  const { assignments } = planner.plan(snap);
  for (const a of assignments) {
    assert.ok(a.task.type !== "GO_RESOURCE", `不可见矿不应分配 GO_RESOURCE，实际 ${JSON.stringify(a)}`);
  }
});
