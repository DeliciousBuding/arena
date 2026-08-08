/** M1b merged real-sample export tests (global split + feature quality). */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { sha256Canonical } from "../src/domain/integrity.ts";
import { buildDataset } from "../src/sim/dataset/builder.ts";
import {
  exportRealSamples,
  type RealSampleExportResult,
} from "../src/offline-learning/export/real-sample-export.ts";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RULES = join(PKG_ROOT, "src", "sim", "contracts", "rules-v0.14.json");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CORE = "11111111-1111-1111-1111-111111111111";
const WORKER = "22222222-2222-2222-2222-222222222222";

function stateAt(resources: number) {
  return {
    status: "ACTIVE", respawn_at_tick: null, resources,
    population: 1, population_tier: null, upkeep_next_tick: null,
    champion_beacon: { position: [3, 1], status: "GROUND", carrier_id: null },
    objects: [
      {
        kind: "CORE", id: CORE, controlled: true, owner_username: "t1", position: [0, 0],
        hp: 5, shield: 5, state: "NORMAL", move_direction: null, move_progress: null,
        move_required_ticks: null, destination: null,
      },
      {
        kind: "UNIT", id: WORKER, controlled: true, position: [1, 0], hp: 2,
        unit_type: "WORKER", cargo: 0,
      },
    ],
    events: [],
  };
}

function makeCase(processRunId: string, tick: number): Record<string, unknown> {
  return {
    schema: "sim-calibration-case-v1",
    caseId: `${processRunId}:${tick}`,
    tenantId: "t1",
    rulesVersion: "v0.14",
    seed: 0,
    metadata: {
      source: "live-recorder",
      opponentPlans: "complete",
      recordedAt: null,
      sourceCommit: COMMIT,
      runId: `${processRunId}:${tick}:1`,
    },
    before: { tick, state: stateAt(10) },
    plan: { tick, unitActions: {}, coreAction: null, intents: {} },
    after: { tick: tick + 1, state: stateAt(10) },
  };
}

interface TestDataset {
  readonly root: string;
  readonly manifestPath: string;
}

