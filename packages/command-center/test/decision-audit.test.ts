/**
 * 决策-结果审计聚合测试（2026-08-08，综合决策/日志系统）：
 * - 动作/意图/决策源/planHash 振荡/停摆 tick 聚合；
 * - 事件计数（字符串 + failedEvents 对象两种形态）、满载率、人类覆盖。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateAudit } from "../lib/decision-audit.ts";

test("decision-audit: 动作/意图/振荡/停摆聚合", () => {
  const d = [
    JSON.stringify({ tick: 100, decisionSource: "deterministic", moveCount: 2, harvestCount: 0, depositCount: 0, waitCount: 3, intentCounts: { GO_RESOURCE: 2, WAIT: 3 }, planHash: "a" }),
    JSON.stringify({ tick: 101, decisionSource: "deterministic", moveCount: 1, harvestCount: 0, depositCount: 0, waitCount: 1, intentCounts: { WAIT: 1 }, planHash: "b" }),
    JSON.stringify({ tick: 102, decisionSource: "human", moveCount: 0, harvestCount: 2, depositCount: 1, waitCount: 0, intentCounts: { GO_RESOURCE: 2, DEPOSIT: 1 }, planHash: "b" }),
  ];
  const a = aggregateAudit("t1", 3, d, []);
  assert.equal(a.decision.records, 3);
  assert.equal(a.decision.actionMix.move, 3);
  assert.equal(a.decision.actionMix.wait, 4);
  assert.equal(a.decision.stallTicks, 2, "tick100/101 wait 主导且 0 采集/交付");
  assert.equal(a.decision.planChurn?.unique, 2);
  assert.equal(a.decision.planChurn?.rate, 0.667, "churn rate 保留 3 位小数");
  assert.equal(a.decision.sourceMix.human, 1);
  const top = a.decision.intentTop[0];
  assert.equal(top?.intent, "GO_RESOURCE");
  assert.equal(top?.count, 4);
  assert.equal(a.currentTick, 102);
});

test("decision-audit: outcome 事件计数（字符串+对象）/满载率/人类覆盖", () => {
  const o = [
    JSON.stringify({
      tick: 200, coreResourceDelta: 5, workerCount: 4, workersWithCargo: 1, workerMeanDistanceFromCore: 3,
      events: ["DEPOSIT_SUCCEEDED", "HARVEST_SUCCEEDED", "DEPOSIT_SUCCEEDED"],
      failedEvents: [{ eventType: "DEPOSIT_FAILED", reasonCode: "CORE_MOVING" }],
      humanOverride: { applied: ["u1"], rejected: ["u2"] },
    }),
    JSON.stringify({
      tick: 201, coreResourceDelta: -1, workerCount: 4, workersWithCargo: 2, workerMeanDistanceFromCore: 5,
      events: ["HARVEST_FAILED"],
      failedEvents: [],
      humanOverride: { applied: [], rejected: [] },
    }),
  ];
  const a = aggregateAudit("t1", 2, [], o);
  assert.equal(a.outcome.records, 2);
  assert.equal(a.outcome.coreDeltaSum, 4);
  assert.equal(a.outcome.coreDeltaPositiveTicks, 1);
  assert.equal(a.outcome.depositSucceeded, 2);
  assert.equal(a.outcome.depositFailed, 1);
  assert.equal(a.outcome.harvestSucceeded, 1);
  assert.equal(a.outcome.harvestFailed, 1);
  assert.equal(a.outcome.depositSuccessRate, 0.667, "rate 保留 3 位小数");
  assert.equal(a.outcome.cargoEfficiency, (0.25 + 0.5) / 2);
  assert.equal(a.outcome.workerMeanDistFromCore, 4);
  assert.equal(a.outcome.humanApplied, 1);
  assert.equal(a.outcome.humanRejected, 1);
});
