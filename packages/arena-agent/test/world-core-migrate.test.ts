/**
 * World 核心迁移巡逻重置测试（2026-08-08，t2 生产实证）：
 * - 核心稳定（NORMAL）位置变化 ≥ 5 格 → worker 巡逻记忆重置（patrolRing/started/returning）；
 * - 核心小幅移动（<5 格）→ 不重置；
 * - 核心 MOVING 途中位移 → 不触发（到达稳定才一次性重置）；
 * - 绝对坐标 intel（资源记忆）保留。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { TickState, UnitSnapshot } from "../src/domain/model.ts";
import { World } from "../src/domain/world.ts";

function makeState(
  tick: number,
  corePos: [number, number],
  coreState: "NORMAL" | "MOVING" = "NORMAL",
  units: UnitSnapshot[] = [],
  resourceCells: Set<string> = new Set(),
): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 0,
    population: 1,
    core: { id: "c1", position: corePos, hp: 5, shield: 5, state: coreState, ownerUsername: "p1" },
    units,
    workers: units.filter((u) => u.unitType === "WORKER"),
    vanguards: units.filter((u) => u.unitType === "VANGUARD"),
    rangers: units.filter((u) => u.unitType === "RANGER"),
    visibleEnemies: [],
    resourceCells,
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

function worker(id: string): UnitSnapshot {
  return { id, position: [0, 0], hp: 2, unitType: "WORKER", cargo: 0 };
}

function seedWorkerMemory(world: World, id: string, ring: number): void {
  const mem = world.unitMemory(id);
  mem.patrolRing = ring;
  mem.patrolStarted = true;
  mem.patrolReturning = true;
  mem.workerMode = "go_harvest";
  mem.harvestTarget = [10, 10];
}

test("World: 核心迁移 ≥5 格（NORMAL）→ worker 巡逻记忆重置", () => {
  const world = new World();
  const units = [worker("w1"), worker("w2")];
  world.observe(makeState(100, [-44, 51], "NORMAL", units, new Set(["5,5"])));
  seedWorkerMemory(world, "w1", 3);
  seedWorkerMemory(world, "w2", 2);

  world.observe(makeState(105, [-30, 38], "NORMAL", units));
  assert.equal(world.corePatrolResetCount, 1);
  assert.equal(world.lastCorePatrolResetTick, 105);
  for (const id of ["w1", "w2"]) {
    const mem = world.unitMemory(id);
    assert.equal(mem.patrolRing, 0, `${id} patrolRing 应重置`);
    assert.equal(mem.patrolStarted, false, `${id} patrolStarted 应重置`);
    assert.equal(mem.patrolReturning, false, `${id} patrolReturning 应重置`);
    assert.equal(mem.workerMode, "patrol", `${id} workerMode 应回 patrol`);
    assert.equal(mem.harvestTarget, null, `${id} harvestTarget 应清`);
  }
  assert.equal(world.resourceHints().length, 1, "资源记忆应保留");
});

test("World: 核心小幅移动 <5 格 → 不重置", () => {
  const world = new World();
  const units = [worker("w1")];
  world.observe(makeState(100, [-44, 51], "NORMAL", units));
  seedWorkerMemory(world, "w1", 3);
  world.observe(makeState(105, [-42, 51], "NORMAL", units));
  assert.equal(world.corePatrolResetCount, 0);
  assert.equal(world.unitMemory("w1").patrolRing, 3, "小幅移动不应重置");
});

test("World: 核心 MOVING 途中位移不触发，稳定后一次性重置", () => {
  const world = new World();
  const units = [worker("w1")];
  world.observe(makeState(100, [-44, 51], "NORMAL", units));
  seedWorkerMemory(world, "w1", 3);
  world.observe(makeState(105, [-40, 49], "MOVING", units));
  world.observe(makeState(110, [-30, 38], "MOVING", units));
  assert.equal(world.corePatrolResetCount, 0, "MOVING 途中不应重置");
  assert.equal(world.unitMemory("w1").patrolRing, 3);
  world.observe(makeState(115, [-30, 38], "NORMAL", units));
  assert.equal(world.corePatrolResetCount, 1);
  assert.equal(world.unitMemory("w1").patrolRing, 0);
  world.observe(makeState(120, [-30, 38], "NORMAL", units));
  assert.equal(world.corePatrolResetCount, 1, "稳定后不重复重置");
});
