/**
 * 分级失败冷却测试（2026-08-08，缺席实证）：survey-db 缺席统计高频格升级
 * markResourceFailed 冷却（32 → 96/192/384 tick），worker 不每 32 tick 白试
 * 长期死格。语义约束：
 * - 无分级记录 = 默认冷却（零回归）；
 * - visible 矿优先于冷却（refill 后重新可见立即恢复，不被升级冷却压制）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Position, TickState } from "../src/domain/model.ts";
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
      position: [0, 0] as const,
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
    beacon: { position: [100, 100] as const, status: "GROUND", carrierId: null },
    events: [],
    ...overrides,
  };
}

const MINE: [number, number] = [8, 0]; // Core 视野 5 之外（[0,0] → Manhattan 8），避免视野证伪干扰
const MINE_KEY = "8,0";

/** seed 一个 stale 记忆矿（seeded 标志保留——seed 格不受 maxAge 窗口限制）。
 *  结束后 world.tick = seedTick。 */
function seedStaleMine(world: World, tick: number): void {
  world.seedResourceMemory([MINE], tick);
  world.observe(makeState(tick));
}

function hasMine(candidates: readonly { cell: Position }[]): boolean {
  return candidates.some((c) => c.cell[0] === MINE[0] && c.cell[1] === MINE[1]);
}

test("分级冷却：无分级记录 = 默认 32 tick 冷却（零回归）", () => {
  const world = new World();
  seedStaleMine(world, 100);
  world.markResourceFailed(MINE); // world.tick = 100
  assert.equal(hasMine(world.resourceCandidates()), false, "冷却内被压制");
  world.observe(makeState(131)); // 100 + 31 < 32
  assert.equal(hasMine(world.resourceCandidates()), false, "31 tick 仍压制");
  world.observe(makeState(132)); // 100 + 32 = 到期
  assert.equal(hasMine(world.resourceCandidates()), true, "32 tick 后恢复候选");
});

test("分级冷却：升级格冷却更长（96），过期后恢复", () => {
  const world = new World();
  seedStaleMine(world, 100);
  world.seedFailedCooldownTiers([{ position: MINE, cooldownTicks: 96 }]);
  world.markResourceFailed(MINE); // world.tick = 100
  world.observe(makeState(131)); // 32 后（默认冷却已到期）
  assert.equal(hasMine(world.resourceCandidates()), false, "96 冷却内不恢复（默认 32 已过期）");
  world.observe(makeState(195)); // 100 + 95 < 96
  assert.equal(hasMine(world.resourceCandidates()), false, "95 tick 仍压制");
  world.observe(makeState(196)); // 100 + 96 = 到期
  assert.equal(hasMine(world.resourceCandidates()), true, "96 tick 后恢复候选");
});

test("分级冷却：可见矿优先于升级冷却（refill 后立即恢复，不拦真矿）", () => {
  const world = new World();
  seedStaleMine(world, 100);
  world.seedFailedCooldownTiers([{ position: MINE, cooldownTicks: 384 }]);
  world.markResourceFailed(MINE);
  // 升级冷却 384 内，矿 refill 重新可见 → visible 优先恢复
  world.observe(makeState(110, { resourceCells: new Set([MINE_KEY]) }));
  assert.equal(hasMine(world.resourceCandidates()), true, "visible 优先于冷却，不拦真矿");
});

test("分级冷却：空注入 = 零回归（seedFailedCooldownTiers 幂等）", () => {
  const world = new World();
  seedStaleMine(world, 100);
  assert.equal(world.seedFailedCooldownTiers([]), 0, "空注入不计数");
  world.markResourceFailed(MINE); // world.tick = 100
  world.observe(makeState(131));
  assert.equal(hasMine(world.resourceCandidates()), false, "无分级记录 = 默认 32 冷却");
  world.observe(makeState(132));
  assert.equal(hasMine(world.resourceCandidates()), true, "32 后恢复");
});
