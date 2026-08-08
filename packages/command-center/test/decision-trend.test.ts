/**
 * 决策-结果趋势测试（2026-08-08）：尾部切 N 窗口聚合。
 * - 窗口切片顺序（index 0=最早 → steps-1=最新）；
 * - 逐窗口 stallRate/planChurn/cargoEff/coreDelta/人类覆盖；
 * - 窗口边界容错（尾部不足时最早窗口为空）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateDecisionTrend } from "../lib/decision-audit.ts";

test("decision-trend: N 窗口切片 + 逐窗口指标", () => {
  // 6 行 decision：tick 100..105，每行 1 个 wait → stall；planHash 各不同
  const d: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    d.push(JSON.stringify({ tick: 100 + i, decisionSource: "deterministic", moveCount: 1, harvestCount: 0, depositCount: 0, waitCount: 1, intentCounts: { WAIT: 1 }, planHash: `h${i}` }));
  }
  // 6 行 outcome：coreDelta 交替 +1/-1，cargo 0.5
  const o: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    o.push(JSON.stringify({ tick: 100 + i, coreResourceDelta: i % 2 === 0 ? 1 : -1, workerCount: 2, workersWithCargo: 1, workerMeanDistanceFromCore: 3, events: ["DEPOSIT_SUCCEEDED"], humanOverride: { applied: i === 5 ? ["u"] : [], rejected: [] } }));
  }
  const tr = aggregateDecisionTrend("t1", 2, 3, d, o);
  assert.equal(tr.steps, 3);
  assert.equal(tr.trend.length, 3);
  // 窗口 0（最早：tick100-101）：stall 2/2=1，coreDelta 1+(-1)=0
  assert.equal(tr.trend[0]?.index, 0);
  assert.equal(tr.trend[0]?.stallRate, 1);
  assert.equal(tr.trend[0]?.coreDelta, 0);
  assert.equal(tr.trend[0]?.cargoEff, 0.5);
  // 窗口 2（最新：tick104-105）：humanApplied=1
  assert.equal(tr.trend[2]?.index, 2);
  assert.equal(tr.trend[2]?.humanApplied, 1);
  assert.equal(tr.trend[2]?.planChurn, 1, "两行不同 planHash → churn 1");
  assert.equal(tr.trend[2]?.tick, 105);
});

test("decision-trend: 空输入兜底", () => {
  const tr = aggregateDecisionTrend("t2", 2, 3, [], []);
  assert.equal(tr.trend.length, 3);
  assert.equal(tr.trend[0]?.stallRate, null);
  assert.equal(tr.trend[0]?.coreDelta, 0);
  assert.equal(tr.trend[2]?.humanApplied, 0);
});
