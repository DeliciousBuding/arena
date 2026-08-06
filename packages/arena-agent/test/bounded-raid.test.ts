/**
 * 有界攻坚测试（2026-08-07，B6 竞品 "exceeds the bounded mission distance"
 * 对照）：boundedRaid——aggressive 敌 Core 记忆推进时，记忆位置距我方
 * Core 超上限（40 格 Chebyshev）= 远征送死 → 取消攻坚回 Core 守位；
 * 近距记忆/可见敌人不受影响。默认关闭零回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

function enemyCore(position: Position): VisibleEntity {
  return { id: "ec", kind: "CORE", position, hp: 5, unitType: "VANGUARD" };
}

function makeState(tick: number, enemies: VisibleEntity[]): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    // aggressive 远征 Vanguard 在 [50,0]（远离自家 Core）
    units: [{ id: "v1", position: [50, 0], hp: 4, unitType: "VANGUARD", cargo: 0 }],
    workers: [],
    vanguards: [{ id: "v1", position: [50, 0], hp: 4, unitType: "VANGUARD", cargo: 0 }],
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

const BOUNDED_CONFIG = { ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" as const, boundedRaid: true };

test("boundedRaid 默认关闭：远距记忆敌 Core 仍推进（历史行为零回归）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" as const });
  // tick1：敌 Core [60,0] 可见（v1 [50,0] 距 10——视野外？Vanguard 视野 4！
  // 需要敌 Core 先入记忆：tick1 放近处 [52,0]（v1 视野内 2 格）→ 记忆位置 [52,0]
  planner.decide({ state: makeState(1, [enemyCore([52, 0])]), policy: PRESSURE_POLICY });
  // tick2：无可见敌人 → memory 分支（记忆位置 [52,0] 距 p1 Core 52 > 40）
  const plan = planner.decide({ state: makeState(2, []), policy: PRESSURE_POLICY });
  assert.equal(plan.intents["v1"], "vanguard_pressure_memory", "默认无视距离继续推进");
  assert.deepEqual(plan.unitActions["v1"], { type: "MOVE", direction: "RIGHT" });
});

test("boundedRaid 开启：远距记忆敌 Core（>40 格）→ 取消攻坚回 Core", () => {
  const planner = new SafetyPlanner(BOUNDED_CONFIG);
  planner.decide({ state: makeState(1, [enemyCore([52, 0])]), policy: PRESSURE_POLICY });
  const plan = planner.decide({ state: makeState(2, []), policy: PRESSURE_POLICY });
  assert.equal(plan.intents["v1"], "vanguard_bounded_return");
  assert.deepEqual(plan.unitActions["v1"], { type: "MOVE", direction: "LEFT" }, "朝自家 Core 返回");
});

test("boundedRaid 开启：近距记忆敌 Core（≤40 格）→ 正常推进", () => {
  const planner = new SafetyPlanner(BOUNDED_CONFIG);
  // 敌 Core [52,0] 记忆距 p1 Core 52 > 40 → 但改近距场景：v1 [10,0]，敌 Core [12,0]（记忆距 Core 12 ≤40）
  const near = makeState(1, [enemyCore([12, 0])]);
  const nearState = {
    ...near,
    units: [{ id: "v1", position: [10, 0] as Position, hp: 4, unitType: "VANGUARD" as const, cargo: 0 }],
    vanguards: [{ id: "v1", position: [10, 0] as Position, hp: 4, unitType: "VANGUARD" as const, cargo: 0 }],
  };
  planner.decide({ state: nearState, policy: PRESSURE_POLICY });
  const plan = planner.decide({ state: makeState(2, []), policy: PRESSURE_POLICY });
  assert.equal(plan.intents["v1"], "vanguard_pressure_memory", "12 格（≤40）不算远征");
});

test("boundedRaid 开启：边界 40 格不触发（>40 才超限）", () => {
  const planner = new SafetyPlanner(BOUNDED_CONFIG);
  // v1 [38,0] 视野内敌 Core [40,0]（记忆距 p1 Core 恰好 40 = 上限）→ 不超限
  const boundary = makeState(1, [enemyCore([40, 0])]);
  const boundaryState = {
    ...boundary,
    units: [{ id: "v1", position: [38, 0] as Position, hp: 4, unitType: "VANGUARD" as const, cargo: 0 }],
    vanguards: [{ id: "v1", position: [38, 0] as Position, hp: 4, unitType: "VANGUARD" as const, cargo: 0 }],
  };
  planner.decide({ state: boundaryState, policy: PRESSURE_POLICY });
  const plan = planner.decide({ state: makeState(2, []), policy: PRESSURE_POLICY });
  assert.equal(plan.intents["v1"], "vanguard_pressure_memory", "40 格边界不触发");
});

test("boundedRaid 开启：可见敌人时不受影响（memory 分支仅在无敌人时）", () => {
  const planner = new SafetyPlanner(BOUNDED_CONFIG);
  // tick1 记忆远距敌 Core；tick2 有可见敌人 → pressure 目标（attackPriority core）
  planner.decide({ state: makeState(1, [enemyCore([52, 0])]), policy: PRESSURE_POLICY });
  const plan = planner.decide({ state: makeState(2, [enemyCore([49, 0])]), policy: PRESSURE_POLICY });
  assert.notEqual(plan.intents["v1"], "vanguard_bounded_return", "有可见敌人走正常 pressure");
  assert.ok(
    plan.intents["v1"] === "vanguard_pressure" || plan.intents["v1"] === "sweep",
    "邻接敌 SWEEP 反击优先，否则正常 pressure",
  );
});
