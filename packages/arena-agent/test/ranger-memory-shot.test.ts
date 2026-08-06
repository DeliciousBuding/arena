/**
 * Ranger 记忆射击测试（2026-08-07，B12 竞品 strategy.md "A strike Ranger
 * may also fire at the remembered cell of a confirmed stationary Core
 * during a short visibility gap" 对照）：aggressive Ranger 无可见目标时
 * 对"确认静止"（两次观察同位置）的敌 Core 记忆格 cell-fire；远距/非
 * 静止/可见目标优先均不触发。默认关闭零回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

function enemyCore(position: Position): VisibleEntity {
  return { id: "ec1", kind: "CORE", position, hp: 5, unitType: "VANGUARD" };
}

function enemyVanguard(position: Position): VisibleEntity {
  return { id: "e1", kind: "UNIT", position, hp: 4, unitType: "VANGUARD" };
}

function makeState(tick: number, rangerPosition: Position, enemies: VisibleEntity[]): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [{ id: "r1", position: rangerPosition, hp: 2, unitType: "RANGER", cargo: 0 }],
    workers: [],
    vanguards: [],
    rangers: [{ id: "r1", position: rangerPosition, hp: 2, unitType: "RANGER", cargo: 0 }],
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const AGGRESSIVE_POLICY = {
  posture: "aggressive" as const,
  workerTarget: 4,
  militaryRatio: 0.5,
  focusRegion: null,
  attackPriority: "core" as const,
};

const SHOT_CONFIG = { ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" as const, rangerMemoryShot: true };

test("rangerMemoryShot 默认关闭：无可见目标 + 敌 Core 记忆 → 不射击（零回归）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" as const });
  // tick1：Ranger [6,0] 见敌 Core [8,0]（2 格，同直线——写入记忆）
  planner.decide({ state: makeState(1, [6, 0], [enemyCore([8, 0])]), policy: AGGRESSIVE_POLICY });
  // tick2：敌 Core 消失（记忆还在，静止确认需两次观察——tick2 无新观察，
  // 记忆 prevPosition 仍是 undefined（tick1 初次）→ 非静止确认 → 不射击）
  const plan = planner.decide({ state: makeState(2, [6, 0], []), policy: AGGRESSIVE_POLICY });
  assert.notEqual(plan.intents["r1"], "ranger_memory_shot", "默认关闭不射击");
});

test("rangerMemoryShot 开启：确认静止敌 Core 记忆 + 射程内 → 记忆格 cell-fire", () => {
  const planner = new SafetyPlanner(SHOT_CONFIG);
  // tick1：Ranger [6,0] 见敌 Core [8,0]（初次观察）
  planner.decide({ state: makeState(1, [6, 0], [enemyCore([8, 0])]), policy: AGGRESSIVE_POLICY });
  // tick2：再次见敌 Core [8,0]（同位置 = 静止确认；prevPosition=[8,0] == position）
  planner.decide({ state: makeState(2, [6, 0], [enemyCore([8, 0])]), policy: AGGRESSIVE_POLICY });
  // tick3：敌 Core 消失（视野丢失）→ 射程内（2 格直线）→ 记忆格 cell-fire
  const plan = planner.decide({ state: makeState(3, [6, 0], []), policy: AGGRESSIVE_POLICY });
  assert.equal(plan.intents["r1"], "ranger_memory_shot");
  assert.deepEqual(plan.unitActions["r1"], { type: "SHOOT", targetId: null, expectedCell: [8, 0] });
});

test("rangerMemoryShot 开启：敌 Core 记忆超射程（>3 格）→ 不射击", () => {
  const planner = new SafetyPlanner(SHOT_CONFIG);
  // Ranger [6,0]，敌 Core [10,0]（4 格 >3）——静止确认后仍不可射击
  planner.decide({ state: makeState(1, [6, 0], [enemyCore([10, 0])]), policy: AGGRESSIVE_POLICY });
  planner.decide({ state: makeState(2, [6, 0], [enemyCore([10, 0])]), policy: AGGRESSIVE_POLICY });
  const plan = planner.decide({ state: makeState(3, [6, 0], []), policy: AGGRESSIVE_POLICY });
  assert.notEqual(plan.intents["r1"], "ranger_memory_shot", "4 格超射程不射击");
});

test("rangerMemoryShot 开启：敌 Core 非静止（两次观察位置不同）→ 不射击", () => {
  const planner = new SafetyPlanner(SHOT_CONFIG);
  planner.decide({ state: makeState(1, [6, 0], [enemyCore([8, 0])]), policy: AGGRESSIVE_POLICY });
  // tick2：敌 Core 移动 [9,0]（prevPosition=[8,0] != [9,0] = 非静止）
  planner.decide({ state: makeState(2, [6, 0], [enemyCore([9, 0])]), policy: AGGRESSIVE_POLICY });
  const plan = planner.decide({ state: makeState(3, [6, 0], []), policy: AGGRESSIVE_POLICY });
  assert.notEqual(plan.intents["r1"], "ranger_memory_shot", "移动中的 Core 不射击记忆");
});

test("rangerMemoryShot 开启：可见敌在射程 → 正常 shoot 优先（记忆射击不抢）", () => {
  const planner = new SafetyPlanner(SHOT_CONFIG);
  planner.decide({ state: makeState(1, [6, 0], [enemyCore([8, 0])]), policy: AGGRESSIVE_POLICY });
  planner.decide({ state: makeState(2, [6, 0], [enemyCore([8, 0])]), policy: AGGRESSIVE_POLICY });
  // tick3：可见 Vanguard [5,0] 在射程（1 格直线）→ 正常 shoot（aggressive 优先 WORKER，
  // 但 Vanguard 是唯一可见 → shoot 它）
  const plan = planner.decide({ state: makeState(3, [6, 0], [enemyVanguard([5, 0])]), policy: AGGRESSIVE_POLICY });
  assert.equal(plan.intents["r1"], "shoot", "可见目标优先于记忆射击");
  const action = plan.unitActions["r1"];
  assert.equal(action.type, "SHOOT");
  assert.equal(action.type === "SHOOT" ? action.targetId : null, "e1");
});
