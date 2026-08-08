/** M2c q-sample-v1 decision-point SSOT contract tests. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { makeCandidateV1 } from "../src/offline-learning/candidate/decision-candidate-v1.ts";
import {
  computeCandidateSetHash,
  derivePairwisePreferences,
  makeQSampleV1,
  validateQSampleV1,
} from "../src/offline-learning/q-sample/q-sample-v1.ts";

const CANDIDATE_A = makeCandidateV1({
  candidateId: "cand-a",
  kind: "WORKER_TARGET",
  parameters: { workerTarget: 10 },
  source: "local-neighborhood",
});
const CANDIDATE_B = makeCandidateV1({
  candidateId: "cand-b",
  kind: "WORKER_TARGET",
  parameters: { workerTarget: 8 },
  source: "local-neighborhood",
});
const CANDIDATE_C = makeCandidateV1({
  candidateId: "cand-c",
  kind: "MILITARY_RATIO",
  parameters: { militaryRatio: 0.3 },
  source: "planner",
});

const FEATURES = {
  resources: 42, workers: 10, military_total: 0, core_hp: 5, threat_normal: 1,
  threat_alert: 0, posture_balanced: 1, worker_target: 10, military_ratio: 0.2,
} as const;

const POLICY = {
  policyVersion: "runtime-config-v0.14",
  workerTarget: 10,
  militaryRatio: 0.2,
  posture: "balanced" as const,
  focusRegion: null,
  attackPriority: null,
  note: null,
};

function makeRealEvaluation(candidateHash: string, net: number, horizonTicks = 20) {
  return {
    candidateHash,
    comparisonGroupId: "real-observed",
    label: {
      horizonTicks,
      outcome: { net, deathProb: 0.05, coreRisk: 0 as const },
      source: "REAL" as const,
      confidence: 1,
      observed: true,
    },
    behaviorPropensity: null,
  };
}

function makeSimEvaluation(
  candidateHash: string,
  net: number,
  horizonTicks = 32,
  scenarioSeed = 42,
  comparisonGroupId = `sim:seed-${scenarioSeed}`,
) {
  return {
    candidateHash,
    comparisonGroupId,
    label: {
      horizonTicks,
      outcome: { net, deathProb: null, coreRisk: null },
      source: "SIM" as const,
      confidence: 0.85,
      observed: false,
    },
    sim: {
      simulatorVersion: "0.14.0",
      certificateVersion: "cert-v1",
      scenarioSeed,
      opponentId: "op-waaiging",
      initialStateScope: "full-sim-world" as const,
      completionPolicy: "none",
      completionSeed: null,
      rolloutHorizon: horizonTicks,
      unknownEffectCount: 1,
      firstUnknownTick: 30,
      terminatedByUnknown: false,
    },
  };
}

function makeSample(evaluations: readonly unknown[]) {
  return makeQSampleV1({
    decisionPointId: "dp-1",
    processRunId: "run-20260808",
    tenantId: "t1",
    tick: 512,
    features: FEATURES,
    behaviorPolicy: POLICY,
    candidateSet: [CANDIDATE_A, CANDIDATE_B, CANDIDATE_C],
    evaluations: evaluations as never,
  });
}

test("makeQSampleV1 builds a valid decision-point sample with REAL evaluations", () => {
  const sample = makeSample([
    makeRealEvaluation(CANDIDATE_A.deterministicHash, 5),
    makeRealEvaluation(CANDIDATE_B.deterministicHash, 2),
  ]);
  assert.equal(sample.schema, "q-sample-v1");
  assert.equal(sample.decisionPointId, "dp-1");
  assert.match(sample.state.featureHash, /^[0-9a-f]{64}$/u);
  assert.match(sample.candidateSetHash, /^[0-9a-f]{64}$/u);
  assert.deepEqual(validateQSampleV1(sample), []);
});

test("candidateSetHash is order-independent; featureHash is key-order independent", () => {
  const sample = makeSample([makeRealEvaluation(CANDIDATE_A.deterministicHash, 5)]);
  const reordered = makeQSampleV1({
    decisionPointId: "dp-1",
    processRunId: "run-20260808",
    tenantId: "t1",
    tick: 512,
    features: { workers: 10, resources: 42 } as const,
    behaviorPolicy: POLICY,
    candidateSet: [CANDIDATE_C, CANDIDATE_A, CANDIDATE_B],
    evaluations: [makeRealEvaluation(CANDIDATE_A.deterministicHash, 5)],
  });
  // Same candidate set, different order -> same set hash.
  assert.equal(
    computeCandidateSetHash([CANDIDATE_A, CANDIDATE_B, CANDIDATE_C]),
    computeCandidateSetHash([CANDIDATE_C, CANDIDATE_B, CANDIDATE_A]),
  );
  assert.equal(reordered.candidateSetHash, sample.candidateSetHash);
  // Same features, different key order -> same feature hash.
  const swapped = makeQSampleV1({
    decisionPointId: "dp-1",
    processRunId: "run-20260808",
    tenantId: "t1",
    tick: 512,
    features: { resources: 42, workers: 10, military_total: 0, core_hp: 5, threat_normal: 1, threat_alert: 0, posture_balanced: 1, worker_target: 10, military_ratio: 0.2 } as const,
    behaviorPolicy: POLICY,
    candidateSet: [CANDIDATE_A, CANDIDATE_B, CANDIDATE_C],
    evaluations: [makeRealEvaluation(CANDIDATE_A.deterministicHash, 5)],
  });
  assert.equal(swapped.state.featureHash, sample.state.featureHash);
});

test("SIM labels require full sim provenance; REAL rejects sim block", () => {
  const simSample = makeSample([
    makeSimEvaluation(CANDIDATE_A.deterministicHash, 3),
  ]);
  assert.deepEqual(validateQSampleV1(simSample), []);

  // SIM without sim provenance -> rejected.
  assert.throws(
    () => makeSample([
      {
        candidateHash: CANDIDATE_A.deterministicHash,
        comparisonGroupId: "sim:seed-42",
        label: {
          horizonTicks: 32,
          outcome: { net: 3, deathProb: null, coreRisk: null },
          source: "SIM",
          confidence: 0.85,
          observed: false,
        },
      },
    ]),
    /sim is required for SIM labels/u,
  );

  // REAL with a sim block -> rejected.
  assert.throws(
    () => makeSample([
      {
        ...makeRealEvaluation(CANDIDATE_A.deterministicHash, 5),
        sim: makeSimEvaluation(CANDIDATE_A.deterministicHash, 3).sim,
      },
    ]),
    /sim only allowed for SIM labels/u,
  );
});

test("label source semantics: REAL confidence=1 observed; HEURISTIC confidence<1", () => {
  // REAL with confidence < 1 -> rejected.
  assert.throws(
    () => makeSample([
      {
        ...makeRealEvaluation(CANDIDATE_A.deterministicHash, 5),
        label: { ...makeRealEvaluation(CANDIDATE_A.deterministicHash, 5).label, confidence: 0.7 },
      },
    ]),
    /REAL confidence must be exactly 1/u,
  );

  // HEURISTIC with confidence 1 (posing as truth) -> rejected.
  assert.throws(
    () => makeSample([
      {
        candidateHash: CANDIDATE_A.deterministicHash,
        comparisonGroupId: "heuristic-teacher-v1",
        label: {
          horizonTicks: 20,
          outcome: { net: 4, deathProb: null, coreRisk: null },
          source: "HEURISTIC",
          confidence: 1,
          observed: false,
        },
        heuristicNote: "teacher prior: more workers early is better",
      },
    ]),
    /HEURISTIC confidence must be < 1/u,
  );

  // Valid HEURISTIC passes.
  const validHeuristic = makeSample([
    {
      candidateHash: CANDIDATE_A.deterministicHash,
      comparisonGroupId: "heuristic-teacher-v1",
      label: {
        horizonTicks: 20,
        outcome: { net: 4, deathProb: null, coreRisk: null },
        source: "HEURISTIC",
        confidence: 0.5,
        observed: false,
      },
      heuristicNote: "teacher prior: more workers early is better",
    },
  ]);
  assert.deepEqual(validateQSampleV1(validHeuristic), []);
});

test("evaluations must reference candidateSet members, uniquely", () => {
  // Unknown candidateHash -> rejected.
  assert.throws(
    () => makeSample([
      makeRealEvaluation("0".repeat(64), 5),
    ]),
    /candidateHash not in candidateSet/u,
  );
  // Duplicate evaluation of the same (candidate, source, horizon) -> rejected.
  assert.throws(
    () => makeSample([
      makeRealEvaluation(CANDIDATE_A.deterministicHash, 5),
      makeRealEvaluation(CANDIDATE_A.deterministicHash, 6),
    ]),
    /duplicates evaluation key/u,
  );

  // Same SIM candidate/horizon may retain multiple matched rollout seeds.
  const replicated = makeSample([
    makeSimEvaluation(CANDIDATE_A.deterministicHash, 5, 32, 41),
    makeSimEvaluation(CANDIDATE_A.deterministicHash, 6, 32, 42),
  ]);
  assert.deepEqual(validateQSampleV1(replicated), []);
});

test("tampered featureHash and candidateSetHash are rejected", () => {
  const sample = makeSample([makeRealEvaluation(CANDIDATE_A.deterministicHash, 5)]);
  const badFeatureHash = {
    ...sample,
    state: { ...sample.state, featureHash: "0".repeat(64) },
  };
  assert.ok(
    validateQSampleV1(badFeatureHash)
      .some((problem) => problem.includes("state.featureHash mismatch")),
  );
  const badSetHash = { ...sample, candidateSetHash: "0".repeat(64) };
  assert.ok(
    validateQSampleV1(badSetHash)
      .some((problem) => problem.includes("candidateSetHash mismatch")),
  );
});

test("derivePairwisePreferences: A +5, B +2, C -1 -> three pairs (derived, not stored)", () => {
  const sample = makeSample([
    makeRealEvaluation(CANDIDATE_A.deterministicHash, 5),
    makeRealEvaluation(CANDIDATE_B.deterministicHash, 2),
    makeRealEvaluation(CANDIDATE_C.deterministicHash, -1),
  ]);
  const pairs = derivePairwisePreferences(sample);
  assert.equal(pairs.length, 3);
  // A > B, A > C, B > C — A is preferred in two pairs.
  assert.equal(pairs.filter((pair) => pair.preferredCandidateHash === CANDIDATE_A.deterministicHash).length, 2);
  assert.equal(pairs.filter((pair) => pair.preferredCandidateHash === CANDIDATE_B.deterministicHash).length, 1);
  const aVsB = pairs.find((pair) =>
    pair.preferredCandidateHash === CANDIDATE_A.deterministicHash &&
    pair.dispreferredCandidateHash === CANDIDATE_B.deterministicHash);
  assert.ok(aVsB, "A > B pair expected");
  assert.equal(aVsB?.margin, 3);
  // margin = |q_a - q_b|.
  const aVsC = pairs.find((pair) =>
    pair.preferredCandidateHash === CANDIDATE_A.deterministicHash &&
    pair.dispreferredCandidateHash === CANDIDATE_C.deterministicHash);
  assert.equal(aVsC?.margin, 6);
  assert.equal(pairs[0]!.schema, "q-pairwise-preference-v1");
});

test("derivePairwisePreferences never mixes source or horizon groups", () => {
  const sample = makeSample([
    makeRealEvaluation(CANDIDATE_A.deterministicHash, 5, 20),
    makeRealEvaluation(CANDIDATE_B.deterministicHash, 2, 20),
    makeSimEvaluation(CANDIDATE_A.deterministicHash, 9, 32),
    makeSimEvaluation(CANDIDATE_B.deterministicHash, 1, 32),
  ]);
  const pairs = derivePairwisePreferences(sample);
  // Two groups (REAL:20 and SIM:32), one pair each — REAL 5 vs SIM 9 must
  // NOT compare, and h20 vs h32 must NOT compare.
  assert.equal(pairs.length, 2);
  assert.deepEqual(
    pairs.map((pair) => `${pair.source}:${pair.horizonTicks}`).sort(),
    ["REAL:20", "SIM:32"],
  );
});

test("derivePairwisePreferences never crosses SIM comparison groups/seeds", () => {
  const sample = makeSample([
    makeSimEvaluation(CANDIDATE_A.deterministicHash, 10, 32, 41),
    makeSimEvaluation(CANDIDATE_B.deterministicHash, 1, 32, 41),
    makeSimEvaluation(CANDIDATE_A.deterministicHash, -5, 32, 42),
    makeSimEvaluation(CANDIDATE_B.deterministicHash, 8, 32, 42),
  ]);
  const pairs = derivePairwisePreferences(sample);
  assert.equal(pairs.length, 2);
  assert.deepEqual(
    pairs.map((pair) => pair.comparisonGroupId).sort(),
    ["sim:seed-41", "sim:seed-42"],
  );
  assert.notEqual(pairs[0]!.preferredCandidateHash, pairs[1]!.preferredCandidateHash);
});

test("REAL behaviorPropensity is optional/null or exact probability; SIM rejects it", () => {
  const known = {
    ...makeRealEvaluation(CANDIDATE_A.deterministicHash, 5),
    behaviorPropensity: 0.2,
  };
  assert.deepEqual(validateQSampleV1(makeSample([known])), []);
  assert.throws(
    () => makeSample([{ ...known, behaviorPropensity: 0 }]),
    /behaviorPropensity/u,
  );
  assert.throws(
    () => makeSample([{
      ...makeSimEvaluation(CANDIDATE_A.deterministicHash, 5),
      behaviorPropensity: 0.5,
    }]),
    /behaviorPropensity only allowed for REAL/u,
  );
});

test("derivePairwisePreferences: equal values and null outcomes produce no pair", () => {
  const sample = makeSample([
    makeRealEvaluation(CANDIDATE_A.deterministicHash, 3, 20),
    makeRealEvaluation(CANDIDATE_B.deterministicHash, 3, 20),
    {
      candidateHash: CANDIDATE_C.deterministicHash,
      comparisonGroupId: "real-observed",
      label: {
        horizonTicks: 20,
        outcome: { net: null, deathProb: null, coreRisk: null },
        source: "REAL",
        confidence: 1,
        observed: true,
      },
    },
  ]);
  assert.deepEqual(derivePairwisePreferences(sample), []);
});
