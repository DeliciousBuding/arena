/** runtime/loop 测试：plan→wire 转换、shadow 模式、提交路径。 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Turn } from "@arena/arena-hero-ts";
import type { PlayerState } from "@arena/arena-hero-ts";

import { planToCommandPlan, handleTurn } from "../src/runtime/loop.ts";
import { SafetyPlanner, DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";
import type { Plan } from "../src/domain/model.ts";

const MIN_STATE: PlayerState = {
  status: "ACTIVE",
  respawn_at_tick: null,
  resources: 4,
  population: 1,
  population_tier: 0,
  upkeep_next_tick: 0,
  champion_beacon: { position: [0, 0], status: "GROUND", carrier_id: null },
  objects: [
    {
      kind: "CORE",
      id: "c1",
      controlled: true,
      owner_username: "fixture_user",
      position: [0, 0],
      hp: 5,
      shield: 5,
      state: "NORMAL",
      move_direction: null,
      move_progress: null,
      move_required_ticks: null,
      destination: null,
    },
    {
      kind: "UNIT",
      id: "u1",
      controlled: true,
      position: [0, 1],
      hp: 2,
      unit_type: "WORKER",
      cargo: 0,
    },
  ],
  events: [],
};

function makeTurn(submitter: (plan: unknown) => Promise<{ accepted: boolean; tick: number }>) {
  return new Turn(100, MIN_STATE, submitter as never);
}

test("planToCommandPlan: domain Plan → wire CommandPlan（SHOOT/SPAWN 字段映射）", () => {
  const plan: Plan = {
    tick: 100,
    unitActions: {
      u1: { type: "SHOOT", targetId: "e1", expectedCell: [3, 0] },
    },
    coreAction: { type: "SPAWN", unitType: "WORKER" },
    intents: {},
  };
  const wire = planToCommandPlan(plan);
  assert.deepEqual(wire, {
    tick: 100,
    unit_actions: {
      u1: { type: "SHOOT", target_id: "e1", expected_cell: [3, 0] },
    },
    core_action: { type: "SPAWN", unit_type: "WORKER" },
  });
});

test("planToCommandPlan: 空计划 core_action null", () => {
  const wire = planToCommandPlan({ tick: 1, unitActions: {}, coreAction: null, intents: {} });
  assert.deepEqual(wire, { tick: 1, unit_actions: {}, core_action: null });
});

test("handleTurn shadow 模式：产出 plan 但不提交", async () => {
  let submitted = false;
  const turn = makeTurn(async () => {
    submitted = true;
    return { accepted: true, tick: 100 };
  });
  const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  const outcome = await handleTurn(turn, planner, { shadow: true }, 8000);
  assert.equal(outcome.tick, 100);
  assert.equal(outcome.source, "safety");
  assert.equal(outcome.accepted, false);
  assert.equal(submitted, false, "shadow 模式不得提交");
  assert.ok(outcome.plan.tick === 100);
});

test("handleTurn 提交路径：safety plan 提交成功", async () => {
  const accepted = await new Promise<{ accepted: boolean; tick: number }>((resolve) => {
    const turn = makeTurn(async (plan) => {
      const p = plan as { tick: number };
      resolve({ accepted: true, tick: p.tick });
      return { accepted: true, tick: p.tick };
    });
    void handleTurn(turn, new SafetyPlanner(DEFAULT_SAFETY_CONFIG), {}, 8000).then((outcome) => {
      assert.equal(outcome.source, "safety");
      assert.equal(outcome.accepted, true);
    });
  });
  assert.equal(accepted.tick, 100);
});

test("handleTurn 提交失败：error 字段带出", async () => {
  const turn = makeTurn(async () => {
    throw new Error("boom");
  });
  const outcome = await handleTurn(turn, new SafetyPlanner(DEFAULT_SAFETY_CONFIG), {}, 8000);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.error, "boom");
});
