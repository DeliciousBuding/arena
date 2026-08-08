/**
 * 敌核状态视图测试（2026-08-08，共享测绘深化）：ACTIVE/RELOCATED/STALE 分类 +
 * 威胁级别（距友核/活跃度）+ 排序。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEnemyCoreStates, DEFAULT_ENEMY_CORE_OPTS } from "../lib/enemy-core-state.ts";
import type { EnemyCoreHuntRow } from "../lib/enemy-core-state.ts";

const hunt = (over: Partial<EnemyCoreHuntRow> & { owner: string }): EnemyCoreHuntRow => ({
  x: 0, y: 0, firstSeenTick: 100, lastSeenTick: 100, source: "CORE",
  ...over,
});

test("enemy-core-state: ACTIVE——单位置且目击新鲜", () => {
  const cores = buildEnemyCoreStates([hunt({ owner: "alpha", x: 10, y: 10, lastSeenTick: 74000 })], 74050);
  assert.equal(cores.length, 1);
  assert.equal(cores[0].status, "ACTIVE");
  assert.equal(cores[0].locationCount, 1);
  assert.equal(cores[0].threat, "low", "无友核 → low");
});

test("enemy-core-state: RELOCATED——多位置且最新目击活跃", () => {
  const cores = buildEnemyCoreStates([
    hunt({ owner: "beta", x: 0, y: 0, lastSeenTick: 72000 }),
    hunt({ owner: "beta", x: 50, y: 60, lastSeenTick: 74100 }),
  ], 74200);
  const b = cores.find((c) => c.owner === "beta")!;
  assert.equal(b.status, "RELOCATED", "两位置 + 活跃 → 迁移中");
  assert.equal(b.locationCount, 2);
  assert.deepEqual([b.x, b.y], [50, 60], "最新位置 = 当前位置");
});

test("enemy-core-state: STALE——目击超陈旧窗口（即使多位置）", () => {
  const cores = buildEnemyCoreStates([
    hunt({ owner: "gamma", x: 0, y: 0, lastSeenTick: 60000 }),
    hunt({ owner: "gamma", x: 5, y: 5, lastSeenTick: 60005 }),
  ], 74000);
  const g = cores.find((c) => c.owner === "gamma")!;
  assert.equal(g.status, "STALE", "age > staleWindow → STALE");
  assert.equal(g.threat, "low", "STALE 不评估威胁");
});

test("enemy-core-state: 威胁级别——活跃距友核近 → high/medium", () => {
  const friend = [[0, 0] as readonly number[]];
  const cores = buildEnemyCoreStates([
    hunt({ owner: "near", x: 10, y: 10, lastSeenTick: 74100 }),   // 距友核 10 → high
    hunt({ owner: "mid", x: 100, y: 0, lastSeenTick: 74100 }),    // 距友核 100 → medium
    hunt({ owner: "far", x: 500, y: 500, lastSeenTick: 74100 }),  // → low
  ], 74200, friend);
  const byOwner = new Map(cores.map((c) => [c.owner, c.threat]));
  assert.equal(byOwner.get("near"), "high", "距 10 ≤ 60 → high");
  assert.equal(byOwner.get("mid"), "medium", "距 100 ≤ 200 → medium");
  assert.equal(byOwner.get("far"), "low", "距 500 → low");
  assert.equal(cores[0].owner, "near", "high 威胁排最前");
});

test("enemy-core-state: 默认窗口常量", () => {
  assert.equal(DEFAULT_ENEMY_CORE_OPTS.activeWindow, 1000);
  assert.equal(DEFAULT_ENEMY_CORE_OPTS.staleWindow, 5000);
  assert.equal(DEFAULT_ENEMY_CORE_OPTS.highThreatRadius, 60, "与 core-threats approachRadius 同口径");
});
