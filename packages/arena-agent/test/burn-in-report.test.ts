import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBurnInReport,
  DEFAULT_BURN_IN_THRESHOLDS,
} from "../src/analysis/burn-in-report.ts";
import type {
  DecisionTraceRecord,
  OutcomeTraceRecord,
  RuntimeTraceRecord,
} from "../src/telemetry/decision-trace.ts";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function runtimeRecord(
  tick: number,
  submitResult: RuntimeTraceRecord["submitResult"],
  notSubmittedReason?: RuntimeTraceRecord["notSubmittedReason"],
): RuntimeTraceRecord {
  return {
    processRunId: RUN_ID,
    tenantId: "t1",
    tick,
    runId: `${RUN_ID}:t1:${tick}:${tick}`,
    deadlineOutcome: "not_applicable",
    agentLatencyMs: null,
    selectionLatencyMs: 2,
    abortRequested: false,
    rotationGeneration: 0,
    submitResult,
    notSubmittedReason,
  };
}

function decisionRecord(tick: number): DecisionTraceRecord {
  return {
    processRunId: RUN_ID,
    tenantId: "t1",
    tick,
    runId: `${RUN_ID}:t1:${tick}:${tick}`,
    decisionSource: "deterministic",
    agentActionCount: 0,
    safetyReplacementCount: 0,
    invalidAgentActionCount: 0,
    repairCount: 0,
    moveCount: 8,
    harvestCount: tick === 10 ? 1 : 0,
    depositCount: tick === 20 ? 1 : 0,
    waitCount: 0,
    intentCounts: { patrol: 8 },
    planHash: `hash-${tick}`,
  };
}

function outcomeRecord(tick: number): OutcomeTraceRecord {
  const events = tick === 10
    ? ["HARVEST_SUCCEEDED"]
    : tick === 20
      ? ["DEPOSIT_SUCCEEDED"]
      : ["UNIT_MOVE_SUCCEEDED"];
  return {
    processRunId: RUN_ID,
    tenantId: "t1",
    tick,
    coreResourcesBefore: tick < 20 ? 10 : 11,
    coreResourcesAfter: tick < 20 ? 10 : 11,
    coreResourceDelta: tick === 20 ? 1 : 0,
    visibleResourceCellCount: tick === 10 ? 1 : 0,
    workerCount: 8,
    workersWithCargo: tick >= 10 && tick < 20 ? 1 : 0,
    workerCargoTotal: tick >= 10 && tick < 20 ? 1 : 0,
    uniqueWorkerCellCount: 8,
    workerMaxDistanceFromCore: 16,
    workerMeanDistanceFromCore: 8,
    failedEvents: [],
    events,
  };
}

test("Burn-in report：1 startup sync + 100 accepted + 正收益 → PASS", () => {
  const runtime = [
    runtimeRecord(1, "not_submitted", "startup_sync"),
    ...Array.from({ length: 100 }, (_, index) => runtimeRecord(index + 2, "accepted")),
  ];
  const decisions = Array.from({ length: 101 }, (_, index) => decisionRecord(index + 1));
  const outcomes = Array.from({ length: 100 }, (_, index) => outcomeRecord(index + 2));
  const report = buildBurnInReport(RUN_ID, runtime, decisions, outcomes);

  assert.equal(report.passed, true);
  assert.equal(report.liveAttempts, 100);
  assert.equal(report.startupSyncTicks, 1);
  assert.equal(report.accepted, 100);
  assert.equal(report.rejected, 0);
  assert.equal(report.harvestActions, 1);
  assert.equal(report.depositActions, 1);
  assert.equal(report.coreResourceDelta, 1);
  assert.equal(report.gates.every((gate) => gate.pass), true);
});

test("Burn-in report：submit reject + CELL_UNIT_LIMIT + 无收益 → FAIL 且精确列门禁", () => {
  const runtime = [
    runtimeRecord(1, "not_submitted", "startup_sync"),
    ...Array.from({ length: 99 }, (_, index) => runtimeRecord(index + 2, "accepted")),
    { ...runtimeRecord(101, "rejected"), submitError: "409 COMMAND_WINDOW_CLOSED" },
  ];
  const decisions = Array.from({ length: 101 }, (_, index) => ({
    ...decisionRecord(index + 1),
    repairCount: index === 4 ? 1 : 0,
    harvestCount: 0,
    depositCount: 0,
  }));
  const outcomes = Array.from({ length: 100 }, (_, index) => ({
    ...outcomeRecord(index + 2),
    coreResourceDelta: 0,
    failedEvents: index === 5
      ? [{
          eventType: "UNIT_MOVE_FAILED",
          reasonCode: "CELL_UNIT_LIMIT",
          actorId: "w1",
          targetId: null,
          priorAction: '{"type":"MOVE","direction":"UP"}',
          priorIntent: "patrol",
        }]
      : [],
  }));
  const report = buildBurnInReport(RUN_ID, runtime, decisions, outcomes, {
    ...DEFAULT_BURN_IN_THRESHOLDS,
    maxFailedActionRate: 0,
  });

  assert.equal(report.passed, false);
  assert.equal(report.failedReasonCounts.CELL_UNIT_LIMIT, 1);
  const failedNames = report.gates.filter((gate) => !gate.pass).map((gate) => gate.name);
  assert.ok(failedNames.includes("all_live_submits_accepted"));
  assert.ok(failedNames.includes("no_submit_rejection"));
  assert.ok(failedNames.includes("no_plan_repair"));
  assert.ok(failedNames.includes("no_cell_unit_limit"));
  assert.ok(failedNames.includes("failed_action_rate"));
  assert.ok(failedNames.includes("harvest_observed"));
  assert.ok(failedNames.includes("deposit_observed"));
  assert.ok(failedNames.includes("positive_core_resource_delta"));
});

test("Burn-in report：非法门禁配置 fail-fast", () => {
  assert.throws(
    () => buildBurnInReport(RUN_ID, [], [], [], {
      ...DEFAULT_BURN_IN_THRESHOLDS,
      maxWaitRatio: 2,
    }),
    /maxWaitRatio must be within/,
  );
});
