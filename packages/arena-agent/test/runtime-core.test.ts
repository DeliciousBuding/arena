import { test } from "node:test";
import assert from "node:assert/strict";

import { type Plan, type TickState, type UnitSnapshot } from "../src/domain/model.ts";
import { validatePlan } from "../src/domain/plan-validator.ts";
import { DecisionLease } from "../src/runtime/decision-lease.ts";
import { hashTickState } from "../src/runtime/state-hash.ts";
import { SafetyPlanner } from "../src/strategies/safety-planner.ts";

const CORE = {
  id: "00000000-0000-0000-0000-000000000001",
  position: [0, 0] as const,
  hp: 5,
  shield: 5,
  state: "NORMAL" as const,
  ownerUsername: "buding",
};

function unit(
  id: string,
  unitType: UnitSnapshot["unitType"],
  position: readonly [number, number],
  options: { hp?: number; cargo?: number } = {},
): UnitSnapshot {
  return {
    id,
    unitType,
    position,
    hp: options.hp ?? (unitType === "VANGUARD" ? 4 : 2),
    cargo: options.cargo ?? 0,
  };
}

function state(options: Partial<TickState> = {}): TickState {
  const units = options.units ?? [];
  return {
    tick: 42,
    status: "ACTIVE",
    resources: 6,
    resourceCapacity: 10,
    resourceSpace: 4,
    population: units.length,
    core: CORE,
    units,
    workers: units.filter((item) => item.unitType === "WORKER"),
    vanguards: units.filter((item) => item.unitType === "VANGUARD"),
    rangers: units.filter((item) => item.unitType === "RANGER"),
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
    ...options,
  };
}

test("DecisionLease accepts exactly one matching candidate", () => {
  const current = state();
  const stateHash = hashTickState(current);
  const lease = new DecisionLease({ tick: current.tick, stateHash, deadlineAt: 10_000, runId: "run-1" });
  const plan: Plan = { tick: current.tick, unitActions: {}, coreAction: null, intents: {} };
  const candidate = { protocolVersion: "1" as const, tick: current.tick, stateHash, plan };
  assert.deepEqual(lease.submit(candidate, 9_000), { accepted: true, candidate });
  const second = lease.submit(candidate, 9_001);
  assert.equal(second.accepted, false);
  if (!second.accepted) assert.equal(second.code, "lease_not_active");
});

test("DecisionLease rejects stale state and late candidates", () => {
  const current = state();
  const stateHash = hashTickState(current);
  const plan: Plan = { tick: current.tick, unitActions: {}, coreAction: null, intents: {} };
  const mismatch = new DecisionLease({ tick: current.tick, stateHash, deadlineAt: 100 });
  const wrong = mismatch.submit({ protocolVersion: "1", tick: current.tick, stateHash: "wrong", plan }, 50);
  assert.equal(wrong.accepted, false);
  if (!wrong.accepted) assert.equal(wrong.code, "state_mismatch");

  const late = new DecisionLease({ tick: current.tick, stateHash, deadlineAt: 100 });
  const result = late.submit({ protocolVersion: "1", tick: current.tick, stateHash, plan }, 101);
  assert.equal(result.accepted, false);
  assert.equal(late.status, "expired");
});

test("validator repairs invalid actions without discarding legal actions", () => {
  const worker = unit("00000000-0000-0000-0000-000000000010", "WORKER", [0, 0], { cargo: 1 });
  const ranger = unit("00000000-0000-0000-0000-000000000020", "RANGER", [0, 0]);
  const enemy = {
    id: "00000000-0000-0000-0000-000000000099",
    kind: "UNIT" as const,
    position: [2, 0] as const,
    hp: 2,
    unitType: "VANGUARD" as const,
  };
  const current = state({ units: [worker, ranger], visibleEnemies: [enemy] });
  const plan: Plan = {
    tick: current.tick,
    unitActions: {
      [worker.id]: { type: "SHOOT", targetId: enemy.id, expectedCell: enemy.position },
      [ranger.id]: { type: "SHOOT", targetId: enemy.id, expectedCell: enemy.position },
      unknown: { type: "WAIT" },
    },
    coreAction: { type: "SPAWN", unitType: "RANGER" },
    intents: { [worker.id]: "bad", [ranger.id]: "shoot", unknown: "bad" },
  };
  const result = validatePlan(current, plan);
  assert.equal(result.valid, false);
  assert.deepEqual(Object.keys(result.plan.unitActions), [ranger.id]);
  assert.equal(result.plan.coreAction, null); // 6 resources cannot spawn Ranger
  assert.deepEqual(result.issues.map((issue) => issue.code).sort(), [
    "insufficient_resources",
    "unknown_unit",
    "wrong_capability",
  ]);
});

test("safety planner deposits cargo and prepares affordable Worker spawn", () => {
  const worker = unit("00000000-0000-0000-0000-000000000010", "WORKER", [0, 0], { cargo: 1 });
  const planner = new SafetyPlanner();
  const plan = planner.decide({ state: state({ units: [worker] }) });
  assert.deepEqual(plan.unitActions[worker.id], { type: "DEPOSIT" });
  assert.deepEqual(plan.coreAction, { type: "SPAWN", unitType: "WORKER" });
});

test("safety planner chooses legal Ranger shot before movement", () => {
  const ranger = unit("00000000-0000-0000-0000-000000000020", "RANGER", [0, 0]);
  const enemy = {
    id: "00000000-0000-0000-0000-000000000099",
    kind: "UNIT" as const,
    position: [3, 0] as const,
    hp: 2,
    unitType: "VANGUARD" as const,
  };
  const planner = new SafetyPlanner();
  const plan = planner.decide({ state: state({ units: [ranger], visibleEnemies: [enemy] }) });
  assert.deepEqual(plan.unitActions[ranger.id], {
    type: "SHOOT",
    targetId: enemy.id,
    expectedCell: enemy.position,
  });
});

test("TickState hash is independent of Set insertion order", () => {
  const a = state({ obstacleCells: new Set(["2,2", "1,1"]) });
  const b = state({ obstacleCells: new Set(["1,1", "2,2"]) });
  assert.equal(hashTickState(a), hashTickState(b));
});
