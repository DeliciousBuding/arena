/** 军事产兵回退测试（2026-08-07，t2 生产实证回归）：
 * 3V+0R、vanguardRatio 0.5、res 13 → nextMilitaryType 首选 RANGER(12+2=14)
 * 买不起 → 旧逻辑返回 null 军事冻结；修复后回退产 VANGUARD(10+2=12 ≤ 13)。
 * 首选买得起时仍产首选（配比语义不变）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { TickState, UnitType } from "../src/domain/model.ts";
import { selectDeterministicCoreAction } from "../src/planning/deterministic-planner.ts";

function makeState(workers: number, vanguards: number, rangers: number, resources: number): TickState {
  const units = [];
  const mk = (id: string, t: UnitType) => ({ id, position: [1, 0] as const, hp: 4, unitType: t, cargo: 0 });
  for (let i = 0; i < workers; i++) units.push(mk(`w${i}`, "WORKER"));
  for (let i = 0; i < vanguards; i++) units.push(mk(`v${i}`, "VANGUARD"));
  for (let i = 0; i < rangers; i++) units.push(mk(`r${i}`, "RANGER"));
  return {
    tick: 1,
    status: "ACTIVE",
    resources,
    resourceCapacity: 20,
    resourceSpace: 20 - resources,
    population: workers + vanguards + rangers,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units,
    workers: units.filter((u) => u.unitType === "WORKER"),
    vanguards: units.filter((u) => u.unitType === "VANGUARD"),
    rangers: units.filter((u) => u.unitType === "RANGER"),
    visibleEnemies: [],
    resourceCells: new Set<string>(),
    obstacleCells: new Set<string>(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const POLICY = {
  posture: "aggressive" as const,
  workerTarget: 12,
  militaryRatio: 0.4,
  focusRegion: null,
  attackPriority: "core" as const,
};

test("军事产兵：首选 RANGER 买不起（res 13 < 14）→ 回退产 VANGUARD（t2 冻结回归）", () => {
  // t2 生产实证快照：3V+0R、pop 15、res 13、ratio 0.5 → 首选 RANGER 12+2=14 > 13。
  // 2026-08-10 用户裁决：P1 危机爆兵接管（military 3 < 8、V 3 < 4 → 补 VANGUARD）。
  const state = makeState(12, 3, 0, 13);
  const r = selectDeterministicCoreAction(state, null, POLICY, 0.5, 30, false, 2, 20, false);
  assert.deepEqual(r.action, { type: "SPAWN", unitType: "VANGUARD" }, "应产 VANGUARD 打破冻结");
  assert.equal(r.intent, "spawn_emergency_military");
});

test("军事产兵：首选买得起仍产首选（配比语义保留于 P1 之后）", () => {
  // 3V+0R、res 15 ≥ RANGER 12+2=14 → 旧配比首选 RANGER；P1（V<4）接管产 VANGUARD
  const state = makeState(12, 3, 0, 15);
  const r = selectDeterministicCoreAction(state, null, POLICY, 0.5, 30, false, 2, 20, false);
  assert.deepEqual(r.action, { type: "SPAWN", unitType: "VANGUARD" });
  assert.equal(r.intent, "spawn_emergency_military");
});

test("军事产兵：两种都买不起 → null（保持现状不强制）", () => {
  const state = makeState(12, 3, 0, 9); // VANGUARD 10+2=12 > 9
  const r = selectDeterministicCoreAction(state, null, POLICY, 0.5, 30, false, 2, 20, false);
  assert.equal(r.action, null);
});
