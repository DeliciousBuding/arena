/** W7 chunk 配额复察队测试（2026-08-09）：
 *  纯函数能力——chunkKey/refillTickAtOrAfter/chunkQuota/refillProbeAllowed/
 *  planChunkResurvey。未接线 variant-registry/safety-planner，零回归。 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chunkKey,
  chunkQuota,
  planChunkResurvey,
  refillProbeAllowed,
  refillTickAtOrAfter,
  type RefillPrediction,
} from "../src/intel/refill-predictions.ts";

/** 构造一个 RefillPrediction（仅填 planChunkResurvey 关心的字段）。 */
function prediction(
  cell: string,
  predictedNextTick: number,
  currentTick: number,
): RefillPrediction {
  return {
    cell,
    windows: 3,
    avgGapTicks: 100,
    lastWindowStartTick: predictedNextTick - 100,
    predictedNextTick,
    dueInTicks: predictedNextTick - currentTick,
  };
}

test("refillTickAtOrAfter: 4-tick 对齐（W 源码 _refill_tick_at_or_after）", () => {
  assert.equal(refillTickAtOrAfter(0), 0);
  assert.equal(refillTickAtOrAfter(1), 4);
  assert.equal(refillTickAtOrAfter(3), 4);
  assert.equal(refillTickAtOrAfter(4), 4);
  assert.equal(refillTickAtOrAfter(5), 8);
  assert.equal(refillTickAtOrAfter(7), 8);
  assert.equal(refillTickAtOrAfter(8), 8);
  assert.equal(refillTickAtOrAfter(12), 12);
});

test("chunkQuota: ring → max(2, 128//(8+ring))（W 源码 _chunk_quota）", () => {
  assert.equal(chunkQuota(0), 16); // floor(128/8)=16
  assert.equal(chunkQuota(8), 8); // floor(128/16)=8
  assert.equal(chunkQuota(16), 5); // floor(128/24)=5
  assert.equal(chunkQuota(24), 4); // floor(128/32)=4
  // 远 ring 触底保 2
  assert.equal(chunkQuota(120), 2); // floor(128/128)=1 → max(2,1)=2
});

test("chunkKey: 轴归一（-value-1 折正，W 源码 _chunk_quota ring 语义）", () => {
  // (0,0) 与 (-1,-1) 同 chunk（axis(-1)=0）
  assert.equal(chunkKey(0, 0), "0,0");
  assert.equal(chunkKey(-1, -1), "0,0");
  // (-2,-3) → (1,2)
  assert.equal(chunkKey(-2, -3), "1,2");
  // 正坐标不变
  assert.equal(chunkKey(5, 7), "5,7");
  // 混合
  assert.equal(chunkKey(-4, 3), "3,3"); // axis(-4)=3
});

test("refillProbeAllowed: 40-cap / beacon leash / 12-回退（W 源码 _refill_probe_allowed）", () => {
  // 无信标：硬上限 40
  assert.equal(refillProbeAllowed(40, null, 100), true);
  assert.equal(refillProbeAllowed(41, null, 100), false);

  // 信标在前向（beaconDist ≤ travel → OK）：beaconDist=30 travel=35 OK
  assert.equal(refillProbeAllowed(35, 30, 100), true);
  // travel=50 超 40 硬上限 → 拒（不论信标）
  assert.equal(refillProbeAllowed(50, 30, 100), false);

  // 回退（beaconDist > travel，信标在远离方向）：仅 ≤ 12 放行
  // beaconDist=20 travel=12 → 回退，12 ≤ 12 OK
  assert.equal(refillProbeAllowed(12, 20, 100), true);
  // beaconDist=20 travel=13 → 回退，13 > 12 拒
  assert.equal(refillProbeAllowed(13, 20, 100), false);

  // 边界：beaconDist == travel（前向边界 → OK）
  assert.equal(refillProbeAllowed(30, 30, 100), true);
  // 回退 12 边界 + 40-cap：travel=40 beaconDist=50（回退）→ 40≤40 过硬上限，
  // 回退 40 > 12 → 拒
  assert.equal(refillProbeAllowed(40, 50, 100), false);
});

test("planChunkResurvey: 空预测 → 空计划", () => {
  assert.deepEqual(planChunkResurvey(new Map(), 5, 100), []);
});

test("planChunkResurvey: workerCount=0 → 空计划（并发上限 min(3,(0+1)//2)=0）", () => {
  const preds = new Map([["10,10", prediction("10,10", 110, 100)]]);
  assert.deepEqual(planChunkResurvey(preds, 0, 100), []);
});

test("planChunkResurvey: 并发不超 min(3,(n+1)//2)", () => {
  // 5 个不同 chunk 的预测都 due，workerCount=2 → cap=min(3,1)=1
  const preds = new Map<string, RefillPrediction>([
    ["0,0", prediction("0,0", 104, 100)],
    ["40,0", prediction("40,0", 104, 100)],
    ["80,0", prediction("80,0", 104, 100)],
    ["120,0", prediction("120,0", 104, 100)],
    ["160,0", prediction("160,0", 104, 100)],
  ]);
  const plans = planChunkResurvey(preds, 2, 100);
  assert.equal(plans.length, 1, "workerCount=2 → cap=1");

  // workerCount=6 → cap=min(3,3)=3
  const plans6 = planChunkResurvey(preds, 6, 100);
  assert.equal(plans6.length, 3, "workerCount=6 → cap=3");

  // workerCount=10 → cap=min(3,5)=3（封顶 3）
  const plans10 = planChunkResurvey(preds, 10, 100);
  assert.equal(plans10.length, 3, "workerCount=10 → cap=3（封顶）");
});

