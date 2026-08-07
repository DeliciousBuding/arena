/**
 * World 世界状态测试（docs/design/world-state.md P0）：
 * - tick 回退（服务器世界重置）→ 全清本地记忆 + worldResetCount 计数；
 * - 资源记忆 TTL：stale/harvested 超过 64 ticks 删除（防幽灵资源）；
 * - visible 资源永不因 TTL 删除（活跃引用保持）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { TickState } from "../src/domain/model.ts";
import { World } from "../src/domain/world.ts";

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

test("World: tick 回退 → 全清记忆 + worldResetCount 计数", () => {
  const world = new World();
  // 正常推进：tick 100 看到资源/障碍/敌人
  world.observe(makeState(100, {
    resourceCells: new Set(["5,5"]),
    obstacleCells: new Set(["9,9"]),
    visibleEnemies: [{ id: "enemy-1", kind: "UNIT", position: [8, 8], hp: 2, unitType: "WORKER" }],
  }));
  world.unitMemory("worker-1");
  assert.equal(world.resourceHints().length, 1);
  assert.equal(world.obstacles().size, 1);
  assert.equal(world.enemyHints().length, 1);

  // tick 回退（服务器世界重置）→ 全清
  world.observe(makeState(50));
  assert.equal(world.worldResetCount, 1);
  assert.equal(world.lastWorldResetTick, 50);
  assert.equal(world.resourceHints().length, 0, "重置后旧资源记忆清空");
  assert.equal(world.obstacles().size, 0, "重置后旧障碍清空");
  assert.equal(world.enemyHints().length, 0, "重置后旧敌人清空");
  // 重置后新可见资源正常入记忆
  world.observe(makeState(51, { resourceCells: new Set(["1,1"]) }));
  assert.equal(world.resourceHints().length, 1);
});

test("World: 资源记忆 TTL（stale 超 64 ticks 删除）", () => {
  const world = new World();
  world.observe(makeState(100, { resourceCells: new Set(["5,5"]) }));
  assert.equal(world.resourceHints().length, 1, "visible 资源可用");

  // 不可见 → stale；65 ticks 后过期删除
  world.observe(makeState(101));
  assert.equal(world.resourceHints().length, 1, "stale 在 maxAge 内仍可用");
  world.observe(makeState(166));
  assert.equal(world.resourceHints().length, 0, "超过 TTL 的 stale 已删除");
});

test("World: visible 资源不受 TTL 影响（活跃引用保持）", () => {
  const world = new World();
  world.observe(makeState(100, { resourceCells: new Set(["5,5"]) }));
  // 持续可见 200 ticks（> TTL）——不删除
  for (let tick = 101; tick <= 300; tick += 1) {
    world.observe(makeState(tick, { resourceCells: new Set(["5,5"]) }));
  }
  assert.equal(world.resourceHints().length, 1, "持续可见资源永不因 TTL 删除");
});

test("World: HARVEST_FAILED NOT_RESOURCE_CELL → 负记忆（visited-empty 立即失效）", () => {
  const world = new World();
  world.observe(makeState(100, { resourceCells: new Set(["5,5"]) }));
  assert.equal(world.resourceHints().length, 1, "可见资源入记忆");

  // 下一 tick 资源消失 + 采集失败 NOT_RESOURCE_CELL（追死记忆矿）→ 记 harvested
  world.observe(makeState(101, {
    resourceCells: new Set(),
    events: [{
      eventId: "e1", tick: 101, eventType: "HARVEST_FAILED", reasonCode: "NOT_RESOURCE_CELL",
      actorId: "worker-1", targetId: null, position: [5, 5], values: {},
    }],
  }));
  assert.equal(world.resourceHints().length, 0, "NOT_RESOURCE_CELL 后不再从记忆提示（防 30-78 格无效脚程）");

  // refill 后重新可见 → 恢复提示（不永久丢失）
  world.observe(makeState(106, { resourceCells: new Set(["5,5"]) }));
  assert.equal(world.resourceHints().length, 1, "refill 重新可见即恢复");
});
