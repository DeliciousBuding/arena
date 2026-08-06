/**
 * worker 遭遇撤离测试（2026-08-07，B10 竞品 "Scout And Observer
 * Response" 对照）：scoutEvade——空 worker 视野内（3 格）出现战斗单位
 * 时撤离回 Core（EVADE+RETURN 合一、敌占格硬块绕开），接触丢失后仍
 * 继续回 Core，到 Core 3 格内冷却 3 tick 再恢复。默认关闭零回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

function enemyVanguard(position: Position): VisibleEntity {
  return { id: "e1", kind: "UNIT", position, hp: 4, unitType: "VANGUARD" };
}

function enemyWorker(position: Position): VisibleEntity {
  return { id: "e2", kind: "UNIT", position, hp: 2, unitType: "WORKER" };
}

function makeState(tick: number, workerPosition: Position, enemies: VisibleEntity[]): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [{ id: "w1", position: workerPosition, hp: 2, unitType: "WORKER", cargo: 0 }],
    workers: [{ id: "w1", position: workerPosition, hp: 2, unitType: "WORKER", cargo: 0 }],
    vanguards: [],
    rangers: [],
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const EVADE_CONFIG = { ...DEFAULT_SAFETY_CONFIG, scoutEvade: true };

test("scoutEvade 默认关闭：worker 旁有战斗单位 → 正常巡逻（零回归）", () => {
  const planner = new SafetyPlanner();
  // worker [6,0] 远离 Core；敌 Vanguard [6,1]（相邻）——默认不撤离
  const plan = planner.decide({ state: makeState(1, [6, 0], [enemyVanguard([6, 1])]) });
  assert.notEqual(plan.intents["w1"], "worker_evade_return", "默认见敌不撤离");
});

test("scoutEvade 开启：视野内战斗单位 → 撤离回 Core（worker_evade_return）", () => {
  const planner = new SafetyPlanner(EVADE_CONFIG);
  // worker [6,0]，敌 Vanguard [6,1]（距离 1 ≤3）；Core [0,0] → 向左回
  const plan = planner.decide({ state: makeState(1, [6, 0], [enemyVanguard([6, 1])]) });
  assert.equal(plan.intents["w1"], "worker_evade_return");
  assert.deepEqual(plan.unitActions["w1"], { type: "MOVE", direction: "LEFT" });
});

test("scoutEvade 开启：战斗单位在 worker 与 Core 之间 → 绕开敌占格回 Core", () => {
  const planner = new SafetyPlanner(EVADE_CONFIG);
  // worker [6,0]，敌 Vanguard [5,0]（回 Core 直线上，视为硬块）→ 不走进敌格
  const plan = planner.decide({ state: makeState(1, [6, 0], [enemyVanguard([5, 0])]) });
  assert.equal(plan.intents["w1"], "worker_evade_return");
  const action = plan.unitActions["w1"];
  assert.equal(action.type, "MOVE");
  assert.notEqual(
    action.type === "MOVE" ? action.direction : null,
    "LEFT",
    "敌占格 [5,0] 为硬块——不走 LEFT 进敌格（垂直绕行）",
  );
});

test("scoutEvade 开启：敌方 WORKER 不触发（非战斗单位）", () => {
  const planner = new SafetyPlanner(EVADE_CONFIG);
  const plan = planner.decide({ state: makeState(1, [6, 0], [enemyWorker([6, 1])]) });
  assert.notEqual(plan.intents["w1"], "worker_evade_return", "敌方 WORKER 不是战斗单位");
});

test("scoutEvade 开启：视野外战斗单位（>3 格）不触发", () => {
  const planner = new SafetyPlanner(EVADE_CONFIG);
  const plan = planner.decide({ state: makeState(1, [6, 0], [enemyVanguard([6, 4])]) });
  assert.notEqual(plan.intents["w1"], "worker_evade_return", "4 格外不触发（worker 视野 3）");
});

test("scoutEvade 开启：接触丢失后仍继续回 Core（RETURN 持续），到 Core 3 格内冷却", () => {
  const planner = new SafetyPlanner(EVADE_CONFIG);
  // tick1：worker [10,0] 见敌 [10,1] → 撤离（persistent return flow）
  planner.decide({ state: makeState(1, [10, 0], [enemyVanguard([10, 1])]) });
  // tick2-6：敌人消失 → 持续回 Core（RETURN 不恢复旧巡逻）
  const plan2 = planner.decide({ state: makeState(2, [9, 0], []) });
  assert.equal(plan2.intents["w1"], "worker_evade_return", "接触丢失后继续回 Core");
  for (let tick = 3; tick <= 6; tick += 1) {
    const plan = planner.decide({ state: makeState(tick, [9 - (tick - 2), 0], []) });
    assert.equal(plan.intents["w1"], "worker_evade_return", `tick${tick} 仍回 Core`);
  }
  // tick7：到 Core 3 格内 → 冷却 3 tick（WAIT）
  const plan7 = planner.decide({ state: makeState(7, [3, 0], []) });
  assert.equal(plan7.intents["w1"], "worker_evade_cooldown", "到 Core 3 格内进入冷却");
  // tick8-9：冷却中（WAIT）
  assert.equal(planner.decide({ state: makeState(8, [3, 0], []) }).intents["w1"], "worker_evade_cooldown");
  assert.equal(planner.decide({ state: makeState(9, [3, 0], []) }).intents["w1"], "worker_evade_cooldown");
  // tick10：冷却到期 → 恢复巡逻（不再撤离意图）
  const plan10 = planner.decide({ state: makeState(10, [3, 0], []) });
  assert.notEqual(plan10.intents["w1"], "worker_evade_cooldown", "冷却结束恢复");
  assert.notEqual(plan10.intents["w1"], "worker_evade_return", "不再回 Core");
});
