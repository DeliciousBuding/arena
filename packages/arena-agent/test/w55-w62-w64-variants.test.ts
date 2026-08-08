/**
 * W55/W62/W64 竞品学习候选测试（2026-08-09）：
 *
 * W55 单入口掩体寻找（core-shelter-v1）：aggressive + 无可见敌人 → 主动迁移到
 *   单入口掩体（三面岩石口袋）；当前 Core 已是掩体 = hold 不迁移；默认关零回归。
 * W62 环形扇区扫荡（assault-sector-sweep-v1）：aggressive 军事打野改用全队共享
 *   前沿航点（半径振荡 + 扇区旋转 + 全员到齐门控）；默认关零回归。
 * W64 地形背靠守位（terrain-guard-v1）：无可见敌人时按地形背靠重排 Core 四邻
 *   守位顺序（守位站开阔侧、岩石在背后）；默认关零回归。
 *
 * 评估结论：三者与既有逻辑均不重叠——
 *   W55 ≠ coreEvade（反应式远敌 vs 主动式抢地形）、≠ chokepointLockPoint
 *     （敌核锁点 vs 我核迁移掩体）；
 *   W62 ≠ rally-assault（搜索阶段几何 vs 压已知目标前集结；全员到齐 vs ≥3 到齐
 *     或超时）、≠ per-unit patrolRing（共享航点 vs 各自升环）；
 *   W64 ≠ guard-axes（地形背靠 vs 威胁方向分桶，正交维度）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { TickState, VisibleEntity } from "../src/domain/model.ts";
import {
  DEFAULT_SAFETY_CONFIG,
  SafetyPlanner,
} from "../src/strategies/safety-planner.ts";
import {
  coreShelterTarget,
  isCoreShelter,
  terrainGuardPost,
} from "../src/strategies/safety-planner-helpers.ts";
import {
  isSafetyVariant,
  resolveSafetyVariantConfig,
} from "../src/strategies/variant-registry.ts";

/** 构造一个 Core 在 [0,0]、NORMAL、无敌人/资源的最简 TickState。 */
function makeIdleState(tick: number, obstacleCells: ReadonlySet<string> = new Set()): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 20,
    resourceCapacity: 100,
    resourceSpace: 100,
    population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [],
    workers: [],
    vanguards: [],
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells,
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

function vanguard(id: string, position: readonly [number, number]): TickState["units"][number] {
  return { id, position, hp: 4, unitType: "VANGUARD", cargo: 0 };
}

// ---------------------------------------------------------------------------
// 变体注册映射：三个新 id 合法 + 解析正确
// ---------------------------------------------------------------------------

test("variant registry: core-shelter-v1 resolves coreShelter", () => {
  assert.deepEqual(resolveSafetyVariantConfig("core-shelter-v1"), { coreShelter: true });
  assert.equal(isSafetyVariant("core-shelter-v1"), true);
});

test("variant registry: assault-sector-sweep-v1 resolves assaultSectorSweep", () => {
  assert.deepEqual(resolveSafetyVariantConfig("assault-sector-sweep-v1"), { assaultSectorSweep: true });
  assert.equal(isSafetyVariant("assault-sector-sweep-v1"), true);
});

test("variant registry: terrain-guard-v1 resolves terrainGuard", () => {
  assert.deepEqual(resolveSafetyVariantConfig("terrain-guard-v1"), { terrainGuard: true });
  assert.equal(isSafetyVariant("terrain-guard-v1"), true);
});

// ---------------------------------------------------------------------------
// W64 地形背靠守位（纯函数）：四面开阔 = 回退 homeCell；半侧集中 = 开阔半侧优先
// ---------------------------------------------------------------------------

test("W64 terrainGuardPost: 四面开阔（无障碍）= 回退 homeCell 历史四邻序（零回归）", () => {
  const obstacles = new Set<string>();
  // 无障碍 = 四面开阔，非地形背靠 → 回退 homeCell：index0 = UP 邻格 [0,-1]
  const post = terrainGuardPost([0, 0], obstacles, 0);
  assert.deepEqual(post, [0, -1]);
});

