/**
 * 矿利用趋势测试（2026-08-08）：可见未开采缺口随窗口变化。
 * - 窗口 endTick 降序（index 0=最早，steps-1=最新）；
 * - visibleNever：窗口内可见且首次采集晚于窗口末；
 * - 首采后窗口 visibleNever 归零（缺口缩小）；
 * - 空输入兜底。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateMineUtilizationTrend } from "../lib/mine-utilization.ts";

test("mine-trend: 首采后缺口缩小", () => {
  const resources = [
    { cell: "1,1", firstSeenTick: 100, lastSeenTick: 10000 }, // 一直可见，tick3000 首次采集
    { cell: "2,2", firstSeenTick: 200, lastSeenTick: 9900 },  // 一直可见（窗口2 cutoff 9800 内），从未采集
    { cell: "3,3", firstSeenTick: 100, lastSeenTick: 5900 },  // tick5900 后不再可见（仅窗口0 可见）
  ];
  const events = [
    { cell: "1,1", tick: 3000, eventType: "HARVEST_SUCCEEDED" },
    { cell: "1,1", tick: 3001, eventType: "HARVEST_SUCCEEDED" },
  ];
  // currentTick=10000, window=2000, steps=3 → endTick: 6000, 8000, 10000
  // 每窗口新鲜 cutoff = endTick - RESOURCE_FRESH_WINDOW_TICKS(200)
  const tr = aggregateMineUtilizationTrend("t2", 2000, 3, resources, events, 10000);
  assert.equal(tr.trend.length, 3);
  assert.deepEqual(tr.trend.map((s) => s.endTick), [6000, 8000, 10000]);
  // 窗口 0 (endTick 6000, cutoff 5800)：1,1 已采 / 2,2 未采 / 3,3 lastSeen 5900>=5800 可见未采
  assert.equal(tr.trend[0]?.visible, 3, "1,1 + 2,2 + 3,3 可见");
  assert.equal(tr.trend[0]?.visibleNever, 2, "2,2 + 3,3 未采");
  // 窗口 2 (endTick 10000, cutoff 9800)：3,3 lastSeen 5900 < 9800 → 不可见
  assert.equal(tr.trend[2]?.visible, 2, "1,1 + 2,2");
  assert.equal(tr.trend[2]?.visibleNever, 1, "2,2");
  assert.equal(tr.currentTick, 10000);
});

test("mine-trend: 空输入兜底 + 全采集", () => {
  const a = aggregateMineUtilizationTrend("t1", 2000, 3, [], [], 5000);
  assert.equal(a.trend.length, 3);
  assert.equal(a.trend[0]?.total, 0);
  assert.equal(a.trend[0]?.visibleNever, 0);
  const resources = [{ cell: "9,9", firstSeenTick: 100, lastSeenTick: 8900 }]; // 窗口1 cutoff 8800 内可见
  const events = [{ cell: "9,9", tick: 200, eventType: "HARVEST_SUCCEEDED" }];
  const b = aggregateMineUtilizationTrend("t3", 2000, 2, resources, events, 9000);
  assert.equal(b.trend[1]?.visibleNever, 0, "已采集 → 缺口 0");
  assert.equal(b.trend[1]?.visible, 1);
});
