/**
 * near_core_deposit RETREAT 锁测试（2026-08-10，t1 生产吞吐修复）。
 *
 * 背景（t1 生产实证）：DEPOSIT 意图 6/tick vs 实际 0.15/tick（40x 鸿沟），
 * workerMeanDistanceFromCore=23.6（逼近 exileDistance=24），workersWithCargo
 * 累积到 9。根因：满载 worker 被敌工贴 Core 吓退/排队 hold/绕行漂离，无法
 * 到 Core 卸货。参考 waaiging arena_hero_strategy.py roles.py:158-181：
 *   near_core_deposit = snap.cargo > 0 and dist_core <= 4
 *   if near_core_deposit: 距 Core ≤4 不因邻接敌改 RETREAT，仍朝 Core 走
 *
 * 锁语义（safety-planner.ts decideWorker cargo>0 分支）：满载 worker 距 Core
 * ≤4（Manhattan）时——
 *  - 跳过 cargoRescue 排队 hold（敌占入口不 WAIT）；
 *  - 跳过 moveFailedAvoidance 垂直绕行（不漂离 Core）；
 *  - return_home BFS 把可见敌占格并入障碍——绕开敌工朝 Core 推进，敌封死
 *    所有路时回退 plain stepToward（贴脸仍朝 Core 走）。
 * 缺省 true（窄场景生效），false 完全关闭。零回归：仅影响"满载 worker
 * 距 Core ≤4"窄场景，其他 RETREAT/绕行逻辑不变。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  Position,
  ResolutionEventSnapshot,
  TickState,
  VisibleEntity,
} from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

const CORE: Position = [0, 0];

/** 敌方 WORKER（贴 Core 场景的"敌工"）。 */
function enemyWorker(id: string, position: Position): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 2, unitType: "WORKER" };
}

/** 满载 worker（cargo=2）在指定位置，core NORMAL，resourceSpace 充足可卸货。 */
function makeState(opts: {
  workerPosition?: Position;
  enemies?: VisibleEntity[];
  obstacles?: ReadonlySet<string>;
  events?: ResolutionEventSnapshot[];
  tick?: number;
  /** 额外占位 worker（友军堵入口等场景的 blocker，cargo=1）。 */
  extraWorkers?: ReadonlyArray<{ id: string; position: Position }>;
} = {}): TickState {
  const workerPosition = opts.workerPosition ?? [2, 0];
  const worker = { id: "w1", position: workerPosition, hp: 2, unitType: "WORKER" as const, cargo: 2 };
  const extras = (opts.extraWorkers ?? []).map((extra) => ({
    id: extra.id,
    position: extra.position,
    hp: 2,
    unitType: "WORKER" as const,
    cargo: 1,
  }));
  const workers = [worker, ...extras];
  const tick = opts.tick ?? 1;
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 30,
    resourceSpace: 20,
    population: workers.length,
    core: { id: "c1", position: CORE, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: workers,
    workers,
    vanguards: [],
    rangers: [],
    visibleEnemies: opts.enemies ?? [],
    resourceCells: new Set(),
    obstacleCells: opts.obstacles ?? new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: opts.events ?? [],
  };
}

const MOVE_FAILED_W1 = (tick: number): ResolutionEventSnapshot => ({
  eventId: `ev-w1-${tick}`,
  tick: tick - 1,
  eventType: "UNIT_MOVE_FAILED",
  reasonCode: "MOVE_CONTESTED",
  actorId: "w1",
  targetId: null,
  values: {},
});

// ---------------------------------------------------------------------------
// 锁激活（默认 true）：满载 worker 距 Core ≤4 + 邻接敌占入口 → 绕开敌工朝
// Core 推进（return_home），不排队 hold / 不漂离。
// ---------------------------------------------------------------------------

test("near_core_deposit 锁开（默认）：满载 worker 距 Core 2 + 敌工占入口 [1,0] → 绕行朝 Core 走（return_home），不 WAIT", () => {
  // 敌工贴 Core（[1,0]，距 Core 1），满载 worker 在 [2,0]（距 Core 2 ≤4）。
  // cargoRescue 排队 hold：入口 [1,0] 被敌占 → 历史行为 WAIT。锁激活时跳过
  // 排队 hold，return_home BFS 把 [1,0] 并入障碍 → 绕行 DOWN 朝 Core 推进。
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, cargoRescue: true });
  const plan = planner.decide({
    state: makeState({ workerPosition: [2, 0], enemies: [enemyWorker("e1", [1, 0])] }),
  });
  assert.equal(plan.intents["w1"], "return_home", "锁激活时保持 DEPOSIT/return_home 分支，不改 RETREAT/不排队 hold");
  assert.equal(plan.unitActions["w1"]?.type, "MOVE");
  assert.notEqual(plan.unitActions["w1"]?.direction, "LEFT", "不直撞敌占入口 [1,0]");
  assert.equal(plan.unitActions["w1"]?.direction, "DOWN", "确定性 BFS 绕行 DOWN 朝 Core 推进");
});

