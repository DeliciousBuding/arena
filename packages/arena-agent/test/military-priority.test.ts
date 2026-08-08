/**
 * 威胁优先产兵测试（2026-08-08，military-priority-v1）：
 * reference guide"敌方进入 Core 防区 → 守家队优先补齐"——活跃敌核贴脸
 * （raid-defense nearbyEnemyCore ≤24 格）且军事未达地板（默认 4）时，
 * 跳过 worker 积累直接产兵，并用低储备（reserveEarly=1）尽早成型。
 * t3 生产实证：3 活跃敌核 ≤20 格仅 1 Vanguard，res 11 被财富储备 3 卡到
 * 13 才产兵——本变体让 res 11 即产。默认关闭零回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState } from "../src/domain/model.ts";
import type { CoreHuntTarget } from "../src/domain/world.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

function makeState(workers: number, vanguards: number, resources: number): TickState {
  const units = [];
  for (let i = 0; i < workers; i++) {
    units.push({ id: `w${i}`, position: [3, 0] as Position, hp: 2, unitType: "WORKER" as const, cargo: 0 });
  }
  const vs = [];
  for (let i = 0; i < vanguards; i++) {
    const u = { id: `v${i}`, position: [4, 0] as Position, hp: 4, unitType: "VANGUARD" as const, cargo: 0 };
    units.push(u);
    vs.push(u);
  }
  return {
    tick: 1,
    status: "ACTIVE",
    resources,
    resourceCapacity: 100,
    resourceSpace: 100,
    population: workers + vanguards,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units,
    workers: units.filter((u) => u.unitType === "WORKER"),
    vanguards: vs,
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const POLICY = {
  posture: "aggressive" as const,
  workerTarget: 8,
  militaryRatio: 0.4,
  focusRegion: null,
  attackPriority: "core" as const,
};

/** 敌核位置 seed（raid-defense nearbyEnemyCore ≤24 触发）。 */
function seedEnemyCore(planner: SafetyPlanner, pos: Position): void {
  const targets: readonly CoreHuntTarget[] = [
    { position: pos, lastSeenTick: 1, source: "CORE", owner: "enemy1" },
  ];
  planner.seedCoreHuntTargets(targets);
}

test("military-priority：敌核 10 格贴脸 + 0V（< 地板 4）+ res 11 → 直接产 VANGUARD（低储备）", () => {
  const planner = new SafetyPlanner({
    ...DEFAULT_SAFETY_CONFIG,
    aggression: "aggressive",
    threatMilitaryPriority: true,
    raidDefense: true,
  });
  seedEnemyCore(planner, [10, 0]); // cheb 10 ≤ 24 → nearbyEnemyCore true
  const plan = planner.decide({ state: makeState(6, 0, 11), policy: POLICY });
  assert.deepEqual(plan.coreAction, { type: "SPAWN", unitType: "VANGUARD" }, `res 11 应低储备产 VANGUARD（military-priority 跳过 worker），实际 ${JSON.stringify(plan.coreAction)}`);
});

test("military-priority：默认关闭（零回归）→ 同状态产 WORKER", () => {
  const planner = new SafetyPlanner({
    ...DEFAULT_SAFETY_CONFIG,
    aggression: "aggressive",
    raidDefense: true,
    // threatMilitaryPriority 未开
  });
  seedEnemyCore(planner, [10, 0]);
  const plan = planner.decide({ state: makeState(6, 0, 11), policy: POLICY });
  // worker 6 < target 8 → 正常顺序产 WORKER
  assert.deepEqual(plan.coreAction, { type: "SPAWN", unitType: "WORKER" }, `默认应产 WORKER，实际 ${JSON.stringify(plan.coreAction)}`);
});

test("military-priority：军事已达标（4V ≥ 地板）→ 不强制产兵（worker 优先）", () => {
  const planner = new SafetyPlanner({
    ...DEFAULT_SAFETY_CONFIG,
    aggression: "aggressive",
    threatMilitaryPriority: true,
    raidDefense: true,
  });
  seedEnemyCore(planner, [10, 0]);
  const plan = planner.decide({ state: makeState(6, 4, 20), policy: POLICY });
  assert.deepEqual(plan.coreAction, { type: "SPAWN", unitType: "WORKER" }, `军事达标应回正常顺序，实际 ${JSON.stringify(plan.coreAction)}`);
});

test("military-priority：敌核 40 格（> 24）不触发 → worker 优先", () => {
  const planner = new SafetyPlanner({
    ...DEFAULT_SAFETY_CONFIG,
    aggression: "aggressive",
    threatMilitaryPriority: true,
    raidDefense: true,
  });
  seedEnemyCore(planner, [40, 0]); // cheb 40 > 24
  const plan = planner.decide({ state: makeState(6, 0, 20), policy: POLICY });
  assert.deepEqual(plan.coreAction, { type: "SPAWN", unitType: "WORKER" }, `敌核远不应触发，实际 ${JSON.stringify(plan.coreAction)}`);
});
