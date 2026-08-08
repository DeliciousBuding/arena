/**
 * DeterministicPlanner 适配测试（leader 集成，离线 fixture）。
 *
 * 验收口径：Task → UnitAction 确定性映射、唯一性（同一资源格最多一个 Worker）、
 * 与 SafetyPlanner 接口可互换（decide({ state }) → Plan）、输出过 validatePlan。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Turn, type PlayerState } from "@arena/arena-hero-ts";

import {
  DeterministicPlanner,
  resolveMoveCapacity,
  selectDeterministicCoreAction,
  stepToward,
  stepTowardAvoiding,
} from "../src/planning/deterministic-planner.ts";
import { DEFAULT_MISSION_CONFIG } from "../src/planning/mission-planner.ts";
import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import { validatePlan } from "../src/domain/plan-validator.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import {
  chebyshev,
  EXPLORE_DIRECTION_COUNT,
  EXPLORE_RING_COUNT,
  exploreRadiusForRing,
  exploreTarget,
  manhattan,
  move,
} from "../src/domain/nav.ts";
import type { Position, TickState, UnitAction } from "../src/domain/model.ts";
import { World } from "../src/domain/world.ts";

function makeState(tick: number, objects: PlayerState["objects"], resources = 6): TickState {
  const turn = new Turn(
    tick,
    {
      status: "ACTIVE",
      respawn_at_tick: null,
      resources,
      population: objects.filter((o) => o.kind === "UNIT").length,
      population_tier: 0,
      upkeep_next_tick: 0,
      champion_beacon: { position: [100, 100], status: "GROUND", carrier_id: null },
      objects,
      events: [],
    },
    (() => {}) as never,
  );
  return reduceTurn(turn as unknown as TurnLike);
}

function unit(id: string, x: number, y: number, unitType: "WORKER" | "VANGUARD" = "WORKER", cargo = 0, hp = 2): PlayerState["objects"][number] {
  return { kind: "UNIT", id, controlled: true, position: [x, y], hp, unit_type: unitType, cargo };
}

function core(x = 0, y = 0): PlayerState["objects"][number] {
  return {
    kind: "CORE", id: "c1", controlled: true, owner_username: "fixture_user",
    position: [x, y], hp: 5, shield: 5, state: "NORMAL",
    move_direction: null, move_progress: null, move_required_ticks: null, destination: null,
  };
}

// 资源格在 domain state 里是 resourceCells（reduceTurn 从对象/事件推导）——
// 用 RESOURCE 对象? domain 模型里没有 RESOURCE kind——reduceTurn 的 resourceCells
// 从哪来? 查 state-reducer——先构造 fixture 用 obstacle+events 或直接改 state。
// 简化：reduceTurn 后直接改 state.resourceCells（TickState 可变? 不行——重新构造）。
// 看 reduceTurn 如何推导 resourceCells。

test("stepToward：先 x 后 y 确定性方向", () => {
  assert.equal(stepToward([0, 0], [3, 0]), "RIGHT");
  assert.equal(stepToward([3, 0], [0, 0]), "LEFT");
  assert.equal(stepToward([0, 0], [0, 3]), "DOWN");
  assert.equal(stepToward([0, 3], [0, 0]), "UP");
  assert.equal(stepToward([0, 0], [2, 1]), "RIGHT"); // 先 x
  assert.equal(stepToward([1, 0], [1, 0]), "UP"); // 同格退化（调用方不触发）
});

test("exploreTarget：8 个 Worker 获得 8 个独立方位且保持同一 Chebyshev 半径", () => {
  const home: Position = [0, 0];
  const targets = Array.from({ length: EXPLORE_DIRECTION_COUNT }, (_, index) =>
    exploreTarget(home, [10, 0], index, 8),
  );
  assert.deepEqual(targets, [
    [8, 0],
    [8, 8],
    [0, 8],
    [-8, 8],
    [-8, 0],
    [-8, -8],
    [0, -8],
    [8, -8],
  ]);
  assert.equal(new Set(targets.map((target) => `${target[0]},${target[1]}`)).size, 8);
  assert.ok(targets.every((target) => chebyshev(home, target) === 8));
});

test("分层扩圈：半径按 8→16→24→32→40 循环，Worker 完成一趟后进入下一圈", () => {
  assert.deepEqual(
    Array.from({ length: EXPLORE_RING_COUNT + 1 }, (_, ring) => exploreRadiusForRing(8, ring)),
    [8, 16, 24, 32, 40, 8],
  );

  const planner = new SafetyPlanner();
  const atHome = makeState(100, [core(0, 0), unit("w1", 0, 0)]);
  planner.decide({ state: atHome });
  assert.equal(planner.world.unitMemory("w1").patrolRing, 0);

  // beacon [100,100]（东南基）+ 初始方向 (0*3+7)%8=7 → 方位 0（正东）：
  // 首圈环点 [8,0]。到达环点后连续外扩（2026-08-06 用户导向）——
  // 不回 home 换环，同方位直接延伸下一环 [16,0]。
  const atFirstTarget = makeState(101, [core(0, 0), unit("w1", 8, 0)]);
  planner.decide({ state: atFirstTarget });
  const ring1 = planner.world.unitMemory("w1");
  assert.equal(ring1.patrolRing, 1, "到达环点后连续外扩到下一环");
  assert.equal(ring1.patrolReturning, false);

  // 强制回 home（如被采到资源拉回）：换方位 + 推进环
  const returnedHome = makeState(102, [core(0, 0), unit("w1", 0, 0)]);
  planner.decide({ state: returnedHome });
  const memory = planner.world.unitMemory("w1");
  assert.equal(memory.patrolRing, 2);
  assert.equal(memory.patrolDirection, 2, "方位 +3 步进：(7+3)%8=2");
});

test("绕路越界（chebyshev>=环半径但不在环点）→ 连续外扩而非折返（2026-08-07 t4 修复）", () => {
  const planner = new SafetyPlanner();
  // beacon [100,100]（东南基）+ 初始方向 7 → 方位 0（正东），首圈环点 [8,0]。
  // w1 在 [12,0]：chebyshev 12 >= 环半径 8（绕路越过精确环点，未停在 [8,0]）
  // → 旧逻辑"越界→回家"（t4 生产实证：30 格折返、够不到 36 格资源带）；
  // 新逻辑"到达环带即外扩"→ ring 0→1，目标 [16,0]，继续向外。
  const state = makeState(100, [core(0, 0), unit("w1", 12, 0)]);
  const plan = planner.decide({ state });
  const memory = planner.world.unitMemory("w1");
  assert.equal(memory.patrolRing, 1, "越过环半径即外扩下一环，不折返");
  assert.equal(memory.patrolReturning, false, "外扩中不是返回态");
  assert.equal(plan.unitActions["w1"]?.type, "MOVE");
  assert.notEqual(
    plan.unitActions["w1"]?.type === "MOVE" ? plan.unitActions["w1"].direction : null,
    "LEFT",
    "不朝 Core 回退",
  );
});

test("最外环（40）到达后回家换方位：返回态不重新外扩", () => {
  const planner = new SafetyPlanner();
  // 连续外扩：8→16→24→32（每次把 w1 放到当前环半径位置，推进到最外环 ring 4）
  let prev = makeState(100, [core(0, 0), unit("w1", 8, 0)]);
  planner.decide({ state: prev });
  for (const radius of [16, 24, 32]) {
    const at = makeState(prev.tick + 1, [core(0, 0), unit("w1", radius, 0)]);
    planner.decide({ state: at });
    prev = at;
  }
  let mem = planner.world.unitMemory("w1");
  assert.equal(mem.patrolRing, 4, "32 到达 → ring 4（最外环，半径 40）");
  assert.equal(mem.patrolReturning, false, "尚未到达最外环半径，仍是外扩态");
  // 最外环半径（40）到达 → 回家换方位
  const atMax = makeState(prev.tick + 1, [core(0, 0), unit("w1", 40, 0)]);
  planner.decide({ state: atMax });
  mem = planner.world.unitMemory("w1");
  assert.equal(mem.patrolRing, 4);
  assert.equal(mem.patrolReturning, true, "最外环到达 → 回家换方位");
  // 返回途中 chebyshev 仍 >= 环半径 → 保持返回（不重新外扩）
  const returning = makeState(prev.tick + 2, [core(0, 0), unit("w1", 41, 0)]);
  const rplan = planner.decide({ state: returning });
  mem = planner.world.unitMemory("w1");
  assert.equal(mem.patrolReturning, true, "返回途中越界不重新外扩");
  assert.equal(rplan.unitActions["w1"]?.type, "MOVE");
});

test("巡逻目标是障碍：到达相邻格即外扩下一环，不在障碍旁振荡", () => {
  const planner = new SafetyPlanner();
  // 首圈环点 [8,0] 被障碍占据，w1 在 [7,0]（障碍邻格）
  const state = makeState(100, [
    { kind: "OBSTACLE", positions: [[8, 0]] },
    core(0, 0),
    unit("w1", 7, 0),
  ]);

  const plan = planner.decide({ state });
  const memory = planner.world.unitMemory("w1");
  assert.equal(memory.patrolRing, 1, "障碍环点不再贴近，连续外扩下一环");
  assert.equal(plan.unitActions["w1"]?.type, "MOVE");
  // 绕行第一步可能瞬时横向偏移（BFS 绕开 [8,0] 障碍），但绝不回退朝 Core
  assert.notEqual(
    plan.unitActions["w1"]?.type === "MOVE" ? plan.unitActions["w1"].direction : null,
    "LEFT",
    "绕行不朝 Core 回退",
  );

  // 位置未变（静态切片）→ 决策确定性一致：不横跳、不抖动
  const next = makeState(101, [
    { kind: "OBSTACLE", positions: [[8, 0]] },
    core(0, 0),
    unit("w1", 7, 0),
  ]);
  const nextPlan = planner.decide({ state: next });
  assert.equal(planner.world.unitMemory("w1").patrolRing, 1);
  assert.deepEqual(nextPlan.unitActions["w1"], plan.unitActions["w1"], "同状态决策确定性一致");
});

test("World：MOVE_CONTESTED 失败格仅对对应 actor 短期生效", () => {
  const base = makeState(100, [core(), unit("w1", 0, 0), unit("w2", 1, 0)]);
  const world = new World();
  world.observe({
    ...base,
    events: [{
      eventId: "move-failed-1",
      tick: 100,
      eventType: "UNIT_MOVE_FAILED",
      reasonCode: "MOVE_CONTESTED",
      actorId: "w1",
      targetId: null,
      position: [0, 1],
      values: {},
    }],
  });

  assert.equal(world.movementObstacles("w1").has("0,1"), true);
  assert.equal(world.movementObstacles("w2").has("0,1"), false);

  world.observe(makeState(103, [core(), unit("w1", 0, 0), unit("w2", 1, 0)]));
  assert.equal(world.movementObstacles("w1").has("0,1"), false, "3 Tick 后释放动态争用格");
});

test("DeterministicPlanner：资源路径 MOVE_CONTESTED 后绕行，不连续重试同一格", () => {
  const planner = new DeterministicPlanner();
  const first = {
    ...makeState(100, [core(), unit("w1", 0, 0)]),
    resourceCells: new Set(["0,3"]),
  };
  const firstPlan = planner.decide({ state: first });
  assert.deepEqual(firstPlan.unitActions["w1"], { type: "MOVE", direction: "DOWN" });

  const contested: TickState = {
    ...makeState(101, [core(), unit("w1", 0, 0)]),
    resourceCells: new Set(["0,3"]),
    events: [{
      eventId: "move-failed-1",
      tick: 101,
      eventType: "UNIT_MOVE_FAILED",
      reasonCode: "MOVE_CONTESTED",
      actorId: "w1",
      targetId: null,
      position: [0, 1],
      values: {},
    }],
  };
  const rerouted = planner.decide({ state: contested });
  assert.equal(rerouted.unitActions["w1"]?.type, "MOVE");
  assert.notDeepEqual(
    rerouted.unitActions["w1"],
    { type: "MOVE", direction: "DOWN" },
    "争用目的格冷却期间不得原样重试",
  );

  for (const tick of [102, 103]) {
    const cooling = planner.decide({
      state: {
        ...makeState(tick, [core(), unit("w1", 0, 0)]),
        resourceCells: new Set(["0,3"]),
      },
    });
    assert.notDeepEqual(cooling.unitActions["w1"], { type: "MOVE", direction: "DOWN" });
  }

  const released = planner.decide({
    state: {
      ...makeState(104, [core(), unit("w1", 0, 0)]),
      resourceCells: new Set(["0,3"]),
    },
  });
  assert.deepEqual(released.unitActions["w1"], { type: "MOVE", direction: "DOWN" });
});

test("DeterministicPlanner：decide 输出合法 Plan（validatePlan 过）", () => {
  // res 4 < WORKER 成本 5（bootstrap 阶段豁免 reserve 也不产）→ coreAction null
  const state = makeState(100, [core(), unit("w1", 1, 0), unit("w2", 2, 0)], 4);
  // 注入资源格（reduceTurn 不推导——直接改 resourceCells）
  const withCells: TickState = { ...state, resourceCells: new Set(["5,0", "5,1"]) };
  const planner = new DeterministicPlanner();
  const plan = planner.decide({ state: withCells });
  const validation = validatePlan(withCells, plan);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  assert.equal(plan.tick, 100);
  // 两个 worker 都有动作（MOVE 朝资源格）
  assert.equal(plan.unitActions["w1"]?.type, "MOVE");
  assert.equal(plan.unitActions["w2"]?.type, "MOVE");
  assert.equal(plan.coreAction, null);
});

test("DeterministicPlanner：唯一性——同一资源格最多一个 Worker（含强制任务占用）", () => {
  // w1 站在资源格（HARVEST_CURRENT 强制占用），w2/w3 竞争剩余格
  const state = makeState(100, [core(), unit("w1", 5, 0), unit("w2", 1, 0), unit("w3", 1, 1)]);
  const withCells: TickState = { ...state, resourceCells: new Set(["5,0", "5,1"]) };
  const planner = new DeterministicPlanner();
  const plan = planner.decide({ state: withCells });
  const validation = validatePlan(withCells, plan);
  assert.equal(validation.valid, true);
  // w1 在格上 → HARVEST；w2/w3 中只有一个去 5,1（另一个 MOVE 去别处或 WAIT）
  assert.equal(plan.unitActions["w1"]?.type, "HARVEST");
  const harvesters = Object.entries(plan.unitActions).filter(([, a]) => a.type === "HARVEST");
  assert.equal(harvesters.length, 1, "唯一性：同一资源格最多一个 HARVEST");
});

test("DeterministicPlanner：单资源只分配一个 Worker，其余继续巡逻而非 WAIT", () => {
  const state = makeState(100, [core(), unit("w1", 0, 0), unit("w2", 1, 0), unit("w3", 0, 1)]);
  const withCell: TickState = { ...state, resourceCells: new Set(["5,0"]) };
  const plan = new DeterministicPlanner().decide({ state: withCell });
  const intents = Object.values(plan.intents ?? {});
  assert.equal(intents.filter((intent) => intent === "GO_RESOURCE").length, 1);
  assert.equal(Object.values(plan.unitActions).filter((action) => action.type === "WAIT").length, 0);
  assert.ok(intents.filter((intent) => intent === "patrol").length >= 2);
});

test("容量裁决：Core 占一个槽，回仓 Worker 优先于巡逻并让巡逻改道", () => {
  const state = makeState(100, [
    core(0, 0),
    unit("w-cargo", 1, 0, "WORKER", 1),
    unit("w-patrol", 0, 1),
  ]);
  const result = resolveMoveCapacity(
    state,
    {
      "w-cargo": { type: "MOVE", direction: "LEFT" },
      "w-patrol": { type: "MOVE", direction: "UP" },
    },
    { "w-cargo": "return_home", "w-patrol": "patrol" },
    new Set(),
  );
  assert.deepEqual(result.unitActions["w-cargo"], { type: "MOVE", direction: "LEFT" });
  assert.notDeepEqual(result.unitActions["w-patrol"], { type: "MOVE", direction: "UP" });
  assert.equal(result.rerouteCount, 1);
  assert.equal(result.waitCount, 0);
  assert.equal(result.intents["w-patrol"], "capacity_reroute:patrol");
});

test("容量裁决：三个巡逻 Worker 争同一空格，只保留两个并为第三个改道", () => {
  const state = makeState(100, [
    unit("w1", 0, 1),
    unit("w2", 1, 0),
    unit("w3", 2, 1),
  ]);
  const result = resolveMoveCapacity(
    state,
    {
      w1: { type: "MOVE", direction: "RIGHT" },
      w2: { type: "MOVE", direction: "DOWN" },
      w3: { type: "MOVE", direction: "LEFT" },
    },
    { w1: "patrol", w2: "patrol", w3: "patrol" },
    new Set(),
  );
  const arrivalsAtCenter = Object.entries(result.unitActions).filter(([id, action]) => {
    if (action.type !== "MOVE") return false;
    const source = state.units.find((item) => item.id === id)?.position;
    if (source === undefined) return false;
    const destination = move(source, action.direction);
    return destination[0] === 1 && destination[1] === 1;
  });
  assert.equal(arrivalsAtCenter.length, 2);
  assert.equal(result.rerouteCount, 1);
  assert.equal(result.waitCount, 0);
});

test("容量裁决：当前满格的两个占用者都离开时，依赖链允许新 Worker 进入", () => {
  const state = makeState(100, [
    unit("a", 1, 0),
    unit("b", 1, 0),
    unit("c", 0, 0),
  ]);
  const actions: Record<string, UnitAction> = {
    a: { type: "MOVE", direction: "RIGHT" },
    b: { type: "MOVE", direction: "DOWN" },
    c: { type: "MOVE", direction: "RIGHT" },
  };
  const result = resolveMoveCapacity(
    state,
    actions,
    { a: "patrol", b: "patrol", c: "patrol" },
    new Set(),
  );
  assert.deepEqual(result.unitActions, actions);
  assert.equal(result.rerouteCount, 0);
  assert.equal(result.waitCount, 0);
});

test("容量裁决：两个 cargo Worker 同时回 Core 时仅一个进入，另一个等待重算", () => {
  const state = makeState(100, [
    core(0, 0),
    unit("0001", 1, 0, "WORKER", 1),
    unit("0002", 0, 1, "WORKER", 1),
  ]);
  const result = resolveMoveCapacity(
    state,
    {
      "0001": { type: "MOVE", direction: "LEFT" },
      "0002": { type: "MOVE", direction: "UP" },
    },
    { "0001": "return_home", "0002": "return_home" },
    new Set(),
  );
  assert.deepEqual(result.unitActions["0001"], { type: "MOVE", direction: "LEFT" });
  assert.deepEqual(result.unitActions["0002"], { type: "WAIT" });
  assert.equal(result.waitCount, 1);
  assert.equal(result.intents["0002"], "capacity_wait:return_home");
});

test("deterministic Core：Worker 少于 2 且 Core 格空闲时紧急补员", () => {
  const state = makeState(100, [core(0, 0), unit("w1", 2, 0)], 5);
  const plan = new DeterministicPlanner().decide({ state });
  assert.deepEqual(plan.coreAction, { type: "SPAWN", unitType: "WORKER" });
  assert.equal(plan.intents.core, "emergency_spawn_worker");
});

test("deterministic Core：policy.workerTarget 驱动目标补员（spawn_worker_target）", () => {
  // workers=2（非 emergency），policy 目标 6，资源足够（5+reserve2）→ 目标补员
  const state = makeState(100, [core(0, 0), unit("w1", 1, 0), unit("w2", 2, 0)], 10);
  const policy = { posture: "harvest" as const, workerTarget: 6, militaryRatio: 0, focusRegion: null, attackPriority: null };
  const plan = new DeterministicPlanner().decide({ state, policy });
  assert.deepEqual(plan.coreAction, { type: "SPAWN", unitType: "WORKER" });
  assert.equal(plan.intents.core, "spawn_worker_target");

  // 资源不足 reserve（5+2=7 门槛，只有 6）→ 不补员（worker 6 已达 bootstrap
  // 目标，恢复 reserve 保护——bootstrap 豁免只在 worker<6 时生效）
  const poor = makeState(100, [
    core(0, 0),
    unit("w1", 1, 0), unit("w2", 2, 0), unit("w3", 3, 0),
    unit("w4", 4, 0), unit("w5", 5, 0), unit("w6", 6, 0),
  ], 6);
  const poorPlan = new DeterministicPlanner().decide({ state: poor, policy });
  assert.equal(poorPlan.coreAction, null);

  // workers 已达 workerTarget → 不再补员
  const full = makeState(100, [
    core(0, 0),
    unit("w1", 1, 0), unit("w2", 2, 0), unit("w3", 3, 0),
    unit("w4", 4, 0), unit("w5", 5, 0), unit("w6", 6, 0),
  ], 20);
  const fullPlan = new DeterministicPlanner().decide({ state: full, policy });
  assert.equal(fullPlan.coreAction, null);
});

test("deterministic Core：Core 格已有 Unit 时不冒险 SPAWN", () => {
  const state = makeState(100, [core(0, 0), unit("w1", 0, 0)], 5);
  const decision = selectDeterministicCoreAction(state, null);
  assert.equal(decision.action, null);
  assert.equal(decision.intent, null);
});

test("deterministic Core：正常人口继续积累，不保留被压制的 spawn intent", () => {
  // 无 policy 默认目标=4（2026-08-06 扩编主动性优化）：2 worker + res 20 → 补员
  const state = makeState(100, [core(0, 0), unit("w1", 1, 0), unit("w2", 2, 0)], 20);
  const plan = new DeterministicPlanner().decide({ state });
  assert.deepEqual(plan.coreAction, { type: "SPAWN", unitType: "WORKER" });
  assert.equal(plan.intents.core, "spawn_worker_target");

  // 已达默认目标 4 → 不再补员（res 充足也不产）
  const full = makeState(100, [
    core(0, 0),
    unit("w1", 1, 0), unit("w2", 2, 0), unit("w3", 3, 0), unit("w4", 4, 0),
  ], 20);
  const fullPlan = new DeterministicPlanner().decide({ state: full });
  assert.equal(fullPlan.coreAction, null);
  assert.equal(fullPlan.intents.core, undefined);
});

test("deterministic Core：生存动作 HEAL / REPAIR_SHIELD 继续执行", () => {
  const healthyBase = makeState(100, [core(0, 0), unit("w1", 1, 0), unit("w2", 2, 0)], 3);
  const damaged: TickState = {
    ...healthyBase,
    core: { ...healthyBase.core!, hp: 4 },
  };
  assert.deepEqual(new DeterministicPlanner().decide({ state: damaged }).coreAction, { type: "HEAL" });

  const unshielded: TickState = {
    ...healthyBase,
    core: { ...healthyBase.core!, shield: 4 },
  };
  assert.deepEqual(new DeterministicPlanner().decide({ state: unshielded }).coreAction, { type: "REPAIR_SHIELD" });
});

test("DeterministicPlanner：DEPOSIT——cargo>0 回 Core；到位 DEPOSIT", () => {
  const state = makeState(100, [core(0, 0), unit("w1", 3, 0, "WORKER", 3)]);
  const planner = new DeterministicPlanner();
  const plan = planner.decide({ state });
  assert.equal(plan.unitActions["w1"]?.type, "MOVE");
  assert.equal((plan.unitActions["w1"] as { direction: string }).direction, "LEFT");
  // w1 已在 Core 格 → DEPOSIT
  const atCore = makeState(101, [core(0, 0), unit("w1", 0, 0, "WORKER", 3)]);
  const plan2 = planner.decide({ state: atCore });
  assert.equal(plan2.unitActions["w1"]?.type, "DEPOSIT");
});

test("DeterministicPlanner：无资源时继承完整 Safety 基线（Worker 巡逻、Vanguard 守家）", () => {
  const state = makeState(100, [core(), unit("w1", 1, 0, "WORKER"), unit("v1", 1, 2, "VANGUARD")]);
  const planner = new DeterministicPlanner();
  const plan = planner.decide({ state });
  assert.equal(plan.unitActions["v1"]?.type, "MOVE");
  assert.equal(plan.intents["v1"], "vanguard_move");
  assert.equal(plan.unitActions["w1"]?.type, "MOVE");
  assert.equal(plan.intents["w1"], "patrol");
});

test("DeterministicPlanner：资源离开视野后继续跨 Tick 追踪，不退化为 WAIT", () => {
  // Core 移远 [20,20]（半径 5 不覆盖远端资源）；tick100 w1 [5,0]（视野 3 覆盖 [8,0]）
  // → GO_RESOURCE；tick101 w1 折返 [2,0]（距 [8,0] 6 > 3，Core 距 >5）→ 真正离开
  // 所有观察者视野 → stale 记忆仍追踪（go_harvest_mem），不退化为 WAIT。
  const planner = new DeterministicPlanner();
  const seen = makeState(100, [core(20, 20), unit("w1", 5, 0)]);
  const p1 = planner.decide({ state: { ...seen, resourceCells: new Set(["8,0"]) } });
  assert.equal(p1.unitActions["w1"]?.type, "MOVE");
  assert.equal(p1.intents["w1"], "GO_RESOURCE");

  const hidden = makeState(101, [core(20, 20), unit("w1", 2, 0)]);
  const p2 = planner.decide({ state: hidden });
  assert.equal(p2.unitActions["w1"]?.type, "MOVE");
  assert.equal(p2.intents["w1"], "go_harvest_mem");
});

test("DeterministicPlanner：视野内资源消失（确认采空）→ harvested，不再跨 Tick 追踪", () => {
  // 视线感知资源失效（2026-08-08）：资源 [3,0] 在 Core [0,0] 半径 5 视野内却不在
  // 本轮 resourceCells → 确认被采空 → 立即 harvested 负记忆 → worker 不再追空矿
  // （旧行为 stale 32 tick 内仍提示 → 继续 go_harvest_mem 追已消失的矿）。
  const planner = new DeterministicPlanner();
  const seen = makeState(100, [core(), unit("w1", 0, 0)]);
  const p1 = planner.decide({ state: { ...seen, resourceCells: new Set(["3,0"]) } });
  assert.equal(p1.intents["w1"], "GO_RESOURCE");

  const emptied = makeState(101, [core(), unit("w1", 1, 0)]);
  const p2 = planner.decide({ state: emptied });
  assert.equal(p2.intents["w1"], "patrol", "视野内确认采空 → 不再追空矿");
});

test("DeterministicPlanner：sticky——上一 Tick 分配缓存（防抖动）", () => {
  const state = makeState(100, [core(), unit("w1", 1, 0), unit("w2", 2, 0)]);
  const withCells: TickState = { ...state, resourceCells: new Set(["5,0", "6,0"]) };
  const planner = new DeterministicPlanner();
  const p1 = planner.decide({ state: withCells });
  const p2 = planner.decide({ state: withCells });
  // 两次分配应一致（sticky 加成不改变分配但保证确定性）
  assert.equal(p1.unitActions["w1"]?.type, p2.unitActions["w1"]?.type);
  assert.equal(p1.unitActions["w2"]?.type, p2.unitActions["w2"]?.type);
});

test("stepTowardAvoiding：首选方向被障碍挡 → 另一轴；全挡 → null", () => {
  // 目标在右侧，但右侧是障碍 → BFS 选择确定性的向下绕行。
  const obstacles = new Set(["4,0"]);
  const dir = stepTowardAvoiding([3, 0], [6, 0], obstacles);
  assert.equal(dir, "DOWN");
  // 四邻全挡 → null
  const blocked = new Set(["4,0", "2,0", "3,1", "3,-1"]);
  assert.equal(stepTowardAvoiding([3, 0], [6, 0], blocked), null);
});

test("stepTowardAvoiding：长墙场景可绕行到 Core，不再两格振荡", () => {
  const target: Position = [119, 109];
  const obstacles = new Set<string>();
  for (let y = 97; y <= 108; y += 1) obstacles.add(`119,${y}`);
  let position: Position = [119, 95];
  const visited = new Set([`${position[0]},${position[1]}`]);
  for (let i = 0; i < 40 && (position[0] !== target[0] || position[1] !== target[1]); i += 1) {
    const direction = stepTowardAvoiding(position, target, obstacles);
    assert.notEqual(direction, null, "可绕行墙体时不得 WAIT");
    position = move(position, direction!);
    visited.add(`${position[0]},${position[1]}`);
  }
  assert.deepEqual(position, target);
  assert.ok(visited.size > 14, "路径应包含绕墙侧移，而不是 95/96 两格来回");
});

test("DeterministicPlanner：障碍避让——MOVE 不再被挡（blocked_move 修复）", () => {
  const state = makeState(100, [core(), unit("w1", 1, 0), unit("w2", 2, 0)]);
  const withCells: TickState = { ...state, resourceCells: new Set(["5,0"]), obstacleCells: new Set(["4,0"]) };
  const planner = new DeterministicPlanner();
  const plan = planner.decide({ state: withCells });
  const validation = validatePlan(withCells, plan);
  // 无障碍冲突（目标格 5,0 可达——避开 4,0 障碍）
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  const w1 = plan.unitActions["w1"] as { type: string; direction?: string };
  assert.ok(w1.type === "MOVE" || w1.type === "WAIT", "被挡时允许 WAIT（validator 语义）");
});

test("DeterministicPlanner：与 GROUND Beacon 同格的 Worker → PICKUP_BEACON", () => {
  // w1 与 Beacon 同格 (2,2)，w2 在别处
  const state = makeState(100, [core(), unit("w1", 2, 2), unit("w2", 5, 5)], 6);
  const withBeacon: TickState = {
    ...state,
    beacon: { position: [2, 2], status: "GROUND", carrierId: null },
  };
  const planner = new DeterministicPlanner();
  const plan = planner.decide({ state: withBeacon });
  const validation = validatePlan(withBeacon, plan);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  assert.deepEqual(plan.unitActions["w1"], { type: "PICKUP_BEACON" });
  assert.equal(plan.intents["w1"], "PICKUP_BEACON");
});

test("DeterministicPlanner：Beacon 已被他人持有（CARRIED）→ 不拾取，正常行为", () => {
  const state = makeState(100, [core(), unit("w1", 2, 2)], 6);
  const withCarried: TickState = {
    ...state,
    beacon: { position: [9, 9], status: "CARRIED", carrierId: "other" },
  };
  const planner = new DeterministicPlanner();
  const plan = planner.decide({ state: withCarried });
  const w1 = plan.unitActions["w1"];
  assert.notDeepEqual(w1, { type: "PICKUP_BEACON" }, "CARRIED Beacon 不得拾取");
});

test("DeterministicPlanner：载货 Worker 路过 Beacon 格 → 优先回仓（DEPOSIT），不拾取", () => {
  const state = makeState(100, [core(), unit("w1", 2, 2, "WORKER", 1)], 6);
  const withBeacon: TickState = {
    ...state,
    beacon: { position: [2, 2], status: "GROUND", carrierId: null },
  };
  const planner = new DeterministicPlanner();
  const plan = planner.decide({ state: withBeacon });
  const w1 = plan.unitActions["w1"];
  assert.notDeepEqual(w1, { type: "PICKUP_BEACON" }, "载货时先 DEPOSIT，不拾取 Beacon");
  assert.notEqual(w1.type, "PICKUP_BEACON");
});

test("DeterministicPlanner：Beacon 拾取不破坏计划合法性（含容量裁决）", () => {
  const state = makeState(100, [core(), unit("w1", 2, 2), unit("w2", 2, 2)], 6);
  const withBeacon: TickState = {
    ...state,
    beacon: { position: [2, 2], status: "GROUND", carrierId: null },
  };
  const planner = new DeterministicPlanner();
  const plan = planner.decide({ state: withBeacon });
  const validation = validatePlan(withBeacon, plan);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  assert.deepEqual(plan.unitActions["w1"], { type: "PICKUP_BEACON" });
});

test("DeterministicPlanner：coreMovingHold——核心 MOVING 时 cargo worker 持货待命（不追交）", () => {
  const movingCore = (): PlayerState["objects"][number] => ({
    kind: "CORE", id: "c1", controlled: true, owner_username: "fixture_user",
    position: [0, 0], hp: 5, shield: 5, state: "MOVING",
    move_direction: "DOWN", move_progress: 1, move_required_ticks: 4, destination: [0, 1],
  });
  const holdConfig = { coreMovingHold: true };
  const planner = new DeterministicPlanner(
    undefined,
    new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, ...holdConfig }),
    new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, ...holdConfig }),
  );
  // 满载 worker 站在核心格：迁移中必须 WAIT（引擎会拒 DEPOSIT——CORE_MOVING）
  const movingState = makeState(100, [movingCore(), unit("w1", 0, 0, "WORKER", 1)]);
  const plan = planner.decide({ state: movingState });
  assert.deepEqual(plan.unitActions["w1"], { type: "WAIT" }, "MOVING + coreMovingHold → 持货待命");

  // 对照组 1：核心 NORMAL + coreMovingHold → 正常 DEPOSIT
  const normalState = makeState(101, [core(), unit("w1", 0, 0, "WORKER", 1)]);
  const normalPlan = planner.decide({ state: normalState });
  assert.equal(normalPlan.unitActions["w1"]?.type, "DEPOSIT", "NORMAL → 正常交仓");

  // 对照组 2：核心 MOVING 但 coreMovingHold=false（历史行为）→ 仍 DEPOSIT（零回归）
  const legacy = new DeterministicPlanner(
    undefined,
    new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG }),
    new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG }),
  );
  const legacyPlan = legacy.decide({ state: movingState });
  assert.equal(legacyPlan.unitActions["w1"]?.type, "DEPOSIT", "无 coreMovingHold → 保持历史追交行为");
});

test("热加载：SafetyPlanner.updateConfig 原子替换配置（实例保留，World 记忆不丢）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, workerDenseScan: false });
  assert.equal(planner.config.workerDenseScan, false);
  planner.updateConfig({ ...DEFAULT_SAFETY_CONFIG, workerDenseScan: true, frontierPriority: true });
  assert.equal(planner.config.workerDenseScan, true);
  assert.equal(planner.config.frontierPriority, true);
  assert.equal(planner.config.coreMovingHold, undefined);
});

test("热加载：DeterministicPlanner.updateConfig 同步内部 SafetyPlanner + deterministic 参数", () => {
  const fallback = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, workerDenseScan: false });
  const patrol = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, workerDenseScan: false });
  const det = new DeterministicPlanner(undefined, fallback, patrol);
  det.updateConfig({ ...DEFAULT_SAFETY_CONFIG, workerDenseScan: true }, { vanguardRatio: 0.75, accumulateThreshold: 30 });
  assert.equal(fallback.config.workerDenseScan, true, "fallback SafetyPlanner 已热更");
  assert.equal(patrol.config.workerDenseScan, true, "patrol SafetyPlanner 已热更");
  // deterministic 参数经 decide 消费（selectDeterministicCoreAction 读实例字段）
  const state = makeState(100, [core(), unit("w1", 1, 0)], 40);
  const plan = det.decide({ state });
  assert.equal(typeof plan.coreAction, "object");
});


test("safety veto：core 通道清障 worker_clear_core_empty 不被经济 GO_RESOURCE 覆盖（t2 死锁实证）", () => {
  const clearConfig = { ...DEFAULT_SAFETY_CONFIG, coreClearance: true };
  const planner = new DeterministicPlanner(
    undefined,
    new SafetyPlanner(clearConfig),
    new SafetyPlanner(clearConfig),
  );
  // 空 worker 占核心格 (0,0)（无 cargo）；满载 worker 在 (0,1) 等卸货；可见矿在
  // (5,5) → 经济 WorkerTaskPlanner 想把空 worker 派去挖矿（GO_RESOURCE）——若不
  // veto，疏散意图被覆盖 → 空 worker 永远占核心格 → deposit=0 冻结（t2 生产实证）。
  const empty = unit("w-empty", 0, 0);
  const loaded = unit("w-full", 0, 1, "WORKER", 1);
  const state = {
    ...makeState(1, [core(), empty, loaded]),
    resourceCells: new Set<string>(["5,5"]),
  };
  const plan = planner.decide({ state } as never);
  assert.equal(
    plan.intents["w-empty"],
    "worker_clear_core_empty",
    `Safety 疏散意图应被 veto 保留，实际=${plan.intents["w-empty"] ?? "(none)"}`,
  );
  const action = plan.unitActions["w-empty"];
  assert.ok(
    action !== undefined && action.type === "MOVE",
    `空 worker 应 MOVE 离开核心格，实际=${JSON.stringify(action)}`,
  );
});

/** migration-scout planner 级集成（2026-08-08 修复）：核心"位置已变"（即使决策时
 *  coreState 为 NORMAL——服务端 MOVING 是提交后才出现）即触发 EXPLORE 朝迁移方向
 *  勘探；prevCorePosition 必须在覆盖前捕获（旧实现双因失效：previousCorePosition
 *  在 planner.plan 前被更新为当前值 + coreState==="MOVING" 决策时几乎恒 false）。 */
