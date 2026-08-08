/** 寡不敌众撤退测试（2026-08-08，guide "巡逻单位兵力不足撤退"对照）：
 * outnumbered-retreat-v1——非守家（>Core 4 格）军事单位遇可见敌战斗单位且附近
 * 我方军事 < 敌（aggressive 严格劣势 / defensive ≤）→ 向家撤退（绕开敌人占位），
 * 防 1v2+ 单薄送死；敌核守军（known CORE 8 格内）不计入（攻坚不因目标守军撤退）；
 * 守家圈（≤4）不撤（最后防线接战）。默认关闭零回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import type { CoreHuntTarget } from "../src/domain/world.ts";

function enemyUnit(id: string, position: Position, unitType: "VANGUARD" | "RANGER" = "VANGUARD"): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 4, unitType };
}

function makeState(tick: number, enemies: readonly VisibleEntity[], vPos: readonly Position[], rPos: readonly Position[] = []): TickState {
  const units = [];
  const vanguards = [];
  const rangers = [];
  for (let i = 0; i < vPos.length; i++) {
    const id = `v${String(i).padStart(2, "0")}`;
    const u = { id, position: [...vPos[i]] as Position, hp: 4, unitType: "VANGUARD" as const, cargo: 0 };
    units.push(u); vanguards.push(u);
  }
  for (let i = 0; i < rPos.length; i++) {
    const id = `r${String(i).padStart(2, "0")}`;
    const u = { id, position: [...rPos[i]] as Position, hp: 4, unitType: "RANGER" as const, cargo: 0 };
    units.push(u); rangers.push(u);
  }
  return {
    tick, status: "ACTIVE", resources: 10, resourceCapacity: 10, resourceSpace: 10,
    population: vPos.length + rPos.length,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units, workers: [], vanguards, rangers,
    visibleEnemies: enemies, resourceCells: new Set(), obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const PRESSURE_POLICY = {
  posture: "aggressive" as const, workerTarget: 6, militaryRatio: 0.4,
  focusRegion: null, attackPriority: "core" as const,
};

function retreatConfig() {
  return {
    ...DEFAULT_SAFETY_CONFIG,
    aggression: "aggressive" as const,
    attackForce: 1,
    outnumberedRetreat: true,
    enemyCoreMemoryTicks: 1200,
  };
}

function intentOf(plan: { intents?: Record<string, string> }, id: string): string {
  return plan.intents?.[id] ?? "?";
}

const TWO_ENEMIES: readonly VisibleEntity[] = [enemyUnit("e1", [25, 0]), enemyUnit("e2", [25, 1])];

test("outnumbered：1V 遇 2 敌（半径 10 内）→ vanguard_outnumbered_retreat 向家撤退", () => {
  const planner = new SafetyPlanner(retreatConfig());
  const plan = planner.decide({ state: makeState(1, TWO_ENEMIES, [[20, 0]]), policy: PRESSURE_POLICY });
  assert.equal(intentOf(plan, "v00"), "vanguard_outnumbered_retreat", `应撤退，实际=${intentOf(plan, "v00")}`);
});

test("outnumbered：敌邻接也先撤（置于 SWEEP 之前，止损优先）", () => {
  const planner = new SafetyPlanner(retreatConfig());
  const enemies: readonly VisibleEntity[] = [enemyUnit("e1", [21, 0]), enemyUnit("e2", [22, 0])];
  const plan = planner.decide({ state: makeState(1, enemies, [[20, 0]]), policy: PRESSURE_POLICY });
  assert.equal(intentOf(plan, "v00"), "vanguard_outnumbered_retreat", `邻接敌也先撤，实际=${intentOf(plan, "v00")}`);
});

test("outnumbered：我方 2 对 1 不撤（非严格劣势照常接战）", () => {
  const planner = new SafetyPlanner(retreatConfig());
  const enemies: readonly VisibleEntity[] = [enemyUnit("e1", [21, 0])];
  const plan = planner.decide({ state: makeState(1, enemies, [[20, 0], [20, 1]]), policy: PRESSURE_POLICY });
  assert.notEqual(intentOf(plan, "v00"), "vanguard_outnumbered_retreat", `2v1 应接战，实际=${intentOf(plan, "v00")}`);
});

test("outnumbered：守家圈（≤4）不撤——最后防线接战（SWEEP）", () => {
  const planner = new SafetyPlanner(retreatConfig());
  const enemies: readonly VisibleEntity[] = [enemyUnit("e1", [4, 0]), enemyUnit("e2", [4, 1])];
  const plan = planner.decide({ state: makeState(1, enemies, [[3, 0]]), policy: PRESSURE_POLICY });
  assert.equal(intentOf(plan, "v00"), "sweep", `守家圈应接战不撤，实际=${intentOf(plan, "v00")}`);
});

test("outnumbered：敌核守军（known CORE 8 格内）不计入——攻坚不撤退", () => {
  const planner = new SafetyPlanner(retreatConfig());
  planner.seedCoreHuntTargets([
    { position: [25, 0], lastSeenTick: 1, source: "CORE", owner: "jerkman" } satisfies CoreHuntTarget,
  ]);
  const plan = planner.decide({ state: makeState(1, TWO_ENEMIES, [[20, 0]]), policy: PRESSURE_POLICY });
  assert.notEqual(intentOf(plan, "v00"), "vanguard_outnumbered_retreat", `守军不计入应不撤，实际=${intentOf(plan, "v00")}`);
});

test("outnumbered：默认关闭 → 照常接战（零回归）", () => {
  const config = { ...retreatConfig(), outnumberedRetreat: false };
  const planner = new SafetyPlanner(config);
  const plan = planner.decide({ state: makeState(1, TWO_ENEMIES, [[20, 0]]), policy: PRESSURE_POLICY });
  assert.notEqual(intentOf(plan, "v00"), "vanguard_outnumbered_retreat", `默认关闭不撤，实际=${intentOf(plan, "v00")}`);
});

test("outnumbered：Ranger 寡不敌众 → ranger_outnumbered_retreat", () => {
  const planner = new SafetyPlanner(retreatConfig());
  const plan = planner.decide({ state: makeState(1, TWO_ENEMIES, [], [[20, 0]]), policy: PRESSURE_POLICY });
  assert.equal(intentOf(plan, "r00"), "ranger_outnumbered_retreat", `Ranger 应撤退，实际=${intentOf(plan, "r00")}`);
});

test("outnumbered：defensive 姿势 2v2 也撤（≤ 判据，guide 同值）", () => {
  const config = { ...retreatConfig(), aggression: "defensive" as const };
  const planner = new SafetyPlanner(config);
  const enemies: readonly VisibleEntity[] = [enemyUnit("e1", [21, 0]), enemyUnit("e2", [21, 1])];
  const plan = planner.decide({ state: makeState(1, enemies, [[20, 0], [20, 1]]), policy: PRESSURE_POLICY });
  assert.equal(intentOf(plan, "v00"), "vanguard_outnumbered_retreat", `defensive 2v2 应撤，实际=${intentOf(plan, "v00")}`);
});
