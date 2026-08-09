/**
 * 家防底线渐进补编测试（home-defense-bottom-v1，W3b，2026-08-09，
 * algorithm-update-plan-v1 §4-W3）：
 * 早期（worker 起步 >=4）按官方 AGGRESS_DEFENDER_VANGUARDS=3 /
 * AGGRESS_DEFENDER_RANGERS=3 底线渐进补编——1V 自卫 → 1V+2R → 3V+3R，
 * 每档只产缺口兵种；豁免 spawnReserve（纯成本门禁）；不受 workerTarget=12
 * 前置门限制。变体关闭 = 行为不变（零回归）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState } from "../src/domain/model.ts";
import { selectDeterministicCoreAction } from "../src/planning/deterministic-planner.ts";

function makeState(resources: number, workers: number, vanguards: number, rangers = 0): TickState {
  const units = [
    ...Array.from({ length: workers }, (_, i) => ({
      id: `w${i}`.padEnd(36, "0"), position: [5, 0] as Position, hp: 2, unitType: "WORKER" as const, cargo: 0,
    })),
    ...Array.from({ length: vanguards }, (_, i) => ({
      id: `v${i}`.padEnd(36, "0"), position: [5, 0] as Position, hp: 4, unitType: "VANGUARD" as const, cargo: 0,
    })),
    ...Array.from({ length: rangers }, (_, i) => ({
      id: `r${i}`.padEnd(36, "0"), position: [5, 0] as Position, hp: 2, unitType: "RANGER" as const, cargo: 0,
    })),
  ];
  return {
    tick: 1,
    status: "ACTIVE" as const,
    resources,
    resourceCapacity: 50,
    resourceSpace: 50 - resources,
    population: units.length,
    core: { id: "c1", position: [0, 0] as Position, hp: 5, shield: 5, state: "NORMAL" as const, ownerUsername: "p1" },
    units,
    workers: units.filter((u) => u.unitType === "WORKER"),
    vanguards: units.filter((u) => u.unitType === "VANGUARD"),
    rangers: units.filter((u) => u.unitType === "RANGER"),
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND" as const, carrierId: null },
    events: [],
  };
}

const AGGRESSIVE = { posture: "aggressive" as const, workerTarget: 12, militaryRatio: 0.4, focusRegion: null as null, attackPriority: "core" as const };

/** 参数顺序：state, fallback, policy, vanguardRatio, accumulateThreshold, surgeActive, spawnReserve, populationCeiling, threatDefenseSpawn, recoveryEarlyMilitary, homeDefenseBottom */
function decide(state: TickState, homeDefenseBottom: boolean) {
  return selectDeterministicCoreAction(state, null, AGGRESSIVE, undefined, 0, false, 2, undefined, false, false, homeDefenseBottom);
}

test("W3b 家防底线：worker 5 + 无军事 → 产 VANGUARD（P1 危机爆兵接管，2026-08-10 用户裁决）", () => {
  // 旧语义：homeDefenseBottom 渐进补编（intent spawn_home_defense_vanguard）。
  // 2026-08-10 用户裁决"守卫起码 8 个（4V+4R）"：P1 危机爆兵（military < 8
  // 且 worker 起步）优先接管——产出同为 VANGUARD，intent 换 emergency。
  const decision = decide(makeState(20, 5, 0), true);
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" });
  assert.equal(decision.intent, "spawn_emergency_military");
});

test("W3b 家防底线：已有 1V → P1 接管（V<4 补 VANGUARD，4V+4R 编成）", () => {
  // 旧渐进：1V → 补 RANGER。新裁决 4V+4R：V(1) < 4 → 补 VANGUARD。
  const decision = decide(makeState(20, 5, 1), true);
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" });
  assert.equal(decision.intent, "spawn_emergency_military");
});

test("W3b 家防底线：已有 1V+2R → P1 接管（V<4 补 VANGUARD）", () => {
  const decision = decide(makeState(20, 5, 1, 2), true);
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" });
  assert.equal(decision.intent, "spawn_emergency_military");
});

test("W3b 家防底线：已有 3V+3R（6 < 8）→ P1 接管补 VANGUARD（4V+4R 编成未满）", () => {
  // 旧语义：3V+3R 满编（家防底线 3V+3R）→ 回正常扩编。新裁决底线 4V+4R：
  // 军事 6 < 8 且 V(3) < 4 → 继续补 VANGUARD。
  const decision = decide(makeState(20, 5, 3, 3), true);
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" });
  assert.equal(decision.intent, "spawn_emergency_military");
});

test("W3b 家防底线：豁免 reserve——res 刚够 VANGUARD 纯成本（10）→ 仍产（生存行为只看纯成本）", () => {
  const decision = decide(makeState(10, 5, 0), true);
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" });
});

test("W3b 家防底线：res 不足纯成本 → 不产军事（资源门禁仍在）", () => {
  const decision = decide(makeState(9, 5, 0), true);
  assert.notEqual(
    (decision.action as { unitType?: string } | null)?.unitType,
    "VANGUARD",
    "res < 成本不得产 VANGUARD",
  );
});

test("W3b 家防底线：worker 3（<floor 4）→ 不触发（冷启动产 worker 优先）", () => {
  const decision = decide(makeState(20, 3, 0), true);
  assert.equal(decision.action?.type, "SPAWN");
  assert.equal((decision.action as { unitType: string }).unitType, "WORKER");
});

test("W3b 家防底线：militaryRatio=0 → P1 接管（2026-08-10 用户裁决：守卫底线不随配比关闭）", () => {
  // 旧语义：militaryRatio=0 → 纯 worker 扩编。新裁决：军事 < 8（守卫编成）
  // 且 worker 起步 → P1 危机爆兵，与 militaryRatio 无关（家不空防优先）。
  const noRatio = { posture: "aggressive" as const, workerTarget: 12, militaryRatio: 0, focusRegion: null as null, attackPriority: "core" as const };
  const decision = selectDeterministicCoreAction(makeState(20, 5, 0), null, noRatio, undefined, 0, false, 2, undefined, false, false, true);
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" });
  assert.equal(decision.intent, "spawn_emergency_military");
});

test("W3b 家防底线：变体关闭 → P1 仍接管（逃生口语义更新，2026-08-10 用户裁决）", () => {
  // 旧语义：关闭 = 历史行为（扩 worker）。P1 危机爆兵为默认开的核心行为，
  // 不受该变体开关控制：military 0 < 8 且 worker 起步 → 产 VANGUARD。
  const decision = decide(makeState(20, 5, 0), false);
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" });
  assert.equal(decision.intent, "spawn_emergency_military");
});

test("W3b 家防底线：与 recoveryEarlyMilitary 独立（P1 统一接管）", () => {
  const decision = selectDeterministicCoreAction(makeState(20, 4, 0), null, AGGRESSIVE, undefined, 0, false, 2, undefined, false, false, true);
  // 4 worker + 0 军事 → P1 危机爆兵产 VANGUARD（2026-08-10 用户裁决，
  // 覆盖旧 home_defense/recovery 分支语义）
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" });
  assert.equal(decision.intent, "spawn_emergency_military");
});
