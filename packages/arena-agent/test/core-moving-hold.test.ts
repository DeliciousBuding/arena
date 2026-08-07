/** 核心迁移中交仓待命测试（2026-08-07，core-moving-hold-v1）：
 * 生产实测 t2/t3 手操迁移时 150 tick 内 DEPOSIT_FAILED 17/11 次
 * （CORE_MOVING/CORE_NOT_PRESENT）——cargo worker 追着移动核心交仓空跑：
 * 1. coreMovingHold=true + Core MOVING → cargo worker WAIT 持货，不 DEPOSIT；
 * 2. coreMovingHold=true + Core NORMAL → 正常交仓（DEPOSIT/MOVE），零回归；
 * 3. coreMovingHold=false（默认）→ 历史行为（MOVING 也照常决策），零回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, UnitSnapshot, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

function makeState(tick: number, coreState: "NORMAL" | "MOVING", workerPos: Position, cargo: number): TickState {
  const worker: UnitSnapshot = { id: "w01", position: workerPos, hp: 2, unitType: "WORKER", cargo };
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: coreState, ownerUsername: "p1" },
    units: [worker],
    workers: [worker],
    vanguards: [],
    rangers: [],
    visibleEnemies: [] as VisibleEntity[],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

function holdConfig() {
  return { ...DEFAULT_SAFETY_CONFIG, coreMovingHold: true };
}

test("core-moving-hold：Core MOVING + cargo → worker WAIT 持货（不追交）", () => {
  const planner = new SafetyPlanner(holdConfig());
  const plan = planner.decide({ state: makeState(1, "MOVING", [0, 0], 1) });
  const action = plan.unitActions["w01"];
  assert.equal(action.type, "WAIT", `MOVING 中 cargo worker 应 WAIT，实际 ${JSON.stringify(action)}`);
  assert.equal(plan.intents?.["w01"], "worker_hold_cargo_moving");
});

test("core-moving-hold：Core NORMAL + cargo → 正常交仓（DEPOSIT）", () => {
  const planner = new SafetyPlanner(holdConfig());
  const plan = planner.decide({ state: makeState(1, "NORMAL", [0, 0], 1) });
  const action = plan.unitActions["w01"];
  assert.equal(action.type, "DEPOSIT", `NORMAL 中核心格 cargo worker 应 DEPOSIT，实际 ${JSON.stringify(action)}`);
});

test("core-moving-hold：Core MOVING + cargo 不在核心格 → WAIT（不追着移动核心跑）", () => {
  const planner = new SafetyPlanner(holdConfig());
  const plan = planner.decide({ state: makeState(1, "MOVING", [5, 0], 1) });
  const action = plan.unitActions["w01"];
  assert.equal(action.type, "WAIT", `MOVING 中远离核心的 cargo worker 应 WAIT（不追），实际 ${JSON.stringify(action)}`);
});

test("core-moving-hold：变体关闭（默认）→ MOVING 中照常决策（零回归）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG });
  const plan = planner.decide({ state: makeState(1, "MOVING", [5, 0], 1) });
  const action = plan.unitActions["w01"];
  // 历史行为：cargo worker 不在核心格 → 向 core 移动（return_home）
  assert.equal(action.type, "MOVE", `变体关闭 MOVING 中应照常 return_home，实际 ${JSON.stringify(action)}`);
});
