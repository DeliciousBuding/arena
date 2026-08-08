/**
 * 矿发现-利用缺口审计测试（2026-08-08）：
 * - 汇总：total/harvested/never/visibleNever/staleNever/利用率；
 * - candidates：可见未开采按 lastSeen 降序；
 * - timeToFirstHarvest：发现→首采耗时 + 中位数；
 * - 空数据兜底。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateMineUtilization } from "../lib/mine-utilization.ts";

test("mine-utilization: 缺口汇总 + 候选排序 + 首采耗时", () => {
  const resources = [
    { cell: "1,1", x: 1, y: 1, firstSeenTick: 100, lastSeenTick: 4800, seenCount: 40 }, // visible, harvested
    { cell: "2,2", x: 2, y: 2, firstSeenTick: 200, lastSeenTick: 4700, seenCount: 20 }, // visible, never
    { cell: "3,3", x: 3, y: 3, firstSeenTick: 50, lastSeenTick: 2500, seenCount: 10 },  // stale, never
    { cell: "4,4", x: 4, y: 4, firstSeenTick: 60, lastSeenTick: 2200, seenCount: 5 },   // stale, harvested
  ];
  const events = [
    { cell: "1,1", tick: 130, eventType: "HARVEST_SUCCEEDED", amount: 2 },
    { cell: "1,1", tick: 160, eventType: "HARVEST_SUCCEEDED", amount: 2 },
    { cell: "4,4", tick: 90, eventType: "HARVEST_SUCCEEDED", amount: 1 },
    { cell: "4,4", tick: 95, eventType: "HARVEST_FAILED", amount: null },
  ];
  // currentTick=5000 → 新鲜窗口 cutoff=3000：1,1/2,2 visible，3,3/4,4 stale
  const a = aggregateMineUtilization("t1", 5000, resources, events);
  assert.equal(a.total, 4);
  assert.equal(a.harvested, 2);
  assert.equal(a.neverHarvested, 2);
  assert.equal(a.visibleNever, 1, "2,2 可见未开采");
  assert.equal(a.staleNever, 1, "3,3 历史未开采");
  assert.equal(a.utilizationRate, 0.5);
  // candidates = 可见未开采（2,2），lastSeen 降序
  assert.equal(a.candidates.length, 1);
  assert.equal(a.candidates[0]?.cell, "2,2");
  // timeToFirstHarvest：1,1 首采 130-100=30；4,4 首采 90-60=30
  const med = a.medianTimeToFirstHarvest;
  assert.equal(med, 30, "两条首采耗时均 30 → 中位 30");
});

test("mine-utilization: gapAge 发现后仍未采时长", () => {
  // currentTick=5000：可见未开采 2,2（firstSeen 200）→ gapAge 4800；已采 1,1 → null
  const resources = [
    { cell: "1,1", x: 1, y: 1, firstSeenTick: 100, lastSeenTick: 4800, seenCount: 40 },
    { cell: "2,2", x: 2, y: 2, firstSeenTick: 200, lastSeenTick: 4700, seenCount: 20 },
    { cell: "3,3", x: 3, y: 3, firstSeenTick: 1000, lastSeenTick: 4600, seenCount: 5 },
  ];
  const events = [
    { cell: "1,1", tick: 130, eventType: "HARVEST_SUCCEEDED", amount: 2 },
    { cell: "3,3", tick: 1200, eventType: "HARVEST_SUCCEEDED", amount: 1 },
  ];
  const a = aggregateMineUtilization("t1", 5000, resources, events);
  const byCell = Object.fromEntries(a.candidates.map((c) => [c.cell, c]));
  assert.equal(byCell["2,2"].gapAgeTicks, 4800, "5000-200");
  assert.equal(byCell["2,2"].neverHarvested, true);
  assert.equal(a.maxGapAgeTicks, 4800);
  assert.equal(a.medianGapAgeTicks, 4800, "仅一个候选 → 中位=自身");
  // 空数据兜底：gapAge 相关为 null
  const b = aggregateMineUtilization("t2", null, [], []);
  assert.equal(b.maxGapAgeTicks, null);
  assert.equal(b.medianGapAgeTicks, null);
  assert.equal(b.candidates.length, 0);
});

test("mine-utilization: 金牌矿榜（累计收益/次数 top）", () => {
  const resources = [
    { cell: "1,1", x: 1, y: 1, firstSeenTick: 100, lastSeenTick: 4800, seenCount: 10 },
    { cell: "2,2", x: 2, y: 2, firstSeenTick: 200, lastSeenTick: 4700, seenCount: 8 },
    { cell: "3,3", x: 3, y: 3, firstSeenTick: 50, lastSeenTick: 4000, seenCount: 5 },
  ];
  const events = [
    { cell: "1,1", tick: 120, eventType: "HARVEST_SUCCEEDED", amount: 2 },
    { cell: "1,1", tick: 150, eventType: "HARVEST_SUCCEEDED", amount: 3 },
    { cell: "2,2", tick: 250, eventType: "HARVEST_SUCCEEDED", amount: 4 },
    { cell: "2,2", tick: 260, eventType: "HARVEST_SUCCEEDED", amount: 1 },
    { cell: "3,3", tick: 80, eventType: "HARVEST_FAILED", amount: null },
  ];
  const a = aggregateMineUtilization("t1", 5000, resources, events);
  assert.equal(a.topMines.byAmount.length, 2);
  assert.equal(a.topMines.byAmount[0].cell, "2,2", "累计收益 5 最高");
  assert.equal(a.topMines.byAmount[0].harvestAmount, 5);
  assert.equal(a.topMines.byAmount[1].cell, "1,1");
  assert.equal(a.topMines.byCount[0].cell, "2,2", "次数 2 并列，末采 260 更新优先");
  // 空数据兜底
  const b = aggregateMineUtilization("t2", null, [], []);
  assert.equal(b.topMines.byAmount.length, 0);
  assert.equal(b.topMines.byCount.length, 0);
});

test("mine-utilization: 空数据兜底 + 全采集", () => {
  const a = aggregateMineUtilization("t2", null, [], []);
  assert.equal(a.total, 0);
  assert.equal(a.candidates.length, 0);
  assert.equal(a.utilizationRate, null);
  assert.equal(a.medianTimeToFirstHarvest, null);

  const resources = [{ cell: "0,0", x: 0, y: 0, firstSeenTick: 10, lastSeenTick: 4200, seenCount: 2 }];
  const events = [{ cell: "0,0", tick: 15, eventType: "HARVEST_SUCCEEDED", amount: 3 }];
  const b = aggregateMineUtilization("t3", 5000, resources, events);
  assert.equal(b.neverHarvested, 0);
  assert.equal(b.harvested, 1);
  assert.equal(b.visibleNever, 0);
  assert.equal(b.candidates.length, 0);
});
