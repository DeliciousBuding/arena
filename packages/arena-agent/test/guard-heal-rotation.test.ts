/**
 * 守卫轮换治疗测试（2026-08-07，B8 竞品 healing rotation 对照）：
 * guardHealRotation——defensive 守卫受伤（Vanguard ≤2/4、Ranger ≤1/2）且无
 * 反击压力时回 Core 补血；战斗中的守卫不回修（SWEEP/SHOOT 反击优先——C7）。
 * 默认关闭零回归；开启时仅在"受伤 + 无反击压力 + 不在 Core 格"触发。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

const CORE: Position = [0, 0];

function enemy(id: string, position: Position, unitType: "VANGUARD" | "RANGER" | "WORKER" = "VANGUARD"): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 2, unitType };
}

function makeState(
  unit: { id: string; position: Position; hp: number; unitType: "VANGUARD" | "RANGER" },
  enemies: VisibleEntity[] = [],
): TickState {
  const unitSnapshot = { ...unit, cargo: 0 };
  return {
    tick: 1,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: CORE, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [unitSnapshot],
    workers: [],
    vanguards: unit.unitType === "VANGUARD" ? [unitSnapshot] : [],
    rangers: unit.unitType === "RANGER" ? [unitSnapshot] : [],
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const ROTATION_CONFIG = { ...DEFAULT_SAFETY_CONFIG, guardHealRotation: true };

test("guardHealRotation 默认关闭：受伤守卫不回修（历史行为零回归）", () => {
  const planner = new SafetyPlanner();
  const plan = planner.decide({
    state: makeState({ id: "v1", position: [0, -1], hp: 2, unitType: "VANGUARD" }),
  });
  // 守位锚点 [0,-1]（homeCell index 0）已在位 → 无动作（历史行为）
  assert.equal(plan.unitActions["v1"], undefined);
});

test("guardHealRotation 开启：Vanguard 2hp 无反击压力 → 回 Core 补血", () => {
  const planner = new SafetyPlanner(ROTATION_CONFIG);
  const plan = planner.decide({
    state: makeState({ id: "v1", position: [3, 0], hp: 2, unitType: "VANGUARD" }),
  });
  assert.deepEqual(plan.unitActions["v1"], { type: "MOVE", direction: "LEFT" });
  assert.equal(plan.intents["v1"], "guard_heal_return");
});

test("guardHealRotation 开启：Vanguard 2hp 邻格有敌 → SWEEP 反击优先（不回修）", () => {
  const planner = new SafetyPlanner(ROTATION_CONFIG);
  const plan = planner.decide({
    state: makeState(
      { id: "v1", position: [3, 0], hp: 2, unitType: "VANGUARD" },
      [enemy("e1", [2, 0])],
    ),
  });
  assert.deepEqual(plan.unitActions["v1"], { type: "SWEEP", direction: "LEFT" }, "战斗中反击优先（C7）");
});

test("guardHealRotation 开启：Vanguard 满血或未过半 → 不回修", () => {
  const planner = new SafetyPlanner(ROTATION_CONFIG);
  // 守卫已在守位锚点 [0,-1]（homeCell index 0）——满血/轻伤时守位不动
  const full = planner.decide({
    state: makeState({ id: "v1", position: [0, -1], hp: 4, unitType: "VANGUARD" }),
  });
  assert.equal(full.unitActions["v1"], undefined, "满血不回修");
  const light = planner.decide({
    state: makeState({ id: "v1", position: [0, -1], hp: 3, unitType: "VANGUARD" }),
  });
  assert.equal(light.unitActions["v1"], undefined, "3/4 未过半不回修");
});

test("guardHealRotation 开启：Vanguard 已在 Core 格 → 主循环 HEAL 接管", () => {
  const planner = new SafetyPlanner(ROTATION_CONFIG);
  const plan = planner.decide({
    state: makeState({ id: "v1", position: [0, 0], hp: 2, unitType: "VANGUARD" }),
  });
  assert.deepEqual(plan.unitActions["v1"], { type: "HEAL" }, "到 Core 格后直接治疗");
});

test("guardHealRotation 开启：Ranger 1hp 无射程内敌 → 回 Core 补血", () => {
  const planner = new SafetyPlanner(ROTATION_CONFIG);
  const plan = planner.decide({
    state: makeState({ id: "r1", position: [3, 0], hp: 1, unitType: "RANGER" }),
  });
  assert.deepEqual(plan.unitActions["r1"], { type: "MOVE", direction: "LEFT" });
  assert.equal(plan.intents["r1"], "guard_heal_return");
});

test("guardHealRotation 开启：Ranger 1hp 有射程内敌 → SHOOT 优先（不回修）", () => {
  const planner = new SafetyPlanner(ROTATION_CONFIG);
  const plan = planner.decide({
    state: makeState(
      { id: "r1", position: [3, 0], hp: 1, unitType: "RANGER" },
      [enemy("e1", [6, 0])],
    ),
  });
  assert.equal(plan.unitActions["r1"]?.type, "SHOOT", "有射击目标先打（C7 反击优先）");
});

test("guardHealRotation 开启：Ranger 1hp 敌超射程 → 回修", () => {
  const planner = new SafetyPlanner(ROTATION_CONFIG);
  const plan = planner.decide({
    state: makeState(
      { id: "r1", position: [3, 0], hp: 1, unitType: "RANGER" },
      [enemy("e1", [8, 0])],
    ),
  });
  assert.deepEqual(plan.unitActions["r1"], { type: "MOVE", direction: "LEFT" });
  assert.equal(plan.intents["r1"], "guard_heal_return");
});

test("guardHealRotation 开启：aggressive 进攻单位不回修（守卫轮换仅 defensive）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive", guardHealRotation: true });
  const plan = planner.decide({
    state: makeState({ id: "v1", position: [3, 0], hp: 2, unitType: "VANGUARD" }),
  });
  // aggressive Vanguard 继续 pressure 攻坚（朝敌 Core 推进 MOVE），不回修
  assert.notEqual(plan.intents["v1"], "guard_heal_return");
  assert.notEqual(plan.unitActions["v1"]?.type, "HEAL", "不在 Core 格，未进入治疗");
});
