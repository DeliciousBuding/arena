/** S9 artifact canonicalization and output-boundary unit tests. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Json } from "../src/sim/tools/artifacts.ts";
import { runAB, runBenchmark } from "../src/sim/tools/experiments.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO = JSON.parse(
  readFileSync(join(here, "fixtures", "sim", "scenario-basic.json"), "utf8"),
) as unknown;
const RULES = join(here, "..", "src", "sim", "contracts", "rules-v0.11.json");

test("S9: canonical JSON/hash is insertion-order independent", () => {
  const a = { z: [3, { b: 2, a: 1 }], a: true };
  const b = { a: true, z: [3, { a: 1, b: 2 }] };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(sha256Json(a), sha256Json(b));
  assert.match(sha256Json(a), /^[0-9a-f]{64}$/);
});

test("S9: canonical JSON rejects values that JSON.stringify would silently corrupt", () => {
  assert.throws(() => canonicalJson({ value: Number.NaN }), /non-finite number/);
  assert.throws(() => canonicalJson({ value: Number.POSITIVE_INFINITY }), /non-finite number/);
  assert.throws(() => canonicalJson({ value: undefined }), /rejects undefined/);
  assert.throws(() => canonicalJson({ value: new Map([["a", 1]]) }), /non-plain object/);
  assert.throws(() => canonicalJson({ value: new Date(0) }), /non-plain object/);
  const sparse = new Array(2);
  sparse[1] = 1;
  assert.throws(() => canonicalJson(sparse), /sparse array/);
});

test("S9: direct A/B API normalizes duplicate seeds and planners", () => {
  const { report } = runAB({
    scenario: SCENARIO,
    rulesPath: RULES,
    ticks: 1,
    seeds: [2, 1, 2],
    planners: ["safety", "safety"],
  });
  assert.deepEqual(report.seeds, [1, 2]);
  assert.deepEqual(report.planners, ["safety"]);
  assert.equal(report.runs.length, 2);
  assert.equal(report.rankingStatus, "conclusive");
});

test("S9: benchmark locks final world, trace and semantic summary", () => {
  const report = runBenchmark({
    scenario: SCENARIO,
    rulesPath: RULES,
    planner: "deterministic",
    seed: 7,
    ticks: 1,
    warmupRuns: 0,
    measuredRuns: 2,
  });
  assert.match(report.finalWorldHash, /^[0-9a-f]{64}$/);
  assert.match(report.traceHash, /^[0-9a-f]{64}$/);
  assert.equal(report.semanticStatus, "supported");
  assert.equal(report.samples.length, 2);
});
