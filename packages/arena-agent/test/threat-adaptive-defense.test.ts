/** 威胁自适应防守测试（2026-08-07，排行榜威胁画像"留强"）：
 * 攻坚目标所有者是官方排行榜高伤害玩家（猛攻蛆，如 jerkman damage #5 =
 * ELITE_AGGRESSOR）时——
 * 1. 前压成型门槛提高（base attackForce 6 → ELITE 10）：军事未达高门槛守家
 *    蓄势（不单薄前压送死）；
 * 2. 守家预留增加（strikeGroupReserve 1 → 2）：高威胁下保留 2 个 Vanguard
 *    守家（防远征时被偷家/反打）；
 * 3. STANDARD 对手/无画像 = 基础行为零回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import type { ThreatProfile } from "../src/strategies/safety-planner-config.ts";
import type { CoreHuntTarget } from "../src/domain/world.ts";

const JERKMAN_PROFILE: ThreatProfile = {
  username: "jerkman",
  damageScore: 1765,
  damageRank: 5,
  coreScore: 70,
  coreRank: 9,
  tier: "ELITE_AGGRESSOR",
};

function enemyCore(position: Position, owner?: string): VisibleEntity {
  return { id: "ec", kind: "CORE", position, hp: 5, unitType: "VANGUARD", ownerUsername: owner };
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

/** 攻坚 base 配置：attackForce 6 + strikeGroupReserve 1 + 威胁自适应开关。 */
function adaptiveConfig() {
  return {
    ...DEFAULT_SAFETY_CONFIG,
    aggression: "aggressive" as const,
    attackForce: 6,
    strikeGroupReserve: true,
    threatAdaptiveDefense: true,
    militaryHunt: true,
    boundedRaid: true,
    enemyCoreMemoryTicks: 1200,
  };
}

/** 播种 jerkman 敌 Core 目标（Chebyshev 49 ≤64，允许远征）。 */
function seedJerkman(planner: SafetyPlanner): void {
  const targets: readonly CoreHuntTarget[] = [
    { position: [49, 0], lastSeenTick: 1, source: "CORE", owner: "jerkman" },
  ];
  planner.seedCoreHuntTargets(targets);
}

test("威胁自适应：ELITE 猛攻蛆（jerkman）→ 军事 6 < 门槛 10 守家蓄势（vanguard_hold）", () => {
  const planner = new SafetyPlanner(adaptiveConfig(), undefined, new Map([["jerkman", JERKMAN_PROFILE]]));
  seedJerkman(planner);
  // tick1：敌 Core 可见入记忆；tick2：无可见敌人 → memory 分支
  planner.decide({ state: makeState(1, [enemyCore([49, 0], "jerkman")], 6), policy: PRESSURE_POLICY });
  const plan = planner.decide({ state: makeState(2, [], 6), policy: PRESSURE_POLICY });
  const vanguardIntents = Object.entries(plan.intents ?? {})
    .filter(([id]) => id.startsWith("v"))
    .map(([, intent]) => intent);
  assert.ok(
    vanguardIntents.every((intent) => intent === "vanguard_hold"),
    `高威胁下 6 军事 < 门槛 10 应全员守家蓄势，实际 intents=${JSON.stringify(vanguardIntents)}`,
  );
});

test("威胁自适应：无画像对照 → 军事 6 ≥ base 门槛 6 正常前压（零回归）", () => {
  const planner = new SafetyPlanner(adaptiveConfig());
  seedJerkman(planner);
  planner.decide({ state: makeState(1, [enemyCore([49, 0], "jerkman")], 6), policy: PRESSURE_POLICY });
  const plan = planner.decide({ state: makeState(2, [], 6), policy: PRESSURE_POLICY });
  const intents = Object.values(plan.intents ?? {});
  assert.ok(
    intents.some((intent) => intent !== "vanguard_hold"),
    `无画像 6 ≥ 6 应前压（非全员守家），实际 intents=${JSON.stringify(intents)}`,
  );
});

test("威胁自适应：STANDARD 对手不触发（门槛保持 base 6）", () => {
  const standard: ThreatProfile = { ...JERKMAN_PROFILE, username: "casual", damageRank: 99, tier: "STANDARD" };
  const planner = new SafetyPlanner(adaptiveConfig(), undefined, new Map([["casual", standard]]));
  const targets: readonly CoreHuntTarget[] = [
    { position: [49, 0], lastSeenTick: 1, source: "CORE", owner: "casual" },
  ];
  planner.seedCoreHuntTargets(targets);
  planner.decide({ state: makeState(1, [enemyCore([49, 0], "casual")], 6), policy: PRESSURE_POLICY });
  const plan = planner.decide({ state: makeState(2, [], 6), policy: PRESSURE_POLICY });
  const intents = Object.values(plan.intents ?? {});
  assert.ok(
    intents.some((intent) => intent !== "vanguard_hold"),
    `STANDARD 对手 6 ≥ 6 应前压，实际 intents=${JSON.stringify(intents)}`,
  );
});

test("威胁自适应：军事 10 ≥ 门槛 10 通过 gate，高威胁下保留 2 个 Vanguard 守家", () => {
  const planner = new SafetyPlanner(adaptiveConfig(), undefined, new Map([["jerkman", JERKMAN_PROFILE]]));
  seedJerkman(planner);
  planner.decide({ state: makeState(1, [enemyCore([49, 0], "jerkman")], 10), policy: PRESSURE_POLICY });
  const plan = planner.decide({ state: makeState(2, [], 10), policy: PRESSURE_POLICY });
  const homeGuards = Object.entries(plan.intents ?? {})
    .filter(([, intent]) => intent === "vanguard_home_guard")
    .map(([id]) => id);
  assert.equal(homeGuards.length, 2, `高威胁下应保留 2 个守家，实际 ${JSON.stringify(homeGuards)}`);
  // 其余 8 个前压（非守家）
  const others = Object.entries(plan.intents ?? {}).filter(([, i]) => i !== "vanguard_home_guard");
  assert.ok(
    others.length >= 8,
    `应有余量前压，实际 others=${others.length} intents=${JSON.stringify(plan.intents)}`,
  );
});

test("威胁自适应：默认关闭 → 高威胁画像也不触发（零回归）", () => {
  const config = { ...adaptiveConfig(), threatAdaptiveDefense: false };
  const planner = new SafetyPlanner(config, undefined, new Map([["jerkman", JERKMAN_PROFILE]]));
  seedJerkman(planner);
  planner.decide({ state: makeState(1, [enemyCore([49, 0], "jerkman")], 6), policy: PRESSURE_POLICY });
  const plan = planner.decide({ state: makeState(2, [], 6), policy: PRESSURE_POLICY });
  const intents = Object.values(plan.intents ?? {});
  assert.ok(
    intents.some((intent) => intent !== "vanguard_hold"),
    `变体关闭时 6 ≥ 6 应前压，实际 intents=${JSON.stringify(intents)}`,
  );
});
