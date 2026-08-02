/**
 * DeterministicPlanner 适配测试（leader 集成，离线 fixture）。
 *
 * 验收口径：Task → UnitAction 确定性映射、唯一性（同一资源格最多一个 Worker）、
 * 与 SafetyPlanner 接口可互换（decide({ state }) → Plan）、输出过 validatePlan。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Turn, type PlayerState } from "@arena/arena-hero-ts";

import { DeterministicPlanner, stepToward } from "../src/planning/deterministic-planner.ts";
import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import { validatePlan } from "../src/domain/plan-validator.ts";
import type { TickState } from "../src/domain/model.ts";

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

test("DeterministicPlanner：非 Worker（Vanguard）→ WAIT（骨架只分配 Worker）", () => {
  const state = makeState(100, [core(), unit("w1", 1, 0, "WORKER"), unit("v1", 1, 2, "VANGUARD")]);
  const planner = new DeterministicPlanner();
  const plan = planner.decide({ state });
  assert.equal(plan.unitActions["v1"]?.type, "WAIT");
  assert.equal(plan.intents["v1"], "WAIT");
  assert.equal(plan.unitActions["w1"]?.type, "WAIT"); // 无资源格 → WAIT
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
