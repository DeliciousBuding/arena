/**
 * 威胁防御产兵测试（2026-08-07，竞品 arena_farmer _control_core 对照）：
 * 可见战斗敌距 Core <=3 格（射程内威胁）时优先产 VANGUARD 防御（官方
 * DEFENSE_VANGUARD_TARGET=3）——敌人打到门口时产 worker 补员是送死。
 * 无威胁保持原行为（worker 补员/按 militaryRatio 产兵）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { selectDeterministicCoreAction } from "../src/planning/deterministic-planner.ts";

function makeState(
  resources: number,
  workers: number,
  vanguards: number,
  enemies: VisibleEntity[] = [],
): TickState {
  const units = [
    ...Array.from({ length: workers }, (_, i) => ({
      id: `w${i}`.padEnd(36, "0"), position: [5, 0] as Position, hp: 2, unitType: "WORKER" as const, cargo: 0,
    })),
    ...Array.from({ length: vanguards }, (_, i) => ({
      id: `v${i}`.padEnd(36, "0"), position: [5, 0] as Position, hp: 4, unitType: "VANGUARD" as const, cargo: 0,
    })),
  ];
  return {
    tick: 1,
    status: "ACTIVE" as const,
    resources,
    resourceCapacity: 50,
    resourceSpace: 50 - resources,
    population: units.length,
    core: { id: "c1", position: [0, 0] as Position, hp: 5, shield: 5, state: "NORMAL" as const, ownerUsername: "p1" },
    units,
    workers: units.filter((u) => u.unitType === "WORKER"),
    vanguards: units.filter((u) => u.unitType === "VANGUARD"),
    rangers: [],
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND" as const, carrierId: null },
    events: [],
  };
}

function enemyAt(position: Position): VisibleEntity {
  return { id: "e1", kind: "UNIT", position, hp: 4, unitType: "VANGUARD" };
}

test("威胁防御产兵：敌距 Core 3 格内 + VANGUARD 未达标 → spawn VANGUARD", () => {
  // workers 3 < target 4，threatDefenseSpawn=true → 威胁分支产 Vanguard
  // （P1 仅管军事 deficit，不再叠加 coreThreatened）
  const decision = selectDeterministicCoreAction(
    makeState(15, 3, 0, [enemyAt([3, 0])]),
    null,
    undefined,
    undefined,
    0,
    false,
    2,
    undefined, // populationCeiling 默认无限
    true, // threatDefenseSpawn 显式开启
  );
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" });
  assert.equal(decision.intent, "spawn_vanguard_defense");
});

test("威胁防御产兵：无威胁保持 worker 补员（原行为回归）", () => {
  const decision = selectDeterministicCoreAction(makeState(15, 3, 0), null);
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "WORKER" });
  assert.equal(decision.intent, "spawn_worker_target");
});

test("威胁防御产兵：敌 6 格外（预警带外）不触发", () => {
  const decision = selectDeterministicCoreAction(
    makeState(15, 3, 0, [enemyAt([6, 0])]),
    null,
    undefined,
    undefined,
    0,
    false,
    2,
    undefined,
    true,
  );
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "WORKER" }, "6 格威胁不触发防御产兵");
});

test("威胁防御产兵：敌 5 格（预警带内、射程外）触发", () => {
  const decision = selectDeterministicCoreAction(
    makeState(15, 3, 0, [enemyAt([5, 0])]),
    null,
    undefined,
    undefined,
    0,
    false,
    2,
    undefined,
    true,
  );
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" }, "5 格 = 预警带内触发防御产兵");
});

test("威胁防御产兵：VANGUARD 已达 3 防御目标 → worker 补员", () => {
  const decision = selectDeterministicCoreAction(
    makeState(15, 3, 3, [enemyAt([3, 0])]),
    null,
    undefined,
    undefined,
    0,
    false,
    2,
    undefined,
    true,
  );
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "WORKER" }, "防御达标回经济");
});

test("威胁防御产兵：资源 10（纯成本，豁免 reserve）→ spawn", () => {
  const decision = selectDeterministicCoreAction(
    makeState(10, 3, 0, [enemyAt([3, 0])]),
    null,
    undefined,
    undefined,
    0,
    false,
    2,
    undefined,
    true,
  );
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" }, "威胁产兵豁免 reserve——10 即可产");
});

test("威胁防御产兵：资源 9（<10）→ VANGUARD 买不起，回退产 WORKER", () => {
  const decision = selectDeterministicCoreAction(
    makeState(9, 3, 0, [enemyAt([3, 0])]),
    null,
    undefined,
    undefined,
    0,
    false,
    2,
    undefined,
    true,
  );
  // threatDefenseSpawn=true 匹配但 VANGUARD 买不起 → fall-through 到 worker spawn
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "WORKER" }, "9 < 10 → 不产 VANGUARD，回退产 WORKER");
});

test("威胁防御产兵：敌方 WORKER 不触发（非战斗单位）", () => {
  const enemy: VisibleEntity = { id: "e1", kind: "UNIT", position: [3, 0], hp: 2, unitType: "WORKER" };
  const decision = selectDeterministicCoreAction(makeState(15, 3, 0, [enemy]), null, undefined, undefined, 0, false, 2, undefined, true);
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "WORKER" }, "敌方 WORKER 不是威胁");
});

test("威胁防御产兵：Core 格被占（非满载 worker）→ 不 spawn（容量预检优先）", () => {
  const state = makeState(15, 3, 0, [enemyAt([3, 0])]);
  const stateWithOccupant: TickState = {
    ...state,
    units: [{ ...state.units[0], position: [0, 0] as Position }, ...state.units.slice(1)],
    workers: [{ ...state.workers[0], position: [0, 0] as Position }, ...state.workers.slice(1)],
  };
  const decision = selectDeterministicCoreAction(stateWithOccupant, null, undefined, undefined, 0, false, 2, undefined, true);
  assert.equal(decision.action, null, "Core 格被占 → 容量预检阻止 spawn");
});

test("威胁防御产兵：默认关闭（候选）——威胁场景走 worker 补员（零回归）", () => {
  // threatDefenseSpawn 默认关闭 → 威胁不产兵（P1 仅管军事 deficit）
  // workers=3 < 4 → 正常扩编产 WORKER
  const decision = selectDeterministicCoreAction(
    makeState(15, 3, 0, [enemyAt([3, 0])]),
    null,
  );
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "WORKER" }, "默认关闭 → 威胁不产兵，走 worker 补员");
});

test("威胁防御产兵：默认关闭且 workers 达标（4）→ P1 军事归零接管", () => {
  // workers 4 ≥ 起步门 4，military 0 < 底线 8 → P1 危机接管（与开关无关）
  const decision = selectDeterministicCoreAction(
    makeState(15, 4, 0, [enemyAt([3, 0])]),
    null,
  );
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" }, "workers 起步后军事归零 → 紧急爆兵");
});
