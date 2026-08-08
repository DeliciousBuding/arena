/**
 * W57 双相轮换治疗测试（2026-08-09，竞品 arena_hero_strategy.py 两相 heal
 * rotation 对照）：guardHealRotationTwoPhase——将 v1 单相 hold-timer 升级为
 * patient（伤员占用治疗槽回修）+ relief（前伤员脱离危险血量后槽冷却，阻止
 * 下一个伤员立即冲入仍被占用的 Core 格）两相 FSM。默认关闭零回归；开启时
 * 复用 v1 的回修触发条件（HP 阈值/无反击压力/不在 Core 格），仅替换
 * one-at-a-time 槽管理为两相 FSM。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

const CORE: Position = [0, 0];

function enemy(id: string, position: Position, unitType: "VANGUARD" | "RANGER" | "WORKER" = "VANGUARD"): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 2, unitType };
}

interface Guard {
  id: string;
  position: Position;
  hp: number;
  unitType: "VANGUARD" | "RANGER";
}

function makeState(tick: number, guards: Guard[], enemies: VisibleEntity[] = []): TickState {
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
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

/** v2 配置：guardHealRotation + 双相 FSM，使用默认 patientPhaseTicks=12 /
 * reliefPhaseTicks=4。 */
const TWO_PHASE_CONFIG = {
  ...DEFAULT_SAFETY_CONFIG,
  guardHealRotation: true,
  guardHealRotationTwoPhase: true,
};
/** v2 配置 + 短 relief 冷却（1 tick），便于测试冷却到期释放槽。 */
const TWO_PHASE_SHORT_RELIEF = {
  ...DEFAULT_SAFETY_CONFIG,
  guardHealRotation: true,
  guardHealRotationTwoPhase: true,
  reliefPhaseTicks: 1,
};
/** v2 配置 + 短 patient 相（1 tick），便于测试 patient 超时强制转 relief。 */
const TWO_PHASE_SHORT_PATIENT = {
  ...DEFAULT_SAFETY_CONFIG,
  guardHealRotation: true,
  guardHealRotationTwoPhase: true,
  patientPhaseTicks: 1,
  reliefPhaseTicks: 1,
};

test("W57 默认关闭：guardHealRotationTwoPhase 未设 → 行为同 v1（零回归）", () => {
  // 仅开 guardHealRotation（v1 单相），不开 twoPhase → 走 v1 hold-timer 路径
  const v1Config = { ...DEFAULT_SAFETY_CONFIG, guardHealRotation: true };
  const planner = new SafetyPlanner(v1Config);
  const plan = planner.decide({
    state: makeState(1, [{ id: "v1", position: [3, 0], hp: 2, unitType: "VANGUARD" }]),
  });
  assert.equal(plan.intents["v1"], "guard_heal_return", "v1 路径仍触发回修");
  assert.deepEqual(plan.unitActions["v1"], { type: "MOVE", direction: "LEFT" });
});

test("W57 开启：单受伤 Vanguard → 认领 patient 相回 Core 补血", () => {
  const planner = new SafetyPlanner(TWO_PHASE_CONFIG);
  const plan = planner.decide({
    state: makeState(1, [{ id: "v1", position: [3, 0], hp: 2, unitType: "VANGUARD" }]),
  });
  assert.equal(plan.intents["v1"], "guard_heal_return", "patient 相认领 → 回修");
  assert.deepEqual(plan.unitActions["v1"], { type: "MOVE", direction: "LEFT" });
});

test("W57 开启：双受伤 Vanguard 同时 → patient 相 one-at-a-time（第二个守位）", () => {
  const planner = new SafetyPlanner(TWO_PHASE_CONFIG);
  const plan = planner.decide({
    state: makeState(1, [
      { id: "v1", position: [3, 0], hp: 2, unitType: "VANGUARD" },
      { id: "v2", position: [3, 1], hp: 2, unitType: "VANGUARD" },
    ]),
  });
  assert.equal(plan.intents["v1"], "guard_heal_return", "v1 先 decide → 认领 patient 相回修");
  assert.notEqual(plan.intents["v2"], "guard_heal_return", "v2 槽被 v1 占用 → 守位");
});

