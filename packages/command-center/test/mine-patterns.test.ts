/**
 * mine-patterns 矿刷新预测算法测试（2026-08-08）：
 * - 出现窗口切分（gap ≤ REFILL_GAP_TICKS 同窗口）；
 * - avgGapTicks = 相邻窗口起始差（完整周期）；
 * - predictedNextTick = 最后窗口结束 + 平均缺席长（消失→再出现的可行动信号）；
 * - 单窗口格不预测；按 dueInTicks 升序。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeRefillPredictions, type MineRefillPrediction } from "../lib/mine-patterns.ts";

test("mine-patterns: 逐矿刷新预测——窗口切分/周期/缺席长/排序", () => {
  const rows = [
    // cell A：3 个窗口 [100-104] [130-134] [160-164]（窗口内 gap ≤5，窗口间 gap 30）
    ...[100, 101, 102, 103, 104, 130, 131, 132, 133, 134, 160, 161, 162, 163, 164].map((tick) => ({ cell: "A", tick })),
    // cell B：单窗口（无法预测）
    ...[300, 301, 302].map((tick) => ({ cell: "B", tick })),
  ];
  const resources = [
    { cell: "A", x: 5, y: 6 },
    { cell: "B", x: 7, y: 8 },
  ];
  const out = computeRefillPredictions(rows, resources, 200);
  assert.equal(out.length, 1, "只有 ≥2 窗口的格进入预测");
  const a = out[0] as MineRefillPrediction;
  assert.equal(a.cell, "A");
  assert.equal(a.x, 5);
  assert.equal(a.y, 6);
  assert.equal(a.windows, 3);
  // gaps: 130-100=30, 160-130=30 → avg 30
  assert.equal(a.avgGapTicks, 30);
  // absents: (130-104)=26, (160-134)=26 → avg 26；lastEnd=164 → predicted=190
  assert.equal(a.predictedNextTick, 190);
  assert.equal(a.lastSeenTick, 164);
  assert.equal(a.dueInTicks, 190 - 200);
});

test("mine-patterns: 预测按 dueInTicks 升序（即将刷新优先）", () => {
  const rows = [
    ...[100, 120, 150].map((tick) => ({ cell: "soon", tick })),      // windows [100][120][150]，gap 20/30
    ...[1000, 1010, 2000, 2010, 3000, 3010].map((tick) => ({ cell: "far", tick })),
  ];
  const out = computeRefillPredictions(rows, [], 100);
  assert.equal(out.length, 2);
  assert.ok((out[0]?.dueInTicks ?? 0) <= (out[1]?.dueInTicks ?? 0), "dueInTicks 升序");
  assert.equal(out[0]?.cell, "soon");
});
