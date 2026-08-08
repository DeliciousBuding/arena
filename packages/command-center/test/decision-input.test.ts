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

test("decision-input: 威胁表 join（threatLevel/threatCombat）", () => {
  const predictions = [
    { cell: "1,1", x: 1, y: 1, dueInTicks: 5, predictedNextTick: 100, lastSeenTick: 95, windows: 2, avgGapTicks: 5 },
    { cell: "9,9", x: 9, y: 9, dueInTicks: 50, predictedNextTick: 150, lastSeenTick: 100, windows: 2, avgGapTicks: 50 },
  ];
  const threat = new Map<string, { threatLevel: 0 | 1 | 2 | 3; threatCombat: number }>([
    ["1,1", { threatLevel: 3, threatCombat: 14 }],
  ]);
  const p = buildDecisionInput("t1", 100, predictions, [], threat);
  assert.equal(p.refillPredictions[0].cell, "1,1");
  assert.equal(p.refillPredictions[0].threatLevel, 3, "高危格标注");
  assert.equal(p.refillPredictions[0].threatCombat, 14);
  const q = p.refillPredictions.find((r) => r.cell === "9,9");
  assert.equal(q?.threatLevel, 0, "无威胁数据默认 0");
  assert.equal(q?.threatCombat, 0);
});

test("decision-input: 补测目标（resurveyTargets）——按陈旧度降序 + key 推导", () => {
  const resurvey = [
    { key: "3,3", cx: 3, cy: 3, lastSeenTick: 70000, stalenessTicks: 3000, distChunks: 2 },
    { key: "1,1", cx: 1, cy: 1, lastSeenTick: 65000, stalenessTicks: 8000, distChunks: 1 },
  ];
  const p = buildDecisionInput("t1", 73000, [], [], undefined, resurvey);
  assert.equal(p.resurveyTargets.length, 2);
  assert.equal(p.resurveyTargets[0].key, "1,1", "最旧（陈旧 8000）优先");
  assert.equal(p.resurveyTargets[0].stalenessTicks, 8000);
  assert.equal(p.resurveyTargets[1].distChunks, 2);
  // 空输入兜底
  const q = buildDecisionInput("t2", 73000, [], []);
  assert.equal(q.resurveyTargets.length, 0);
});

test("decision-input: 采集候选（miningCandidates）归一 + 威胁 join + 空兕底", () => {
  const candidates = [
    { cell: "5,5", x: 5, y: 5, lastSeenTick: 12000, gapAgeTicks: 300, harvestFail: 0, activity: 0.5, threatLevel: 0 as const, threatCombat: 0 },
    { cell: "6,6", x: 6, y: 6, lastSeenTick: 11800, gapAgeTicks: 500, harvestFail: 2, activity: 0.1, threatLevel: 3 as const, threatCombat: 53 },
  ];
  const p = buildDecisionInput("t1", 12000, [], [], undefined, [], [], candidates);
  assert.equal(p.miningCandidates.length, 2);
  assert.equal(p.miningCandidates[0].cell, "5,5", "保持传入顺序（已 lastSeen 降序）");
  assert.equal(p.miningCandidates[1].harvestFail, 2, "竞争矿信号保留");
  assert.equal(p.miningCandidates[1].gapAgeTicks, 500);
  assert.equal(p.miningCandidates[1].threatLevel, 3, "同格威胁级保留");
  assert.equal(p.miningCandidates[1].threatCombat, 53);
  // 空兕底
  const q = buildDecisionInput("t2", null, [], []);
  assert.equal(q.miningCandidates.length, 0);
});
