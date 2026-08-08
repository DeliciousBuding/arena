/** M1d-lite ModelScorer + OOD telemetry tests. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeOodReport,
  oodReferenceFromFeatureQuality,
  type OodReference,
} from "../src/offline-learning/runtime/ood-telemetry.ts";
import { UnavailableScorer } from "../src/offline-learning/runtime/model-scorer.ts";

const REFERENCE: OodReference = {
  ranges: {
    resources: [0, 60],
    worker_dist_core_mean: [1, 30],
    threat_unknown: [0, 1],
  },
};

test("computeOodReport flags out-of-range features and computes fraction", () => {
  const report = computeOodReport(
    { resources: 120, worker_dist_core_mean: 5, threat_unknown: 0 },
    REFERENCE,
  );
  assert.equal(report.featureOutOfRangeCount, 1);
  assert.equal(report.featureCount, 3);
  assert.equal(report.outOfRangeFraction, 1 / 3);
  assert.deepEqual(report.outOfRangeFeatures, ["resources"]);
  // Overshoot ratio: 120 is 60 above max 60, span 60 -> ratio 1.0.
  assert.equal(report.maxOutOfRangeRatio, 1.0);
});

test("computeOodReport is clean inside train range", () => {
  const report = computeOodReport(
    { resources: 30, worker_dist_core_mean: 10, threat_unknown: 1 },
    REFERENCE,
  );
  assert.equal(report.featureOutOfRangeCount, 0);
  assert.equal(report.maxOutOfRangeRatio, 0);
  assert.deepEqual(report.outOfRangeFeatures, []);
});

test("oodReferenceFromFeatureQuality builds ranges from the M1b report shape", () => {
  const reference = oodReferenceFromFeatureQuality({
    entries: [
      { feature: "resources", min: 0, max: 60 },
      { feature: "core_moving", min: 0, max: 1 },
      { feature: "always_missing", min: null, max: null },
    ],
  });
  assert.deepEqual(reference.ranges.resources, [0, 60]);
  assert.deepEqual(reference.ranges.core_moving, [0, 1]);
  assert.equal("always_missing" in reference.ranges, false);
});

test("UnavailableScorer fails closed until a model is deployed", async () => {
  const scorer = new UnavailableScorer<Record<string, number>, number>();
  assert.equal(scorer.modelId, "unavailable");
  await assert.rejects(
    () => scorer.score({ resources: 5 }),
    /model not deployed/u,
  );
});
