/**
 * 产兵让位测试（2026-08-08，spawnYield，用户研究驱动）：
 * 核心本 tick 计划 SPAWN 时，核心格/邻格的满载 worker 让位——DEPOSIT
 * Phase8 先于 SPAWN Phase10，worker 卸货成功仍占核心格会挡掉同 tick
 * SPAWN（生产 t2 实证 112 次 CORE_SPAWN_FAILED/CELL_UNIT_LIMIT）。
 * 默认关闭零回归。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SafetyPlanner, DEFAULT_SAFETY_CONFIG, type SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";
import type { Position, TickState } from "../src/domain/model.ts";

const CORE: Position = [0, 0];

function makeState(opts: {
  workers?: TickState["workers"];
  resources?: number;
  coreHp?: number;
  coreShield?: number;
} = {}): TickState {
  const workers = opts.workers ?? [
    // 满载 worker 在核心格上（cargo=1）
    { id: "w-full-on-core", position: [0, 0], hp: 2, unitType: "WORKER", cargo: 1 },
    { id: "w-empty", position: [5, 0], hp: 2, unitType: "WORKER", cargo: 0 },
  ];
  return {
    tick: 100,
    status: "ACTIVE",
    resources: opts.resources ?? 30,
    resourceCapacity: 30,
    resourceSpace: 30,
    population: 2,
    core: {
      id: "c1",
      position: CORE,
      hp: opts.coreHp ?? 5,
      shield: opts.coreShield ?? 5,
      state: "NORMAL",
      ownerUsername: "p1",
    },
    units: workers,
    workers,
    vanguards: [],
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

/** 产兵让位配置：spawnYield 开启 + 人口未满 + 资源足够产 WORKER(5)+reserveEarly(1)。 */
const YIELD_CONFIG: SafetyPlannerConfig = {
  ...DEFAULT_SAFETY_CONFIG,
  spawnYield: true,
  workerTarget: 8,
};

test("spawnYield：核心格满载 worker + 核心要产兵 → 让位（worker_yield_spawn）", () => {
  const planner = new SafetyPlanner(YIELD_CONFIG);
  const state = makeState();
  const plan = planner.decide({ state });
  const action = plan.unitActions["w-full-on-core"];
  assert.ok(action !== undefined, "expected action for w-full-on-core");
  assert.equal(plan.intents["w-full-on-core"], "worker_yield_spawn");
  assert.equal(action.type, "MOVE"); // 让出核心格
});

test("spawnYield：核心格满载 worker + 资源不够产兵 → 正常 DEPOSIT（不预判 spawn）", () => {
  const planner = new SafetyPlanner(YIELD_CONFIG);
  // 资源 3 < WORKER 成本 5 + reserve 1 → 核心不会 spawn → worker 正常卸货
  const state = makeState({ resources: 3 });
  const plan = planner.decide({ state });
  assert.equal(plan.intents["w-full-on-core"], "deposit");
  assert.equal(plan.unitActions["w-full-on-core"].type, "DEPOSIT");
});

test("spawnYield：邻格满载 worker + 核心要产兵 → WAIT 不进核心格", () => {
  const planner = new SafetyPlanner(YIELD_CONFIG);
  const state = makeState({
    workers: [
      { id: "w-adjacent", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 1 },
      { id: "w-empty", position: [5, 0], hp: 2, unitType: "WORKER", cargo: 0 },
    ],
  });
  const plan = planner.decide({ state });
  assert.equal(plan.intents["w-adjacent"], "worker_yield_spawn");
  assert.equal(plan.unitActions["w-adjacent"].type, "WAIT");
});

test("spawnYield：远处满载 worker 不受影响（正常 return_home）", () => {
  const planner = new SafetyPlanner(YIELD_CONFIG);
  const state = makeState({
    workers: [
      { id: "w-far", position: [10, 10], hp: 2, unitType: "WORKER", cargo: 1 },
      { id: "w-empty", position: [5, 0], hp: 2, unitType: "WORKER", cargo: 0 },
    ],
  });
  const plan = planner.decide({ state });
  assert.notEqual(plan.intents["w-far"], "worker_yield_spawn");
  assert.equal(plan.unitActions["w-far"].type, "MOVE"); // 走 return_home
});

test("spawnYield：连续让位超限 → 强制卸货（防让位饿死）", () => {
  const planner = new SafetyPlanner(YIELD_CONFIG);
  const state = makeState();
  // 第一次让位
  const p1 = planner.decide({ state });
  assert.equal(p1.intents["w-full-on-core"], "worker_yield_spawn");
  // 连续让位直到超限：SPAWN_YIELD_MAX_TICKS=3，第 4 次不再让位
  let sawYield = 0;
  for (let i = 0; i < 4; i++) {
    const p = planner.decide({ state });
    if (p.intents["w-full-on-core"] === "worker_yield_spawn") sawYield++;
  }
  assert.equal(sawYield, 3, "让位 3 次后应强制卸货");
});

test("spawnYield：默认关闭 → 历史行为（核心格满载 worker 直接 DEPOSIT）", () => {
  const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG); // spawnYield 未开
  const state = makeState();
  const plan = planner.decide({ state });
  assert.equal(plan.intents["w-full-on-core"], "deposit");
  assert.equal(plan.unitActions["w-full-on-core"].type, "DEPOSIT");
});

test("spawnYield：人口已满 → 核心不产兵 → 正常 DEPOSIT", () => {
  const planner = new SafetyPlanner({ ...YIELD_CONFIG, populationCeiling: 2 });
  const state = makeState(); // population=2 = ceiling
  const plan = planner.decide({ state });
  assert.equal(plan.intents["w-full-on-core"], "deposit");
});

test("spawnYield：核心受伤（hp<5）→ heal 优先 → 不预判 spawn → 正常 DEPOSIT", () => {
  const planner = new SafetyPlanner(YIELD_CONFIG);
  const state = makeState({ coreHp: 3 });
  const plan = planner.decide({ state });
  assert.equal(plan.intents["w-full-on-core"], "deposit");
});
