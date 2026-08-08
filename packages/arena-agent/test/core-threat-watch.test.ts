/** 近核入侵观察集成测试（2026-08-08，core-threat-watch-v1）：
 * 1. 静止 WORKER camp 距我方 Core ≤18 且超出短窗口（12 tick）→ 最近 Vanguard
 *    回访清剿（vanguard_watch_clear）——t2 实证：敌 WORKER 离核 2 格盘踞
 *    600+ tick，短记忆（6-12）过期后威胁归零、无军事响应；
 * 2. 战斗单位 camp（当前不可见、长 TTL 观察内）→ 远端 Vanguard 回援
 *    （vanguard_reinforce，官方 guide "敌方战斗单位进入 Core 防区 → 立即回援"）；
 * 3. 变体关闭 = 历史行为（无回访清剿）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

function enemyWorker(position: Position): VisibleEntity {
  return { id: "w-camp", kind: "UNIT", position, hp: 2, unitType: "WORKER", ownerUsername: "raider" };
}
function enemyVanguard(position: Position): VisibleEntity {
  return { id: "v-camp", kind: "UNIT", position, hp: 4, unitType: "VANGUARD", ownerUsername: "raider" };
}

function makeState(tick: number, enemies: VisibleEntity[], military: number, vanguardPos: Position = [10, 0]): TickState {
  const vanguards = [];
  for (let i = 0; i < military; i++) {
    const id = `v${String(i).padStart(2, "0")}`;
    vanguards.push({ id, position: vanguardPos, hp: 4, unitType: "VANGUARD" as const, cargo: 0 });
  }
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: military,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: vanguards,
    workers: [],
    vanguards,
    rangers: [],
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

function watchConfig(extra: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_SAFETY_CONFIG,
    aggression: "aggressive" as const,
    attackForce: 0,
    militaryHunt: true,
    coreThreatWatch: true,
    ...extra,
  };
}

function intentsOf(plan: { intents?: Record<string, string> }): string[] {
  return Object.values(plan.intents ?? {});
}

test("入侵观察：静止 WORKER camp 超出短窗口 → 最近 Vanguard 回访清剿（vanguard_watch_clear）", () => {
  const planner = new SafetyPlanner(watchConfig());
  // t1/t2 目击同一敌 WORKER 于 [2,0]（距 Core 2 格，观察半径内）→ stationary
  planner.decide({ state: makeState(1, [enemyWorker([2, 0])], 2), policy: undefined });
  planner.decide({ state: makeState(2, [enemyWorker([2, 0])], 2), policy: undefined });
  // t3..t19 无目击（推进 tick）；t20 时 lastSeen=2 → 20-2=18 > PREY_STATIONARY_TTL(12)，
  // 且仍在 CORE_WATCH_TTL(60) 内 → 走 vanguard_watch_clear（而非 scavenge/短窗口 prey）
  for (let t = 3; t < 20; t++) planner.decide({ state: makeState(t, [], 2), policy: undefined });
  const plan = planner.decide({ state: makeState(20, [], 2), policy: undefined });
  assert.ok(intentsOf(plan).includes("vanguard_watch_clear"), `期望 vanguard_watch_clear，实际 ${JSON.stringify(intentsOf(plan))}`);
});

test("入侵观察：变体关闭 = 历史行为（无回访清剿，走 scavenge）", () => {
  const planner = new SafetyPlanner(watchConfig({ coreThreatWatch: false }));
  planner.decide({ state: makeState(1, [enemyWorker([2, 0])], 2), policy: undefined });
  planner.decide({ state: makeState(2, [enemyWorker([2, 0])], 2), policy: undefined });
  for (let t = 3; t < 20; t++) planner.decide({ state: makeState(t, [], 2), policy: undefined });
  const plan = planner.decide({ state: makeState(20, [], 2), policy: undefined });
  assert.ok(!intentsOf(plan).includes("vanguard_watch_clear"), "变体关闭不应回访清剿");
});

test("入侵观察：战斗单位 camp（不可见、长 TTL 内）→ 远端 Vanguard 回援（vanguard_reinforce）", () => {
  const planner = new SafetyPlanner(watchConfig({ remoteReinforce: true, raidDefense: true }));
  // 远端 vanguard 在 [40,0]（REINFORCE_HOME_RING 外）；敌 Vanguard camp 在 [4,4] 距 Core 4
  planner.decide({ state: makeState(1, [enemyVanguard([4, 4])], 2, [40, 0]), policy: undefined });
  planner.decide({ state: makeState(2, [enemyVanguard([4, 4])], 2, [40, 0]), policy: undefined });
  for (let t = 3; t < 20; t++) planner.decide({ state: makeState(t, [], 2, [40, 0]), policy: undefined });
  const plan = planner.decide({ state: makeState(20, [], 2, [40, 0]), policy: undefined });
  assert.ok(intentsOf(plan).includes("vanguard_reinforce"), `期望回援，实际 ${JSON.stringify(intentsOf(plan))}`);
});
