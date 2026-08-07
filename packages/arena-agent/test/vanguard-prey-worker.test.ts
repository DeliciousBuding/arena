/**
 * 清剿可见敌方 WORKER 测试（2026-08-08，vanguardPreyWorker，用户"挂机/落单
 * 单位赶紧打掉"）：aggressive Vanguard 对 12 格内可见敌 WORKER 优先追击
 * （白赚：断经济 + 无反击）；敌核心记忆 8 格内的 WORKER 不追（避守军）；
 * 默认关闭零回归。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SafetyPlanner, DEFAULT_SAFETY_CONFIG, type SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";
import type { Position, TickState } from "../src/domain/model.ts";

const CORE: Position = [0, 0];

function makeState(opts: { enemies?: TickState["visibleEnemies"]; coreHunt?: { position: Position }[] } = {}): TickState {
  return {
    tick: 100,
    status: "ACTIVE",
    resources: 30,
    resourceCapacity: 30,
    resourceSpace: 30,
    population: 3,
    core: { id: "c1", position: CORE, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [
      { id: "v1", position: [0, 1], hp: 4, unitType: "VANGUARD", cargo: 0 },
      { id: "v2", position: [0, 2], hp: 4, unitType: "VANGUARD", cargo: 0 },
      { id: "w1", position: [2, 0], hp: 2, unitType: "WORKER", cargo: 0 },
    ],
    workers: [{ id: "w1", position: [2, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
    vanguards: [
      { id: "v1", position: [0, 1], hp: 4, unitType: "VANGUARD", cargo: 0 },
      { id: "v2", position: [0, 2], hp: 4, unitType: "VANGUARD", cargo: 0 },
    ],
    rangers: [],
    visibleEnemies: opts.enemies ?? [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const PREY_CONFIG: SafetyPlannerConfig = {
  ...DEFAULT_SAFETY_CONFIG,
  aggression: "aggressive",
  vanguardPreyWorker: true,
};

test("vanguardPreyWorker：12 格内可见敌 WORKER → 最近 Vanguard 追击（白赚）", () => {
  const planner = new SafetyPlanner(PREY_CONFIG);
  // 敌 WORKER 在 (8,0)，距 v1 (0,1) = 9、v2 (0,2) = 10——都在 12 内
  const state = makeState({
    enemies: [{ id: "e-w", kind: "UNIT", position: [8, 0], hp: 2, unitType: "WORKER" }],
  });
  const plan = planner.decide({ state });
  // 至少一个 Vanguard 发出 vanguard_prey_worker（最近的 v1）
  const preyIntents = Object.entries(plan.intents).filter(([, i]) => i === "vanguard_prey_worker");
  assert.ok(preyIntents.length >= 1, "expected prey intent, got: " + JSON.stringify(plan.intents));
  const [unitId] = preyIntents[0];
  assert.equal(unitId, "v1"); // 最近的 Vanguard 去
  assert.equal(plan.unitActions[unitId].type, "MOVE");
});

test("vanguardPreyWorker：敌核心记忆 8 格内的 WORKER 不追（避守军）", () => {
  const planner = new SafetyPlanner(PREY_CONFIG);
  // 敌 WORKER 在 (8,0)，敌核心记忆在 (10,0)（Chebyshev 2 ≤ 8）→ 不追
  const state = makeState({
    enemies: [{ id: "e-w", kind: "UNIT", position: [8, 0], hp: 2, unitType: "WORKER" }],
  });
  // 播种敌核心记忆：先让 planner observe 一个含敌 CORE 的 state
  const withCore = makeState({
    enemies: [
      { id: "e-w", kind: "UNIT", position: [8, 0], hp: 2, unitType: "WORKER" },
      { id: "c-enemy", kind: "CORE", position: [10, 0], hp: 5, ownerUsername: "jerkman" },
    ],
  });
  planner.decide({ state: withCore }); // observe 记录敌核心记忆
  const plan = planner.decide({ state });
  const preyIntents = Object.entries(plan.intents).filter(([, i]) => i === "vanguard_prey_worker");
  assert.equal(preyIntents.length, 0, "should not chase near enemy core: " + JSON.stringify(plan.intents));
});

test("vanguardPreyWorker：默认关闭零回归（无 prey 意图）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" });
  const state = makeState({
    enemies: [{ id: "e-w", kind: "UNIT", position: [5, 0], hp: 2, unitType: "WORKER" }],
  });
  const plan = planner.decide({ state });
  const preyIntents = Object.entries(plan.intents).filter(([, i]) => i === "vanguard_prey_worker");
  assert.equal(preyIntents.length, 0);
});
test("vanguardPreyWorker：多个敌 WORKER 选最近的可猎（旧版 find-first 漏猎回归）", () => {
  const planner = new SafetyPlanner(PREY_CONFIG);
  // 列表第一个 WORKER 在 (40,40) 很远；第二个在 (8,0) 距 v1=9 可猎。
  // 旧版 enemies.find 取第一个 → 永远不追（BUG）；新版选最近 → v1 追击。
  const state = makeState({
    enemies: [
      { id: "e-far", kind: "UNIT", position: [40, 40], hp: 2, unitType: "WORKER" },
      { id: "e-near", kind: "UNIT", position: [8, 0], hp: 2, unitType: "WORKER" },
    ],
  });
  const plan = planner.decide({ state });
  const preyIntents = Object.entries(plan.intents).filter(([, i]) => i === "vanguard_prey_worker");
  assert.ok(preyIntents.length >= 1, "expected prey intent for near worker, got: " + JSON.stringify(plan.intents));
  const [unitId] = preyIntents[0];
  assert.equal(unitId, "v1");
});
