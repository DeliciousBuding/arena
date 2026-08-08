/**
 * W8 explore-radius-wide-v1 消费接线测试（2026-08-09）。
 *
 * 覆盖 safety-planner.ts decideWorker 的 exploreRadiusWide 消费：
 *  - exploreRadiusWide=true 时用 WIDE_EXPLORE_DEFAULTS.exploreRadius（16）替代
 *    默认 8 作为 exploreRadiusForRing 的 base radius；
 *  - 与 W38 hunger-gate 正交（W8 管 base radius，W38 管 ring cap）；
 *  - 默认关闭 → base = config.exploreRadius（8），零回归。
 *
 * 纯函数 / WIDE_EXPLORE_DEFAULTS 常量由 explore-radius-wide.test.ts 覆盖；本测试
 * 只验 safety-planner 侧的"消费接线"——base radius 切换 + 零回归 + 与 hunger-gate 正交。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { SafetyPlanner, DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";
import type { TickState } from "../src/domain/model.ts";

/**
 * 几何设计（让 wide on/off 产生可观测的 DIRECTION 差异）：
 *  - home=[0,0]，beacon=[101,101]（SE → exploreOctant base=1）。
 *  - worker 0 的 patrol direction = (0*3+7)%8 = 7；norm=(1+7)%8=0 → DELTAS[0]=[1,0]
 *    → patrolPoint = [radius, 0]（纯东向）。
 *  - worker 在 [20,0]：chebyshev=20 ≥ ring0 radius（8 或 16）→ 进入"到达/越环"
 *    分支，升 ring 0→1，target = patrolPoint at ring1。
 *    - wide OFF: ring1 = exploreRadiusForRing(8,1) = 16 → target [16,0] → worker[20,0] 向 LEFT。
 *    - wide ON:  ring1 = exploreRadiusForRing(16,1) = 32 → target [32,0] → worker[20,0] 向 RIGHT。
 *  方向 LEFT vs RIGHT 干净区分 base radius 切换。
 */
function makeWideState(): TickState {
  return {
    tick: 100,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [{ id: "w1", position: [20, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
    workers: [{ id: "w1", position: [20, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
    vanguards: [],
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [101, 101], status: "GROUND", carrierId: null },
    events: [],
  };
}

function actionDirection(plan: { unitActions: Readonly<Record<string, { type: string; direction?: string }>> }, id: string): string {
  const action = plan.unitActions[id];
  assert.ok(action !== undefined && action.type === "MOVE", `${id} 应为 MOVE`);
  assert.ok(action.direction !== undefined, `${id} MOVE 应有 direction`);
  return action.direction!;
}

// ── 零回归：默认关闭 → base radius=8 → ring1 target [16,0] → LEFT ────────

test("exploreRadiusWide 默认关闭：base=8，worker 向 [16,0] = LEFT（零回归）", () => {
  const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  const plan = planner.decide({ state: makeWideState() });
  assert.equal(actionDirection(plan, "w1"), "LEFT", "base=8 → ring1 target [16,0] → LEFT");
});

// ── 开启 → base=16，ring1 target [32,0] → RIGHT ──────────────────────────

test("exploreRadiusWide 开启：base=16，worker 向 [32,0] = RIGHT", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, exploreRadiusWide: true });
  const plan = planner.decide({ state: makeWideState() });
  assert.equal(actionDirection(plan, "w1"), "RIGHT", "base=16 → ring1 target [32,0] → RIGHT");
});

// ── ON vs OFF 方向不同 → 干净证明 base radius 切换 ────────────────────────

test("exploreRadiusWide ON vs OFF 产生不同 patrol 方向（base radius 切换证据）", () => {
  const off = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  const on = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, exploreRadiusWide: true });
  const planOff = off.decide({ state: makeWideState() });
  const planOn = on.decide({ state: makeWideState() });
  assert.notEqual(
    actionDirection(planOff, "w1"),
    actionDirection(planOn, "w1"),
    "wide on/off 改变 patrol 半径 → 不同方向",
  );
});

// ── 显式 false = 零回归（与 undefined 同）────────────────────────────────

test("exploreRadiusWide=false 显式关闭 = 零回归（同默认）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, exploreRadiusWide: false });
  const plan = planner.decide({ state: makeWideState() });
  assert.equal(actionDirection(plan, "w1"), "LEFT", "显式 false 同默认 base=8");
});

// ── 与 W38 hunger-gate 正交：wide + hungerGate 同时开仍正常 ───────────────

test("exploreRadiusWide + hungerGate 联动：base=16 + 饥饿放开远环（无异常）", () => {
  // worker 在 [20,0] 且从未采集（lastHarvest=0），tick=100，gateTicks=200 → 未饥饿
  // （100-0=100 ≤ 200）→ patrolRing 锁 nearCap(2)。wide base=16 + ring cap 2。
  // 联动应正常产 MOVE（不报错、行为合法）。
  const planner = new SafetyPlanner({
    ...DEFAULT_SAFETY_CONFIG,
    exploreRadiusWide: true,
    hungerGate: true,
  });
  const plan = planner.decide({ state: makeWideState() });
  assert.ok(plan.unitActions["w1"] !== undefined, "wide+hunger 联动产动作");
  // wide on → base=16 → ring1 target [32,0] → RIGHT（hungerGate 未饥饿不锁死 ring1）
  assert.equal(actionDirection(plan, "w1"), "RIGHT");
});

// ── wide 开启不影响 military patrol（Vanguard/Ranger 仍用 config.exploreRadius）──

test("exploreRadiusWide 开启：Vanguard patrol 不受 wide 影响（W8 仅 worker）", () => {
  // 一个 Vanguard 在 [20,0]，无敌人 → 走既有守位/巡逻（military 不消费 W8）。
  // 关键验证：不报错 + 行为合法（MOVE/WAIT），不因 wide 切换崩溃。
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, exploreRadiusWide: true });
  const state: TickState = {
    ...makeWideState(),
    units: [{ id: "v1", position: [20, 0], hp: 4, unitType: "VANGUARD", cargo: 0 }],
    workers: [],
    vanguards: [{ id: "v1", position: [20, 0], hp: 4, unitType: "VANGUARD", cargo: 0 }],
    rangers: [],
    population: 1,
  };
  const plan = planner.decide({ state });
  assert.ok(plan.unitActions["v1"] !== undefined, "Vanguard 有动作");
  const action = plan.unitActions["v1"]!;
  assert.ok(
    action.type === "MOVE" || action.type === "WAIT" || action.type === "SWEEP",
    "Vanguard 动作合法（不因 wide 崩溃）",
  );
});
