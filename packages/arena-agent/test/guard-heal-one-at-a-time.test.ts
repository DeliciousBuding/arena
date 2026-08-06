/**
 * B8 one-at-a-time 测试（2026-08-07，竞品 strategy.md "one wounded
 * non-assault defender at a time" 对照）：同类型守卫同时最多 1 个处于
 * 回修流程（防多守卫同时离位/同占 Core 格 → 防线真空）；满血释放名额。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

const CORE: Position = [0, 0];

interface Guard {
  id: string;
  position: Position;
  hp: number;
  unitType: "VANGUARD" | "RANGER";
}

function makeState(tick: number, guards: Guard[]): TickState {
  const units = guards.map((g) => ({ ...g, cargo: 0 }));
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: guards.length,
    core: { id: "c1", position: CORE, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units,
    workers: [],
    vanguards: guards.filter((g) => g.unitType === "VANGUARD").map((g) => ({ ...g, cargo: 0 })),
    rangers: guards.filter((g) => g.unitType === "RANGER").map((g) => ({ ...g, cargo: 0 })),
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const ROTATION_CONFIG = { ...DEFAULT_SAFETY_CONFIG, guardHealRotation: true };

test("one-at-a-time：双受伤 Vanguard 同时最多 1 个回修（第二个守位）", () => {
  const planner = new SafetyPlanner(ROTATION_CONFIG);
  const plan = planner.decide({
    state: makeState(1, [
      { id: "v1", position: [3, 0], hp: 2, unitType: "VANGUARD" },
      { id: "v2", position: [3, 1], hp: 2, unitType: "VANGUARD" },
    ]),
  });
  assert.equal(plan.intents["v1"], "guard_heal_return", "v1 先 decide → 回修");
  assert.notEqual(plan.intents["v2"], "guard_heal_return", "v2 检测到 v1 回修中 → 守位");
  assert.ok(plan.unitActions["v2"] === undefined || plan.unitActions["v2"].type === "MOVE", "v2 正常守位（非回修）");
});

test("one-at-a-time：先回修者满血 → 释放名额，另一个可回修", () => {
  const planner = new SafetyPlanner(ROTATION_CONFIG);
  planner.decide({
    state: makeState(1, [
      { id: "v1", position: [3, 0], hp: 2, unitType: "VANGUARD" },
      { id: "v2", position: [3, 1], hp: 2, unitType: "VANGUARD" },
    ]),
  });
  // tick2：v1 已满血（补血完成）→ 名额释放；v2 仍受伤 → 触发回修
  const plan = planner.decide({
    state: makeState(2, [
      { id: "v1", position: [3, 0], hp: 4, unitType: "VANGUARD" },
      { id: "v2", position: [3, 1], hp: 2, unitType: "VANGUARD" },
    ]),
  });
  assert.notEqual(plan.intents["v1"], "guard_heal_return", "v1 满血不回修");
  assert.equal(plan.intents["v2"], "guard_heal_return", "v2 获得名额回修");
});

test("one-at-a-time：Ranger 同样受限于同类型名额", () => {
  const planner = new SafetyPlanner(ROTATION_CONFIG);
  const plan = planner.decide({
    state: makeState(1, [
      { id: "r1", position: [3, 0], hp: 1, unitType: "RANGER" },
      { id: "r2", position: [3, 1], hp: 1, unitType: "RANGER" },
    ]),
  });
  assert.equal(plan.intents["r1"], "guard_heal_return", "r1 先 decide → 回修");
  assert.notEqual(plan.intents["r2"], "guard_heal_return", "r2 守位（r1 占用名额）");
});

test("one-at-a-time：不同类型守卫互不影响（Vanguard 回修不阻塞 Ranger）", () => {
  const planner = new SafetyPlanner(ROTATION_CONFIG);
  const plan = planner.decide({
    state: makeState(1, [
      { id: "v1", position: [3, 0], hp: 2, unitType: "VANGUARD" },
      { id: "r1", position: [3, 1], hp: 1, unitType: "RANGER" },
    ]),
  });
  assert.equal(plan.intents["v1"], "guard_heal_return");
  assert.equal(plan.intents["r1"], "guard_heal_return", "不同类型各自有名额");
});
