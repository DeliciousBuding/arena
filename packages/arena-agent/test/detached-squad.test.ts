/**
 * 远端突击组局部响应测试（2026-08-07，B5 竞品 detached squad response 对照）：
 * detachedSquadResponse——aggressive 突击单位前压时，敌**非目标**战斗单位
 * 进入 5 格局部响应半径 = 被拦截：释放旧任务、回 Core 守位至少 8 tick
 * （防抖动记忆），Core 不迁移；返回期间邻接敌仍 SWEEP 反击。
 * 默认关闭零回归；开启时仅在"非目标敌进入 5 格"触发。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

const CORE: Position = [0, 0];
const ENEMY_CORE: Position = [20, 0];

function enemyUnit(id: string, position: Position): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 2, unitType: "VANGUARD" };
}

function enemyCore(): VisibleEntity {
  return { id: "ec", kind: "CORE", position: ENEMY_CORE, hp: 5, unitType: "VANGUARD" };
}

function makeState(tick: number, enemies: VisibleEntity[]): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: CORE, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    // aggressive 突击 Vanguard 在 [10,0]，敌 Core 在 [20,0]（攻坚目标）
    units: [{ id: "v1", position: [10, 0], hp: 4, unitType: "VANGUARD", cargo: 0 }],
    workers: [],
    vanguards: [{ id: "v1", position: [10, 0], hp: 4, unitType: "VANGUARD", cargo: 0 }],
    rangers: [],
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const PRESSURE_POLICY = {
  posture: "aggressive" as const,
  workerTarget: 6,
  militaryRatio: 0.4,
  focusRegion: null,
  attackPriority: "core" as const,
};

const DETACHED_CONFIG = { ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" as const, detachedSquadResponse: true };

test("detachedSquadResponse 默认关闭：拦截者进 5 格仍继续压力（历史行为零回归）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" as const });
  const plan = planner.decide({
    state: makeState(1, [enemyCore(), enemyUnit("e1", [13, 0])]),
    policy: PRESSURE_POLICY,
  });
  assert.equal(plan.intents["v1"], "vanguard_pressure", "默认无视拦截继续攻坚");
  assert.deepEqual(plan.unitActions["v1"], { type: "MOVE", direction: "RIGHT" });
});

test("detachedSquadResponse 开启：非目标敌进 5 格 → 释放任务回 Core", () => {
  const planner = new SafetyPlanner(DETACHED_CONFIG);
  const plan = planner.decide({
    state: makeState(1, [enemyCore(), enemyUnit("e1", [13, 0])]),
    policy: PRESSURE_POLICY,
  });
  assert.equal(plan.intents["v1"], "vanguard_detached_return");
  assert.deepEqual(plan.unitActions["v1"], { type: "MOVE", direction: "LEFT" }, "朝自家 Core 返回");
});

test("detachedSquadResponse 开启：拦截者在 5 格外 → 不误触发（继续压力）", () => {
  const planner = new SafetyPlanner(DETACHED_CONFIG);
  const plan = planner.decide({
    state: makeState(1, [enemyCore(), enemyUnit("e1", [16, 0])]),
    policy: PRESSURE_POLICY,
  });
  assert.equal(plan.intents["v1"], "vanguard_pressure", "6 格（>5）不算拦截");
});

test("detachedSquadResponse 开启：任务目标本身在 5 格内不算拦截（继续攻坚）", () => {
  // attackPriority core 时敌 Core 就是任务目标——贴近敌 Core 是攻坚不是被拦截
  const planner = new SafetyPlanner(DETACHED_CONFIG);
  const plan = planner.decide({
    state: makeState(1, [enemyCore()]),
    policy: PRESSURE_POLICY,
  });
  assert.equal(plan.intents["v1"], "vanguard_pressure", "敌 Core 是目标不算拦截者");
});

test("detachedSquadResponse 开启：拦截后敌消失 → 8 tick 内仍返回（防抖动记忆）", () => {
  const planner = new SafetyPlanner(DETACHED_CONFIG);
  planner.decide({ state: makeState(1, [enemyCore(), enemyUnit("e1", [13, 0])]), policy: PRESSURE_POLICY });
  // tick 5 仍在 8 tick 窗口内（returnUntil = 1+8 = 9），敌已消失 → 仍返回
  const plan = planner.decide({ state: makeState(5, [enemyCore()]), policy: PRESSURE_POLICY });
  assert.equal(plan.intents["v1"], "vanguard_detached_return", "敌人闪失不立刻取消返回（竞品 8-tick 语义）");
});

test("detachedSquadResponse 开启：8 tick 后敌消失 → 恢复前压", () => {
  const planner = new SafetyPlanner(DETACHED_CONFIG);
  planner.decide({ state: makeState(1, [enemyCore(), enemyUnit("e1", [13, 0])]), policy: PRESSURE_POLICY });
  // tick 10 > returnUntil 9 → 记忆过期，任务目标仍在 → 恢复压力
  const plan = planner.decide({ state: makeState(10, [enemyCore()]), policy: PRESSURE_POLICY });
  assert.equal(plan.intents["v1"], "vanguard_pressure");
});

test("detachedSquadResponse 开启：返回期间邻接敌 → SWEEP 反击优先", () => {
  const planner = new SafetyPlanner(DETACHED_CONFIG);
  planner.decide({ state: makeState(1, [enemyCore(), enemyUnit("e1", [13, 0])]), policy: PRESSURE_POLICY });
  // tick 5 仍在返回窗口，但邻接出现敌 → SWEEP（反击优先，不回 Core）
  const plan = planner.decide({ state: makeState(5, [enemyCore(), enemyUnit("e2", [9, 0])]), policy: PRESSURE_POLICY });
  assert.deepEqual(plan.unitActions["v1"], { type: "SWEEP", direction: "LEFT" });
});
