/**
 * 矿刷新预测命中率测试（2026-08-08）：computePredictionAccuracy——
 * 已过预测时间的预测重见率 + 未到判定窗口跳过 + 空兜底。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { computePredictionAccuracy, computeRefillPredictions, computeAbsentStats, computeDeadMines } from "../lib/mine-patterns.ts";
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

test("mine-patterns: refill 算法契约与 arena-agent 一致（防止双实现漂移）", async () => {
  // 2026-08-08：arena-agent/src/intel/refill-predictions.ts 曾用 lastStart+avgGap，
  // 与 mine-patterns 的 lastEnd+avgAbsent 分叉（实测 95% 格差异、最大 72 tick）。
  // 契约测试：对同一 rows，两边 predictedNextTick 必须逐格一致。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { computeRefillPredictions: agentCompute } = await import("../../arena-agent/src/intel/refill-predictions.ts");
  const rows = [
    { cell: "1,1", tick: 100 }, { cell: "1,1", tick: 104 },
    { cell: "1,1", tick: 200 }, { cell: "1,1", tick: 204 },
    { cell: "1,1", tick: 300 }, { cell: "1,1", tick: 301 },
    { cell: "2,2", tick: 50 }, { cell: "2,2", tick: 160 },
    { cell: "3,3", tick: 10 }, { cell: "3,3", tick: 12 }, { cell: "3,3", tick: 90 }, { cell: "3,3", tick: 95 },
  ];
  const resources = [
    { cell: "1,1", x: 1, y: 1 }, { cell: "2,2", x: 2, y: 2 }, { cell: "3,3", x: 3, y: 3 },
  ];
  const cc = computeRefillPredictions(rows, resources, 400);
  const agent = agentCompute(rows, 400);
  assert.equal(cc.length, agent.size, "两边预测格数一致");
  for (const p of cc) {
    const ap = agent.get(p.cell);
    assert.ok(ap, `agent 应含 ${p.cell}`);
    assert.equal(ap.predictedNextTick, p.predictedNextTick, `${p.cell} predictedNextTick 契约一致`);
    assert.equal(ap.dueInTicks, p.dueInTicks, `${p.cell} dueInTicks 契约一致`);
  }
});

test("mine-patterns: A16 缺席段长度分布——严格连续段（GAP=1）median/p90", () => {
  // 缺席记录：(1,1) tick 100-103（4 tick 连续段）+ 110（孤立）；(2,2) tick 200-209（10 tick）
  const abs = [
    { cell: "1,1", tick: 100 }, { cell: "1,1", tick: 101 }, { cell: "1,1", tick: 102 }, { cell: "1,1", tick: 103 },
    { cell: "1,1", tick: 110 },
    { cell: "2,2", tick: 200 }, { cell: "2,2", tick: 201 }, { cell: "2,2", tick: 202 }, { cell: "2,2", tick: 203 },
    { cell: "2,2", tick: 204 }, { cell: "2,2", tick: 205 }, { cell: "2,2", tick: 206 }, { cell: "2,2", tick: 207 },
    { cell: "2,2", tick: 208 }, { cell: "2,2", tick: 209 },
  ];
  const st = computeAbsentStats(abs)!;
  assert.equal(st.segCount, 3, "3 段：1,1 连续段 + 1,1 孤立 + 2,2 连续段");
  // 段长 = last-first：1,1 连续段 100-103=3；1,1 孤立 110=0；2,2 连续段 200-209=9
  const lens = [0, 3, 9].sort((a, b) => a - b); // [0,3,9]
  assert.equal(st.medianLen, 3, "median=3");
  assert.equal(st.p90Len, 9, "p90=9（≥90% 分位）");
  assert.equal(st.p99Len, 9, "p99=9");
});

test("mine-patterns: A16 疑似死矿——长连续缺席段（≥200 tick）格标记，短段不标", () => {
  const abs = [
    // (1,1) 长段 300 tick（100-399 连续）
    ...Array.from({ length: 300 }, (_, i) => ({ cell: "1,1", tick: 100 + i })),
    // (2,2) 短段 5 tick（500-504）+ 孤立
    { cell: "2,2", tick: 500 }, { cell: "2,2", tick: 501 }, { cell: "2,2", tick: 502 },
    { cell: "2,2", tick: 503 }, { cell: "2,2", tick: 504 }, { cell: "2,2", tick: 510 },
  ];
  const resources = [
    { cell: "1,1", x: 1, y: 1 }, { cell: "2,2", x: 2, y: 2 },
  ];
  const dead = computeDeadMines(abs, resources);
  assert.equal(dead.length, 1, "只有 1,1 长缺席段被判死矿");
  assert.equal(dead[0].cell, "1,1");
  assert.equal(dead[0].maxAbsentLen, 299);
  assert.equal(dead[0].lastAbsentTick, 399);
  assert.equal(dead[0].x, 1);
});