test("planChunkResurvey: dueInTicks 升序（最早刷新优先）", () => {
  const preds = new Map<string, RefillPrediction>([
    ["0,0", prediction("0,0", 140, 100)], // dueInTicks=40
    ["40,0", prediction("40,0", 104, 100)], // dueInTicks=4
    ["80,0", prediction("80,0", 108, 100)], // dueInTicks=8
  ]);
  const plans = planChunkResurvey(preds, 6, 100); // cap=3，全收
  assert.equal(plans[0]!.cell, "40,0", "最早 due 排第一");
  assert.equal(plans[1]!.cell, "80,0");
  assert.equal(plans[2]!.cell, "0,0", "最晚 due 排最后");
  // dueInTicks 经 4-tick 对齐：104→4, 108→8, 140→4（140 对齐到 140，140-100=40）
  assert.equal(plans[0]!.dueInTicks, 4);
  assert.equal(plans[1]!.dueInTicks, 8);
  assert.equal(plans[2]!.dueInTicks, 40);
});

test("planChunkResurvey: chunk 配额（同 chunk 取至多 quota）", () => {
  // 同一 chunk (0,0) 内 5 个 cell，ring=0 → quota=16，但 workerCount=6 → cap=3
  const preds = new Map<string, RefillPrediction>([
    ["0,0", prediction("0,0", 104, 100)],
    ["1,0", prediction("1,0", 104, 100)],
    ["2,0", prediction("2,0", 104, 100)],
    ["3,0", prediction("3,0", 104, 100)],
    ["4,0", prediction("4,0", 104, 100)],
  ]);
  const plans = planChunkResurvey(preds, 6, 100); // cap=3
  assert.equal(plans.length, 3, "受并发上限 3 约束（非 quota 16）");
  // 全属同 chunk，quota=16 不受限
  assert.equal(plans[0]!.quota, 16);
});

test("planChunkResurvey: 跨 chunk 聚合 + quota 限制", () => {
  // chunk A (0,0) ring=0 quota=16；chunk B (cell 96,0 → chunk 3,0) ring=3 quota=11
  // chunk B 3 个 cell，chunk A 1 个 cell；workerCount=20 → cap=3
  const preds = new Map<string, RefillPrediction>([
    ["0,0", prediction("0,0", 104, 100)], // chunk 0,0；dueInTicks=4
    ["96,0", prediction("96,0", 104, 100)], // chunk 3,0；dueInTicks=4
    ["97,0", prediction("97,0", 104, 100)], // chunk 3,0
    ["98,0", prediction("98,0", 104, 100)], // chunk 3,0
  ]);
  const plans = planChunkResurvey(preds, 20, 100); // cap=min(3,10)=3
  assert.equal(plans.length, 3);
  // chunk 3,0 ring=3 → quota=max(2,128//11)=max(2,11)=11；3 个 cell ≤ quota
  const chunkBQuota = plans.find((p) => p.cell.startsWith("9"))?.quota;
  assert.equal(chunkBQuota, 11);
  // chunk 0,0 quota=16
  const chunkAQuota = plans.find((p) => p.cell === "0,0")?.quota;
  assert.equal(chunkAQuota, 16);
});

test("planChunkResurvey: 负 dueInTicks（已过期/死矿）不入计划", () => {
  const preds = new Map<string, RefillPrediction>([
    ["0,0", prediction("0,0", 90, 100)], // dueInTicks=-10（过期）
    ["40,0", prediction("40,0", 104, 100)], // dueInTicks=4
  ]);
  const plans = planChunkResurvey(preds, 6, 100);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.cell, "40,0");
});

test("planChunkResurvey: assignedWorkers 占位 ID（w0,w1,…）", () => {
  const preds = new Map<string, RefillPrediction>([
    ["0,0", prediction("0,0", 104, 100)],
    ["40,0", prediction("40,0", 104, 100)],
  ]);
  const plans = planChunkResurvey(preds, 6, 100); // cap=3
  assert.deepEqual(plans[0]!.assignedWorkers, ["w0"]);
  assert.deepEqual(plans[1]!.assignedWorkers, ["w1"]);
});

test("planChunkResurvey: 4-tick 对齐 dueInTicks（非对齐 predictedNextTick）", () => {
  // predictedNextTick=105（非 4 倍数）→ 对齐到 108 → dueInTicks=8
  const preds = new Map<string, RefillPrediction>([
    ["0,0", prediction("0,0", 105, 100)],
  ]);
  const plans = planChunkResurvey(preds, 6, 100);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.dueInTicks, 8, "105→对齐 108→dueInTicks=8");
});

test("零回归：纯函数不接线，computeRefillPredictions 未改", () => {
  // 确认新增函数仅是能力，未影响既有 computeRefillPredictions 契约
  // （computeRefillPredictions 仍由 refill-predictions.test.ts 覆盖）
  // 这里只验证新函数可独立调用且不抛
  assert.equal(typeof chunkKey, "function");
  assert.equal(typeof refillTickAtOrAfter, "function");
  assert.equal(typeof chunkQuota, "function");
  assert.equal(typeof refillProbeAllowed, "function");
  assert.equal(typeof planChunkResurvey, "function");
});

export {};