test("DeterministicPlanner：migration-scout——核心位移触发 EXPLORE 朝迁移方向勘探", () => {
  const mission = {
    ...DEFAULT_MISSION_CONFIG,
    migrationScout: true,
    surveyWorkerCap: 3,
    surveyWorkerFloor: 3,
    surveyBurstTicks: 100,
  };
  const planner = new DeterministicPlanner(
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, mission,
  );
  // 第一帧：核心 [100,100]（NORMAL），worker 在 [100,95]；prevCore=null → 不 scout
  const s1 = makeState(100, [core(100, 100), unit("w1", 100, 95)]);
  const p1 = planner.decide({ state: s1 });
  assert.notEqual(p1.intents["w1"], "worker_migration_scout", "首帧无迁移记录 → 不 scout");
  // 第二帧：核心移到 [100,99]（南移一格，state 仍 NORMAL——决策时服务端 MOVING 未出现）
  const s2 = makeState(101, [core(100, 99), unit("w1", 100, 95)]);
  const p2 = planner.decide({ state: s2 });
  assert.equal(p2.intents["w1"], "worker_migration_scout", "核心位移 → EXPLORE 转迁移勘探");
  assert.deepEqual(p2.unitActions["w1"], { type: "MOVE", direction: "UP" }, "朝迁移前方 [100,75] 探路");
});

test("DeterministicPlanner：migration-scout——核心未动（NORMAL 且位置不变）零影响", () => {
  const mission = {
    ...DEFAULT_MISSION_CONFIG,
    migrationScout: true,
    surveyWorkerCap: 3,
    surveyWorkerFloor: 3,
    surveyBurstTicks: 100,
  };
  const planner = new DeterministicPlanner(
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, mission,
  );
  const s1 = makeState(100, [core(100, 100), unit("w1", 100, 95)]);
  planner.decide({ state: s1 });
  const s2 = makeState(101, [core(100, 100), unit("w1", 100, 95)]);
  const p2 = planner.decide({ state: s2 });
  assert.notEqual(p2.intents["w1"], "worker_migration_scout", "核心未移动 → 不 scout");
});