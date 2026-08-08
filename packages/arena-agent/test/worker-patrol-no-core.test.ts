/**
 * worker 巡逻不穿核心格测试（2026-08-08，t3 振荡修复）：
 * 空载 worker 巡逻目标在核心对侧时，旧 stepToward 第一步会穿回核心格（生产格）
 * → 与 worker_clear_core_empty 交替振荡（t3 实证 pop 冻结 1、res 恒 5、
 * emergency_spawn_worker/worker_clear_core_empty 每 tick 互切 100+ tick）。
 * 修复：巡逻去目标点（target !== home）且空载时把核心格临时视为禁入，BFS 绕行。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, UnitSnapshot } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import { move } from "../src/domain/nav.ts";

function makeWorkerState(core: Position, workerPos: Position, beacon: Position): TickState {
  const worker: UnitSnapshot = { id: "w1", position: workerPos, hp: 4, unitType: "WORKER", cargo: 0 };
  return {
    tick: 1,
    status: "ACTIVE",
    resources: 5,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: core, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [worker],
    workers: [worker],
    vanguards: [],
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: beacon, status: "GROUND", carrierId: null },
    events: [],
  };
}

test("巡逻不穿核心格：worker 在东邻、巡逻目标在西南 → 第一步不进核心格", () => {
  const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  // beacon 在西侧 → 巡逻 base 方位 4（西）；index=0 初始方位 7 → 巡逻点西南
  const state = makeWorkerState([0, 0], [1, 0], [-1, 0]);
  const plan = planner.decide({ state });
  const action = plan.unitActions["w1"];
  assert.ok(action !== undefined, "worker 应有动作");
  if (action.type !== "MOVE") return; // 非移动分支（资源/回血等）不适用
  const next = move([1, 0], action.direction);
  assert.ok(
    !(next[0] === 0 && next[1] === 0),
    `worker 巡逻第一步不得进入核心格 [0,0]，实际 ${action.direction} -> ${JSON.stringify(next)}`,
  );
});

test("巡逻不穿核心格：核心格被禁不影响正常巡逻推进（方向有效）", () => {
  const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  const state = makeWorkerState([0, 0], [1, 0], [-1, 0]);
  const plan = planner.decide({ state });
  const action = plan.unitActions["w1"];
  assert.ok(action !== undefined);
  assert.equal(action.type, "MOVE", "空载无资源 worker 应巡逻移动，实际 " + JSON.stringify(action));
});

test("多 tick 振荡断链：worker 让位后巡逻连续 8 tick 不穿回核心格", () => {
  const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  let pos: Position = [1, 0]; // 核心东邻（让位后的位置）
  for (let t = 1; t <= 8; t += 1) {
    const state = makeWorkerState([0, 0], pos, [-1, 0]);
    const plan = planner.decide({ state });
    const action = plan.unitActions["w1"];
    assert.ok(action !== undefined, `tick ${t} worker 应有动作`);
    if (action.type !== "MOVE") {
      // 非移动分支（罕见）：允许，但位置不变则下一 tick 再判
      continue;
    }
    const next = move(pos, action.direction);
    assert.ok(
      !(next[0] === 0 && next[1] === 0),
      `tick ${t}: worker 巡逻不得穿回核心格 [0,0]，${action.direction} -> ${JSON.stringify(next)}`,
    );
    pos = next;
  }
});

test("巡逻不穿核心格：满载 worker 回核心卸货不受影响（cargo>0 不禁核心格）", () => {
  const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  const worker: UnitSnapshot = { id: "w1", position: [1, 0], hp: 4, unitType: "WORKER", cargo: 3 };
  const state: TickState = {
    tick: 1, status: "ACTIVE", resources: 5, resourceCapacity: 10, resourceSpace: 10, population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [worker], workers: [worker], vanguards: [], rangers: [],
    visibleEnemies: [], resourceCells: new Set(), obstacleCells: new Set(),
    beacon: { position: [-1, 0], status: "GROUND", carrierId: null }, events: [],
  };
  const plan = planner.decide({ state });
  const action = plan.unitActions["w1"];
  assert.ok(action !== undefined);
  // 满载 worker 应走向核心卸货（MOVE 回 home 或 DEPOSIT/WAIT），不受禁核心格影响
  if (action.type === "MOVE") {
    const next = move([1, 0], action.direction);
    assert.ok(
      next[0] === 0 && next[1] === 0,
      `满载 worker 应走向核心格 [0,0]，实际 ${action.direction} -> ${JSON.stringify(next)}`,
    );
  }
});
