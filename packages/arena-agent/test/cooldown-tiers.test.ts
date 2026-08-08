/**
 * 分级失败冷却测试（2026-08-08，缺席实证）：survey-db 缺席统计高频格升级
 * 失败冷却（96/192/384 tick），worker 不再每 32 tick 白试长期死格。
 * - 默认 32 零回归（无缺席记录格走默认冷却）；
 * - 升级格在升级冷却内被跳过、过期后恢复；
 * - visible 优先语义不变（refill 后重新可见立即恢复，不拦真矿）；
 * - 空注入/重复注入幂等。
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

// 矿格必须位于 Core 视野（Manhattan 5）之外——否则空视野 observe 会被
// vision invalidation 证伪为 harvested（负记忆不进 hints，永不恢复）。
const MINE: [number, number] = [8, 0];

function candidatesContain(world: World, cell: [number, number]): boolean {
  return world.resourceCandidates({ maxAge: 64 }).some(
    (candidate) => candidate.cell[0] === cell[0] && candidate.cell[1] === cell[1],
  );
}

test("cooldown-tiers: 无缺席记录格走默认 32 tick 冷却（零回归）", () => {
  const world = new World();
  world.observe(makeState(100));
  world.seedResourceMemory([MINE], 100);
  world.markResourceFailed(MINE);
  // 默认冷却 32：tick 100 + 32 内被压。
  world.observe(makeState(125));
  assert.equal(candidatesContain(world, MINE), false, "32 tick 内仍被失败冷却压制");
  world.observe(makeState(133));
  assert.equal(candidatesContain(world, MINE), true, "33 tick 后默认冷却过期恢复");
});

test("cooldown-tiers: 升级格 96 tick 冷却——升级时长内跳过、过期恢复", () => {
  const world = new World();
  world.observe(makeState(100));
  world.seedResourceMemory([MINE], 100);
  world.seedFailedCooldownTiers([{ position: MINE, cooldownTicks: 96 }]);
  world.markResourceFailed(MINE);
  world.observe(makeState(132));
  assert.equal(candidatesContain(world, MINE), false, "tick 132（+32）仍被 96 tick 升级冷却压制");
  world.observe(makeState(195));
  assert.equal(candidatesContain(world, MINE), false, "tick 195（+95）仍差 1 tick");
  world.observe(makeState(197));
  assert.equal(candidatesContain(world, MINE), true, "tick 197（+97）升级冷却过期恢复");
});

test("cooldown-tiers: visible 优先于失败冷却——refill 重新可见立即恢复", () => {
  const world = new World();
  world.observe(makeState(100));
  world.seedResourceMemory([MINE], 100);
  world.seedFailedCooldownTiers([{ position: MINE, cooldownTicks: 384 }]);
  world.markResourceFailed(MINE);
  // 升级冷却内重新可见（refill 后被视野看到）→ visible 第一分支，冷却不拦。
  world.observe(makeState(105, { resourceCells: new Set([cellKey(MINE)]) }));
  assert.equal(candidatesContain(world, MINE), true, "visible 矿不受失败冷却压制");
});

test("cooldown-tiers: 空注入幂等 + 重复注入不覆盖已有档位", () => {
  const world = new World();
  world.observe(makeState(100));
  assert.equal(world.seedFailedCooldownTiers([]), 0, "空注入返回 0");
  assert.equal(world.seedFailedCooldownTiers([{ position: MINE, cooldownTicks: 96 }]), 1, "首注 1 格");
  assert.equal(
    world.seedFailedCooldownTiers([{ position: MINE, cooldownTicks: 192 }]),
    0,
    "重复注入不覆盖（保持 96 档，幂等）",
  );
  world.seedResourceMemory([MINE], 100);
  world.markResourceFailed(MINE);
  world.observe(makeState(132));
  assert.equal(candidatesContain(world, MINE), false, "保持 96 档冷却而非被 192 覆盖");
});

function cellKey(cell: [number, number]): string {
  return `${cell[0]},${cell[1]}`;
}