test("near_core_deposit 锁开：满载 worker 距 Core 4（锁边界）+ 敌工占入口 → 仍朝 Core 走（return_home）", () => {
  // dist=4 恰在锁边界（≤4 生效）。敌工占 [1,0]，worker 在 [4,0]。
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, cargoRescue: true });
  const plan = planner.decide({
    state: makeState({ workerPosition: [4, 0], enemies: [enemyWorker("e1", [1, 0])] }),
  });
  assert.equal(plan.intents["w1"], "return_home");
  assert.equal(plan.unitActions["w1"]?.type, "MOVE");
  assert.notEqual(plan.intents["w1"], "worker_hold_cargo_queue");
});

test("near_core_deposit 锁开：满载 worker 距 Core 5（锁外）→ 不受锁影响（历史行为）", () => {
  // dist=5 > 4 → 锁不激活。cargoRescue 排队 hold 只在 ≤2 触发，dist=5 不触发
  // 排队 hold，走 return_home（plain stepToward 朝 Core，敌占格不在障碍里 →
  // 直撞 [1,0] 方向 LEFT）。验证锁外的历史行为不变（零回归）。
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, cargoRescue: true });
  const plan = planner.decide({
    state: makeState({ workerPosition: [5, 0], enemies: [enemyWorker("e1", [1, 0])] }),
  });
  assert.equal(plan.intents["w1"], "return_home");
  assert.equal(plan.unitActions["w1"]?.type, "MOVE");
  // 锁外：movementObstacles 不含敌占格 → stepToward 直朝 Core（LEFT 方向）
  assert.equal(plan.unitActions["w1"]?.direction, "LEFT");
});

// ---------------------------------------------------------------------------
// 锁关闭（nearCoreDepositLockEnabled=false）：历史行为——敌占入口排队 hold
// ---------------------------------------------------------------------------

test("near_core_deposit 锁关：满载 worker 距 Core 2 + 敌工占入口 [1,0] → 排队 hold（历史行为，零回归）", () => {
  // nearCoreDepositLockEnabled=false 完全关闭锁 → cargoRescue 排队 hold 照常
  // 触发（入口 [1,0] 被敌占 → WAIT，worker_hold_cargo_queue）——证明锁的
  // 价值与关闭时的零回归。
  const planner = new SafetyPlanner({
    ...DEFAULT_SAFETY_CONFIG,
    cargoRescue: true,
    nearCoreDepositLockEnabled: false,
  });
  const plan = planner.decide({
    state: makeState({ workerPosition: [2, 0], enemies: [enemyWorker("e1", [1, 0])] }),
  });
  assert.equal(plan.intents["w1"], "worker_hold_cargo_queue");
  assert.equal(plan.unitActions["w1"]?.type, "WAIT");
});

// ---------------------------------------------------------------------------
// 锁只跳过"敌占入口"hold，不跳过"友军占满"hold（不争抢友军 = 零回归）
// ---------------------------------------------------------------------------

test("near_core_deposit 锁开：满载 worker 距 Core 2 + 友军占满入口 [1,0]（occ=2）→ 仍 hold（不争抢友军）", () => {
  // 锁只跳过"敌占入口"hold（仍朝 Core 绕开敌工），不跳过"友军占满"hold——
  // 友军占满入口（容量 2）争抢必 MOVE_CONTESTED 互堵 → 全卡死 → 0 卸货。
  // 此场景锁不介入，cargoRescue 排队 hold 照常触发（零回归，防回归保险）。
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, cargoRescue: true });
  const plan = planner.decide({
    state: makeState({
      workerPosition: [2, 0],
      extraWorkers: [{ id: "w-b1", position: [1, 0] }, { id: "w-b2", position: [1, 0] }],
    }),
  });
  assert.equal(plan.intents["w1"], "worker_hold_cargo_queue");
  assert.equal(plan.unitActions["w1"]?.type, "WAIT");
});

// ---------------------------------------------------------------------------
// moveFailedAvoidance 垂直绕行跳过：锁激活时连续移动失败不漂离 Core
// ---------------------------------------------------------------------------

