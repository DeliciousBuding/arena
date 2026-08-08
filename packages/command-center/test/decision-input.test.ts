/**
 * 决策输入管道测试（2026-08-08）：
 * - buildDecisionInput：refillPredictions 按 dueInTicks 升序 + chunkCoverage 按最老分区；
 * - 空数据兜底 + 字段归一。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDecisionInput } from "../lib/decision-input.ts";

test("decision-input: 预测排序 + chunk 覆盖 + 归一", () => {
  const predictions = [
    { cell: "1,1", x: 1, y: 1, dueInTicks: 100, predictedNextTick: 12000, lastSeenTick: 11900, windows: 2, avgGapTicks: 100 },
    { cell: "2,2", x: 2, y: 2, dueInTicks: 5, predictedNextTick: 11905, lastSeenTick: 11900, windows: 3, avgGapTicks: 5 },
  ];
  const chunks = [
    { key: "3,3", cx: 3, cy: 3, lastSeenTick: 11000 },
    { key: "1,1", cx: 1, cy: 1, lastSeenTick: 5000 },
  ];
  const p = buildDecisionInput("t1", 12000, predictions, chunks);
  assert.equal(p.tenant, "t1");
  assert.equal(p.currentTick, 12000);
  assert.equal(p.refillPredictions.length, 2);
  assert.equal(p.refillPredictions[0].cell, "2,2", "dueInTicks 5 即将刷新优先");
  assert.equal(p.refillPredictions[0].dueInTicks, 5);
  assert.equal(p.chunkCoverage.length, 2);
  assert.equal(p.chunkCoverage[0].key, "1,1", "最老分区（5000）优先=勘探方向");
});

test("decision-input: 空数据兜底 + key 推导", () => {
  const p = buildDecisionInput("t2", null, [], []);
  assert.equal(p.refillPredictions.length, 0);
  assert.equal(p.chunkCoverage.length, 0);
  assert.equal(p.currentTick, null);
  // key 缺失时从 cx,cy 推导
  const q = buildDecisionInput("t3", 100, [], [{ cx: 7, cy: 8, lastSeenTick: 90 }]);
  assert.equal(q.chunkCoverage[0].key, "7,8");
});
