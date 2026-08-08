/** 攻坚集结测试（2026-08-08，guide "有护卫 Core 先退到安全集结点、全员到齐
 * 再共同出击"对照）：rally-assault-v1——aggressive 无可见敌人时对已知敌 Core 记忆
 * 攻坚，军事单位先到敌核外圈安全集结位（Chebyshev 5，敌守军 Vanguard 射程 1 /
 * Ranger 射程 3 之外）汇合，≥3 到齐或首到后 40 tick 超时再成建制压上——防逐个
 * 送死（t2 第二轮 jerkman 攻坚实证：5 Ranger 全灭、核心未破）。默认关闭零回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import type { CoreHuntTarget } from "../src/domain/world.ts";

function enemyCore(position: Position, owner?: string): VisibleEntity {
  return { id: "ec", kind: "CORE", position, hp: 5, unitType: "VANGUARD", ownerUsername: owner };
}

/** 构造战斗状态：militaryPositions 决定 Vanguard 出发点（默认家侧 [5,*]）。 */
function makeState(tick: number, enemies: VisibleEntity[], militaryPositions: readonly Position[], rangerPositions: readonly Position[] = []): TickState {
  const units = [];
  const vanguards = [];
  const rangers = [];
  for (let i = 0; i < militaryPositions.length; i++) {
    const id = `v${String(i).padStart(2, "0")}`;
    const u = { id, position: [...militaryPositions[i]] as Position, hp: 4, unitType: "VANGUARD" as const, cargo: 0 };
    units.push(u);
    vanguards.push(u);
  }
  for (let i = 0; i < rangerPositions.length; i++) {
    const id = `r${String(i).padStart(2, "0")}`;
    const u = { id, position: [...rangerPositions[i]] as Position, hp: 4, unitType: "RANGER" as const, cargo: 0 };
    units.push(u);
    rangers.push(u);
  }
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: militaryPositions.length,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units,
    workers: [],
    vanguards,
    rangers,
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const PRESSURE_POLICY = {
  posture: "aggressive" as const,
  workerTarget: 6,
  militaryRatio: 0.4,
  focusRegion: null,
  attackPriority: "core" as const,
};

/** 攻坚集结 base 配置：attackForce 2（2 军事即可过 gate）+ rallyAssault 开关。 */
function rallyConfig() {
  return {
    ...DEFAULT_SAFETY_CONFIG,
    aggression: "aggressive" as const,
    attackForce: 2,
    rallyAssault: true,
    militaryHunt: true,
    boundedRaid: true,
    enemyCoreMemoryTicks: 1200,
  };
}

/** 播种目标敌 Core（[49,0]，距家 49 < boundedRaid 64）+ tick1 目击注册记忆。 */
function seedCore(planner: SafetyPlanner): void {
  const targets: readonly CoreHuntTarget[] = [
    { position: [49, 0], lastSeenTick: 1, source: "CORE", owner: "jerkman" },
  ];
  planner.seedCoreHuntTargets(targets);
  planner.decide({ state: makeState(1, [enemyCore([49, 0], "jerkman")], []), policy: PRESSURE_POLICY });
}

function vanguardIntents(plan: { intents?: Record<string, string> }): string[] {
  return Object.entries(plan.intents ?? {})
    .filter(([id]) => id.startsWith("v"))
    .map(([, intent]) => intent);
}

const HOME_SIDE: readonly Position[] = [
  [5, 0], [5, 1], [5, -1], [4, 0], [4, 1], [4, -1],
];

test("rally：启用且组未齐 → 全员先到敌核外圈集结位（vanguard_rally）", () => {
  const planner = new SafetyPlanner(rallyConfig());
  seedCore(planner);
  const plan = planner.decide({ state: makeState(2, [], HOME_SIDE), policy: PRESSURE_POLICY });
  const intents = vanguardIntents(plan);
  assert.ok(
    intents.length === 6 && intents.every((i) => i === "vanguard_rally"),
    `组未齐（0 到集结位）应全员赶路集结，实际 intents=${JSON.stringify(intents)}`,
  );
});

test("rally：首个到集结位者等待，其余继续赶路（vanguard_rally_hold）", () => {
  const planner = new SafetyPlanner(rallyConfig());
  seedCore(planner);
  // v00 已在集结位 [44,0]（敌核 [49,0] 外圈 5 格，距家最近方位）；v01-v05 仍在赶路。
  const positions: readonly Position[] = [
    [44, 0], [5, 0], [5, 1], [5, -1], [4, 0], [4, 1],
  ];
  const plan = planner.decide({ state: makeState(2, [], positions), policy: PRESSURE_POLICY });
  const byId = Object.fromEntries(Object.entries(plan.intents ?? {}).filter(([id]) => id.startsWith("v")));
  assert.equal(byId["v00"], "vanguard_rally_hold", `首到者应原地等待，实际=${byId["v00"]}`);
  assert.ok(
    ["v01", "v02", "v03", "v04", "v05"].every((id) => byId[id] === "vanguard_rally"),
    `其余应继续赶路集结，实际=${JSON.stringify(byId)}`,
  );
});

test("rally：首到后超时（40 tick）→ 成建制压上（vanguard_pressure_memory）", () => {
  const planner = new SafetyPlanner(rallyConfig());
  seedCore(planner);
  // 2 个单位永远到不齐（<3）：v00 已到集结位，v01 卡在赶路——首到 tick2，
  // tick42（40 tick 超时）后强制压上，防永久空等。
  const positions: readonly Position[] = [[44, 0], [5, 0]];
  planner.decide({ state: makeState(2, [], positions), policy: PRESSURE_POLICY });
  const plan = planner.decide({ state: makeState(42, [], positions), policy: PRESSURE_POLICY });
  const intents = vanguardIntents(plan);
  assert.ok(
    intents.length === 2 && intents.every((i) => i === "vanguard_pressure_memory"),
    `超时后应全员压上攻坚，实际 intents=${JSON.stringify(intents)}`,
  );
});

test("rally：默认关闭 → 直接前压（vanguard_pressure_memory 零回归）", () => {
  const config = { ...rallyConfig(), rallyAssault: false };
  const planner = new SafetyPlanner(config);
  seedCore(planner);
  const plan = planner.decide({ state: makeState(2, [], HOME_SIDE), policy: PRESSURE_POLICY });
  const intents = vanguardIntents(plan);
  assert.ok(
    intents.length === 6 && intents.every((i) => i === "vanguard_pressure_memory"),
    `变体关闭应保持历史逐个前压，实际 intents=${JSON.stringify(intents)}`,
  );
});

test("rally Ranger：组未齐 → Ranger 也到集结位（ranger_rally，不再单独前压）", () => {
  const planner = new SafetyPlanner(rallyConfig());
  seedCore(planner);
  // 仅 2 Ranger（military=2 过 attackForce=2 gate）；组未齐 → 同 Vanguard 集结。
  const plan = planner.decide({ state: makeState(2, [], [], [[5, 0], [5, 1]]), policy: PRESSURE_POLICY });
  const rangerIntents = Object.entries(plan.intents ?? {})
    .filter(([id]) => id.startsWith("r"))
    .map(([, intent]) => intent);
  assert.ok(
    rangerIntents.length === 2 && rangerIntents.every((i) => i === "ranger_rally"),
    `Ranger 组未齐应同集结，实际 intents=${JSON.stringify(rangerIntents)}`,
  );
});

test("rally Ranger：首个到集结位者等待（ranger_rally_hold）", () => {
  const planner = new SafetyPlanner(rallyConfig());
  seedCore(planner);
  // r0 已在集结位 [44,0]，r1 仍在赶路——r0 等待，r1 继续赶路。
  const plan = planner.decide({ state: makeState(2, [], [], [[44, 0], [5, 0]]), policy: PRESSURE_POLICY });
  const byId = Object.fromEntries(Object.entries(plan.intents ?? {}).filter(([id]) => id.startsWith("r")));
  assert.equal(byId["r00"], "ranger_rally_hold", `首到者应等待，实际=${byId["r00"]}`);
  assert.equal(byId["r01"], "ranger_rally", `其余应继续赶路，实际=${byId["r01"]}`);
});

test("rally Ranger：默认关闭 → 直接前压（ranger_move 零回归）", () => {
  const config = { ...rallyConfig(), rallyAssault: false };
  const planner = new SafetyPlanner(config);
  seedCore(planner);
  const plan = planner.decide({ state: makeState(2, [], [], [[5, 0], [5, 1]]), policy: PRESSURE_POLICY });
  const rangerIntents = Object.entries(plan.intents ?? {})
    .filter(([id]) => id.startsWith("r"))
    .map(([, intent]) => intent);
  assert.ok(
    rangerIntents.length === 2 && rangerIntents.every((i) => i === "ranger_move"),
    `变体关闭应保持历史单独前压，实际 intents=${JSON.stringify(rangerIntents)}`,
  );
});

test("rally：Vanguard+Ranger 共享集结——先到的等、后到的赶路，同点位汇合", () => {
  const planner = new SafetyPlanner(rallyConfig());
  seedCore(planner);
  // v00 已在集结位 [44,0]，r00 在赶路：v00 等待（vanguard_rally_hold），r00 赶路（ranger_rally）。
  const plan = planner.decide({ state: makeState(2, [], [[44, 0]], [[5, 0]]), policy: PRESSURE_POLICY });
  const byId = Object.fromEntries(Object.entries(plan.intents ?? {}).filter(([id]) => id.startsWith("v") || id.startsWith("r")));
  assert.equal(byId["v00"], "vanguard_rally_hold", `Vanguard 首到应等待，实际=${byId["v00"]}`);
  assert.equal(byId["r00"], "ranger_rally", `Ranger 应赶路集结，实际=${byId["r00"]}`);
});

test("rally Ranger：仅 survey 陈旧播种（无新鲜 enemyHints）→ 不集结（回归 72216-72258）", () => {
  const planner = new SafetyPlanner(rallyConfig());
  // 只播种 coreHuntTargets（跨 run 陈旧），不注册 enemyHints——与 Vanguard 同源
  // 判定：无新鲜敌核记忆 = 无集结目标，Ranger 照常前压（ranger_move），不 park。
  const targets: readonly CoreHuntTarget[] = [
    { position: [49, 0], lastSeenTick: 1, source: "CORE", owner: "jerkman" },
  ];
  planner.seedCoreHuntTargets(targets);
  const plan = planner.decide({ state: makeState(2, [], [], [[5, 0], [5, 1]]), policy: PRESSURE_POLICY });
  const rangerIntents = Object.entries(plan.intents ?? {})
    .filter(([id]) => id.startsWith("r"))
    .map(([, intent]) => intent);
  assert.ok(
    rangerIntents.length === 2 && rangerIntents.every((i) => i === "ranger_move"),
    `无新鲜记忆不应集结，实际 intents=${JSON.stringify(rangerIntents)}`,
  );
});
