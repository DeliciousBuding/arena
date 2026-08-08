/** worker-mission-v1 Phase 2 矿刷新预测测试（G3 数据管道：窗口切分/周期/dueInTicks/死矿剔除）。 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeRefillPredictions, REFILL_GAP_TICKS } from "../src/intel/refill-predictions.ts";
import {
  DEFAULT_MISSION_CONFIG,
  isCollectable,
  refillBonusOf,
  type MissionConfig,
} from "../src/planning/mission-planner.ts";

const MISSION: MissionConfig = {
  collectionValueFloor: -30,
  maxCollectionDistance: 24,
  surveyWorkerCap: 3,
  surveyBurstTicks: 100,
  surveyWorkerFloor: 3,
  visibleBonus: 0.3,
  seedAgeDecay: 0.02,
  refillLookahead: 16,
  refillBonus: 0.5,
  deadMineOverdueTicks: 100,
  migrationScout: false,
  alwaysSurvey: false,
  switchThreshold: 0,
  surveyOnSupplyGap: false,
};

function worker(id: string, x: number, y: number) {
  return { id, position: [x, y] as const, hp: 5, unitType: "WORKER" as const, cargo: 0 };
}

test("refill: 窗口切分（抖动容忍）+ 周期估计 + dueInTicks", () => {
  // 格 A：三个出现窗口 [100..102], [340..345], [580..581] → 周期 240
  const predictions = computeRefillPredictions(
    [
      { cell: "10,10", tick: 100 },
      { cell: "10,10", tick: 101 },
      { cell: "10,10", tick: 102 },
      { cell: "10,10", tick: 340 },
      { cell: "10,10", tick: 341 },
      { cell: "10,10", tick: 345 },
      { cell: "10,10", tick: 580 },
      { cell: "10,10", tick: 581 },
    ],
    600,
  );
  const a = predictions.get("10,10");
  assert.ok(a !== undefined, "格 A 应有预测");
  assert.equal(a!.windows, 3);
  assert.equal(a!.avgGapTicks, 240);
  assert.equal(a!.lastWindowStartTick, 580);
  // 2026-08-08 契约对齐：predictedNextTick = lastEnd(581) + avgAbsent(237) = 818
  // （与 command-center mine-patterns 一致；旧公式 lastStart+avgGap = 820 已弃）
  assert.equal(a!.predictedNextTick, 818);
  assert.equal(a!.dueInTicks, 218); // 818 − 600
});

test("refill: 单窗口不可预测 + 无历史 = 空", () => {
  const single = computeRefillPredictions([{ cell: "1,1", tick: 100 }], 200);
  assert.equal(single.size, 0);
  const empty = computeRefillPredictions([], 200);
  assert.equal(empty.size, 0);
});

test("refill: REFILL_GAP_TICKS 内合并为同一窗口", () => {
  const predictions = computeRefillPredictions(
    [
      { cell: "5,5", tick: 100 },
      { cell: "5,5", tick: 100 + REFILL_GAP_TICKS }, // 同一窗口
      { cell: "5,5", tick: 100 + REFILL_GAP_TICKS * 3 }, // 新窗口（间隔 > gap）
    ],
    200,
  );
  const p = predictions.get("5,5");
  assert.equal(p!.windows, 2);
});

test("refill: 死矿剔除——dueInTicks 严重负值不入采集池", () => {
  const w = worker("w1", 0, 0);
  const deadMap = new Map([["10,0", -500]]); // 已过预期 500 tick（永久采空疑似）
  assert.equal(isCollectable(5, w, [10, 0], MISSION, deadMap), false);
  const freshMap = new Map([["10,0", 12]]); // 即将刷新
  assert.equal(isCollectable(5, w, [10, 0], MISSION, freshMap), true);
  // 无预测 = 放行（零回归）
  assert.equal(isCollectable(5, w, [10, 0], MISSION, undefined), true);
});

test("refill: 即将刷新格加成——dueInTicks ≤ lookahead → +bonus；死矿不加成", () => {
  assert.equal(refillBonusOf("10,0", new Map([["10,0", 12]]), MISSION), 0.5);
  assert.equal(refillBonusOf("10,0", new Map([["10,0", 30]]), MISSION), 0); // 超出 lookahead
  assert.equal(refillBonusOf("10,0", new Map([["10,0", -500]]), MISSION), 0); // 死矿
  assert.equal(refillBonusOf("10,0", undefined, MISSION), 0); // 无预测
  assert.equal(refillBonusOf("10,0", new Map(), DEFAULT_MISSION_CONFIG), 0); // 缺省关闭
});

export {};

test("refill: avgAbsent 语义——窗口时长影响预测（与 mine-patterns 一致）", () => {
  // 窗口 [100..104] 时长 4、[200..204] 时长 4：gap=100、absent=96 → predictedNext = 204+96 = 300
  const p1 = computeRefillPredictions(
    [
      { cell: "1,1", tick: 100 }, { cell: "1,1", tick: 104 },
      { cell: "1,1", tick: 200 }, { cell: "1,1", tick: 204 },
    ],
    300,
  );
  assert.equal(p1.get("1,1")?.predictedNextTick, 300);
  assert.equal(p1.get("1,1")?.avgGapTicks, 100);
  assert.equal(p1.get("1,1")?.dueInTicks, 0, "300-300");
  // 单 tick 窗口（时长 0）：absent = gap → lastStart+avgGap 与 lastEnd+avgAbsent 相等
  const p2 = computeRefillPredictions(
    [
      { cell: "2,2", tick: 100 },
      { cell: "2,2", tick: 300 },
    ],
    400,
  );
  assert.equal(p2.get("2,2")?.predictedNextTick, 500, "lastEnd(300)+avgAbsent(200)");
});
