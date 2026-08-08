/**
 * VANGUARD 预判拦截测试（2026-08-08，vanguard-blockade-v1）：
 * 手操实战（t1 5198c451 锁敌方 worker）算法化——VANGUARD 预判敌方 worker
 * 前进路径站桩拦截（锁+收割一体：敌方撞上被卡 + 邻接 SWEEP 白打）。
 * 默认关闭零回归。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SafetyPlanner, DEFAULT_SAFETY_CONFIG, type SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";
import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";

const CORE: Position = [0, 0];

function makeState(opts: {
  vanguards?: TickState["vanguards"];
  enemies?: TickState["visibleEnemies"];
  resourceCells?: Set<string>;
} = {}): TickState {
  const vanguards = opts.vanguards ?? [
    { id: "v1", position: [5, 5], hp: 4, unitType: "VANGUARD", cargo: 0 },
    { id: "v2", position: [-5, -5], hp: 4, unitType: "VANGUARD", cargo: 0 },
  ];
  return {
    tick: 100,
    status: "ACTIVE",
    resources: 30,
    resourceCapacity: 30,
    resourceSpace: 30,
    population: 2,
    core: { id: "c1", position: CORE, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: vanguards,
    workers: [],
    vanguards,
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
  vanguardBlockade: true,
  aggression: "aggressive",
};

function enemyWorkerAt(position: Position, prev: Position, id = "e1"): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 2, unitType: "WORKER" };
}

test("vanguardBlockade：敌方 worker 直线移动 → Vanguard 被派往拦截点", () => {
  const planner = new SafetyPlanner(BLOCKADE_CONFIG);
  // 敌方 worker 从 (10,5) 向 (0,5) 移动（LEFT）——Vanguard v1 在 (5,5) 路径前方
  const state1 = makeState({
    enemies: [enemyWorkerAt([9, 5], [10, 5])],
  });
  planner.decide({ state: state1 });
  const state2 = makeState({
    enemies: [enemyWorkerAt([8, 5], [9, 5])],
  });
  const plan = planner.decide({ state: state2 });
  const blockadeIntents = Object.entries(plan.intents).filter(([, i]) => i === "vanguard_blockade");
  assert.ok(blockadeIntents.length >= 1, `期望 ≥1 vanguard_blockade，got ${JSON.stringify(plan.intents)}`);
  const [unitId] = blockadeIntents[0];
  assert.equal(unitId, "v1", "路径前方最近的 Vanguard 应被派去拦截");
  // 已在锁点 → WAIT 站桩；未到 → MOVE 走向锁点
  assert.ok(
    plan.unitActions[unitId].type === "MOVE" || plan.unitActions[unitId].type === "WAIT",
    `拦截手应 MOVE 走向拦截点或 WAIT 站桩，got ${plan.unitActions[unitId].type}`,
  );
});

test("vanguardBlockade：终点封锁降级——WORKER_INFER 锚点不派（中途拦截选点）", () => {
  const planner = new SafetyPlanner(BLOCKADE_CONFIG);
  // 敌方 (7,5) 沿 LEFT 移动 → WORKER_INFER 推断核心 (-1,5)（漂移锚点）
  // → 降级中途拦截：margin 选点 = 敌方路径上 Vanguard 能站住的格（v1 [5,5]
  // 在路径上 → 锁点 (5,5)，非推断核心入口）
  const state1 = makeState({
    enemies: [enemyWorkerAt([8, 5], [9, 5])],
  });
  planner.decide({ state: state1 });
  const state2 = makeState({
    enemies: [enemyWorkerAt([7, 5], [8, 5])],
  });
  const plan = planner.decide({ state: state2 });
  const blockadeIntents = Object.entries(plan.intents).filter(([, i]) => i === "vanguard_blockade");
  assert.ok(blockadeIntents.length >= 1, `期望 ≥1 vanguard_blockade，got ${JSON.stringify(plan.intents)}`);
  const [unitId] = blockadeIntents[0];
  assert.equal(unitId, "v1");
  assert.equal(plan.unitActions[unitId].type, "WAIT", "v1 在路径上 → 站桩（非推断核心入口白跑）");
});

test("vanguardBlockade：伏击兜底——敌方在资源格采集 → Vanguard 蹲守邻格", () => {
  const planner = new SafetyPlanner(BLOCKADE_CONFIG);
  // 敌方 worker 在资源格 (5,5) 上（正在采集）→ 伏击：Vanguard 蹲资源格邻格
  const state = makeState({
    vanguards: [
      { id: "v1", position: [8, 8], hp: 4, unitType: "VANGUARD", cargo: 0 },
      { id: "v2", position: [-5, -5], hp: 4, unitType: "VANGUARD", cargo: 0 },
    ],
    enemies: [enemyWorkerAt([5, 5], [6, 5])],
    resourceCells: new Set(["5,5"]),
  });
  const plan = planner.decide({ state });
  const blockadeIntents = Object.entries(plan.intents).filter(([, i]) => i === "vanguard_blockade");
  assert.ok(blockadeIntents.length >= 1, `期望 ≥1 vanguard_blockade（伏击），got ${JSON.stringify(plan.intents)}`);
  const [unitId] = blockadeIntents[0];
  assert.equal(unitId, "v1", "最近 Vanguard 去蹲守");
  assert.equal(plan.unitActions[unitId].type, "MOVE", "Vanguard 走向蹲守点");
});

test("vanguardBlockade：Vanguard 已在拦截点 → WAIT 站桩（等敌方撞上）", () => {
  const planner = new SafetyPlanner(BLOCKADE_CONFIG);
  // v1 在 (5,5) 正好是敌方路径上的格（敌方 LEFT 移动）→ margin 选点 (5,5)
  // → v1 已在拦截点 → WAIT 站桩
  const state1 = makeState({
    enemies: [enemyWorkerAt([8, 5], [9, 5])],
  });
  planner.decide({ state: state1 });
  const state2 = makeState({
    enemies: [enemyWorkerAt([7, 5], [8, 5])],
  });
  const plan = planner.decide({ state: state2 });
  const blockadeIntents = Object.entries(plan.intents).filter(([, i]) => i === "vanguard_blockade");
  assert.ok(blockadeIntents.length >= 1, `期望 ≥1 vanguard_blockade，got ${JSON.stringify(plan.intents)}`);
  const [unitId] = blockadeIntents[0];
  assert.equal(plan.unitActions[unitId].type, "WAIT", "已在拦截点 → 站桩等敌方");
});

test("vanguardBlockade：敌方邻接 → SWEEP 优先（锁+收割的攻击部分）", () => {
  const planner = new SafetyPlanner(BLOCKADE_CONFIG);
  // v1 在 (5,5)，敌方在 (6,5)（邻接）→ SWEEP 直接打（intent=sweep，非 blockade）
  const state1 = makeState({
    enemies: [enemyWorkerAt([7, 5], [8, 5])],
  });
  planner.decide({ state: state1 });
  const state2 = makeState({
    enemies: [enemyWorkerAt([6, 5], [7, 5])],
  });
  const plan = planner.decide({ state: state2 });
  assert.equal(plan.intents["v1"], "sweep", "邻接敌 → SWEEP 攻击（拦截站桩自动接战）");
});

test("vanguardBlockade：不锁军事单位（VANGUARD/RANGER 预测被过滤）", () => {
  const planner = new SafetyPlanner(BLOCKADE_CONFIG);
  // 敌方 VANGUARD 直线移动（非 WORKER）→ 无 vanguard_blockade
  const state1 = makeState({
    enemies: [{ id: "ev", kind: "UNIT", position: [9, 5], hp: 4, unitType: "VANGUARD" } as VisibleEntity],
  });
  planner.decide({ state: state1 });
  const state2 = makeState({
    enemies: [{ id: "ev", kind: "UNIT", position: [8, 5], hp: 4, unitType: "VANGUARD" } as VisibleEntity],
  });
  const plan = planner.decide({ state: state2 });
  const blockadeIntents = Object.entries(plan.intents).filter(([, i]) => i === "vanguard_blockade");
  assert.equal(blockadeIntents.length, 0, "军事单位不锁（战斗逻辑处理）");
});

test("vanguardBlockade：默认关闭 → 无 vanguard_blockade intent", () => {
  const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  const state = makeState({
    enemies: [enemyWorkerAt([8, 5], [9, 5])],
  });
  const plan = planner.decide({ state });
  const blockadeIntents = Object.entries(plan.intents).filter(([, i]) => i === "vanguard_blockade");
  assert.equal(blockadeIntents.length, 0);
});

test("vanguardBlockade：站桩锁龄超限 → 放弃回巡逻", () => {
  const planner = new SafetyPlanner({ ...BLOCKADE_CONFIG, vanguardBlockadeMaxTicks: 2 });
  // v1 在 (5,5)，敌方在 (6,5) 预测路径 (5,5)(4,5)…——v1 已在锁点站桩
  const state = makeState({
    enemies: [enemyWorkerAt([6, 5], [7, 5])],
  });
  planner.decide({ state }); // tick 100: 站桩开始
  const state2 = { ...state, tick: 103, visibleEnemies: [enemyWorkerAt([6, 5], [7, 5])] };
  const plan = planner.decide({ state: state2 });
  // 锁龄 2 超限（100→103 已 3 tick）→ 无 vanguard_blockade（放弃回巡逻）
  const blockadeIntents = Object.entries(plan.intents).filter(([, i]) => i === "vanguard_blockade");
  assert.equal(blockadeIntents.length, 0, "锁龄超限 → 拦截手释放");
});