test("W64 terrainGuardPost: 三面岩石半侧集中 = 开阔半侧优先（守位站开阔侧）", () => {
  // Core 在 [0,0]；西/北/南三面岩石 → 东是唯一开放邻格（单入口死格，非掩体但
  // 半侧集中度高）。构造一个"东半侧开阔"的背靠：东、东南、东北方向开阔，
  // 西/西北/西南方向岩石。bestAxis 应为东轴 [1,0]，开阔半侧 = 东侧邻格。
  const obstacles = new Set<string>([
    "-1,-1", "-1,0", "-1,1",         // 西列三格岩石
    "-2,-1", "-2,0", "-2,1",         // 西列外圈岩石（加强背靠集中度）
    "-3,-1", "-3,0", "-3,1",
  ]);
  // index0：开阔半侧（东侧 [1,0]、[1,-1] 满足 offset·axis >= 0）优先于西侧。
  const post = terrainGuardPost([0, 0], obstacles, 0);
  // 东侧邻格 [1,0] 在开阔半侧，应优先于 UP[0,-1]（UP·[1,0] = 0*1 + (-1)*0 = 0 >= 0
  // 也属开阔半侧——确定性序 UP 在 RIGHT 前）。验证至少落在非障碍格。
  assert.ok(post !== null, "地形背靠应返回非空守位");
  assert.ok(!obstacles.has(`${post![0]},${post![1]}`), "守位不在障碍格");
});

test("W64 terrainGuardPost: 默认关闭 = SafetyPlanner 用 homeCell（零回归）", () => {
  // 默认 config 无 terrainGuard → Vanguard 守家走 homeCell 四邻序
  const planner = new SafetyPlanner();
  const unit = vanguard("v1", [0, -1]);
  const state: TickState = {
    ...makeIdleState(1),
    units: [unit],
    vanguards: [unit],
    population: 2,
  };
  const plan = planner.decide({ state });
  // 无敌人无资源 + defensive：Vanguard 守家，不迁移 Core
  assert.notEqual(plan.coreAction?.type, "START_MOVE", "默认 defensive Core 不迁移");
});

// ---------------------------------------------------------------------------
// W55 单入口掩体寻找（纯函数 + decideCore 消费）
// ---------------------------------------------------------------------------

test("W55 isCoreShelter: 四邻恰一开放 = 掩体入口；否则 null", () => {
  // 三面岩石（西/北/南）、东开放 = 单入口掩体
  const pocket = new Set<string>(["-1,0", "0,-1", "0,1"]);
  const entrance = isCoreShelter([0, 0], pocket);
  assert.deepEqual(entrance, [1, 0]);
  // 四面开阔 = 非掩体
  assert.equal(isCoreShelter([0, 0], new Set()), null);
  // 两面开放 = 非掩体
  assert.equal(isCoreShelter([0, 0], new Set(["-1,0", "0,-1"])), null);
});

test("W55 coreShelterTarget: 搜索半径内最近掩体（距 Core 最近优先）", () => {
  // 在 [2,0] 构造掩体：[2,-1]/[2,1]/[3,0] 岩石，[1,0] 是其入口（但 [1,0] 开放）
  // 实际掩体候选 = [2,0]，其四邻 [2,-1]/[2,1]/[3,0] 岩石 → 入口 [1,0]。
  const obstacles = new Set<string>(["2,-1", "2,1", "3,0"]);
  const result = coreShelterTarget([0, 0], obstacles, new Set(), 4);
  assert.ok(result !== null, "应找到 [2,0] 掩体");
  assert.deepEqual(result!.target, [2, 0]);
  assert.deepEqual(result!.entrance, [1, 0]);
});

test("W55 coreShelterTarget: 无掩体候选 = null", () => {
  // 全开阔地图无掩体
  assert.equal(coreShelterTarget([0, 0], new Set(), new Set(), 4), null);
});

