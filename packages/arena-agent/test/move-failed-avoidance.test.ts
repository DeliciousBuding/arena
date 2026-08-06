/**
 * moveFailedAvoidance 测试（2026-08-06，第三十一轮）：
 * MOVE_FAILED 反馈规避——连续移动失败 ≥2 tick 后 aggressive Vanguard 不再
 * 盲目重试同格，改走垂直绕行格（探路打破争格僵局）。
 * 默认关闭零回归；开启时仅在连续失败 ≥2 触发。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { TickState, VisibleEntity, ResolutionEventSnapshot } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

function makeState(tick: number, enemies: VisibleEntity[], failedUnitIds: string[] = []): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 2,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [{ id: "v1", position: [18, 0], hp: 4, unitType: "VANGUARD", cargo: 0 }],
    workers: [],
    vanguards: [{ id: "v1", position: [18, 0], hp: 4, unitType: "VANGUARD", cargo: 0 }],
    rangers: [],
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: failedUnitIds.map(
      (actorId): ResolutionEventSnapshot => ({
        eventId: `ev-${actorId}`,
        tick: tick - 1,
        eventType: "UNIT_MOVE_FAILED",
        reasonCode: "MOVE_CONTESTED",
        actorId,
        targetId: null,
        values: {},
      }),
    ),
  };
}

function enemyCore(): VisibleEntity {
  return { id: "e1", kind: "CORE", position: [22, 0], hp: 5, unitType: "VANGUARD" };
}

const PRESSURE_POLICY = {
  posture: "aggressive" as const,
  workerTarget: 6,
  militaryRatio: 0.4,
  focusRegion: null,
  attackPriority: "core" as const,
};

test("moveFailedAvoidance 默认关闭：连续失败仍直走（历史行为零回归）", () => {
  const planner = new SafetyPlanner(); // 默认 config 无 moveFailedAvoidance
  planner.decide({ state: makeState(1, [enemyCore()], ["v1"]), policy: PRESSURE_POLICY });
  const plan = planner.decide({ state: makeState(2, [enemyCore()], ["v1"]), policy: PRESSURE_POLICY });
  // 连续 2 次失败但开关关闭 → 仍朝 CORE 直走（RIGHT）
  assert.deepEqual(plan.unitActions["v1"], { type: "MOVE", direction: "RIGHT" });
});

const AVOID_CONFIG = { ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" as const, moveFailedAvoidance: true };

test("moveFailedAvoidance 开启：连续失败 1 次不触发（阈值 ≥2）", () => {
  const planner = new SafetyPlanner(AVOID_CONFIG);
  const plan = planner.decide({ state: makeState(1, [enemyCore()], ["v1"]), policy: PRESSURE_POLICY });
  assert.deepEqual(plan.unitActions["v1"], { type: "MOVE", direction: "RIGHT" }, "失败 1 次仍直走");
});

test("moveFailedAvoidance 开启：连续失败 2 次 → 垂直绕行（不再争同格）", () => {
  const planner = new SafetyPlanner(AVOID_CONFIG);
  planner.decide({ state: makeState(1, [enemyCore()], ["v1"]), policy: PRESSURE_POLICY });
  const plan = planner.decide({ state: makeState(2, [enemyCore()], ["v1"]), policy: PRESSURE_POLICY });
  // 主方向 RIGHT 被争 → 垂直候选 UP/DOWN 取第一个（UP）绕行探路
  assert.deepEqual(plan.unitActions["v1"], { type: "MOVE", direction: "UP" });
  assert.equal(plan.intents["v1"], "vanguard_pressure");
});

test("moveFailedAvoidance 开启：成功移动后失败计数清零（恢复直走）", () => {
  const planner = new SafetyPlanner(AVOID_CONFIG);
  planner.decide({ state: makeState(1, [enemyCore()], ["v1"]), policy: PRESSURE_POLICY });
  planner.decide({ state: makeState(2, [enemyCore()], ["v1"]), policy: PRESSURE_POLICY });
  // 第 3 tick 无失败事件（移动成功）→ streak 清零 → 恢复直走
  const plan = planner.decide({ state: makeState(3, [enemyCore()], []), policy: PRESSURE_POLICY });
  assert.deepEqual(plan.unitActions["v1"], { type: "MOVE", direction: "RIGHT" });
});

function makeWorkerState(tick: number, failedWorkerIds: string[] = []): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    // 满载 worker 在 [18,0] 回仓（cargo>0 走 return_home），主方向 LEFT 被争
    units: [{ id: "w1", position: [18, 0], hp: 2, unitType: "WORKER", cargo: 2 }],
    workers: [{ id: "w1", position: [18, 0], hp: 2, unitType: "WORKER", cargo: 2 }],
    vanguards: [],
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: failedWorkerIds.map(
      (actorId): ResolutionEventSnapshot => ({
        eventId: `ev-${actorId}`,
        tick: tick - 1,
        eventType: "UNIT_MOVE_FAILED",
        reasonCode: "MOVE_CONTESTED",
        actorId,
        targetId: null,
        values: {},
      }),
    ),
  };
}

test("moveFailedAvoidance 开启：worker 满载回仓连续失败 → 垂直绕行", () => {
  const planner = new SafetyPlanner(AVOID_CONFIG);
  planner.decide({ state: makeWorkerState(1, ["w1"]) });
  const plan = planner.decide({ state: makeWorkerState(2, ["w1"]) });
  // 主方向 LEFT 被争 → 垂直候选 UP/DOWN 取 UP 绕行（return_home 意图保持）
  assert.deepEqual(plan.unitActions["w1"], { type: "MOVE", direction: "UP" });
  assert.equal(plan.intents["w1"], "return_home");
});

function makeBreakoutState(tick: number): TickState {
  // 四向邻接包围（C5 对齐 2026-08-07：BREAKOUT 需当前格投影伤害>0——
  // 8 格外的 Vanguard 打不到 Core，只算 ALERT）：
  // e1 [1,0] e2 [-1,0] e3 [0,1] e4 [0,-1]（无逃逸方向 + 投影伤害 4 → BREAKOUT）
  const enemies: VisibleEntity[] = [
    { id: "e1", kind: "UNIT", position: [1, 0], hp: 4, unitType: "VANGUARD" },
    { id: "e2", kind: "UNIT", position: [-1, 0], hp: 4, unitType: "VANGUARD" },
    { id: "e3", kind: "UNIT", position: [0, 1], hp: 4, unitType: "VANGUARD" },
    { id: "e4", kind: "UNIT", position: [0, -1], hp: 4, unitType: "VANGUARD" },
  ];
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    // worker 在 [10,0]（守家圈外）巡逻——BREAKOUT 时应收缩回家
    units: [{ id: "w1", position: [10, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
    workers: [{ id: "w1", position: [10, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
    vanguards: [],
    rangers: [],
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

test("threatBreakout 默认关闭：四向包围时 worker 照常外巡（历史行为零回归）", () => {
  const planner = new SafetyPlanner(); // 默认 config 无 threatBreakout
  const plan = planner.decide({ state: makeBreakoutState(1) });
  // 10 格外无可见资源 → 巡逻/探索外扩（不收缩）
  assert.notEqual(plan.intents["w1"], "return_home");
  assert.equal(plan.unitActions["w1"]?.type, "MOVE");
});

const BREAKOUT_CONFIG = { ...DEFAULT_SAFETY_CONFIG, threatBreakout: true };

test("threatBreakout 开启：四向包围（BREAKOUT）→ worker 全面收缩守家", () => {
  const planner = new SafetyPlanner(BREAKOUT_CONFIG);
  const plan = planner.decide({ state: makeBreakoutState(1) });
  // 无可见资源 + BREAKOUT → 收缩模式（patrol 缩圈，不朝外扩）
  assert.equal(plan.unitActions["w1"]?.type, "MOVE");
  const direction = plan.unitActions["w1"]?.type === "MOVE" ? plan.unitActions["w1"].direction : null;
  assert.notEqual(direction, null);
});

test("threatBreakout 开启：可逃多轴（东西夹击非 BREAKOUT）→ 不收缩", () => {
  const planner = new SafetyPlanner(BREAKOUT_CONFIG);
  const base = makeBreakoutState(1);
  // 只剩东西两敌（可逃）：重建 state（readonly 属性不可赋值）
  const state: TickState = {
    ...base,
    visibleEnemies: base.visibleEnemies.slice(0, 2),
  };
  const plan = planner.decide({ state });
  // 非 BREAKOUT（ALERT 且 threatRecall 关）→ 无收缩约束
  assert.notEqual(plan.unitActions["w1"]?.type, undefined);
});
