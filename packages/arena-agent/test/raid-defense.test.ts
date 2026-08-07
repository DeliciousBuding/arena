/** 快攻防御测试（2026-08-07，raid-defense-v1）：
 * 用户裁决"别人可以只派一些人来打"——防御不能只看排行榜伤害：
 * 1. 邻近敌核心（Chebyshev ≤24）→ 即使攻坚目标不是高威胁玩家（无画像/
 *    STANDARD），也保留 ≥2 Vanguard 守家（防小股偷家/换家）；
 * 2. 实测敌军战斗单位进入 18 格警戒圈（可见或 12 tick 记忆内）→ 远端军事
 *    回援（vanguard_reinforce），不等贴脸；
 * 3. 变体关闭/远敌核心 = 历史行为零回归（守家预留 1 / 12 格才回援）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import type { CoreHuntTarget } from "../src/domain/world.ts";

function enemyCore(position: Position, owner?: string): VisibleEntity {
  return { id: "ec", kind: "CORE", position, hp: 5, unitType: "VANGUARD", ownerUsername: owner };
}

function enemyUnit(position: Position): VisibleEntity {
  return { id: "eu", kind: "UNIT", position, hp: 2, unitType: "VANGUARD", ownerUsername: "raider" };
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

/** 攻坚 base 配置：attackForce 6 + strikeGroupReserve 1 + 快攻防御开关。 */
function raidConfig() {
  return {
    ...DEFAULT_SAFETY_CONFIG,
    aggression: "aggressive" as const,
    attackForce: 6,
    strikeGroupReserve: true,
    remoteReinforce: true,
    raidDefense: true,
    militaryHunt: true,
    boundedRaid: true,
    enemyCoreMemoryTicks: 1200,
  };
}

function intentsOf(plan: { intents?: Record<string, string> }): string[] {
  return Object.values(plan.intents ?? {});
}

test("快攻防御：邻近敌核心（20 格 ≤24）→ 保留 2 Vanguard 守家（无画像也成立）", () => {
  const planner = new SafetyPlanner(raidConfig());
  // tick1 目击近敌 Core（Chebyshev 20 ≤ raidCoreRadius 24，STANDARD 无画像）；
  // tick2 无可见敌人 → 站立威胁判定走 sticky coreHuntMemory。
  planner.decide({ state: makeState(1, [enemyCore([20, 0], "zercher")], 6), policy: PRESSURE_POLICY });
  const plan = planner.decide({ state: makeState(2, [], 6), policy: PRESSURE_POLICY });
  const homeGuards = Object.entries(plan.intents ?? {})
    .filter(([, intent]) => intent === "vanguard_home_guard")
    .map(([id]) => id);
  assert.equal(homeGuards.length, 2, `邻近敌核心应留 2 守家，实际 ${JSON.stringify(homeGuards)}`);
});

test("快攻防御：远敌核心（30 格 >24）→ 只留 1 守家（零回归）", () => {
  const planner = new SafetyPlanner(raidConfig());
  planner.decide({ state: makeState(1, [enemyCore([30, 0], "far")], 6), policy: PRESSURE_POLICY });
  const plan = planner.decide({ state: makeState(2, [], 6), policy: PRESSURE_POLICY });
  const homeGuards = Object.entries(plan.intents ?? {})
    .filter(([, intent]) => intent === "vanguard_home_guard")
    .map(([id]) => id);
  assert.equal(homeGuards.length, 1, `远敌核心应只留 1 守家，实际 ${JSON.stringify(homeGuards)}`);
});

test("快攻防御：记忆内敌军战斗单位 18 格 → 远端军事回援（vanguard_reinforce）", () => {
  const planner = new SafetyPlanner(raidConfig());
  // tick1 目击战斗单位在 [18,0]（Manhattan 18 = 警戒圈）；tick2 敌人消失 →
  // 12 tick 记忆内仍触发回援（不等贴脸）。
  planner.decide({ state: makeState(1, [enemyUnit([18, 0])], 6), policy: PRESSURE_POLICY });
  const plan = planner.decide({ state: makeState(2, [], 6), policy: PRESSURE_POLICY });
  const reinforce = Object.entries(plan.intents ?? {})
    .filter(([, intent]) => intent === "vanguard_reinforce")
    .map(([id]) => id);
  assert.ok(
    reinforce.length >= 1,
    `记忆内 18 格战斗单位应触发回援，实际 intents=${JSON.stringify(plan.intents)}`,
  );
});

test("快攻防御：变体关闭 → 18 格记忆内不触发回援（12 格口径零回归）", () => {
  const config = { ...raidConfig(), raidDefense: false };
  const planner = new SafetyPlanner(config);
  planner.decide({ state: makeState(1, [enemyUnit([18, 0])], 6), policy: PRESSURE_POLICY });
  const plan = planner.decide({ state: makeState(2, [], 6), policy: PRESSURE_POLICY });
  const reinforce = Object.entries(plan.intents ?? {})
    .filter(([, intent]) => intent === "vanguard_reinforce")
    .map(([id]) => id);
  assert.equal(
    reinforce.length,
    0,
    `变体关闭 18 格记忆不应回援（仅 12 格可见才回），实际 intents=${JSON.stringify(plan.intents)}`,
  );
});

test("快攻防御：播种 CORE 目标（重启记忆恢复）也触发守家预留", () => {
  const planner = new SafetyPlanner(raidConfig());
  planner.seedCoreHuntTargets([
    { position: [22, 0], lastSeenTick: 1, source: "CORE", owner: "zercher" } as CoreHuntTarget,
  ]);
  const plan = planner.decide({ state: makeState(2, [], 6), policy: PRESSURE_POLICY });
  const homeGuards = Object.entries(plan.intents ?? {})
    .filter(([, intent]) => intent === "vanguard_home_guard")
    .map(([id]) => id);
  assert.equal(homeGuards.length, 2, `播种近敌核心应留 2 守家，实际 ${JSON.stringify(homeGuards)}`);
});
