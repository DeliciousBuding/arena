/**
 * v0.14 动态产兵定价测试（2026-08-07 生产实证：pop 24 RANGER 实收 16、
 * pop 25 VANGUARD 实收 13——live 动态价与公式一致；旧 planner 用 base 价
 * 预算导致连串 INSUFFICIENT_RESOURCES 失败，t1 67452-67478 实证）。
 *
 * 验收：
 * - unitSpawnCost：pop≤19 base 价；pop 20/24（21 号起 k=1）→ 7/13/16；
 *   pop 25+（k=2）→ 8/17/20；pop 30（k=3）→ 11/22/26；
 * - selectDeterministicCoreAction：pop≥21 用动态价预算（资源够 base 但
 *   不够动态价 → 不产）；populationCeiling=20 时 pop≥20 不产（对齐
 *   Safety 配置，防超动态价线）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Turn, type PlayerState } from "@arena/arena-hero-ts";

import { unitSpawnCost, unitSpawnCosts } from "../src/domain/pricing.ts";
import { selectDeterministicCoreAction } from "../src/planning/deterministic-planner.ts";
import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import type { TickState } from "../src/domain/model.ts";

function makeState(
  population: number,
  resources: number,
  workers: number,
  vanguards: number,
  rangers: number,
): TickState {
  const objects: Array<PlayerState["objects"][number]> = [];
  const mk = (
    i: number,
    unitType: "WORKER" | "VANGUARD" | "RANGER",
    row: number,
    hp: number,
  ): PlayerState["objects"][number] => ({
    kind: "UNIT", id: `${unitType[0]}${i}`, controlled: true,
    position: [1 + (i % 10), row + Math.floor(i / 10)], hp, unit_type: unitType, cargo: 0,
  });
  for (let i = 0; i < workers; i++) objects.push(mk(i, "WORKER", 1, 2));
  for (let i = 0; i < vanguards; i++) objects.push(mk(i, "VANGUARD", 51, 4));
  for (let i = 0; i < rangers; i++) objects.push(mk(i, "RANGER", 81, 2));
  objects.push({
    kind: "CORE", id: "c1", controlled: true, owner_username: "fixture_user",
    position: [0, 0], hp: 5, shield: 5, state: "NORMAL",
    move_direction: null, move_progress: null, move_required_ticks: null, destination: null,
  });
  const turn = new Turn(
    100,
    {
      status: "ACTIVE",
      respawn_at_tick: null,
      resources,
      population,
      population_tier: 0,
      upkeep_next_tick: 0,
      champion_beacon: { position: [100, 100], status: "GROUND", carrier_id: null },
      objects,
      events: [],
    },
    (() => {}) as never,
  );
  return reduceTurn(turn as unknown as TurnLike);
}

test("unitSpawnCost：pop≤19 base 价；21 号起 k=1（7/13/16）；25+ k=2（8/17/20）；30 k=3（11/22/26）", () => {
  assert.equal(unitSpawnCost("WORKER", 19), 5);
  assert.equal(unitSpawnCost("VANGUARD", 19), 10);
  assert.equal(unitSpawnCost("RANGER", 19), 12);
  assert.deepEqual(unitSpawnCosts(20), { WORKER: 7, VANGUARD: 13, RANGER: 16 });
  assert.deepEqual(unitSpawnCosts(24), { WORKER: 7, VANGUARD: 13, RANGER: 16 }, "pop 24 仍 k=1（live: RANGER 16 实证）");
  assert.deepEqual(unitSpawnCosts(25), { WORKER: 8, VANGUARD: 17, RANGER: 20 }, "pop 25 k=2");
  assert.deepEqual(unitSpawnCosts(30), { WORKER: 11, VANGUARD: 22, RANGER: 26 }, "pop 30 k=3");
});

test("selectDeterministicCoreAction：pop≥21 用动态价——base 价可负担但动态价不够 → 不产（防 INSUFFICIENT_RESOURCES）", () => {
  // pop 24、12W+11V+1R（military 12/24=0.5>0.4 → needMilitary false → 本应产 worker？）
  // 为触发 needMilitary 用 military 占比 <0.4：12W+6V+2R（8/20=0.4 → false）。改用 12W+5V+2R（7/19<0.4）
  const state = makeState(24, 14, 12, 5, 2);
  // resources 14：base RANGER 12+2=14 可负担；动态 16+2=18 不可负担 → 不产
  const decision = selectDeterministicCoreAction(state, null, { posture: "aggressive", workerTarget: 12, militaryRatio: 0.4, focusRegion: null, attackPriority: null }, 0.5, 0, false, 2);
  assert.equal(decision.action, null, "pop 24 + 14 资源 → 动态价 18 不可负担，不产（旧 base 价会误产失败）");
  // 对照：pop 19（base 价）14 资源可负担 → 产军事
  const state19 = makeState(19, 14, 12, 5, 2);
  const decision19 = selectDeterministicCoreAction(state19, null, { posture: "aggressive", workerTarget: 12, militaryRatio: 0.4, focusRegion: null, attackPriority: null }, 0.5, 0, false, 2);
  assert.ok(decision19.action !== null && decision19.action.type === "SPAWN", "pop 19 + 14 资源 → base 价可负担，产兵");
});

test("selectDeterministicCoreAction：populationCeiling=20 → pop≥20 不产（对齐动态价线）", () => {
  // military=8（4V+4R 守卫编成已足，P1 危机爆兵不触发）+ res=80（低于
  // P3 硬顶线 105-15=90，P3 兜底不触发）→ ceiling 语义独立验证。
  // workers=13（units 总数 21 = population，占比 8/21 < 0.4 触发 needMilitary）
  const state = makeState(21, 80, 13, 4, 4);
  const decision = selectDeterministicCoreAction(state, null, { posture: "aggressive", workerTarget: 12, militaryRatio: 0.4, focusRegion: null, attackPriority: null }, 0.5, 0, false, 2, 20);
  assert.equal(decision.action, null, "pop 21 ≥ ceiling 20 → 不产");
  // 缺省（Infinity）= 历史行为：不设上限（动态价预算 + 资源 80 可负担 → 产）
  const decisionDefault = selectDeterministicCoreAction(state, null, { posture: "aggressive", workerTarget: 12, militaryRatio: 0.4, focusRegion: null, attackPriority: null }, 0.5, 0, false, 2);
  assert.ok(decisionDefault.action !== null && decisionDefault.action.type === "SPAWN", "缺省上限 + pop21 + 资源 80 → 动态价可负担，产兵（历史行为零回归）");
});

test("sim/contracts pricing 与 domain 共用公式：pop 24 RANGER=16、pop 25 VANGUARD=13（live 实证对照）", () => {
  // 直接验证 live 观测值反推（spawn 前人口 23/24 → k=1）
  assert.equal(unitSpawnCost("RANGER", 23), 16, "live: pop 24 结算 RANGER 16（spawn 前 23）");
  assert.equal(unitSpawnCost("VANGUARD", 24), 13, "live: pop 25 结算 VANGUARD 13（spawn 前 24）");
});
