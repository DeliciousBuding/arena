/**
 * 守卫预留测试（2026-08-07，B7 候选——竞品 _strike_group_ids 对照）：
 * aggressive 攻坚时按 id 排序保留 1 个 Vanguard 守家（官方拆家留守卫
 * VANGUARD_CORE_GUARDS=1 防换家/反打——家不空防），其余全压。
 * 默认关闭 = 历史全压行为（零回归）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

function makeState(vanguardIds: string[]): TickState {
  const units = vanguardIds.map((id) => ({
    id: id.padEnd(36, "0"), position: [5, 0] as Position, hp: 4, unitType: "VANGUARD" as const, cargo: 0,
  }));
  return {
    tick: 1,
    status: "ACTIVE" as const,
    resources: 20,
    resourceCapacity: 50,
    resourceSpace: 30,
    population: units.length,
    core: { id: "c1", position: [0, 0] as Position, hp: 5, shield: 5, state: "NORMAL" as const, ownerUsername: "p1" },
    units,
    workers: [],
    vanguards: units,
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND" as const, carrierId: null },
    events: [],
  };
}

function decideWithConfig(vanguardIds: string[], strikeGroupReserve: boolean) {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, strikeGroupReserve });
  const plan = planner.decide({
    state: makeState(vanguardIds),
    policy: { posture: "aggressive", workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: null },
  });
  return vanguardIds.map((id) => {
    const unitId = id.padEnd(36, "0");
    return { id, intent: plan.intents[unitId] ?? "" };
  });
}

test("守卫预留：2 Vanguard 开启 → 排序最大 id 守家（vanguard_home_guard），其余原行为", () => {
  const results = decideWithConfig(["a1", "b2"], true);
  const guard = results.find((r) => r.id === "b2");
  const striker = results.find((r) => r.id === "a1");
  assert.equal(guard?.intent, "vanguard_home_guard", "最大 id = 守卫预留");
  assert.notEqual(striker?.intent, "vanguard_home_guard", "其余不守家");
});

test("守卫预留：默认关闭 → 无 vanguard_home_guard（历史全压零回归）", () => {
  const results = decideWithConfig(["a1", "b2"], false);
  assert.ok(!results.some((r) => r.intent === "vanguard_home_guard"), "默认关闭无守卫预留");
});

test("守卫预留：开启但 1 Vanguard → 不保留（len<2 全压）", () => {
  const results = decideWithConfig(["a1"], true);
  assert.ok(!results.some((r) => r.intent === "vanguard_home_guard"), "单兵不留守卫");
});

test("守卫预留：3 Vanguard 开启 → 仅最大 id 守家", () => {
  const results = decideWithConfig(["a1", "b2", "c3"], true);
  const guards = results.filter((r) => r.intent === "vanguard_home_guard");
  assert.equal(guards.length, 1, "只留 1 守卫");
  assert.equal(guards[0]?.id, "c3", "最大 id 守家");
});

test("守卫预留：守卫有邻近敌时 SWEEP 反击优先（不闲置）", () => {
  // 守卫（b2 最大 id）守家时，可见敌 Vanguard 邻接 → 反击优先于守位移动
  const state = makeState(["a1", "b2"]);
  const stateWithEnemy: TickState = {
    ...state,
    visibleEnemies: [{
      id: "e1", kind: "UNIT", position: [4, 0] as Position, hp: 4, unitType: "VANGUARD",
    }],
  };
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, strikeGroupReserve: true });
  const plan = planner.decide({
    state: stateWithEnemy,
    policy: { posture: "aggressive", workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: null },
  });
  const guardId = "b2".padEnd(36, "0");
  const action = plan.unitActions[guardId] ?? null;
  assert.ok(action !== null && action.type === "SWEEP", "守卫邻近敌反击优先");
});
