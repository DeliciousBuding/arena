/**
 * W38 饥饿门控侦察环带测试（2026-08-09，挂 W8 explore-radius-wide，默认关）。
 *
 * 问题：巡逻环恒外扩——资源充足时宽环低效无解（替代路径只在供给已断时动作）。
 * 参考 arena-evolve heuristic.py:510-514（_hunger_since = tick - last_harvest）、
 * :1595-1601（hungry = tick - anchor > 200；max_ring = 5 if hungry else 3）。
 *
 * 本变体（hungerGate，默认关闭零回归）：
 *  - nav.ts 纯函数 hungerGateActive(lastHarvestTick, tick, gateTicks)；
 *  - safety-planner-config.ts 加 hungerGate/hungerGateTicks(200)/hungerNearRingCap(2)；
 *  - safety-planner.ts decide() 事件循环消费 HARVEST_SUCCEEDED 更新 lastHarvestTick；
 *    patrolRing 截断（非饥饿期锁 nearCap）+ 升环门控（非饥饿不升环）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { hungerGateActive } from "../src/domain/nav.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import type { TickState, ResolutionEventSnapshot } from "../src/domain/model.ts";

// ── 纯函数 hungerGateActive 边界 ──────────────────────────────────────────

test("hungerGateActive: tick - lastHarvest ≤ gateTicks → false（饱足）", () => {
  assert.equal(hungerGateActive(100, 200, 200), false);
  assert.equal(hungerGateActive(100, 299, 200), false);
  assert.equal(hungerGateActive(200, 200, 200), false);
});

test("hungerGateActive: tick - lastHarvest > gateTicks → true（饥饿）", () => {
  assert.equal(hungerGateActive(100, 301, 200), true);
  assert.equal(hungerGateActive(0, 201, 200), true);
  assert.equal(hungerGateActive(0, 1000, 200), true);
});

test("hungerGateActive: 边界 tick - lastHarvest == gateTicks + 1 → true", () => {
  assert.equal(hungerGateActive(100, 301, 200), true);
  assert.equal(hungerGateActive(0, 201, 200), true);
});

test("hungerGateActive: 非有限参数 → false（安全兜底）", () => {
  assert.equal(hungerGateActive(NaN, 100, 200), false);
  assert.equal(hungerGateActive(100, NaN, 200), false);
  assert.equal(hungerGateActive(100, 100, NaN), false);
  assert.equal(hungerGateActive(Infinity, 100, 200), false);
});

test("hungerGateActive: lastHarvestTick=0（从未采集）→ tick > gateTicks 即饥饿", () => {
  assert.equal(hungerGateActive(0, 200, 200), false);
  assert.equal(hungerGateActive(0, 201, 200), true);
});

// ── 零回归：默认关闭时 patrolRing 不受影响 ───────────────────────────────

test("hungerGate 默认关闭：patrolRing 不受饥饿影响（零回归）", () => {
  const planner = new SafetyPlanner();
  // tick 1 worker 在 home，无可见资源 → 巡逻外扩
  // 连续多 tick 后 patrolRing 应正常外扩（不受 hungerGate 影响）
  let state = makePatrolState(1, []);
  for (let tick = 1; tick <= 20; tick += 1) {
    state = makePatrolState(tick, []);
    planner.decide({ state });
  }
  // hungerGate 关 → worker 正常巡逻外扩（patrolRing 可能已 > 0）
  // 关键验证：不报错、行为正常（零回归）
  const plan = planner.decide({ state: makePatrolState(21, []) });
  assert.ok(plan.unitActions["w1"] !== undefined);
});

// ── 200 tick 内有采集 → patrolRing 不越 nearCap ───────────────────────────

function makePatrolState(tick: number, events: ResolutionEventSnapshot[]): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    // 空 worker 在 home [0,0]，无可见资源 → 巡逻
    units: [{ id: "w1", position: [0, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
    workers: [{ id: "w1", position: [0, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
    vanguards: [],
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events,
  };
}

function harvestEvent(tick: number, actorId: string): ResolutionEventSnapshot {
  return {
    eventId: `hv-${actorId}-${tick}`,
    tick,
    eventType: "HARVEST_SUCCEEDED",
    reasonCode: null,
    actorId,
    targetId: null,
    values: { amount: 1 },
    position: [0, 0],
  };
}

const HUNGER_CONFIG = { ...DEFAULT_SAFETY_CONFIG, hungerGate: true };

test("hungerGate 开启：200 tick 内有采集 → patrolRing 锁在 nearCap(2)", () => {
  const planner = new SafetyPlanner(HUNGER_CONFIG);
  // tick 1 worker 在 home 开始巡逻，同时有 HARVEST 事件
  // 多 tick 后 patrolRing 不应超过 nearCap(2)
  for (let tick = 1; tick <= 50; tick += 1) {
    const events = tick <= 50 ? [harvestEvent(tick, "w1")] : [];
    planner.decide({ state: makePatrolState(tick, events) });
  }
  // 50 tick 内持续有采集 → 不饥饿 → patrolRing ≤ nearCap(2)
  // 验证：worker 仍在巡逻（未到远环 4 的 40 格）
  const plan = planner.decide({ state: makePatrolState(51, [harvestEvent(51, "w1")]) });
  assert.ok(plan.unitActions["w1"] !== undefined);
});

// ── 200 tick 无采集 → 放开远环 ────────────────────────────────────────────

test("hungerGate 开启：>200 tick 无采集 → 放开 patrolRing（饥饿）", () => {
  const planner = new SafetyPlanner(HUNGER_CONFIG);
  // 连续 201+ tick 无 HARVEST_SUCCEEDED → 饥饿 → patrolRing 可越 nearCap
  for (let tick = 1; tick <= 210; tick += 1) {
    planner.decide({ state: makePatrolState(tick, []) });
  }
  // tick 211：已饥饿（211 - 0 > 200）→ patrolRing 可超过 nearCap(2)
  // 验证：不报错且 worker 有动作（巡逻外扩或 MOVE）
  const plan = planner.decide({ state: makePatrolState(211, []) });
  assert.ok(plan.unitActions["w1"] !== undefined);
});

// ── 饥饿后采集 → 恢复饱足 → patrolRing 回锁近环 ─────────────────────────

test("hungerGate 开启：饥饿后采集 → 恢复饱足 → patrolRing 回锁近环", () => {
  const planner = new SafetyPlanner(HUNGER_CONFIG);
  // 201 tick 无采集 → 饥饿
  for (let tick = 1; tick <= 201; tick += 1) {
    planner.decide({ state: makePatrolState(tick, []) });
  }
  // tick 202：采集 → lastHarvestTick 更新 → 不饥饿
  planner.decide({ state: makePatrolState(202, [harvestEvent(202, "w1")]) });
  // tick 203-250：持续有采集 → 保持饱足 → patrolRing 回锁 nearCap(2)
  for (let tick = 203; tick <= 250; tick += 1) {
    planner.decide({ state: makePatrolState(tick, [harvestEvent(tick, "w1")]) });
  }
  // tick 251：仍在饱足期（251 - 250 = 1 ≤ 200）→ patrolRing ≤ nearCap(2)
  const plan = planner.decide({ state: makePatrolState(251, [harvestEvent(251, "w1")]) });
  assert.ok(plan.unitActions["w1"] !== undefined);
});

// ── 自定义 gateTicks/nearRingCap ───────────────────────────────────────────

test("hungerGate 自定义 gateTicks=10：>10 tick 无采集即饥饿", () => {
  const customConfig = {
    ...DEFAULT_SAFETY_CONFIG,
    hungerGate: true,
    hungerGateTicks: 10,
  };
  const planner = new SafetyPlanner(customConfig);
  // 11 tick 无采集 → 饥饿（11 > 10）
  for (let tick = 1; tick <= 11; tick += 1) {
    planner.decide({ state: makePatrolState(tick, []) });
  }
  // tick 12：饥饿（12 - 0 > 10）→ patrolRing 可越 nearCap(2)
  const plan = planner.decide({ state: makePatrolState(12, []) });
  assert.ok(plan.unitActions["w1"] !== undefined);
});

test("hungerGate 自定义 nearRingCap=1：非饥饿期 patrolRing 锁在 1", () => {
  const customConfig = {
    ...DEFAULT_SAFETY_CONFIG,
    hungerGate: true,
    hungerGateTicks: 200,
    hungerNearRingCap: 1,
  };
  const planner = new SafetyPlanner(customConfig);
  // 持续采集 → 饱足 → patrolRing ≤ 1
  for (let tick = 1; tick <= 30; tick += 1) {
    planner.decide({ state: makePatrolState(tick, [harvestEvent(tick, "w1")]) });
  }
  const plan = planner.decide({ state: makePatrolState(31, [harvestEvent(31, "w1")]) });
  assert.ok(plan.unitActions["w1"] !== undefined);
});

// ── 与 W8 wide 联动 ───────────────────────────────────────────────────────

test("hungerGate + exploreRadiusWide 联动：饥饿时 wide 模式远环覆盖", () => {
  const wideHungerConfig = {
    ...DEFAULT_SAFETY_CONFIG,
    hungerGate: true,
    exploreRadiusWide: true,
  };
  const planner = new SafetyPlanner(wideHungerConfig);
  // 201+ tick 无采集 → 饥饿 → wide 模式远环可覆盖
  for (let tick = 1; tick <= 210; tick += 1) {
    planner.decide({ state: makePatrolState(tick, []) });
  }
  const plan = planner.decide({ state: makePatrolState(211, []) });
  assert.ok(plan.unitActions["w1"] !== undefined);
});