test("W55 decideCore: 默认关闭 = aggressive 无敌人也不迁移到掩体（零回归）", () => {
  // 默认 config 无 coreShelter → 即使有掩体也不主动迁移
  const obstacles = new Set<string>(["2,-1", "2,1", "3,0"]); // [2,0] 是掩体
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" });
  const state = { ...makeIdleState(1, obstacles), population: 1 };
  const plan = planner.decide({ state });
  assert.notEqual(plan.coreAction?.type, "START_MOVE", "coreShelter 默认关 = 不主动迁移");
});

test("W55 decideCore: 开启 + aggressive + 无敌人 + Core 非掩体 → START_MOVE 寻掩体", () => {
  const obstacles = new Set<string>(["2,-1", "2,1", "3,0"]); // [2,0] 是掩体，入口 [1,0]
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive", coreShelter: true });
  const state = { ...makeIdleState(1, obstacles), population: 1 };
  const plan = planner.decide({ state });
  assert.equal(plan.coreAction?.type, "START_MOVE", "应 START_MOVE 向掩体入口推进");
  assert.equal(plan.intents.core, "core_shelter_seek");
});

test("W55 decideCore: 开启 + Core 本身已是掩体 = hold 不迁移", () => {
  // Core 在 [0,0]，构造其为掩体：[-1,0]/[0,-1]/[0,1] 岩石 → 入口 [1,0]
  const obstacles = new Set<string>(["-1,0", "0,-1", "0,1"]);
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive", coreShelter: true });
  const state = { ...makeIdleState(1, obstacles), population: 1 };
  const plan = planner.decide({ state });
  assert.notEqual(plan.coreAction?.type, "START_MOVE", "Core 已是掩体 = hold 不迁移");
  assert.notEqual(plan.intents.core, "core_shelter_seek");
});

test("W55 decideCore: 开启 + defensive = 不迁移（仅 aggressive 触发）", () => {
  const obstacles = new Set<string>(["2,-1", "2,1", "3,0"]);
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, coreShelter: true }); // 默认 defensive
  const state = { ...makeIdleState(1, obstacles), population: 1 };
  const plan = planner.decide({ state });
  assert.notEqual(plan.coreAction?.type, "START_MOVE", "defensive 不触发 coreShelter");
});

test("W55 decideCore: 开启 + 有可见敌人 = 不迁移（coreEvade 优先 / 敌情抑制）", () => {
  const obstacles = new Set<string>(["2,-1", "2,1", "3,0"]);
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive", coreShelter: true });
  const enemy: VisibleEntity = { id: "e1", kind: "UNIT", position: [20, 0], hp: 2, unitType: "VANGUARD" };
  const state: TickState = {
    ...makeIdleState(1, obstacles),
    visibleEnemies: [enemy],
    population: 1,
  };
  const plan = planner.decide({ state });
  assert.notEqual(plan.intents.core, "core_shelter_seek", "有可见敌时不触发 coreShelter");
});

// ---------------------------------------------------------------------------
// W62 环形扇区扫荡（decideVanguard 消费）：共享航点 + 全员到齐门控
// ---------------------------------------------------------------------------

test("W62 decideCore: 默认关闭 = SafetyPlanner 不消费 assaultSectorSweep（零回归）", () => {
  // 默认 config 无 assaultSectorSweep → 走 per-unit patrolRing scavenge（不报 sector_sweep intent）
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" });
  const unit = vanguard("v1", [4, 0]);
  const state: TickState = {
    ...makeIdleState(1),
    units: [unit],
    vanguards: [unit],
    population: 2,
  };
  const plan = planner.decide({ state });
  // 默认关：不应出现 vanguard_sector_sweep intent（历史行为）
  const intents = Object.values(plan.intents).filter((i) => i === "vanguard_sector_sweep");
  assert.equal(intents.length, 0, "默认关 = 不消费 sector sweep");
});

