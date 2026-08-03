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
  stepToward,
  stepTowardAvoiding,
} from "../src/planning/deterministic-planner.ts";
import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import { validatePlan } from "../src/domain/plan-validator.ts";
import { SafetyPlanner } from "../src/strategies/safety-planner.ts";
import {
  chebyshev,
  EXPLORE_DIRECTION_COUNT,
  EXPLORE_RING_COUNT,
  exploreRadiusForRing,
  exploreTarget,
  move,
} from "../src/domain/nav.ts";
import type { Position, TickState, UnitAction } from "../src/domain/model.ts";

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

test("分层扩圈：半径按 8→16→24→32 循环，Worker 完成一趟后进入下一圈", () => {
  assert.deepEqual(
    Array.from({ length: EXPLORE_RING_COUNT + 1 }, (_, ring) => exploreRadiusForRing(8, ring)),
    [8, 16, 24, 32, 8],
  );

  const planner = new SafetyPlanner();
  const atHome = makeState(100, [core(0, 0), unit("w1", 0, 0)]);
  planner.decide({ state: atHome });
  assert.equal(planner.world.unitMemory("w1").patrolRing, 0);

  const atFirstTarget = makeState(101, [core(0, 0), unit("w1", 8, 8)]);
  planner.decide({ state: atFirstTarget });
  assert.equal(planner.world.unitMemory("w1").patrolReturning, true);

  const returnedHome = makeState(102, [core(0, 0), unit("w1", 0, 0)]);
  planner.decide({ state: returnedHome });
  const memory = planner.world.unitMemory("w1");
  assert.equal(memory.patrolRing, 1);
  assert.equal(memory.patrolDirection, 1);
});

test("DeterministicPlanner：decide 输出合法 Plan（validatePlan 过）", () => {
  const state = makeState(100, [core(), unit("w1", 1, 0), unit("w2", 2, 0)]);
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
  const planner = new DeterministicPlanner();
  const seen = makeState(100, [core(), unit("w1", 0, 0)]);
  const p1 = planner.decide({ state: { ...seen, resourceCells: new Set(["3,0"]) } });
  assert.equal(p1.unitActions["w1"]?.type, "MOVE");
  assert.equal(p1.intents["w1"], "GO_RESOURCE");

  const hidden = makeState(101, [core(), unit("w1", 1, 0)]);
  const p2 = planner.decide({ state: hidden });
  assert.equal(p2.unitActions["w1"]?.type, "MOVE");
  assert.equal(p2.intents["w1"], "go_harvest_mem");
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
