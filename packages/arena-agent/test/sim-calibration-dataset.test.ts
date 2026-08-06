/** S8b dataset integrity and aggregate calibration gates. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Plan } from "../src/domain/model.ts";
import { sha256Canonical } from "../src/domain/integrity.ts";
import { runCalibrationDataset } from "../src/sim/calibration/dataset.ts";
import { loadRulesManifest } from "../src/sim/contracts/rules-manifest.ts";
import { settleTick } from "../src/sim/engine/settlement.ts";
import { projectPlayerState } from "../src/sim/visibility/visibility.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RULES = join(PKG_ROOT, "src", "sim", "contracts", "rules-v0.14.json");
const RULES_V011 = join(PKG_ROOT, "src", "sim", "contracts", "rules-v0.11.json");
const CORE = "11111111-1111-1111-1111-111111111111";
const WORKER = "22222222-2222-2222-2222-222222222222";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function calibrationCase(rulesPath: string = RULES) {
  const rules = loadRulesManifest(rulesPath);
  const world = worldFromScenario({
    rulesVersion: rules.rulesVersion,
    tick: 1,
    seed: 7,
    players: [{
      id: "p1",
      username: "p1",
      resources: 4,
      core: { id: CORE, position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
      units: [{ id: WORKER, owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
    }],
    terrain: { obstacles: [], resources: [[1, 0]] },
    beacon: { position: [1, 0], status: "CARRIED", carrierId: WORKER },
  });
  const plan: Plan = {
    tick: 1,
    unitActions: { [WORKER]: { type: "HARVEST" } },
    coreAction: null,
    intents: { [WORKER]: "fixture_harvest" },
  };
  const result = settleTick(world, new Map([["p1", plan]]), { rules, rng: null });
  return {
    schema: "sim-calibration-case-v1",
    caseId: "dataset-case-1",
    tenantId: "p1",
    rulesVersion: rules.rulesVersion,
    seed: 7,
    metadata: {
      source: "fixture",
      opponentPlans: "complete",
      recordedAt: null,
      sourceCommit: COMMIT,
      runId: null,
    },
    before: { tick: 1, state: projectPlayerState(world, "p1", rules) },
    plan,
    after: { tick: 2, state: projectPlayerState(result.world, "p1", rules, result.events) },
  } as const;
}

function writeDataset(root: string, caseValue: ReturnType<typeof calibrationCase>): string {
  const caseFile = "case.json";
  writeFileSync(join(root, caseFile), `${JSON.stringify(caseValue, null, 2)}\n`, "utf8");
  const manifest = {
    schema: "runtime-golden-dataset-v1",
    datasetId: "dataset-1",
    tenantId: "p1",
    rulesVersion: caseValue.rulesVersion,
    sourceCommit: COMMIT,
    configHash: `sha256:${"a".repeat(64)}`,
    startedAt: "2026-08-03T00:00:00Z",
    completedAt: "2026-08-03T00:00:01Z",
    caseCount: 1,
    skippedRejected: 0,
    droppedPending: 0,
    errorCount: 0,
    cases: [{
      caseId: caseValue.caseId,
      tick: 1,
      file: caseFile,
      caseSha256: sha256Canonical(caseValue),
      beforeSha256: sha256Canonical(caseValue.before),
      planSha256: sha256Canonical(caseValue.plan),
      afterSha256: sha256Canonical(caseValue.after),
      receipt: { accepted: true, tick: 1, source: "AGENT", receivedAt: "2026-08-03T00:00:00Z" },
    }],
    errors: [],
  };
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

test("S8b dataset: integrity verified + known deterministic event accuracy 100%", () => {
  const root = mkdtempSync(join(tmpdir(), "calibration-dataset-"));
  try {
    const report = runCalibrationDataset(writeDataset(root, calibrationCase()), RULES);
    assert.equal(report.integrityVerified, true);
    assert.equal(report.caseCount, 1);
    assert.equal(report.statusCounts.MATCH, 1);
    assert.equal(report.hardMismatchCaseCount, 0);
    assert.equal(report.knownEventMatched, 2);
    assert.equal(report.knownEventCompared, 2);
    assert.equal(report.knownEventAccuracy, 1);
    assert.equal(report.accuracyGatePassed, true);
    assert.equal(report.passed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("S8b dataset v0.11 显式回退: v0.11 历史数据集 --rules v0.11 仍全绿", () => {
  const root = mkdtempSync(join(tmpdir(), "calibration-dataset-"));
  try {
    const report = runCalibrationDataset(writeDataset(root, calibrationCase(RULES_V011)), RULES_V011);
    assert.equal(report.rulesVersion, "v0.11");
    assert.equal(report.integrityVerified, true);
    assert.equal(report.caseCount, 1);
    assert.equal(report.statusCounts.MATCH, 1);
    assert.equal(report.hardMismatchCaseCount, 0);
    assert.equal(report.accuracyGatePassed, true);
    assert.equal(report.passed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("S8b dataset: file tampering fails integrity before calibration", () => {
  const root = mkdtempSync(join(tmpdir(), "calibration-dataset-"));
  try {
    const manifestPath = writeDataset(root, calibrationCase());
    const tampered = JSON.parse(readFileSync(join(root, "case.json"), "utf8"));
    tampered.after.state.resources += 1;
    writeFileSync(join(root, "case.json"), JSON.stringify(tampered), "utf8");
    assert.throws(() => runCalibrationDataset(manifestPath, RULES), /case hash mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("S8b dataset: re-signed semantic event mismatch still fails hard and accuracy gates", () => {
  const root = mkdtempSync(join(tmpdir(), "calibration-dataset-"));
  try {
    const broken = structuredClone(calibrationCase());
    broken.after.state.events[0]!.event_type = "BROKEN_EVENT";
    const manifestPath = writeDataset(root, broken);
    const report = runCalibrationDataset(manifestPath, RULES);
    assert.equal(report.integrityVerified, true);
    assert.equal(report.statusCounts.MISMATCH, 1);
    assert.equal(report.taxonomyCounts.EVENT > 0, true);
    assert.equal(report.hardMismatchCaseCount, 1);
    assert.equal(report.knownEventMatched, 1);
    assert.equal(report.knownEventCompared, 2);
    assert.equal(report.knownEventAccuracy, 0.5);
    assert.equal(report.passed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("S8b dataset v0.14: 默认规则版本数据集校准 → MATCH（upkeep no-op + 动态价引擎路径）", () => {
  const root = mkdtempSync(join(tmpdir(), "calibration-dataset-"));
  try {
    const report = runCalibrationDataset(writeDataset(root, calibrationCase(RULES)), RULES);
    assert.equal(report.rulesVersion, "v0.14");
    assert.equal(report.integrityVerified, true);
    assert.equal(report.caseCount, 1);
    assert.equal(report.statusCounts.MATCH, 1);
    assert.equal(report.hardMismatchCaseCount, 0);
    assert.equal(report.accuracyGatePassed, true);
    assert.equal(report.passed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
