/** M2c.1 batch counterfactual exporter integration test. */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  computeCandidateSetHash,
  makeCandidateV1,
} from "../src/offline-learning/candidate/decision-candidate-v1.ts";
import { exportCounterfactualDataset } from "../src/offline-learning/counterfactual/counterfactual-exporter.ts";
import type { MacroDecisionPointV1 } from "../src/offline-learning/runtime/macro-decision-point.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.14.json");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CORE = "11111111-1111-1111-1111-111111111111";
const WORKER = "22222222-2222-2222-2222-222222222222";
const POLICY: MacroPolicy = {
  posture: "balanced",
  workerTarget: 8,
  militaryRatio: 0.4,
  focusRegion: null,
  attackPriority: null,
};
const KEEP = makeCandidateV1({ candidateId: "keep", kind: "KEEP", parameters: {}, source: "baseline" });
const WORKER_9 = makeCandidateV1({
  candidateId: "worker-target-9",
  kind: "WORKER_TARGET",
  parameters: { workerTarget: 9 },
  source: "local-neighborhood",
});

function stateAt(resources: number) {
  return {
    status: "ACTIVE",
    respawn_at_tick: null,
    resources,
    population: 1,
    population_tier: null,
    upkeep_next_tick: null,
    champion_beacon: { position: [15, 0], status: "GROUND", carrier_id: null },
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
      { kind: "RESOURCE", positions: [[1, 0], [0, 2], [-2, 0], [0, -2]] },
    ],
    events: [],
  };
}

function decisionPoint(): MacroDecisionPointV1 {
  const candidates = [KEEP, WORKER_9] as const;
  return {
    schema: "macro-decision-point-v1",
    decisionPointId: "run-a:100",
    processRunId: "run-a",
    tick: 100,
    intervalTicks: 2,
    previousPolicy: POLICY,
    newPolicy: POLICY,
    chosenBy: "policy-sticky",
    candidates,
    candidateSetHash: computeCandidateSetHash(candidates),
    chosenCandidateHash: KEEP.deterministicHash,
    selectionRepresentable: true,
    behaviorPropensity: null,
  };
}

function calibrationCase() {
  return {
    schema: "sim-calibration-case-v1",
    caseId: "run-a:100",
    tenantId: "t1",
    rulesVersion: "v0.14",
    seed: 0,
    metadata: {
      source: "live-recorder",
      opponentPlans: "absent",
      recordedAt: "2026-08-09T00:00:00Z",
      sourceCommit: COMMIT,
      runId: "run-a:t1:100:1",
    },
    before: { tick: 100, state: stateAt(10) },
    plan: { tick: 100, unitActions: {}, coreAction: null, intents: {} },
    after: { tick: 101, state: stateAt(10) },
  };
}

function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("counterfactual exporter joins decision telemetry + calibration and writes auditable artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "counterfactual-export-"));
  try {
    const telemetryDir = join(root, "runtime", "t1", "telemetry");
    const calibrationRoot = join(root, "runtime", "t1", "calibration");
    const caseDir = join(calibrationRoot, "run-a", "cases");
    mkdirSync(telemetryDir, { recursive: true });
    mkdirSync(caseDir, { recursive: true });

    const point = decisionPoint();
    const pointPath = join(telemetryDir, "policy-decision-points.jsonl");
    writeFileSync(pointPath, `${JSON.stringify({ at: "2026-08-09T00:00:00Z", tenantId: "t1", ...point })}\n`, "utf8");
    const decisionPath = join(telemetryDir, "decision.jsonl");
    const decisionRows = Array.from({ length: 6 }, (_, index) => ({
      processRunId: "run-a",
      tenantId: "t1",
      runId: `run-a:${95 + index}`,
      tick: 95 + index,
      threatLevel: index === 4 ? "ALERT" : "NORMAL",
      threatReason: null,
    }));
    writeFileSync(decisionPath, decisionRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    writeFileSync(join(caseDir, "0000000100.json"), `${JSON.stringify(calibrationCase(), null, 2)}\n`, "utf8");

    const result = exportCounterfactualDataset({
      dataRoot: root,
      tenantId: "t1",
      decisionPointsPath: pointPath,
      decisionTelemetryPath: decisionPath,
      calibrationRoot,
      rulesPath: RULES_PATH,
      scenarioSeeds: [0, 1],
      horizons: [2, 4],
      simulatorVersion: "sim/v1.1",
      certificateVersion: "test-cert",
      confidence: 0.25,
      runId: "counterfactual-test",
    });

    assert.equal(result.stats.decisionPointsRead, 1);
    assert.equal(result.stats.decisionPointsExported, 1);
    assert.equal(result.stats.samples, 1);
    assert.equal(result.stats.trajectories, 4, "2 candidates × 2 seeds");
    assert.equal(result.stats.evaluations, 8, "2 candidates × 2 seeds × 2 horizons");
    assert.equal(result.stats.missingThreatContext, 0);
    assert.ok(existsSync(result.qSamplesPath));
    assert.ok(existsSync(result.pairwisePath));
    assert.ok(existsSync(result.manifestPath));
    assert.ok(existsSync(result.reportPath));

    const samples = readJsonl(result.qSamplesPath) as Array<Record<string, unknown>>;
    assert.equal(samples.length, 1);
    const evaluations = samples[0]!.evaluations as Array<Record<string, unknown>>;
    assert.equal(evaluations.length, 8);
    assert.ok(evaluations.every((evaluation) => {
      const sim = evaluation.sim as Record<string, unknown>;
      return sim.initialStateScope === "private-observation-completed" &&
        sim.completionPolicy === "private-visible-only-v1";
    }));

    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as Record<string, unknown>;
    assert.equal(manifest.schema, "counterfactual-q-manifest-v1");
    const report = JSON.parse(readFileSync(result.reportPath, "utf8")) as Record<string, unknown>;
    assert.equal(report.caveat, "DEV_ONLY_PRIVATE_COMPLETION");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
