/** Opponent-plan calibration replay tests (2026-08-07). */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runCalibrationCase } from "../src/sim/calibration/calibrate.ts";
import {
  parseCalibrationCase,
  type CalibrationCaseV1,
} from "../src/sim/calibration/schema.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.14.json");
const FIXTURE_PATH = join(here, "fixtures", "synthetic-match-opponent-plan.json");

function loadFixture(): CalibrationCaseV1 {
  return parseCalibrationCase(JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")));
}

test("schema: opponentPlan survives parse and keeps both plans", () => {
  const parsed = loadFixture();
  assert.ok(parsed.opponentPlan !== undefined, "opponentPlan must be preserved");
  assert.equal(parsed.opponentPlan.tick, parsed.plan.tick);
  assert.equal(parsed.metadata.opponentPlans, "complete");
  assert.ok(Object.keys(parsed.opponentPlan.unitActions).length > 0);
});

test("schema: opponentPlan with mismatched tick is rejected", () => {
  const parsed = loadFixture();
  assert.throws(
    () =>
      parseCalibrationCase({
        ...parsed,
        opponentPlan: { ...parsed.opponentPlan!, tick: parsed.plan.tick + 1 },
      }),
    /opponentPlan\.tick .* does not match before\.tick/,
  );
});

test("calibrate: synthetic case with opponent plan reaches MATCH", () => {
  const report = runCalibrationCase(JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")), MANIFEST_PATH);
  assert.equal(report.status, "MATCH", JSON.stringify(report.differences, null, 2));
  assert.equal(report.differences.length, 0);
});

test("calibrate: dropping opponentPlan degrades the same case to INCONCLUSIVE", () => {
  const parsed = loadFixture();
  const withoutOpponent = JSON.parse(JSON.stringify(parsed));
  delete withoutOpponent.opponentPlan;
  const report = runCalibrationCase(withoutOpponent, MANIFEST_PATH);
  assert.equal(report.status, "INCONCLUSIVE");
  assert.ok(
    report.differences.some((difference) => difference.path === "$.simulation.opponent-action"),
    "without opponent plan the opponent action must be EXPECTED_UNKNOWN",
  );
});
