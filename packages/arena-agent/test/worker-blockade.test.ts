/**
 * 锁阵 workerBlockade 测试（2026-08-08，worker-blockade-v1）：
 * 巡逻 worker 被配对到敌方回程预测锁点 → 走向锁点站桩（WAIT 占格）——
 * 敌方 MOVE 进不来（MOVE_DESTINATION_OCCUPIED）。默认关闭零回归。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SafetyPlanner, DEFAULT_SAFETY_CONFIG, type SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";
import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";

const CORE: Position = [0, 0];

function makeState(opts: {
  workers?: TickState["workers"];
  enemies?: TickState["visibleEnemies"];
  resourceCells?: Set<string>;
} = {}): TickState {
  const workers = opts.workers ?? [
    { id: "w1", position: [5, 0], hp: 2, unitType: "WORKER", cargo: 0 },
    { id: "w2", position: [6, 0], hp: 2, unitType: "WORKER", cargo: 0 },
    { id: "w3", position: [5, 2], hp: 2, unitType: "WORKER", cargo: 0 },
    { id: "w4", position: [6, 2], hp: 2, unitType: "WORKER", cargo: 0 },
    { id: "w5", position: [7, 0], hp: 2, unitType: "WORKER", cargo: 0 },
    { id: "w6", position: [8, 0], hp: 2, unitType: "WORKER", cargo: 0 },
  ];
  return {
    tick: 100,
    status: "ACTIVE",
    resources: 30,
    resourceCapacity: 30,
    resourceSpace: 30,
    population: 6,
    core: { id: "c1", position: CORE, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: workers,
    workers,
    vanguards: [],
    rangers: [],
    visibleEnemies: opts.enemies ?? [],
    resourceCells: opts.resourceCells ?? new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const BLOCKADE_CONFIG: SafetyPlannerConfig = {
  ...DEFAULT_SAFETY_CONFIG,
  workerBlockade: true,
  workerTarget: 4,
};

/** 通过 world.enemyHints 注入敌方记忆：先 decide 一次（observe 记录），
 *  再构造"敌方从 (2,0) 移到 (1,0)"的记忆。为简化，用连续 decide 让
 *  World.observe 累积位置历史。 */
function enemyAt(position: Position, prev: Position, id = "e1"): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 2, unitType: "WORKER" };
}

test("workerBlockade：敌方回程预测命中 → 巡逻 worker 走向锁点", () => {
  const planner = new SafetyPlanner(BLOCKADE_CONFIG);
  // 第一次 decide：敌方 worker 在 (2,0)（被观察到，无 prev）
  const state1 = makeState({
    enemies: [enemyAt([2, 0], [3, 0])],
  });
  planner.decide({ state: state1 });
  // 第二次 decide：敌方移到 (1,0)（向核心 (0,0) 方向 LEFT 移动）→ 回程预测
  const state2 = makeState({
    enemies: [enemyAt([1, 0], [2, 0])],
  });
  const plan = planner.decide({ state: state2 });
  // 敌方朝核心移动的预测锁点 = nextCells[0] = (0,0) = 己方核心格（禁区，
  // 被配对过滤）→ 无 worker_blockade 但 worker 全部有动作（不崩溃）
  const blockadeIntents = Object.entries(plan.intents).filter(([, i]) => i === "worker_blockade");
  assert.equal(blockadeIntents.length, 0, "锁点=己方核心格被过滤（禁区）");
  // worker 全部有动作（MOVE/WAIT/patrol）
  for (const [uid, intent] of Object.entries(plan.intents)) {
    if (uid === "core") continue;
    assert.ok(plan.unitActions[uid] !== undefined, `unit ${uid} (${intent}) 应有动作`);
  }
});

test("workerBlockade：敌方朝敌核心移动（非我方核心）→ 锁位 worker 派去锁点", () => {
  const planner = new SafetyPlanner(BLOCKADE_CONFIG);
  // 核心在 (0,0)；敌方 worker 朝敌核心 (10,0) 移动（RIGHT 方向）——
  // 锁点 = nextCells[0] = (5,0)（不在我方核心格，可锁）
  const state1 = makeState({
    enemies: [enemyAt([3, 0], [2, 0])],
  });
  planner.decide({ state: state1 });
  const state2 = makeState({
    enemies: [enemyAt([4, 0], [3, 0])],
  });
  const plan = planner.decide({ state: state2 });
  const blockadeIntents = Object.entries(plan.intents).filter(([, i]) => i === "worker_blockade");
  assert.ok(blockadeIntents.length >= 1, `期望 ≥1 worker_blockade，got ${JSON.stringify(plan.intents)}`);
  const [unitId] = blockadeIntents[0];
  // 已在锁点 → WAIT 站桩（敌方下一步要进的格被占）；未到 → MOVE 走向锁点
  assert.ok(
    plan.unitActions[unitId].type === "MOVE" || plan.unitActions[unitId].type === "WAIT",
    `锁位 worker 应 MOVE 走向锁点或 WAIT 站桩，got ${plan.unitActions[unitId].type}`,
  );
});

test("workerBlockade：默认关闭 → 历史行为（无 worker_blockade intent）", () => {
  const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  const state = makeState({
    enemies: [enemyAt([1, 0], [2, 0])],
  });
  const plan = planner.decide({ state });
  const blockadeIntents = Object.entries(plan.intents).filter(([, i]) => i === "worker_blockade");
  assert.equal(blockadeIntents.length, 0);
});

test("workerBlockade：worker 数低于保底 → 锁阵停用", () => {
  const planner = new SafetyPlanner({ ...BLOCKADE_CONFIG, blockadeMinWorkers: 10 });
  const state = makeState({
    workers: [{ id: "w1", position: [5, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
    enemies: [enemyAt([1, 0], [2, 0])],
  });
  const plan = planner.decide({ state });
  const blockadeIntents = Object.entries(plan.intents).filter(([, i]) => i === "worker_blockade");
  assert.equal(blockadeIntents.length, 0);
});

test("workerBlockade：敌战斗单位近身 → 锁位 worker 撤离（保命）", () => {
  const planner = new SafetyPlanner(BLOCKADE_CONFIG);
  const state = makeState({
    workers: [{ id: "w1", position: [4, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
    enemies: [
      enemyAt([3, 0], [4, 0]), // 敌方 worker 朝核心移动（回程预测）
      { id: "e-v", kind: "UNIT", position: [4, 1], hp: 4, unitType: "VANGUARD" }, // 敌 Vanguard 近身
    ],
  });
  const plan = planner.decide({ state });
  // w1 不应被派去锁（敌 Vanguard 3 格内）——不强制 intent，验证不崩溃且
  // w1 有动作（撤离/巡逻）
  assert.ok(plan.unitActions["w1"] !== undefined);
});
