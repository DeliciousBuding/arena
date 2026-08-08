/**
 * 矿刷新预测命中率测试（2026-08-08）：computePredictionAccuracy——
 * 已过预测时间的预测重见率 + 未到判定窗口跳过 + 空兜底。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { computePredictionAccuracy } from "../lib/mine-patterns.ts";
import type { MineRefillPrediction } from "../lib/mine-patterns.ts";

const pred = (cell: string, next: number | null): MineRefillPrediction => ({
  cell, x: 0, y: 0, windows: 2, avgGapTicks: 10, lastSeenTick: 100, predictedNextTick: next, dueInTicks: next === null ? null : next - 500,
});

test("mine-patterns: 预测命中率（重见=hit / 未见=miss / 未到期跳过）", () => {
  const predictions = [pred("a", 300), pred("b", 320), pred("c", 480)];
  // currentTick=500，容差 REFILL_GAP_TICKS=5：
  //  - a: next=300，已过；maxSeen=302 ≥ 295 → hit
  //  - b: next=320，已过；maxSeen=310 < 315 → miss
  //  - c: next=480，500-480=20 ≥ 5 → 判定；maxSeen=300 < 475 → miss
  const rows = [
    { cell: "a", tick: 302 }, { cell: "a", tick: 100 },
    { cell: "b", tick: 310 }, { cell: "b", tick: 100 },
    { cell: "c", tick: 300 },
  ];
  const acc = computePredictionAccuracy(predictions, rows, 500);
  assert.ok(acc, "应生成准确率");
  assert.equal(acc.evaluated, 3);
  assert.equal(acc.hits, 1);
  assert.equal(acc.misses, 2);
  assert.equal(acc.hitRate, 0.333); // 1/3 四舍五入到千分位
  assert.ok((acc.avgMissOverdue ?? 0) > 0, "miss 平均已过预期");
});

test("mine-patterns: 命中率空兜底 + 未到期跳过", () => {
  // 全部未到判定窗口（next 都在 current 附近）
  const acc = computePredictionAccuracy([pred("a", 498)], [{ cell: "a", tick: 100 }], 500);
  assert.equal(acc, null, "500-498=2 < 5 未到判定窗口 → null");
  assert.equal(computePredictionAccuracy([], [], 500), null, "空预测 → null");
});

