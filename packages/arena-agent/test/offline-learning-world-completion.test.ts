/** M2c.1 private-observation world-completion bridge tests. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { makeCandidateV1, computeCandidateSetHash } from "../src/offline-learning/candidate/decision-candidate-v1.ts";
import { completeVisibleOnlyDecisionWorld } from "../src/offline-learning/counterfactual/world-completion.ts";
import type { MacroDecisionPointV1 } from "../src/offline-learning/runtime/macro-decision-point.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const CORE = "11111111-1111-1111-1111-111111111111";
const WORKER = "22222222-2222-2222-2222-222222222222";
const ENEMY = "33333333-3333-3333-3333-333333333333";
const KEEP = makeCandidateV1({ candidateId: "keep", kind: "KEEP", parameters: {}, source: "baseline" });
const POLICY: MacroPolicy = {
  posture: "balanced",
  workerTarget: 8,
  militaryRatio: 0.4,
  focusRegion: null,
  attackPriority: null,
};

function stateAt() {
  return {
    status: "ACTIVE",
    respawn_at_tick: null,
    resources: 10,
    population: 1,
    population_tier: null,
    upkeep_next_tick: null,
    champion_beacon: { position: [0, 0], status: null, carrier_id: null },
    objects: [
      {
        kind: "CORE", id: CORE, controlled: true, owner_username: "t1", position: [-10, 4],
        hp: 5, shield: 5, state: "NORMAL", move_direction: null, move_progress: null,
        move_required_ticks: null, destination: null,
      },
      {
        kind: "UNIT", id: WORKER, controlled: true, position: [-9, 4], hp: 2,
        unit_type: "WORKER", cargo: 0,
      },
      {
        kind: "UNIT", id: ENEMY, controlled: false, position: [-7, 4], hp: 2,
        unit_type: "VANGUARD", cargo: null,
      },
      { kind: "RESOURCE", positions: [[-9, 4], [-8, 4]] },
      { kind: "OBSTACLE", positions: [[-10, 6]] },
    ],
    events: [],
  };
}

function rawCase() {
  return {
    schema: "sim-calibration-case-v1",
    caseId: "run-live:100",
    tenantId: "t1",
    rulesVersion: "v0.14",
    seed: 0,
    metadata: {
      source: "live-recorder",
      opponentPlans: "absent",
      recordedAt: "2026-08-09T00:00:00Z",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      runId: "run-live:t1:100:1",
    },
    before: { tick: 100, state: stateAt() },
    plan: { tick: 100, unitActions: {}, coreAction: null, intents: {} },
    after: { tick: 101, state: stateAt() },
  };
}

function decisionPoint(): MacroDecisionPointV1 {
  return {
    schema: "macro-decision-point-v1",
    decisionPointId: "run-live:100",
    processRunId: "run-live",
    tick: 100,
    intervalTicks: 32,
    previousPolicy: POLICY,
    newPolicy: POLICY,
    chosenBy: "policy-sticky",
    candidates: [KEEP],
    candidateSetHash: computeCandidateSetHash([KEEP]),
    chosenCandidateHash: KEEP.deterministicHash,
    selectionRepresentable: true,
    behaviorPropensity: null,
  };
}

test("visible-only completion preserves identity and exposes every hidden-state assumption", () => {
  const completion = completeVisibleOnlyDecisionWorld(rawCase(), decisionPoint());
  assert.equal(completion.initialStateScope, "private-observation-completed");
  assert.equal(completion.completionPolicy, "private-visible-only-v1");
  assert.equal(completion.completionSeed, null);
  assert.equal(completion.opponentId, "visible-opponent-v1");
  assert.equal(completion.world.tick, 100);
  assert.equal(completion.world.resolvedTickCount, 99);
  assert.equal(completion.world.seed, 0);
  assert.ok(completion.world.players.has("t1"));
  assert.ok(completion.world.players.has("visible-opponent-v1"));
  assert.equal(completion.world.players.get("visible-opponent-v1")?.units.length, 1);
  assert.deepEqual(completion.world.beacon, { position: [0, 0], status: "GROUND", carrierId: null });
  for (const assumption of [
    "unobserved-terrain=>EMPTY",
    "unobserved-entities=>ABSENT",
    "visible-opponent-ownership=>SINGLE_SYNTHETIC_OPPONENT",
    "visible-opponent-future-policy=>DETERMINISTIC_DEFAULT",
    "hidden-beacon-status=>GROUND_AT_AUTHORITATIVE_POSITION",
    "observed-opponent-plan=>ABSENT",
  ]) {
    assert.ok(completion.completionAssumptions.includes(assumption), assumption);
  }
});

test("visible-only completion fails closed when decision/case identity diverges", () => {
  assert.throws(
    () => completeVisibleOnlyDecisionWorld(rawCase(), { ...decisionPoint(), tick: 101 }),
    /decision tick/u,
  );
  assert.throws(
    () => completeVisibleOnlyDecisionWorld(rawCase(), {
      ...decisionPoint(),
      decisionPointId: "other-run:100",
      processRunId: "other-run",
    }),
    /processRunId/u,
  );
});
