/** M2b decision-point shadow logging tests (candidate generator + orchestrator events). */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MacroPolicyOrchestrator, parsePolicyText, RESPAWN_OVERRIDE_POLICY } from "../src/runtime/macro-policy-orchestrator.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";
import { generateCandidateSet } from "../src/offline-learning/candidate/candidate-generator.ts";
import {
  resolveChosenCandidate,
  validateMacroDecisionPointV1,
  type MacroDecisionPointV1,
} from "../src/offline-learning/runtime/macro-decision-point.ts";
import { validateDecisionCandidateV1 } from "../src/offline-learning/candidate/decision-candidate-v1.ts";
import type { TickState } from "../src/domain/model.ts";

function fakeState(tick: number, core: TickState["core"] = { id: "core", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "t1" } as unknown as TickState["core"]): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    population: 5,
    workers: [],
    military: [],
    visibleEnemies: [],
    resourceCells: [],
    obstacleCells: [],
    core,
    events: [],
  } as unknown as TickState;
}

const POLICY_10_02: MacroPolicy = {
  posture: "balanced",
  workerTarget: 10,
  militaryRatio: 0.2,
  focusRegion: null,
  attackPriority: null,
};

test("generateCandidateSet: bounded 5–20, includes KEEP and the current policy", () => {
  const candidates = generateCandidateSet(fakeState(0), POLICY_10_02);
  assert.ok(candidates.length >= 5 && candidates.length <= 20, `size=${candidates.length}`);
  // All structurally valid per the M2a.1 contract.
  for (const candidate of candidates) {
    assert.deepEqual(validateDecisionCandidateV1(candidate), []);
  }
  // KEEP is present (baseline).
  assert.ok(candidates.some((candidate) => candidate.kind === "KEEP" && candidate.source === "baseline"));
  // The current workerTarget and militaryRatio are in the neighborhoods.
  assert.ok(candidates.some((candidate) =>
    candidate.kind === "WORKER_TARGET" && candidate.parameters.workerTarget === 10));
  assert.ok(candidates.some((candidate) =>
    candidate.kind === "MILITARY_RATIO" && candidate.parameters.militaryRatio === 0.2));
  // Both posture alternatives (excluding current) exist.
  const postures = candidates.filter((candidate) => candidate.kind === "POSTURE");
  assert.equal(postures.length, 2);
  assert.ok(postures.every((candidate) => candidate.parameters.posture !== "balanced"));
});

test("generateCandidateSet clamps to legal value domains at the edges", () => {
  const edgePolicy: MacroPolicy = { ...POLICY_10_02, workerTarget: 1, militaryRatio: 0 };
  const candidates = generateCandidateSet(fakeState(0), edgePolicy);
  const workerTargets = candidates
    .filter((candidate) => candidate.kind === "WORKER_TARGET")
    .map((candidate) => candidate.parameters.workerTarget);
  assert.deepEqual([...new Set(workerTargets)].sort(), [1, 2]);
  const ratios = candidates
    .filter((candidate) => candidate.kind === "MILITARY_RATIO")
    .map((candidate) => candidate.parameters.militaryRatio as number);
  assert.ok(ratios.every((ratio) => ratio >= 0 && ratio <= 1));
  assert.ok(ratios.includes(0));
});

test("resolveChosenCandidate: exact workerTarget match wins; KEEP is the last resort", () => {
  const candidates = generateCandidateSet(fakeState(0), POLICY_10_02);
  // LLM picked workerTarget=9 (in the neighborhood around 10).
  const inNeighborhood = resolveChosenCandidate(candidates, { ...POLICY_10_02, workerTarget: 9 });
  assert.equal(inNeighborhood.kind, "WORKER_TARGET");
  assert.equal(
    (inNeighborhood.candidate.parameters as { workerTarget: number }).workerTarget,
    9,
  );
  // Exact militaryRatio match wins when workerTarget is outside the neighborhood.
  const ratioMatch = resolveChosenCandidate(candidates, { ...POLICY_10_02, workerTarget: 16 });
  assert.equal(ratioMatch.kind, "MILITARY_RATIO");
  // Nothing matches (both dimensions outside the neighborhood) -> KEEP.
  const farPolicy = { ...POLICY_10_02, workerTarget: 16, militaryRatio: 0.85 };
  const far = resolveChosenCandidate(candidates, farPolicy);
  assert.equal(far.kind, "KEEP");
  // Posture is matched only when the numeric dimensions are outside the
  // neighborhood too (workerTarget/militaryRatio exact matches win first).
  const postureSwitch = resolveChosenCandidate(candidates, { ...farPolicy, posture: "aggressive" });
  assert.equal(postureSwitch.kind, "POSTURE");
  assert.equal(
    (postureSwitch.candidate.parameters as { posture: "aggressive" }).posture,
    "aggressive",
  );
});