/** Write a runtime-golden dataset under <root>/runtime/t1/calibration/<id>. */
function writeDataset(
  root: string,
  processRunId: string,
  startedAt: string,
  ticks: readonly number[],
): TestDataset {
  const datasetDir = join(root, "runtime", "t1", "calibration", processRunId);
  const casesDir = join(datasetDir, "cases");
  mkdirSync(casesDir, { recursive: true });
  const cases = ticks.map((tick) => makeCase(processRunId, tick));
  const manifest = {
    schema: "runtime-golden-dataset-v1",
    datasetId: processRunId,
    tenantId: "t1",
    rulesVersion: "v0.14",
    sourceCommit: COMMIT,
    configHash: `sha256:${"a".repeat(64)}`,
    startedAt,
    completedAt: new Date(new Date(startedAt).getTime() + 1000).toISOString(),
    caseCount: cases.length,
    skippedRejected: 0,
    droppedPending: 0,
    errorCount: 0,
    cases: cases.map((caseValue, index) => {
      const tick = (caseValue.before as { tick: number }).tick;
      const file = `cases/${String(index + 1).padStart(10, "0")}.json`;
      return {
        caseId: caseValue.caseId,
        tick,
        file,
        caseSha256: sha256Canonical(caseValue),
        beforeSha256: sha256Canonical(caseValue.before),
        planSha256: sha256Canonical(caseValue.plan),
        afterSha256: sha256Canonical(caseValue.after),
        receipt: { accepted: true, tick, source: "AGENT", receivedAt: startedAt },
      };
    }),
    errors: [],
  };
  writeFileSync(join(datasetDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  for (const [index, caseValue] of cases.entries()) {
    writeFileSync(
      join(casesDir, `${String(index + 1).padStart(10, "0")}.json`),
      `${JSON.stringify(caseValue, null, 2)}\n`,
      "utf8",
    );
  }
  return { root, manifestPath: join(datasetDir, "manifest.json") };
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("exportRealSamples merges datasets, splits chronologically by run, and reports feature quality", () => {
  const root = mkdtempSync(join(tmpdir(), "export-real-"));
  try {
    // run-a (2026-08-01) and run-b (2026-08-02), 60 ticks each.
    const datasetA = writeDataset(root, "run-a", "2026-08-01T00:00:00Z", Array.from({ length: 60 }, (_, i) => i + 1));
    const datasetB = writeDataset(root, "run-b", "2026-08-02T00:00:00Z", Array.from({ length: 60 }, (_, i) => i + 1));
    for (const dataset of [datasetA, datasetB]) {
      const datasetId = dataset.manifestPath.split(/[\\/]/u).slice(-2, -1)[0]!;
      const result = buildDataset({
        inputPath: dataset.manifestPath,
        rulesPath: RULES,
        dataRoot: root,
        datasetId,
      });
      assert.equal(result.gatePassed, true);
    }

    const result: RealSampleExportResult = exportRealSamples({
      dataRoot: root,
      buildId: "test-build",
    });
    assert.equal(result.totalSamples, 120);
    // Each 60-tick run has 10 complete windows (t+50 <= 60).
    assert.equal(result.eligibleSamples, 20);
    assert.equal(result.failedSamples, 0);
    assert.equal(result.datasetIds.length, 2);

    // Global split at run granularity: 2 runs, 70/15/15 → run-a train, run-b test.
    const counts = result.split.counts;
    assert.equal(counts.train.runs, 1);
    assert.equal(counts.train.eligible, 10);
    assert.equal(counts.validation.runs, 0);
    assert.equal(counts.test.runs, 1);
    assert.equal(counts.test.eligible, 10);
    assert.deepEqual(result.split.leakChecks, { runCrossesSplit: 0, sampleInMultipleSplits: 0 });

    const all = readJsonl(join(result.buildDir, "features-all.jsonl"));
    assert.equal(all.length, 120);
    assert.equal(readJsonl(join(result.buildDir, "train.jsonl")).length, 10);
    assert.equal(readJsonl(join(result.buildDir, "validation.jsonl")).length, 0);
    assert.equal(readJsonl(join(result.buildDir, "test.jsonl")).length, 10);
    for (const record of all) {
      assert.equal(typeof (record.features as Record<string, number>).core_hp, "number");
    }
    // Eligible only: train/test rows all carry usableForSupervisedLearning=true.
    for (const record of readJsonl(join(result.buildDir, "train.jsonl"))) {
      assert.equal(
        (record.realLabelValidity as { usableForSupervisedLearning: boolean }).usableForSupervisedLearning,
        true,
      );
    }

    // Feature quality: 59-dim schema, constant detection on the fixture pool.
    assert.equal(result.quality.dimension, 59);
    assert.equal(result.quality.entries.length, 59);
    assert.ok(result.quality.constantFeatures.length >= 1);
    for (const entry of result.quality.entries) {
      assert.equal(entry.feature in result.quality.activeMask, true);
    }
    assert.ok(existsSync(join(result.buildDir, "manifest.json")));
    assert.ok(existsSync(join(result.buildDir, "split-report.json")));
    assert.ok(existsSync(join(result.buildDir, "feature-quality.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exportRealSamples rebuild fails closed without --force and drops ineligible rows", () => {
  const root = mkdtempSync(join(tmpdir(), "export-real-rebuild-"));
  try {
    const dataset = writeDataset(root, "run-a", "2026-08-01T00:00:00Z", Array.from({ length: 60 }, (_, i) => i + 1));
    const build = buildDataset({
      inputPath: dataset.manifestPath,
      rulesPath: RULES,
      dataRoot: root,
      datasetId: "run-a",
    });
    assert.equal(build.gatePassed, true);
    exportRealSamples({ dataRoot: root, buildId: "dup-build" });
    assert.throws(
      () => exportRealSamples({ dataRoot: root, buildId: "dup-build" }),
      /build directory already exists/u,
    );
    const rebuilt = exportRealSamples({ dataRoot: root, buildId: "dup-build", force: true });
    assert.equal(rebuilt.eligibleSamples, 10);
    // features-all keeps every sample (including incomplete windows)…
    assert.equal(readJsonl(join(rebuilt.buildDir, "features-all.jsonl")).length, 60);
    // …but train/validation/test only carry eligible rows.
    assert.equal(
      readJsonl(join(rebuilt.buildDir, "train.jsonl")).length +
      readJsonl(join(rebuilt.buildDir, "validation.jsonl")).length +
      readJsonl(join(rebuilt.buildDir, "test.jsonl")).length,
      10,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
