/**
 * 远端军事回援测试（2026-08-07，竞品 "敌方战斗单位已经进入 Core 防区时，
 * 所有非守家单位跳过集结等待并立即回援" 对照）：remoteReinforce——可见敌方
 * 战斗单位（VANGUARD/RANGER，非 WORKER/CORE）进入 Core 防区（12）→ 远端
 * 军事（Vanguard/Ranger）立即回 Core 守位，优先于攻坚/打野/环搜；守家圈内
 * （≤4）单位走既有防御逻辑；触发后 8 tick 防抖动记忆。默认关闭零回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

const CORE: Position = [0, 0];
const ENEMY_CORE: Position = [30, 0];

function enemyVanguard(id: string, position: Position): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 4, unitType: "VANGUARD" };
}

function enemyRanger(id: string, position: Position): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 2, unitType: "RANGER" };
}

function enemyWorker(id: string, position: Position): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 2, unitType: "WORKER" };
}

function enemyCore(): VisibleEntity {
  return { id: "ec", kind: "CORE", position: ENEMY_CORE, hp: 5, unitType: "VANGUARD" };
}

/** 远端 Vanguard 在 [15,0]（正压向 30 格外的敌 Core），Ranger 在 [14,0]。 */
function makeState(tick: number, enemies: VisibleEntity[]): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 2,
    core: { id: "c1", position: CORE, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [
      { id: "v1", position: [15, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
      { id: "r1", position: [14, 0], hp: 2, unitType: "RANGER", cargo: 0 },
    ],
    workers: [],
    vanguards: [{ id: "v1", position: [15, 0], hp: 4, unitType: "VANGUARD", cargo: 0 }],
    rangers: [{ id: "r1", position: [14, 0], hp: 2, unitType: "RANGER", cargo: 0 }],
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

const REINFORCE_CONFIG = { ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" as const, remoteReinforce: true };

test("remoteReinforce 默认关闭：敌战斗单位进 12 格防区 → 远端 Vanguard 继续攻坚（零回归）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" as const });
  const plan = planner.decide({
    state: makeState(1, [enemyCore(), enemyVanguard("e1", [10, 0])]),
    policy: PRESSURE_POLICY,
  });
  assert.equal(plan.intents["v1"], "vanguard_pressure", "默认继续攻坚（记忆推进敌 Core）");
});

test("remoteReinforce 开启：敌 Vanguard 进 12 格防区 → 远端 Vanguard 回 Core 守位", () => {
  const planner = new SafetyPlanner(REINFORCE_CONFIG);
  // 敌 Vanguard [10,0] 距 Core 10 ≤12 → v1 [15,0] 向左回 Core
  const plan = planner.decide({
    state: makeState(1, [enemyCore(), enemyVanguard("e1", [10, 0])]),
    policy: PRESSURE_POLICY,
  });
  assert.equal(plan.intents["v1"], "vanguard_reinforce");
  assert.deepEqual(plan.unitActions["v1"], { type: "MOVE", direction: "LEFT" });
});

test("remoteReinforce 开启：敌在 12 格外 → 不触发回援（继续攻坚）", () => {
  const planner = new SafetyPlanner(REINFORCE_CONFIG);
  // 敌 Vanguard [13,0] 距 Core 13 >12 → v1 继续压向敌 Core
  const plan = planner.decide({
    state: makeState(1, [enemyCore(), enemyVanguard("e1", [13, 0])]),
    policy: PRESSURE_POLICY,
  });
  assert.equal(plan.intents["v1"], "vanguard_pressure", "13 格（>12）不算进防区");
});

test("remoteReinforce 开启：敌 WORKER 进 12 格 → 不触发回援（只认战斗单位）", () => {
  const planner = new SafetyPlanner(REINFORCE_CONFIG);
  const plan = planner.decide({
    state: makeState(1, [enemyCore(), enemyWorker("e1", [8, 0])]),
    policy: PRESSURE_POLICY,
  });
  assert.equal(plan.intents["v1"], "vanguard_pressure", "WORKER 不算军事威胁（断经济归 Ranger 管）");
});

test("remoteReinforce 开启：远端 Ranger 同样回援", () => {
  const planner = new SafetyPlanner(REINFORCE_CONFIG);
  // 敌 Vanguard 在 [-10,0]（距 Core 10 ≤12 触发回援）但距 Ranger [14,0] 24 格
  // （射程 3 外）→ 射击分支不拦截，走 ranger_reinforce 回 Core 守位
  const plan = planner.decide({
    state: makeState(1, [enemyCore(), enemyVanguard("e1", [-10, 0])]),
    policy: PRESSURE_POLICY,
  });
  assert.equal(plan.intents["r1"], "ranger_reinforce");
  assert.deepEqual(plan.unitActions["r1"], { type: "MOVE", direction: "LEFT" });
});

test("remoteReinforce 开启：Ranger 射程内能打到进防区敌 → 射击优先（shoot_cell）", () => {
  const planner = new SafetyPlanner(REINFORCE_CONFIG);
  // 敌 Vanguard [10,0] 逼近（预测下一格 [11,0]，距 Ranger [14,0] 3 格可射）→
  // 射击优先于回援（防御本来就要开火，不回跑）
  const plan = planner.decide({
    state: makeState(1, [enemyCore(), enemyVanguard("e1", [10, 0])]),
    policy: PRESSURE_POLICY,
  });
  assert.equal(plan.intents["r1"], "shoot_cell");
});

test("remoteReinforce 开启：回援后敌消失 → 8 tick 内仍回援（防抖动记忆）", () => {
  const planner = new SafetyPlanner(REINFORCE_CONFIG);
  planner.decide({
    state: makeState(1, [enemyCore(), enemyVanguard("e1", [10, 0])]),
    policy: PRESSURE_POLICY,
  });
  // tick 5 仍在 8 tick 窗口内（until = 1+8 = 9），敌已消失 → 仍回 Core
  const plan = planner.decide({ state: makeState(5, [enemyCore()]), policy: PRESSURE_POLICY });
  assert.equal(plan.intents["v1"], "vanguard_reinforce", "敌人闪失不立刻取消回援（竞品 8-tick 语义）");
});

test("remoteReinforce 开启：8 tick 后敌消失 → 恢复攻坚", () => {
  const planner = new SafetyPlanner(REINFORCE_CONFIG);
  planner.decide({
    state: makeState(1, [enemyCore(), enemyVanguard("e1", [10, 0])]),
    policy: PRESSURE_POLICY,
  });
  // tick 10 > until 9 → 记忆过期，任务目标仍在 → 恢复压力
  const plan = planner.decide({ state: makeState(10, [enemyCore()]), policy: PRESSURE_POLICY });
  assert.equal(plan.intents["v1"], "vanguard_pressure");
});

test("remoteReinforce 开启：返回期间邻接敌 → SWEEP 反击优先", () => {
  const planner = new SafetyPlanner(REINFORCE_CONFIG);
  planner.decide({
    state: makeState(1, [enemyCore(), enemyVanguard("e1", [10, 0])]),
    policy: PRESSURE_POLICY,
  });
  // tick 5 仍在回援窗口，但邻接出现敌 → SWEEP（反击优先，不回 Core）
  const plan = planner.decide({
    state: makeState(5, [enemyCore(), enemyVanguard("e2", [14, 0])]),
    policy: PRESSURE_POLICY,
  });
  assert.deepEqual(plan.unitActions["v1"], { type: "SWEEP", direction: "LEFT" });
});

test("remoteReinforce 开启：守家圈内（≤4）单位不触发回援（走既有防御）", () => {
  // 守家 Vanguard [3,0]（距 Core 3 ≤4）——敌进 12 格时不掉头，按既有
  // aggressive 防御逻辑处理（无邻接/射程内敌时维持守位）
  const planner = new SafetyPlanner(REINFORCE_CONFIG);
  const state: TickState = {
    tick: 1,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: CORE, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [{ id: "v1", position: [3, 0], hp: 4, unitType: "VANGUARD", cargo: 0 }],
    workers: [],
    vanguards: [{ id: "v1", position: [3, 0], hp: 4, unitType: "VANGUARD", cargo: 0 }],
    rangers: [],
    visibleEnemies: [enemyCore(), enemyVanguard("e1", [10, 0])],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
  const plan = planner.decide({ state, policy: PRESSURE_POLICY });
  assert.notEqual(plan.intents["v1"], "vanguard_reinforce", "守家圈内不触发远端回援");
});
