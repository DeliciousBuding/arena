/** M2c.1 counterfactual rollout core tests. */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  computeCandidateSetHash,
  makeCandidateV1,
} from "../src/offline-learning/candidate/decision-candidate-v1.ts";
import { runCounterfactualRollouts } from "../src/offline-learning/counterfactual/counterfactual-rollout.ts";
import type { MacroDecisionPointV1 } from "../src/offline-learning/runtime/macro-decision-point.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";
import { worldHash } from "../src/sim/world/canonical.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";

const here = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.14.json");

const BASE_POLICY: MacroPolicy = Object.freeze({
  posture: "balanced",
  workerTarget: 8,
  militaryRatio: 0.4,
  focusRegion: null,
  attackPriority: null,
});

const KEEP = makeCandidateV1({
  candidateId: "keep",
  kind: "KEEP",
  parameters: {},
  source: "baseline",
});
const WORKER_9 = makeCandidateV1({
  candidateId: "worker-target-9",
  kind: "WORKER_TARGET",
  parameters: { workerTarget: 9 },
  source: "local-neighborhood",
});

function initialWorld() {
  return worldFromScenario({
    rulesVersion: "v0.14",
    tick: 100,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 5,
        core: {
          id: "11111111-1111-1111-1111-111111111111",
          position: [0, 0],
          hp: 5,
          shield: 5,
          state: "NORMAL",
        },
        units: [
          {
            id: "22222222-2222-2222-2222-222222222222",
            owner: "p1",
            position: [1, 0],
            hp: 2,
            unitType: "WORKER",
            cargo: 0,
          },
        ],
      },
    ],
    terrain: {
      obstacles: [[3, 0]],
      resources: [[1, 0], [0, 2], [-2, 0], [0, -2]],
    },
    beacon: { position: [0, 0], status: "GROUND", carrierId: null },
  });
}

function decisionPoint(): MacroDecisionPointV1 {
  const candidates = [KEEP, WORKER_9] as const;
  return {
    schema: "macro-decision-point-v1",
    decisionPointId: "run-p4:100",
    processRunId: "run-p4",
    tick: 100,
    intervalTicks: 2,
    previousPolicy: BASE_POLICY,
    newPolicy: BASE_POLICY,
    chosenBy: "policy-sticky",
    candidates,
    candidateSetHash: computeCandidateSetHash(candidates),
    chosenCandidateHash: KEEP.deterministicHash,
    selectionRepresentable: true,
    behaviorPropensity: null,
  };
}

test("M2c.1: one trajectory per candidate×seed, multi-horizon labels share matched groups", () => {
  const world = initialWorld();
  const beforeHash = worldHash(world);
  const result = runCounterfactualRollouts({
    decisionPoint: decisionPoint(),
    tenantId: "p1",
    initialWorld: world,
    rulesPath: RULES_PATH,
    scenarioSeeds: [11, 12],
    horizons: [2, 4],
    behaviorPolicyVersion: "safety/v1.0",
    simulatorVersion: "sim/v1.1",
    certificateVersion: "dev-p4",
    opponentId: "none",
    initialStateScope: "full-sim-world",
    completionPolicy: "none",
    completionSeed: null,
    completionAssumptions: [],
    confidence: 0.5,
    featureContext: {
      threatLevel: "NORMAL",
      recentNonNormalThreatTicks6: 0,
      workerTarget: 8,
      militaryRatio: 0.4,
      posture: "balanced",
    },
  });

  assert.equal(result.stats.evaluatedCandidates, 2);
  assert.equal(result.stats.trajectories, 4, "candidate×seed only; horizons reuse trajectory prefixes");
  assert.equal(result.sample.evaluations.length, 8);
  assert.equal(worldHash(world), beforeHash, "arbitrary-world rollout must not mutate caller world");

  for (const seed of [11, 12]) {
    for (const horizon of [2, 4]) {
      const group = result.sample.evaluations.filter((evaluation) =>
        evaluation.label.horizonTicks === horizon &&
        evaluation.sim?.scenarioSeed === seed,
      );
      assert.equal(group.length, 2);
      assert.equal(new Set(group.map((evaluation) => evaluation.comparisonGroupId)).size, 1,
        "same seed/opponent/completion must form a matched A/B group");
    }
  }

  const h4 = result.sample.evaluations.find((evaluation) => evaluation.label.horizonTicks === 4)!;
  assert.equal(h4.sim?.interventionTicks, 2);
  assert.equal(h4.sim?.continuationPolicy, "revert-baseline");
  assert.equal(h4.sim?.initialStateScope, "full-sim-world");
});

test("M2c.1: private completion provenance is explicit; policy-only unsupported candidates are skipped", () => {
  const migrate = makeCandidateV1({
    candidateId: "migrate-west",
    kind: "MIGRATE",
    parameters: { direction: "west" },
    source: "planner",
  });
  const point = decisionPoint();
  const candidates = [...point.candidates, migrate];
  const result = runCounterfactualRollouts({
    decisionPoint: {
      ...point,
      candidates,
      candidateSetHash: computeCandidateSetHash(candidates),
    },
    tenantId: "p1",
    initialWorld: initialWorld(),
    rulesPath: RULES_PATH,
    scenarioSeeds: [13],
    horizons: [2],
    behaviorPolicyVersion: "safety/v1.0",
    simulatorVersion: "sim/v1.1",
    certificateVersion: "dev-private-completion",
    opponentId: "visible-opponent-v1",
    initialStateScope: "private-observation-completed",
    completionPolicy: "visible-only-v1",
    completionSeed: 77,
    completionAssumptions: ["unobserved-terrain=>EMPTY", "unobserved-entities=>ABSENT"],
    confidence: 0.25,
    featureContext: {
      threatLevel: null,
      recentNonNormalThreatTicks6: null,
      workerTarget: 8,
      militaryRatio: 0.4,
      posture: "balanced",
    },
  });

  assert.deepEqual(result.stats.skippedCandidates, [migrate.deterministicHash]);
  assert.ok(result.sample.evaluations.every((evaluation) =>
    evaluation.sim?.initialStateScope === "private-observation-completed" &&
    evaluation.sim.completionPolicy === "visible-only-v1" &&
    evaluation.sim.completionSeed === 77));
});