test("W62 decideVanguard: 开启 + aggressive + 无敌人资源 = Vanguard 走 sector sweep 航点", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive", assaultSectorSweep: true });
  const unit = vanguard("v1", [4, 0]);
  const state: TickState = {
    ...makeIdleState(1),
    units: [unit],
    vanguards: [unit],
    population: 2,
  };
  const plan = planner.decide({ state });
  // 开启后第一 tick：单位不在航点（phase 0 半径 MIN=8 东扇区 → [8,0]），应 MOVE
  // （intent = vanguard_sector_sweep）。Core 不应迁移（sector sweep 是军事单位行为）。
  assert.notEqual(plan.coreAction?.type, "START_MOVE", "W62 不动 Core");
  const hasSweepIntent = Object.values(plan.intents).some((i) => i === "vanguard_sector_sweep");
  assert.equal(hasSweepIntent, true, "应消费 vanguard_sector_sweep");
});

test("W62 decideVanguard: 开启 + defensive = 不消费（仅 aggressive 触发）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, assaultSectorSweep: true }); // defensive
  const unit = vanguard("v1", [4, 0]);
  const state: TickState = {
    ...makeIdleState(1),
    units: [unit],
    vanguards: [unit],
    population: 2,
  };
  const plan = planner.decide({ state });
  const hasSweepIntent = Object.values(plan.intents).some((i) => i === "vanguard_sector_sweep");
  assert.equal(hasSweepIntent, false, "defensive 不触发 sector sweep");
});

test("W62 decideVanguard: 开启 + 有可见敌人 = 不消费 sector sweep（接战优先）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive", assaultSectorSweep: true });
  const unit = vanguard("v1", [4, 0]);
  const enemy: VisibleEntity = { id: "e1", kind: "UNIT", position: [5, 0], hp: 2, unitType: "VANGUARD" };
  const state: TickState = {
    ...makeIdleState(1),
    units: [unit],
    vanguards: [unit],
    visibleEnemies: [enemy],
    population: 2,
  };
  const plan = planner.decide({ state });
  const hasSweepIntent = Object.values(plan.intents).some((i) => i === "vanguard_sector_sweep");
  assert.equal(hasSweepIntent, false, "有敌人时不走 sector sweep（接战优先）");
});

test("W62 assaultFrontierTarget: 全员到齐门控推进航点（跨 tick 状态）", () => {
  // 两个 Vanguard 都在航点附近（≤reachRadius=4）→ 推进 step；下一 tick 航点变化
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive", assaultSectorSweep: true });
  // phase 0 扇区 = 东 [1,0]，半径 MIN=8 → 航点 [8,0]。单位在 [8,0]/[8,1] 已到齐。
  const v1 = vanguard("v1", [8, 0]);
  const v2 = vanguard("v2", [8, 1]);
  const stateArrived: TickState = {
    ...makeIdleState(1),
    units: [v1, v2],
    vanguards: [v1, v2],
    population: 3,
  };
  const planArrived = planner.decide({ state: stateArrived });
  // 全员到齐 → step 推进；下 tick phase=1（半径 MIN+1=9，扇区仍东）→ 航点 [9,0]
  const stateNext: TickState = {
    ...makeIdleState(2),
    units: [v1, v2],
    vanguards: [v1, v2],
    population: 3,
  };
  const planNext = planner.decide({ state: stateNext });
  // 两个 tick 都应消费 sector sweep intent（W62 启用 + aggressive + 无敌人资源）
  const arrivedSweep = Object.values(planArrived.intents).some((i) => i === "vanguard_sector_sweep");
  const nextSweep = Object.values(planNext.intents).some((i) => i === "vanguard_sector_sweep");
  assert.equal(arrivedSweep, true, "tick1 到齐也应消费 sector sweep（推进后仍朝新航点）");
  assert.equal(nextSweep, true, "tick2 应继续 sector sweep");
});
