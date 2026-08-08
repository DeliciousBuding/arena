/** 弱核优先攻坚测试（2026-08-08，guide "已知核心优先选无护卫"对照）：
 * weak-core-first-v1——多敌核时攻坚/狩猎优先打守军少的（击杀概率高，防攻坚守军
 * 堆叠送死）；无兵力记忆的核视为无护卫（弱目标优先）。tie-break 新鲜度→距我方
 * Core 近。默认关闭零回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import type { CoreHuntTarget } from "../src/domain/world.ts";

function coreAt(position: Position, owner = "jerkman"): VisibleEntity {
  return { id: `ec-${position[0]}-${position[1]}`, kind: "CORE", position, hp: 5, unitType: "VANGUARD", ownerUsername: owner };
}
function enemyUnit(id: string, position: Position, unitType: "VANGUARD" | "RANGER" = "VANGUARD"): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 4, unitType };
}

function moveDir(action: { readonly type: string; readonly direction?: string } | undefined): string | undefined {
  return action?.type === "MOVE" ? action.direction : undefined;
}

function makeState(tick: number, enemies: readonly VisibleEntity[], unitAt: Position, unitType: "VANGUARD" | "RANGER" = "VANGUARD"): TickState {
  const unit = { id: unitType === "VANGUARD" ? "v00" : "r00", position: [...unitAt] as Position, hp: 4, unitType, cargo: 0 };
  const vanguards = unitType === "VANGUARD" ? [unit] : [];
  const rangers = unitType === "RANGER" ? [unit] : [];
  return {
    tick, status: "ACTIVE", resources: 10, resourceCapacity: 10, resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [unit], workers: [], vanguards, rangers,
    visibleEnemies: enemies, resourceCells: new Set(), obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const PRESSURE_POLICY = {
  posture: "aggressive" as const, workerTarget: 6, militaryRatio: 0.4,
  focusRegion: null, attackPriority: "core" as const,
};

function weakConfig() {
  return {
    ...DEFAULT_SAFETY_CONFIG,
    aggression: "aggressive" as const,
    attackForce: 1,
    militaryHunt: true,
    weakCoreFirst: true,
    // enemyHints 短窗口：让"仅播种/守军注册"的新鲜记忆过期，触发狩猎/前压路径。
    enemyCoreMemoryTicks: 2,
  };
}

/** 播种两个敌核：A=[20,0] 更新（lastSeen 10），B=[10,10] 更旧（5）；
 *  并在 tick 11 目击 A + 2 守军 → 给 A 注册守军兵力记忆（guarded）。 */
function seedGuardedAndWeak(planner: SafetyPlanner, tick11: boolean): void {
  planner.seedCoreHuntTargets([
    { position: [20, 0], lastSeenTick: 10, source: "CORE", owner: "jerkman" } satisfies CoreHuntTarget,
    { position: [10, 10], lastSeenTick: 5, source: "CORE", owner: "clucky" } satisfies CoreHuntTarget,
  ]);
  if (tick11) {
    planner.decide({
      state: makeState(11, [coreAt([20, 0]), enemyUnit("g1", [19, 0]), enemyUnit("g2", [21, 0])], [10, 0]),
      policy: PRESSURE_POLICY,
    });
  }
}

test("weak-core-first：狩猎优先无护卫核（B 守军 0 < A 守军 2）→ 朝 B 移动", () => {
  const planner = new SafetyPlanner(weakConfig());
  seedGuardedAndWeak(planner, true);
  const plan = planner.decide({ state: makeState(14, [], [10, 0]), policy: PRESSURE_POLICY });
  const intent = plan.intents?.["v00"];
  const action = plan.unitActions?.["v00"];
  assert.equal(intent, "vanguard_hunt", `应狩猎，实际=${intent}`);
  assert.equal(action?.type, "MOVE", `应移动，实际=${JSON.stringify(action)}`);
  assert.equal(moveDir(action), "DOWN", `弱核 B=[10,10] 应朝下，实际=${JSON.stringify(action)}`);
});

test("weak-core-first：默认关闭 → 历史行为（最新核 A=[20,0]）→ 朝 A 移动", () => {
  const config = { ...weakConfig(), weakCoreFirst: false };
  const planner = new SafetyPlanner(config);
  seedGuardedAndWeak(planner, true);
  const plan = planner.decide({ state: makeState(14, [], [10, 0]), policy: PRESSURE_POLICY });
  const action = plan.unitActions?.["v00"];
  assert.equal(action?.type, "MOVE", `应移动，实际=${JSON.stringify(action)}`);
  assert.equal(moveDir(action), "RIGHT", `最新核 A=[20,0] 应朝右，实际=${JSON.stringify(action)}`);
});

test("weak-core-first：Ranger 前压目标同样优先弱核", () => {
  const planner = new SafetyPlanner(weakConfig());
  seedGuardedAndWeak(planner, true);
  const plan = planner.decide({ state: makeState(14, [], [10, 0], "RANGER"), policy: PRESSURE_POLICY });
  const intent = plan.intents?.["r00"];
  const action = plan.unitActions?.["r00"];
  assert.equal(intent, "ranger_move", `应前压，实际=${intent}`);
  assert.equal(moveDir(action), "DOWN", `Ranger 弱核 B 应朝下，实际=${JSON.stringify(action)}`);
});

test("weak-core-first：单一敌核不受影响（同历史行为）", () => {
  const planner = new SafetyPlanner(weakConfig());
  planner.seedCoreHuntTargets([
    { position: [20, 0], lastSeenTick: 10, source: "CORE", owner: "jerkman" } satisfies CoreHuntTarget,
  ]);
  const plan = planner.decide({ state: makeState(14, [], [10, 0]), policy: PRESSURE_POLICY });
  const action = plan.unitActions?.["v00"];
  assert.equal(moveDir(action), "RIGHT", `单核应照常朝它，实际=${JSON.stringify(action)}`);
});