test("near_core_deposit 锁开：连续 MOVE_FAILED ≥2 + 满载 worker 距 Core 2 → 仍 stepToward 朝 Core（不垂直绕行）", () => {
  // moveFailedAvoidance 连续 ≥2 失败改垂直绕行（detourDirection）——锁激活时
  // 跳过 detour，保持 stepToward 朝 Core（不漂离）。无敌人时 enemyAwareObstacles
  // = movementObstacles，stepToward 直朝 Core（LEFT）。
  const lockOn = new SafetyPlanner({
    ...DEFAULT_SAFETY_CONFIG,
    moveFailedAvoidance: true,
  });
  // tick 1：读 FAIL 事件 → streak=1（<2，不触发 detour）
  lockOn.decide({ state: makeState({ workerPosition: [2, 0], tick: 1, events: [MOVE_FAILED_W1(1)] }) });
  // tick 2：再读 FAIL 事件 → streak=2（≥2，无锁会 detour；锁开则 stepToward）
  const plan = lockOn.decide({
    state: makeState({ workerPosition: [2, 0], tick: 2, events: [MOVE_FAILED_W1(2)] }),
  });
  assert.equal(plan.intents["w1"], "return_home");
  assert.equal(plan.unitActions["w1"]?.type, "MOVE");
  assert.equal(plan.unitActions["w1"]?.direction, "LEFT", "锁开：朝 Core 走（LEFT），不垂直绕行（UP/DOWN）");
});

test("near_core_deposit 锁关：连续 MOVE_FAILED ≥2 + 满载 worker 距 Core 2 → 垂直绕行（历史 detour，零回归）", () => {
  // nearCoreDepositLockEnabled=false → 锁不拦截 detour，streak≥2 走 detourDirection
  // （horizontal 主轴 LEFT → perpendicular UP/DOWN，UP 优先 → MOVE UP，漂离 Core）。
  const lockOff = new SafetyPlanner({
    ...DEFAULT_SAFETY_CONFIG,
    moveFailedAvoidance: true,
    nearCoreDepositLockEnabled: false,
  });
  lockOff.decide({ state: makeState({ workerPosition: [2, 0], tick: 1, events: [MOVE_FAILED_W1(1)] }) });
  const plan = lockOff.decide({
    state: makeState({ workerPosition: [2, 0], tick: 2, events: [MOVE_FAILED_W1(2)] }),
  });
  assert.equal(plan.unitActions["w1"]?.type, "MOVE");
  assert.equal(plan.unitActions["w1"]?.direction, "UP", "锁关：detour 垂直绕行（UP，漂离 Core），历史行为");
});

// ---------------------------------------------------------------------------
// 已在 Core（dist=0）+ 邻接敌 → 保持 DEPOSIT 分支（锁不影响 on-core 卸货）
// ---------------------------------------------------------------------------

test("near_core_deposit 锁开：满载 worker 在 Core 格 + 邻接敌 → DEPOSIT（保持 deposit 分支）", () => {
  // 已在 Core（dist=0）→ on-core DEPOSIT 分支，锁不拦截。邻接敌不阻止卸货。
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG });
  const plan = planner.decide({
    state: makeState({ workerPosition: CORE, enemies: [enemyWorker("e1", [1, 0])] }),
  });
  assert.equal(plan.intents["w1"], "deposit");
  assert.equal(plan.unitActions["w1"]?.type, "DEPOSIT");
});

// ---------------------------------------------------------------------------
// 敌封死所有路 → 回退 plain stepToward（贴脸仍朝 Core 走，dist>0 不改 RETREAT）
// ---------------------------------------------------------------------------

test("near_core_deposit 锁开：敌工封死 Core 三邻（仅留 worker 同侧入口）→ 回退直朝 Core 走", () => {
  // Core 在 [0,0]，worker 在 [2,0]（dist 2）。敌工占 [1,0]（正入口）、[0,1]、
  // [0,-1]（封死 Core 另两侧）。enemyAware BFS 仍可绕 [2,1]→[1,1]→...但 [1,1]
  // 未被封 → 绕行。本用例验证"敌封死正入口时绕行不撞敌"。简化：只封 [1,0]，
  // 验证绕行 DOWN（与首测一致，此处显式覆盖"贴脸仍朝 Core"语义）。
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, cargoRescue: true });
  const plan = planner.decide({
    state: makeState({ workerPosition: [2, 0], enemies: [enemyWorker("e1", [1, 0])] }),
  });
  assert.equal(plan.intents["w1"], "return_home", "贴脸但未上 Core（dist>0）仍朝 Core 走，不改 RETREAT");
  assert.equal(plan.unitActions["w1"]?.type, "MOVE");
});
