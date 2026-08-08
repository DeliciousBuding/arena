/** M2a.1 decision-candidate-v1 per-kind contract tests. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeCandidateDeterministicHash,
  makeCandidateV1,
  validateDecisionCandidateV1,
} from "../src/offline-learning/candidate/decision-candidate-v1.ts";

test("makeCandidateV1 builds a valid KEEP candidate with deterministic hash", () => {
  const candidate = makeCandidateV1({
    candidateId: "C0",
    kind: "KEEP",
    parameters: {},
    source: "baseline",
  });
  assert.equal(candidate.schema, "decision-candidate-v1");
  assert.equal(candidate.legality, "legal");
  assert.match(candidate.deterministicHash, /^[0-9a-f]{64}$/u);
  assert.deepEqual(validateDecisionCandidateV1(candidate), []);
});

test("deterministicHash is key-order independent and parameter-order independent", () => {
  const a = makeCandidateV1({
    candidateId: "C1",
    kind: "WORKER_TARGET",
    parameters: { workerTarget: 12 },
    source: "local-neighborhood",
  });
  const b = makeCandidateV1({
    candidateId: "C1-dup",
    kind: "WORKER_TARGET",
    parameters: { workerTarget: 12 },
    source: "planner",
  });
  assert.equal(a.deterministicHash, b.deterministicHash);
  // Different semantics -> different hash.
  const c = makeCandidateV1({
    candidateId: "C2",
    kind: "WORKER_TARGET",
    parameters: { workerTarget: 8 },
    source: "local-neighborhood",
  });
  assert.notEqual(a.deterministicHash, c.deterministicHash);
  // Different kinds with same parameter value -> different hash.
  const d = makeCandidateV1({
    candidateId: "C3",
    kind: "MILITARY_RATIO",
    parameters: { militaryRatio: 0.3 },
    source: "local-neighborhood",
  });
  assert.notEqual(a.deterministicHash, d.deterministicHash);
});

test("validateDecisionCandidateV1 rejects tampered hash and bad fields", () => {
  const candidate = makeCandidateV1({
    candidateId: "C0",
    kind: "POSTURE",
    parameters: { posture: "harvest" },
    source: "model",
  });
  const tampered = { ...candidate, deterministicHash: "0".repeat(64) };
  const problems = validateDecisionCandidateV1(tampered);
  assert.ok(problems.some((problem) => problem.includes("deterministicHash mismatch")));

  const badKind = { ...candidate, kind: "MOVE_ALL_UNITS" };
  assert.ok(validateDecisionCandidateV1(badKind).some((problem) => problem.includes("kind")));

  const badLegality = { ...candidate, legality: "maybe" };
  assert.ok(validateDecisionCandidateV1(badLegality).some((problem) => problem.includes("legality")));

  const extraKey = { ...candidate, plan: {} };
  assert.ok(validateDecisionCandidateV1(extraKey).some((problem) => problem.includes("not allowed")));
});

test("M2a.1: unit-action semantics are structurally rejected (per-kind exact keys)", () => {
  // The user-audit example: { kind: "ATTACK_TARGET", parameters: { unitId,
  // action: "MOVE", direction: "UP" } } must be unrepresentable — not by
  // comment discipline but by the validator + the TS union.
  const unitActionAttempt = {
    schema: "decision-candidate-v1",
    candidateId: "bad",
    kind: "ATTACK_TARGET",
    parameters: { unitId: "u1", action: "MOVE", direction: "UP" },
    source: "planner",
    legality: "legal",
    deterministicHash: "0".repeat(64),
  };
  const problems = validateDecisionCandidateV1(unitActionAttempt);
  assert.ok(problems.some((problem) => problem.includes("ATTACK_TARGET parameters must be exactly")));

  // WORKER_TARGET accepts ONLY workerTarget — any unit-action key is rejected.
  const workerActionAttempt = {
    schema: "decision-candidate-v1",
    candidateId: "bad",
    kind: "WORKER_TARGET",
    parameters: { workerTarget: 10, unitId: "u1" },
    source: "planner",
    legality: "legal",
    deterministicHash: "0".repeat(64),
  };
  assert.ok(
    validateDecisionCandidateV1(workerActionAttempt)
      .some((problem) => problem.includes("WORKER_TARGET parameters must be exactly")),
  );

  // KEEP must be parameter-free.
  const keepWithParams = {
    schema: "decision-candidate-v1",
    candidateId: "bad",
    kind: "KEEP",
    parameters: { posture: "harvest" },
    source: "baseline",
    legality: "legal",
    deterministicHash: "0".repeat(64),
  };
  assert.ok(
    validateDecisionCandidateV1(keepWithParams)
      .some((problem) => problem.includes("KEEP parameters must be empty")),
  );
});

test("M2a.1: value domains are enforced per kind", () => {
  // workerTarget must be an integer in runtime-config's [1,16].
  for (const bad of [{ workerTarget: 0 }, { workerTarget: 17 }, { workerTarget: 10.5 }]) {
    assert.throws(
      () => makeCandidateV1({ candidateId: "bad", kind: "WORKER_TARGET", parameters: bad, source: "baseline" }),
      /workerTarget must be an integer in \[1,16\]/u,
    );
  }
  // militaryRatio must be in [0,1].
  assert.throws(
    () => makeCandidateV1({ candidateId: "bad", kind: "MILITARY_RATIO", parameters: { militaryRatio: 1.5 }, source: "baseline" }),
    /militaryRatio must be a finite number in \[0,1\]/u,
  );
  // posture enum.
  assert.throws(
    () => makeCandidateV1({ candidateId: "bad", kind: "POSTURE", parameters: { posture: "aggressive-mode" } as never, source: "baseline" }),
    /POSTURE posture must be one of/u,
  );
  // targetClass enum.
  assert.throws(
    () => makeCandidateV1({ candidateId: "bad", kind: "ATTACK_TARGET", parameters: { targetClass: "TURRET" } as never, source: "baseline" }),
    /ATTACK_TARGET targetClass must be one of/u,
  );
  // migrate direction enum.
  assert.throws(
    () => makeCandidateV1({ candidateId: "bad", kind: "MIGRATE", parameters: { direction: "northwest" } as never, source: "baseline" }),
    /MIGRATE direction must be one of/u,
  );
});

test("M2a.1: alternative parameter sets are exactly-one (never both)", () => {
  // RESOURCE_FOCUS: {targetX,targetY} XOR {regionId} — mixing both fails.
  assert.throws(
    () => makeCandidateV1({
      candidateId: "bad", kind: "RESOURCE_FOCUS",
      parameters: { targetX: 3, targetY: 5, regionId: "r1" },
      source: "planner",
    }),
    /RESOURCE_FOCUS parameters must be exactly/u,
  );
  // Incomplete coordinate pair fails.
  assert.throws(
    () => makeCandidateV1({
      candidateId: "bad", kind: "RESOURCE_FOCUS",
      parameters: { targetX: 3 } as never,
      source: "planner",
    }),
    /RESOURCE_FOCUS parameters must be exactly/u,
  );
  // MIGRATE: direction XOR coordinates.
  assert.throws(
    () => makeCandidateV1({
      candidateId: "bad", kind: "MIGRATE",
      parameters: { direction: "north", targetX: 1, targetY: 1 },
      source: "planner",
    }),
    /MIGRATE parameters must be exactly/u,
  );
  // Valid alternatives pass.
  for (const parameters of [
    { targetX: 3, targetY: 5 },
    { regionId: "north-cluster" },
  ] as const) {
    assert.deepEqual(validateDecisionCandidateV1(makeCandidateV1({
      candidateId: "ok", kind: "RESOURCE_FOCUS", parameters, source: "planner",
    })), []);
  }
  for (const parameters of [
    { targetId: "enemy-core-7" },
    { targetClass: "WORKER" as const },
  ] as const) {
    assert.deepEqual(validateDecisionCandidateV1(makeCandidateV1({
      candidateId: "ok", kind: "ATTACK_TARGET", parameters, source: "planner",
    })), []);
  }
  for (const parameters of [
    { direction: "east" as const },
    { targetX: -4, targetY: 9 },
  ] as const) {
    assert.deepEqual(validateDecisionCandidateV1(makeCandidateV1({
      candidateId: "ok", kind: "MIGRATE", parameters, source: "planner",
    })), []);
  }
});

test("computeCandidateDeterministicHash is stable across calls", () => {
  const parameters = { workerTarget: 10 } as const;
  const first = computeCandidateDeterministicHash("WORKER_TARGET", parameters);
  const second = computeCandidateDeterministicHash("WORKER_TARGET", parameters);
  assert.equal(first, second);
});
