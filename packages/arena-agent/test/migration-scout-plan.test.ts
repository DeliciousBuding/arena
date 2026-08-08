/**
 * 勘探前向约束测试（migration-system-v1 §3.3，评审 P1）：
 * migrationScoutDirectionForPlan 读计划路径下一格方向持续前向探路，
 * 不再依赖 core 坐标差分触发；非 LEG_MOVE/无前进格 → null（fallback）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { migrationScoutDirectionForPlan } from "../src/planning/deterministic-planner.ts";
import type { MigrationPlanV1 } from "../src/migration/plan.ts";

function plan(state: MigrationPlanV1["state"], cells: readonly (readonly [number, number])[]): MigrationPlanV1 {
  return {
    schema: "migration-plan-v1",
    operationId: "op-scout-01",
    revision: 1,
    conductorEpoch: 0,
    tenant: "t1",
    mode: "migrate",
    state,
    core: { originCoreId: "uuid-A", currentCoreId: "uuid-A", generation: 1 },
    lease: { untilTick: 999999, heartbeatAt: "2026-08-08T22:00:00.000Z" },
    target: { x: 0, y: -30, reason: "test" },
    path: { cells, corridorWidth: 8, lookahead: 30 },
    legs: [
      {
        index: 0,
        from: { x: 0, y: 0 },
        to: { x: 0, y: -10 },
        audit: { ok: true, freshResources: 12, activeEnemyCores: 0 },
      },
    ],
    legProgress: { legIndex: 0, cellsThisLeg: 2 },
    pace: {
      policy: "adaptive",
      burstCells: 8,
      settleTarget: 60,
      minSettle: 30,
      maxSettle: 120,
      harvestRadius: 12,
    },
    roles: { quotas: { escort: 40, sweep: 30, scout: 15, rear: 15 }, seed: 1 },
    conductor: { pid: 1 },
    updatedAt: "2026-08-08T22:00:00.000Z",
  };
}

const PATH_UP: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, -1],
  [0, -2],
  [0, -3],
];

test("scout-plan: LEG_MOVE 核心 NORMAL → 朝路径下一格方向前向探路", () => {
  const dir = migrationScoutDirectionForPlan([3, 2], [0, 0], plan("LEG_MOVE", PATH_UP), new Set());
  assert.equal(dir, "UP"); // 路径前进方向 UP
});

test("scout-plan: 核心已在路径中段 → 跳过已走格，仍朝前向探路", () => {
  const dir = migrationScoutDirectionForPlan([5, 0], [0, -1], plan("LEG_MOVE", PATH_UP), new Set());
  assert.equal(dir, "UP"); // [0,-1] 之后仍是 UP
});

test("scout-plan: 非 LEG_MOVE（SETTLE/PLAN 等）→ null（fallback 巡逻）", () => {
  for (const state of ["LEG_SETTLE", "PLAN", "ABORT", "ARRIVED", "DEFENSIVE_HOLD"] as const) {
    assert.equal(migrationScoutDirectionForPlan([3, 2], [0, 0], plan(state, PATH_UP), new Set()), null, state);
  }
});

test("scout-plan: 路径已耗尽（核心在最后格）→ null", () => {
  assert.equal(
    migrationScoutDirectionForPlan([3, 2], [0, -3], plan("LEG_MOVE", PATH_UP), new Set()),
    null,
  );
});

test("scout-plan: 核心偏离路径（不相邻）→ null", () => {
  assert.equal(migrationScoutDirectionForPlan([3, 2], [10, 10], plan("LEG_MOVE", PATH_UP), new Set()), null);
});

test("scout-plan: worker 已在目标前方 → null", () => {
  // scoutRange 24：worker 恰在核心 UP 方向 24 格 = 目标点 → 不再移动
  assert.equal(migrationScoutDirectionForPlan([0, -24], [0, 0], plan("LEG_MOVE", PATH_UP), new Set()), null);
});
