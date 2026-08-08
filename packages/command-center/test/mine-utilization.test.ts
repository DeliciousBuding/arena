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