test("orchestrator emits a decision-point event after a successful LLM decision", async () => {
  const events: MacroDecisionPointV1[] = [];
  const orchestrator = new MacroPolicyOrchestrator({
    intervalTicks: 32,
    promptBuilder: () => "prompt",
    requestPolicy: async () => '{"posture":"aggressive","workerTarget":9,"militaryRatio":0.3}',
    onDecisionPoint: (event) => events.push(event),
    processRunId: "run-m2b",
  });
  orchestrator.onTick(fakeState(100)); // first onTick triggers the decision (lastPolicyTick = -∞)
  orchestrator.onTick(fakeState(132)); // in flight — no second decision
  // Wait for the async decision + shadow emit.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.deepEqual(validateMacroDecisionPointV1(event), []);
  assert.equal(event.decisionPointId, "run-m2b:100");
  assert.equal(event.processRunId, "run-m2b");
  assert.equal(event.tick, 100);
  assert.equal(event.intervalTicks, 32);
  assert.equal(event.chosenBy, "policy-llm");
  // Previous policy = the orchestrator default (DEFAULT_MACRO_POLICY).
  assert.deepEqual(event.previousPolicy, { posture: "balanced", workerTarget: 8, militaryRatio: 0.4, focusRegion: null, attackPriority: null });
  assert.equal(event.newPolicy.posture, "aggressive");
  assert.equal(event.newPolicy.workerTarget, 9);
  // Chosen candidate: workerTarget=9 is in the neighborhood around default 8.
  const chosen = event.candidates.find((candidate) => candidate.deterministicHash === event.chosenCandidateHash);
  assert.ok(chosen, "chosen candidate must be in the set");
  assert.equal(chosen!.kind, "WORKER_TARGET");
  assert.equal(chosen!.parameters.workerTarget, 9);
  assert.ok(event.candidates.length >= 5 && event.candidates.length <= 20);
});

test("orchestrator emits a sticky decision-point event on LLM failure", async () => {
  const events: MacroDecisionPointV1[] = [];
  const errors: string[] = [];
  const orchestrator = new MacroPolicyOrchestrator({
    intervalTicks: 32,
    promptBuilder: () => "prompt",
    requestPolicy: async () => {
      throw new Error("model unreachable");
    },
    onDecisionPoint: (event) => events.push(event),
    onPolicyError: (message) => errors.push(message),
    processRunId: "run-m2b-fail",
  });
  orchestrator.onTick(fakeState(100));
  orchestrator.onTick(fakeState(132));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(errors.length, 1);
  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.chosenBy, "policy-sticky");
  // Sticky: new policy == previous policy; chosen resolves to the default's
  // workerTarget candidate (8 ∈ neighborhood) — NOT a fresh decision.
  assert.deepEqual(event.newPolicy, event.previousPolicy);
  const chosen = event.candidates.find((candidate) => candidate.deterministicHash === event.chosenCandidateHash);
  assert.ok(chosen, "chosen candidate must be in the set");
});

test("override and respawn paths do not emit decision points (no real decision)", async () => {
  const events: MacroDecisionPointV1[] = [];
  const orchestrator = new MacroPolicyOrchestrator({
    intervalTicks: 32,
    promptBuilder: () => "prompt",
    requestPolicy: async () => '{"posture":"aggressive"}',
    onDecisionPoint: (event) => events.push(event),
    processRunId: "run-m2b-override",
    override: POLICY_10_02,
  });
  orchestrator.onTick(fakeState(132));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.length, 0);
  assert.deepEqual(orchestrator.current, POLICY_10_02);

  const respawnEvents: MacroDecisionPointV1[] = [];
  const respawnOrchestrator = new MacroPolicyOrchestrator({
    intervalTicks: 32,
    promptBuilder: () => "prompt",
    requestPolicy: async () => '{"posture":"aggressive"}',
    onDecisionPoint: (event) => respawnEvents.push(event),
    processRunId: "run-m2b-respawn",
  });
  const respawningState = fakeState(200, null);
  const policy = respawnOrchestrator.onTick(respawningState);
  assert.deepEqual(policy, RESPAWN_OVERRIDE_POLICY);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(respawnEvents.length, 0);
});

test("parsePolicyText still normalizes LLM output (regression)", () => {
  const policy = parsePolicyText('{"posture":"aggressive","workerTarget":11,"militaryRatio":0.3,"focusRegion":null,"attackPriority":"null"}');
  assert.equal(policy.workerTarget, 11);
  assert.equal(policy.attackPriority, null);
});
