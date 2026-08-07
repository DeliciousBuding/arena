/** 严格占优攻坚测试（2026-08-07，guide v3.0 overmatch 对照）：
 * assaultOvermatch——攻坚成型门槛按目标敌 Core 实测守军动态抬高：
 * 门槛 = max(基础 attackForce, 守军估计+1)。存活兵力严格大于守军估计才压上；
 * 守军增援 → 门槛同步抬高 → 兵力不足自动蓄势（vanguard_hold），不再单薄送死。
 * 默认关闭零回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import type { CoreHuntTarget } from "../src/domain/world.ts";

function enemyCore(position: Position, owner?: string): VisibleEntity {
  return { id: "ec", kind: "CORE", position, hp: 5, unitType: "VANGUARD", ownerUsername: owner };
}

function enemyUnit(id: string, position: Position, unitType: "VANGUARD" | "RANGER"): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 4, unitType };
}

function makeState(tick: number, enemies: VisibleEntity[], military: number): TickState {
  const units = [];
  const vanguards = [];
  for (let i = 0; i < military; i++) {
    const id = `v${String(i).padStart(2, "0")}`;
    const u = { id, position: [50, 0] as Position, hp: 4, unitType: "VANGUARD" as const, cargo: 0 };
    units.push(u);
    vanguards.push(u);
  }
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: military,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units,
    workers: [],
    vanguards,
    rangers: [],
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

/** 攻坚 base 配置：attackForce 6 + overmatch 开关。 */
function overmatchConfig() {
  return {
    ...DEFAULT_SAFETY_CONFIG,
    aggression: "aggressive" as const,
    attackForce: 6,
    assaultOvermatch: true,
    militaryHunt: true,
    boundedRaid: true,
    enemyCoreMemoryTicks: 1200,
  };
}

/** 播种目标敌 Core + tick1 目击一批守军（Vanguard/Ranger 靠近敌 Core）。 */
function seedAndSight(planner: SafetyPlanner, guards: VisibleEntity[]): void {
  const targets: readonly CoreHuntTarget[] = [
    { position: [49, 0], lastSeenTick: 1, source: "CORE", owner: "jerkman" },
  ];
  planner.seedCoreHuntTargets(targets);
  // tick1：敌 Core + 守军可见（进入记忆/兵力记录）
  planner.decide({ state: makeState(1, [enemyCore([49, 0], "jerkman"), ...guards], 7), policy: PRESSURE_POLICY });
}

test("overmatch：敌守军 7（5V+2R）+ 我方 7 → 门槛 8 > 7 守家蓄势（不单薄送死）", () => {
  const planner = new SafetyPlanner(overmatchConfig());
  const guards = [
    enemyUnit("g1", [48, 0], "VANGUARD"), enemyUnit("g2", [48, 1], "VANGUARD"),
    enemyUnit("g3", [48, -1], "VANGUARD"), enemyUnit("g4", [49, 1], "VANGUARD"),
    enemyUnit("g5", [49, -1], "VANGUARD"), enemyUnit("g6", [47, 0], "RANGER"),
    enemyUnit("g7", [47, 1], "RANGER"),
  ];
  seedAndSight(planner, guards);
  // tick2：无可见敌人 → memory 分支 → forceGate（门槛 8）
  const plan = planner.decide({ state: makeState(2, [], 7), policy: PRESSURE_POLICY });
  const vanguardIntents = Object.entries(plan.intents ?? {})
    .filter(([id]) => id.startsWith("v"))
    .map(([, intent]) => intent);
  assert.ok(
    vanguardIntents.every((intent) => intent === "vanguard_hold"),
    `守军 7 时门槛应抬到 8，我方 7 全员蓄势，实际 intents=${JSON.stringify(vanguardIntents)}`,
  );
});

test("overmatch：敌守军少（2）+ 我方 6 → 门槛保持 6 正常前压（不因小敌保守）", () => {
  const planner = new SafetyPlanner(overmatchConfig());
  const guards = [
    enemyUnit("g1", [48, 0], "VANGUARD"), enemyUnit("g2", [48, 1], "RANGER"),
  ];
  seedAndSight(planner, guards);
  const plan = planner.decide({ state: makeState(2, [], 6), policy: PRESSURE_POLICY });
  const vanguardIntents = Object.entries(plan.intents ?? {})
    .filter(([id]) => id.startsWith("v"))
    .map(([, intent]) => intent);
  assert.ok(
    vanguardIntents.some((intent) => intent !== "vanguard_hold"),
    `守军 2 → 门槛 max(6,3)=6，我方 6 应前压，实际 intents=${JSON.stringify(vanguardIntents)}`,
  );
});

test("overmatch：默认关闭 + 敌守军 7 + 我方 7 → 门槛 6 正常前压（零回归）", () => {
  const config = { ...overmatchConfig(), assaultOvermatch: false };
  const planner = new SafetyPlanner(config);
  const guards = [
    enemyUnit("g1", [48, 0], "VANGUARD"), enemyUnit("g2", [48, 1], "VANGUARD"),
    enemyUnit("g3", [48, -1], "VANGUARD"), enemyUnit("g4", [49, 1], "VANGUARD"),
    enemyUnit("g5", [49, -1], "VANGUARD"), enemyUnit("g6", [47, 0], "RANGER"),
    enemyUnit("g7", [47, 1], "RANGER"),
  ];
  seedAndSight(planner, guards);
  const plan = planner.decide({ state: makeState(2, [], 7), policy: PRESSURE_POLICY });
  const vanguardIntents = Object.entries(plan.intents ?? {})
    .filter(([id]) => id.startsWith("v"))
    .map(([, intent]) => intent);
  assert.ok(
    vanguardIntents.some((intent) => intent !== "vanguard_hold"),
    `变体关闭时门槛 6，我方 7 应前压，实际 intents=${JSON.stringify(vanguardIntents)}`,
  );
});

test("overmatch：守军按 ID 去重（同单位重复目击不重复计数）", () => {
  const planner = new SafetyPlanner(overmatchConfig());
  const guards = [enemyUnit("g1", [48, 0], "VANGUARD"), enemyUnit("g2", [48, 1], "VANGUARD")];
  seedAndSight(planner, guards);
  // tick2 再次目击同两个单位（不应重复计数：守军仍 2 → 门槛 3）
  planner.decide({ state: makeState(3, [enemyCore([49, 0], "jerkman"), ...guards], 6), policy: PRESSURE_POLICY });
  const plan = planner.decide({ state: makeState(4, [], 6), policy: PRESSURE_POLICY });
  const vanguardIntents = Object.entries(plan.intents ?? {})
    .filter(([id]) => id.startsWith("v"))
    .map(([, intent]) => intent);
  assert.ok(
    vanguardIntents.some((intent) => intent !== "vanguard_hold"),
    `守军去重后仍 2 → 门槛 3 ≤ 6，我方 6 应前压，实际 intents=${JSON.stringify(vanguardIntents)}`,
  );
});
