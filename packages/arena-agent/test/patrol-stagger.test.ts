/** 巡逻出发错峰测试（2026-08-08，t2 生产实证）：
 * 核心区 worker 群同步出发 → 出口容量互堵永久卡死（12 worker 挤核心 5 格
 * 36+ tick 位置不动）。修复：离 home ≤3 格且 2 格内 worker ≥5（拥挤）且存在
 * 更靠外的邻居 → 原地 WAIT（worker_hold_crowded）错峰；最靠外 worker 正常
 * 出发（patrol）——至少外圈先疏散，不会全 WAIT。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

function makeState(workerPos: number[][]): TickState {
  const units = workerPos.map(([x, y], i) => ({
    id: `22222222-2222-2222-2222-2222222222${String(i).padStart(2, "0")}`,
    position: [x, y] as Position,
    hp: 2,
    unitType: "WORKER" as const,
    cargo: 0,
  }));
  return {
    tick: 1,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 50,
    resourceSpace: 40,
    population: units.length,
    core: { id: "c1", position: [0, 0] as Position, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units,
    workers: units,
    vanguards: [],
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

test("巡逻错峰：核心区拥挤时靠内 worker 等待、最靠外 worker 正常出发", () => {
  // t2 实证布局：12 worker 挤核心 5 格内（大量重叠），无资源/敌人
  const positions: number[][] = [
    [-1, 2], [-1, 2], [-3, 2], [-3, 2], [-4, 2], [-4, 2],
    [0, 3], [0, 3], [-4, -1], [-1, -3], [5, 0], [0, 8],
  ];
  const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  const plan = planner.decide({ state: makeState(positions) });
  const intents = Object.values(plan.intents ?? {});
  assert.ok(
    intents.includes("patrol"),
    `应至少一个 worker 正常出发巡逻，实际 intents=${JSON.stringify(intents)}`,
  );
  assert.ok(
    intents.includes("worker_hold_crowded"),
    `核心区靠内 worker 应错峰等待，实际 intents=${JSON.stringify(intents)}`,
  );
});

test("巡逻错峰：无拥挤（worker 在 4+ 格环外）→ 全员正常巡逻（零回归）", () => {
  // 注意：12 worker 挤 3 格环内也属于"核心区拥挤"（间距 1-2 格），错峰是
  // 正确行为；真正不触发错峰的场景是 worker 已在 4+ 格环外（chebyshev > 3）。
  const positions: number[][] = [
    [4, 0], [0, 4], [-4, 0], [0, -4], [4, 3], [3, 4],
    [-4, 3], [-3, 4], [4, -3], [3, -4], [-4, -3], [-3, -4],
  ];
  const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  const plan = planner.decide({ state: makeState(positions) });
  const intents = Object.values(plan.intents ?? {});
  assert.ok(
    intents.includes("patrol"),
    `分散场景应正常巡逻，实际 intents=${JSON.stringify(intents)}`,
  );
  assert.ok(
    !intents.includes("worker_hold_crowded"),
    "分散场景不应误触发错峰等待",
  );
});