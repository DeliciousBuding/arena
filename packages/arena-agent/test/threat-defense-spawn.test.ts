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
  // workers 3 < target 4，但敌人 [3,0] 距 Core 3 → 生存级 P1 危机接管（2026-08-10：
  // coreThreatened 且 V<3 → spawn_emergency_military，优先于 threatDefenseSpawn 候选）
  const decision = selectDeterministicCoreAction(
    makeState(15, 3, 0, [enemyAt([3, 0])]),
    null,
    undefined,
    undefined,
    0,
    false,
    2,
    undefined, // populationCeiling 默认无限
    true, // threatDefenseSpawn 显式开启（P1 先接管）
  );
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" });
  assert.equal(decision.intent, "spawn_emergency_military");
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

test("威胁防御产兵：资源 9（<10）→ threatDefenseSpawn 分支短路 null（不补员）", () => {
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
  // P1 危机接管资源不足（9 < Vanguard 10）fall through；threatDefenseSpawn=true
  // 且威胁 + V<3 但资源不足 → 旧分支短路 null（不 fall through 到 worker 补员，
  // 威胁时优先防御、防御不可达即不产——避免危险期产 worker 送死）。
  assert.equal(decision.action, null, "威胁期资源不足 → 不产（短路 null）");
  assert.equal(decision.intent, null);
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

test("威胁防御产兵：默认关闭（候选）——P1 危机接管不依赖该开关（2026-08-10 语义更新）", () => {
  // threatDefenseSpawn 是默认关闭的候选；coreThreatened + V<3 属 P1 生存兜底，
  // 无条件接管（用户裁决"危机才爆兵"），开关不再影响威胁产兵。
  const decision = selectDeterministicCoreAction(
    makeState(15, 3, 0, [enemyAt([3, 0])]),
    null,
  );
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" }, "P1 危机接管：威胁 + V<3 无条件产 Vanguard");
  assert.equal(decision.intent, "spawn_emergency_military");
});

test("威胁防御产兵：默认关闭且 workers 达标（4）→ P1 军事归零接管", () => {
  // workers 4 ≥ 起步门 4，military 0 < 底线 8 → P1 危机接管（与开关无关）
  const decision = selectDeterministicCoreAction(
    makeState(15, 4, 0, [enemyAt([3, 0])]),
    null,
  );
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" }, "workers 起步后军事归零 → 紧急爆兵");
});