test("W57 开启：前伤员脱离危险血量（HP > 阈值）→ 转 relief 相，第二伤员仍被冷却阻塞", () => {
  const planner = new SafetyPlanner(TWO_PHASE_SHORT_RELIEF);
  // tick1：v1 认领 patient 相回修
  planner.decide({
    state: makeState(1, [
      { id: "v1", position: [3, 0], hp: 2, unitType: "VANGUARD" },
      { id: "v2", position: [3, 1], hp: 2, unitType: "VANGUARD" },
    ]),
  });
  // tick2：v1 脱离危险血量（HP 3 > 阈值 2）→ advance 转 relief 相（冷却 1 tick）；
  //   v2 仍受伤但槽在 relief 冷却中 → 守位（不认领）
  const plan = planner.decide({
    state: makeState(2, [
      { id: "v1", position: [3, 0], hp: 3, unitType: "VANGUARD" },
      { id: "v2", position: [3, 1], hp: 2, unitType: "VANGUARD" },
    ]),
  });
  assert.notEqual(plan.intents["v1"], "guard_heal_return", "v1 脱离危险血量不再回修");
  assert.notEqual(
    plan.intents["v2"],
    "guard_heal_return",
    "relief 冷却中 → v2 不认领（防冲入仍被 v1 占用的 Core 格）",
  );
});

test("W57 开启：relief 冷却到期 → 槽释放，下一个伤员可认领", () => {
  const planner = new SafetyPlanner(TWO_PHASE_SHORT_RELIEF);
  // tick1：v1 认领 patient 相
  planner.decide({
    state: makeState(1, [
      { id: "v1", position: [3, 0], hp: 2, unitType: "VANGUARD" },
      { id: "v2", position: [3, 1], hp: 2, unitType: "VANGUARD" },
    ]),
  });
  // tick2：v1 脱离危险血量 → relief 相（冷却 1 tick，phaseEndTick = 2+1 = 3）
  planner.decide({
    state: makeState(2, [
      { id: "v1", position: [3, 0], hp: 3, unitType: "VANGUARD" },
      { id: "v2", position: [3, 1], hp: 2, unitType: "VANGUARD" },
    ]),
  });
  // tick3：relief 冷却到期（tick 3 >= phaseEndTick 3）→ 槽释放；v2 仍受伤 → 认领
  const plan = planner.decide({
    state: makeState(3, [
      { id: "v1", position: [3, 0], hp: 4, unitType: "VANGUARD" },
      { id: "v2", position: [3, 1], hp: 2, unitType: "VANGUARD" },
    ]),
  });
  assert.equal(
    plan.intents["v2"],
    "guard_heal_return",
    "relief 冷却到期 → 槽释放 → v2 认领 patient 相回修",
  );
});

test("W57 开启：patient 相超时 → 强制转 relief（防伤员卡槽）", () => {
  const planner = new SafetyPlanner(TWO_PHASE_SHORT_PATIENT);
  // tick1：v1 认领 patient 相（patientPhaseTicks=1，phaseEndTick = 1+1 = 2）
  planner.decide({
    state: makeState(1, [
      { id: "v1", position: [3, 0], hp: 2, unitType: "VANGUARD" },
      { id: "v2", position: [3, 1], hp: 2, unitType: "VANGUARD" },
    ]),
  });
  // tick2：v1 仍受伤（HP 2，未脱离）但 patient 相超时（tick 2 >= phaseEndTick 2）
  //   → advance 强制转 relief；v2 仍受伤但槽在 relief 冷却 → 守位
  const plan = planner.decide({
    state: makeState(2, [
      { id: "v1", position: [3, 0], hp: 2, unitType: "VANGUARD" },
      { id: "v2", position: [3, 1], hp: 2, unitType: "VANGUARD" },
    ]),
  });
  assert.notEqual(
    plan.intents["v2"],
    "guard_heal_return",
    "patient 超时转 relief → v2 被冷却阻塞",
  );
  // tick3：relief 冷却到期（phaseEndTick = 2+1 = 3）→ 槽释放；v1 已满血不再
  //   认领，v2 仍受伤 → 认领 patient 相
  const plan2 = planner.decide({
    state: makeState(3, [
      { id: "v1", position: [3, 0], hp: 4, unitType: "VANGUARD" },
      { id: "v2", position: [3, 1], hp: 2, unitType: "VANGUARD" },
    ]),
  });
  assert.equal(
    plan2.intents["v2"],
    "guard_heal_return",
    "relief 冷却到期 → v1 满血不认领，v2 认领 patient 相",
  );
});

