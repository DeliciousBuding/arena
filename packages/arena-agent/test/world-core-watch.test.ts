/**
 * World 近核入侵观察记忆测试（2026-08-08，core-threat-watch-v1）：
 * - 敌单位距我方 Core ≤ CORE_WATCH_RADIUS 目击 → 入长 TTL 观察；
 * - 观察外（> 半径）不记录；
 * - 连续目击同格 → stationary（盘踞 camp / 挂机单位）；
 * - TTL 过期后不再返回（默认 CORE_WATCH_TTL = 60）；
 * - 战场记忆清理（Core 重生）→ 观察清空。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { TickState } from "../src/domain/model.ts";
import { CORE_WATCH_RADIUS, CORE_WATCH_TTL, World } from "../src/domain/world.ts";

function makeState(tick: number, overrides: Partial<TickState> = {}): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 0,
    population: 1,
    core: {
      id: "11111111-1111-1111-1111-111111111111",
      position: [0, 0],
      hp: 5,
      shield: 5,
      state: "NORMAL",
      ownerUsername: "p1",
    },
    units: [],
    workers: [],
    vanguards: [],
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
    ...overrides,
  };
}

function enemy(id: string, position: [number, number], unitType: "WORKER" | "VANGUARD" | "RANGER") {
  return { id, kind: "UNIT" as const, position, hp: 2, unitType };
}

test("近核观察：半径内敌单位目击 → 记录；观察外不记录", () => {
  const world = new World();
  world.observe(makeState(100, {
    visibleEnemies: [
      enemy("e-near", [CORE_WATCH_RADIUS - 1, 0], "VANGUARD"), // 半径内
      enemy("e-far", [CORE_WATCH_RADIUS + 5, 0], "VANGUARD"),   // 半径外
    ],
  }));
  const targets = world.coreWatchTargets();
  const ids = targets.map((t) => t.id).sort();
  assert.deepEqual(ids, ["e-near"]);
  assert.equal(targets[0]!.coreDistance, CORE_WATCH_RADIUS - 1);
});

test("近核观察：连续目击同格 → stationary（盘踞 camp/挂机）", () => {
  const world = new World();
  world.observe(makeState(100, { visibleEnemies: [enemy("w1", [2, 2], "WORKER")] }));
  world.observe(makeState(101, { visibleEnemies: [enemy("w1", [2, 2], "WORKER")] }));
  const targets = world.coreWatchTargets();
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.stationary, true);
});

test("近核观察：移动单位不算 stationary（连续目击不同格）", () => {
  const world = new World();
  world.observe(makeState(100, { visibleEnemies: [enemy("w1", [2, 2], "WORKER")] }));
  world.observe(makeState(101, { visibleEnemies: [enemy("w1", [3, 3], "WORKER")] }));
  const targets = world.coreWatchTargets();
  assert.equal(targets[0]!.stationary, false);
});

test("近核观察：TTL 过期后不再返回；默认 CORE_WATCH_TTL=60", () => {
  const world = new World();
  world.observe(makeState(100, { visibleEnemies: [enemy("e1", [2, 0], "RANGER")] }));
  assert.equal(world.coreWatchTargets().length, 1);
  assert.equal(world.coreWatchTargets(CORE_WATCH_TTL).length, 1, "显式 TTL 同值仍在");
  // 推进 world.tick（无新目击）：tick 160 → 160-100=60 ≤ TTL 仍在；tick 161 → 过期
  world.observe(makeState(160, { visibleEnemies: [] }));
  assert.equal(world.coreWatchTargets().length, 1, "TTL 边界内仍在");
  world.observe(makeState(161, { visibleEnemies: [] }));
  assert.equal(world.coreWatchTargets().length, 0, "超过 TTL 观察过期");
});

test("近核观察：战场记忆清理（Core 重生）→ 观察清空", () => {
  const world = new World();
  world.observe(makeState(100, { visibleEnemies: [enemy("e1", [2, 0], "VANGUARD")] }));
  assert.equal(world.coreWatchTargets().length, 1);
  const cleared = world.clearBattlefieldMemory();
  assert.ok(cleared >= 1);
  assert.equal(world.coreWatchTargets().length, 0);
});
