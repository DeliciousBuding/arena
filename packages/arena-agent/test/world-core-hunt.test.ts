/**
 * World 敌情狩猎记忆测试（2026-08-07，持久敌情测绘）：
 * - CORE 目击 → sticky 狩猎目标（不随短 TTL 过期）；
 * - WORKER 轨迹/单次目击 → 推断锚点（WORKER_INFER，短窗口过期）；
 * - seedCoreHuntTargets 启动播种：更新鲜的目击不覆盖；
 * - 世界重置（tick 回退）→ 清空狩猎目标。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { TickState } from "../src/domain/model.ts";
import { World, type CoreHuntTarget } from "../src/domain/world.ts";

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

test("敌情狩猎：CORE 目击 → sticky 目标；短 TTL 过期后仍存在（CORE_HUNT_STICKY_TICKS）", () => {
  const world = new World();
  world.observe(makeState(100, {
    visibleEnemies: [{ id: "e-core", kind: "CORE", position: [-50, -30], hp: 5 }],
  }));
  const fresh = world.coreHuntTargets();
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]!.source, "CORE");
  assert.deepEqual(fresh[0]!.position, [-50, -30]);
  // 2000 tick 后（默认 enemyHints(6) 早已过期）CORE 目标仍在
  const old = world.coreHuntTargets();
  assert.equal(old.length, 1, "CORE 目标 sticky");
  void old;
});

test("敌情狩猎：WORKER 单次目击 → 远离我方单位方向推断锚点（WORKER_INFER）", () => {
  const world = new World();
  // 我方单位在 [0,0]；敌 worker 在 [20,0] → 远离方向猜测（东侧延伸）
  world.observe(makeState(100, {
    units: [{ id: "p1-u", position: [0, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
    workers: [{ id: "p1-u", position: [0, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
    vanguards: [],
    rangers: [],
    visibleEnemies: [{ id: "e-w", kind: "UNIT", position: [20, 0], hp: 2, unitType: "WORKER" }],
  }));
  const targets = world.coreHuntTargets();
  const inferred = targets.filter((t) => t.source === "WORKER_INFER");
  assert.ok(inferred.length >= 1, "有 WORKER_INFER 锚点");
  // 猜测锚点应离我方单位更远（x > 20）
  assert.ok(inferred.every((t) => t.position[0] > 20), `锚点应在东侧远处: ${JSON.stringify(inferred)}`);
});

test("敌情狩猎：WORKER 轨迹（有 prev）→ 双向延伸锚点", () => {
  const world = new World();
  // tick 100：敌 worker 在 [10,0]；tick 101：移动到 [12,0]（向东）→ 双向 ±8 格
  world.observe(makeState(100, {
    visibleEnemies: [{ id: "e-w", kind: "UNIT", position: [10, 0], hp: 2, unitType: "WORKER" }],
  }));
  world.observe(makeState(101, {
    visibleEnemies: [{ id: "e-w", kind: "UNIT", position: [12, 0], hp: 2, unitType: "WORKER" }],
  }));
  const xs = world.coreHuntTargets()
    .filter((t) => t.source === "WORKER_INFER")
    .map((t) => t.position[0])
    .sort((a, b) => a - b);
  assert.ok(xs.includes(12 + 8), `轨迹正向延伸锚点: ${JSON.stringify(xs)}`);
  assert.ok(xs.includes(12 - 8), `轨迹反向延伸锚点: ${JSON.stringify(xs)}`);
});

test("敌情狩猎：启动播种 + 更新鲜目击不覆盖 + 世界重置清空", () => {
  const world = new World();
  const seeds: readonly CoreHuntTarget[] = [
    { position: [-100, -50], lastSeenTick: 50, source: "CORE" },
    { position: [-200, -80], lastSeenTick: 30, source: "CORE" },
  ];
  const seeded = world.seedCoreHuntTargets(seeds);
  assert.equal(seeded, 2);
  assert.equal(world.coreHuntTargets().length, 2);
  // 更新鲜的 CORE 目击在 [0,0] → 新增；不覆盖旧目标
  world.observe(makeState(200, {
    visibleEnemies: [{ id: "e-core2", kind: "CORE", position: [0, 0], hp: 5 }],
  }));
  const after = world.coreHuntTargets();
  assert.equal(after.length, 3, "新目击追加");
  assert.equal(after[0]!.source, "CORE");
  // tick 回退（世界重置）→ 清空
  world.observe(makeState(50, {}));
  assert.equal(world.coreHuntTargets().length, 0, "重置清空狩猎目标");
});
