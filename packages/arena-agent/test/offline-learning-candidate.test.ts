/** M2a decision-candidate-v1 contract tests. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CANDIDATE_KINDS,
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
    parameters: { workerTarget: 12, note: "expand" },
    source: "local-neighborhood",
  });
  const b = makeCandidateV1({
    candidateId: "C1-dup",
    kind: "WORKER_TARGET",
    parameters: { note: "expand", workerTarget: 12 },
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
  // Different kinds with same parameters -> different hash.
  const d = makeCandidateV1({
    candidateId: "C3",
    kind: "MILITARY_RATIO",
    parameters: { workerTarget: 12 },
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

  const badParameter = {
    ...candidate,
    parameters: { posture: "harvest", extra: { nested: true } },
  };
  assert.ok(validateDecisionCandidateV1(badParameter).some((problem) => problem.includes("parameters")));

  const extraKey = { ...candidate, plan: {} };
  assert.ok(validateDecisionCandidateV1(extraKey).some((problem) => problem.includes("not allowed")));
});

test("candidate contract forbids unit-level action semantics (v4 discipline)", () => {
  // The contract's kind enum is the macro-strategy surface; a unit action
  // plan must not be representable as a candidate parameter.
  const candidate = makeCandidateV1({
    candidateId: "C4",
    kind: "ATTACK_TARGET",
    parameters: { targetCoreId: "enemy-core-7" },
    source: "planner",
  });
  assert.deepEqual(validateDecisionCandidateV1(candidate), []);
  // Sanity: every kind in the enum is constructible.
  for (const kind of CANDIDATE_KINDS) {
    const built = makeCandidateV1({
      candidateId: `C-${kind}`,
      kind,
      parameters: kind === "MIGRATE" ? { direction: "north" } : {},
      source: "baseline",
    });
    assert.deepEqual(validateDecisionCandidateV1(built), []);
  }
});

test("computeCandidateDeterministicHash is stable across calls", () => {
  const parameters = { workerTarget: 10, militaryRatio: 0.3 };
  const first = computeCandidateDeterministicHash("WORKER_TARGET", parameters);
  const second = computeCandidateDeterministicHash("WORKER_TARGET", parameters);
  assert.equal(first, second);
});
