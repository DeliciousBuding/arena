/**
 * RECOVERY 早期防御产兵测试（2026-08-08，ref lifecycle overlay 对照）：
 * 重生/弱小期 worker 已起步（>=4）但军事=0 时，先产 1 个 Vanguard 自卫
 * （防野怪/入侵），不等 workerTarget=12——t3 重生后无军事实证。
 * 无军事+worker<4 继续冷启动产 worker；已有军事保持正常扩编。
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

test("RECOVERY 早期防御：worker 4 + 军事 0 → 产 VANGUARD 自卫（不等 workerTarget=12）", () => {
  const decision = selectDeterministicCoreAction(makeState(20, 4, 0), null, AGGRESSIVE, undefined, 0, false, 2, undefined, false, true);
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" });
  assert.equal(decision.intent, "spawn_vanguard_recovery");
});

test("RECOVERY 早期防御：res 刚够纯成本（10）但不够 10+reserve(2) → 仍产 VANGUARD（豁免储备）", () => {
  const decision = selectDeterministicCoreAction(makeState(10, 4, 0), null, AGGRESSIVE, undefined, 0, false, 2, undefined, false, true);
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" });
  assert.equal(decision.intent, "spawn_vanguard_recovery");
});

test("RECOVERY 早期防御：worker 3（<floor 4）+ 军事 0 → 继续冷启动产 worker", () => {
  const decision = selectDeterministicCoreAction(makeState(20, 3, 0), null, AGGRESSIVE, undefined, 0, false, 2, undefined, false, true);
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "WORKER" });
  assert.equal(decision.intent, "spawn_worker_target");
});

test("RECOVERY 早期防御：已有 1 军事 → 不触发（正常 worker 扩编）", () => {
  // military=1 不满足 military===0 → worker < target 继续产 worker
  const decision = selectDeterministicCoreAction(makeState(20, 4, 1), null, AGGRESSIVE, undefined, 0, false, 2, undefined, false, true);
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "WORKER" });
});

test("RECOVERY 早期防御：worker 达 target（12）+ 无军事 → 正常 military 产兵路径", () => {
  const decision = selectDeterministicCoreAction(makeState(30, 12, 0), null, AGGRESSIVE, undefined, 0, false, 2, undefined, false, false);
  assert.ok(decision.action !== null && decision.action.type === "SPAWN");
  assert.ok(["VANGUARD", "RANGER"].includes((decision.action as { unitType: string }).unitType), "军事产出应启动");
});

test("RECOVERY 早期防御：可显式关闭（零回归逃生口）", () => {
  const decision = selectDeterministicCoreAction(makeState(20, 4, 0), null, AGGRESSIVE, undefined, 0, false, 2, undefined, false, false);
  // 关闭后回到 worker 扩编
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "WORKER" });
});