test("W57 开启：占用者阵亡 → 槽释放（无 stale 残留）", () => {
  const planner = new SafetyPlanner(TWO_PHASE_SHORT_PATIENT);
  // tick1：v1 认领 patient 相
  planner.decide({
    state: makeState(1, [{ id: "v1", position: [3, 0], hp: 2, unitType: "VANGUARD" }]),
  });
  // tick2：v1 已阵亡（不在 units 中）→ advance 清槽；v2 可认领
  const plan = planner.decide({
    state: makeState(2, [{ id: "v2", position: [3, 1], hp: 2, unitType: "VANGUARD" }]),
  });
  assert.equal(plan.intents["v2"], "guard_heal_return", "v1 阵亡槽释放 → v2 认领");
});

test("W57 开启：Ranger 同样工作（按类型独立槽）", () => {
  const planner = new SafetyPlanner(TWO_PHASE_CONFIG);
  const plan = planner.decide({
    state: makeState(1, [
      { id: "v1", position: [3, 0], hp: 2, unitType: "VANGUARD" },
      { id: "r1", position: [3, 1], hp: 1, unitType: "RANGER" },
    ]),
  });
  assert.equal(plan.intents["v1"], "guard_heal_return", "Vanguard 槽独立");
  assert.equal(plan.intents["r1"], "guard_heal_return", "Ranger 槽独立（不同类型不互斥）");
});

test("W57 开启：Vanguard 2hp 邻格有敌 → SWEEP 反击优先（不回修，同 v1）", () => {
  const planner = new SafetyPlanner(TWO_PHASE_CONFIG);
  const plan = planner.decide({
    state: makeState(
      1,
      [{ id: "v1", position: [3, 0], hp: 2, unitType: "VANGUARD" }],
      [enemy("e1", [2, 0])],
    ),
  });
  assert.deepEqual(plan.unitActions["v1"], { type: "SWEEP", direction: "LEFT" }, "反击优先（C7）");
  assert.notEqual(plan.intents["v1"], "guard_heal_return");
});

test("W57 开启：已在 Core 格 → 主循环 HEAL 接管（不重复 MOVE，同 v1）", () => {
  const planner = new SafetyPlanner(TWO_PHASE_CONFIG);
  const plan = planner.decide({
    state: makeState(1, [{ id: "v1", position: [0, 0], hp: 2, unitType: "VANGUARD" }]),
  });
  assert.deepEqual(plan.unitActions["v1"], { type: "HEAL" }, "到 Core 格直接治疗");
});

test("W57 开启：aggressive 进攻单位不回修（仅 defensive，同 v1）", () => {
  const planner = new SafetyPlanner({
    ...DEFAULT_SAFETY_CONFIG,
    aggression: "aggressive",
    guardHealRotation: true,
    guardHealRotationTwoPhase: true,
  });
  const plan = planner.decide({
    state: makeState(1, [{ id: "v1", position: [3, 0], hp: 2, unitType: "VANGUARD" }]),
  });
  assert.notEqual(plan.intents["v1"], "guard_heal_return", "aggressive 不走双相回修");
});
