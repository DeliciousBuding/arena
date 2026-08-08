import assert from "node:assert/strict";
import { test } from "node:test";

import { aggregateWorkerLiveness } from "../lib/worker-liveness-audit.ts";

test("worker-liveness audit: 聚合局部假活证据 + 重复恢复优先", () => {
  const rows = [
    { tick: 100, telemetryType: "runtime" },
    {
      tick: 101,
      telemetryType: "worker_liveness",
      workerLivenessKind: "economic_no_progress",
      unitId: "w1",
      streak: 6,
      position: [40, 289],
      cargo: 0,
      priorActionType: "WAIT",
      priorIntent: "GO_RESOURCE",
      recentPositions: [[40, 289], [40, 289]],
      uniqueRecentPositions: 1,
      recoveryCount: 1,
      recoveryApplied: true,
    },
    { tick: 110, telemetryType: "runtime" },
    {
      tick: 111,
      telemetryType: "worker_liveness",
      workerLivenessKind: "economic_no_progress",
      unitId: "w1",
      streak: 6,
      position: [40, 289],
      cargo: 0,
      priorActionType: "WAIT",
      priorIntent: "GO_RESOURCE",
      recentPositions: [[40, 289]],
      uniqueRecentPositions: 1,
      recoveryCount: 2,
      recoveryApplied: true,
    },
    {
      tick: 112,
      telemetryType: "worker_liveness",
      workerLivenessKind: "oscillation",
      unitId: "w2",
      streak: 12,
      position: [1, 0],
      cargo: 0,
      priorActionType: "MOVE",
      priorIntent: "patrol",
      recentPositions: [[0, 0], [1, 0], [0, 0], [1, 0]],
      uniqueRecentPositions: 2,
      recoveryCount: 1,
      recoveryApplied: true,
    },
    { tick: 120, telemetryType: "runtime" },
  ];

  const audit = aggregateWorkerLiveness("t4", rows);
  assert.equal(audit.currentTick, 120);
  assert.equal(audit.eventCount, 3);
  assert.equal(audit.affectedWorkers, 2);
  assert.equal(audit.repeatedWorkers, 1);
  assert.deepEqual(audit.byKind, { economic_no_progress: 2, oscillation: 1 });
  assert.equal(audit.latestByWorker[0]?.unitId, "w1");
  assert.equal(audit.latestByWorker[0]?.status, "repeated");
  assert.equal(audit.latestByWorker[0]?.recoveryCount, 2);
  assert.equal(audit.latestByWorker[1]?.status, "recent");
  assert.equal(audit.latestByWorker[1]?.uniqueRecentPositions, 2);
});

test("worker-liveness audit: 老事件降为 historical，坏行/普通 runtime 不计 incident", () => {
  const audit = aggregateWorkerLiveness("t1", [
    { tick: 10, telemetryType: "worker_liveness", workerLivenessKind: "idle_wait", unitId: "w1", recoveryCount: 1 },
    { tick: 40, telemetryType: "stall_warning", unitId: "not-worker-event" },
  ]);
  assert.equal(audit.eventCount, 1);
  assert.equal(audit.latestByWorker[0]?.status, "historical");
});
