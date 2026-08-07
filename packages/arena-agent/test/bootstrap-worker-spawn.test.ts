/** 冷启动 worker 扩编测试（2026-08-07，t3/t4 生产实证回归）：
 * worker < BOOTSTRAP_WORKER_TARGET(6) 时产 worker 豁免 spawnReserve——
 * 资源刚够成本就扩编（t4 实证：2W res 5 < 5+2=7 永不产第 3 个 worker）。
 * 达标后恢复 reserve 保护（防掏空国库）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { TickState, UnitType } from "../src/domain/model.ts";
import { selectDeterministicCoreAction } from "../src/planning/deterministic-planner.ts";

function makeState(workers: number, vanguards: number, rangers: number, resources: number): TickState {
  const units = [];
  const mk = (id: string, t: UnitType) => ({ id, position: [1, 0] as const, hp: 4, unitType: t, cargo: 0 });
  for (let i = 0; i < workers; i++) units.push(mk(`w${i}`, "WORKER"));
  for (let i = 0; i < vanguards; i++) units.push(mk(`v${i}`, "VANGUARD"));
  for (let i = 0; i < rangers; i++) units.push(mk(`r${i}`, "RANGER"));
  return {
    tick: 1,
    status: "ACTIVE",
    resources,
    resourceCapacity: 20,
    resourceSpace: 20 - resources,
    population: workers + vanguards + rangers,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units,
    workers: units.filter((u) => u.unitType === "WORKER"),
    vanguards: units.filter((u) => u.unitType === "VANGUARD"),
    rangers: units.filter((u) => u.unitType === "RANGER"),
    visibleEnemies: [],
    resourceCells: new Set<string>(),
    obstacleCells: new Set<string>(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const POLICY = {
  posture: "aggressive" as const,
  workerTarget: 12,
  militaryRatio: 0.4,
  focusRegion: null,
  attackPriority: "core" as const,
};

test("bootstrap：2W res 5（< cost 5 + reserve 2 = 7）→ 豁免 reserve 产 WORKER（t4 冻结回归）", () => {
  const state = makeState(2, 0, 0, 5);
  const r = selectDeterministicCoreAction(state, null, POLICY, 0.5, 30, false, 2, 20, false);
  assert.deepEqual(r.action, { type: "SPAWN", unitType: "WORKER" });
  assert.equal(r.intent, "spawn_worker_target");
});

test("bootstrap：5W（<6）res 5 → 豁免 reserve 产 WORKER", () => {
  const state = makeState(5, 0, 0, 5);
  const r = selectDeterministicCoreAction(state, null, POLICY, 0.5, 30, false, 2, 20, false);
  assert.deepEqual(r.action, { type: "SPAWN", unitType: "WORKER" });
});

test("bootstrap：达标后（11W ≥ 6）res 6 < 5+2=7 → 保留 reserve 不产（防掏空）", () => {
  const state = makeState(11, 0, 0, 6);
  const r = selectDeterministicCoreAction(state, null, POLICY, 0.5, 30, false, 2, 20, false);
  assert.equal(r.action, null, "达标后应保留 reserve，res 6 不够产 worker");
});

test("bootstrap：成本都不够（2W res 4 < 5）→ 不产", () => {
  const state = makeState(2, 0, 0, 4);
  const r = selectDeterministicCoreAction(state, null, POLICY, 0.5, 30, false, 2, 20, false);
  assert.equal(r.action, null);
});
