/**
 * 长征目标评分测试（migration-long-march-v1 §6 验收，M7，2026-08-09）。
 *
 * 覆盖：
 * - scoreTarget：资源分（半径内新鲜矿计数）；
 * - scoreTarget：活跃敌核硬扣分（不可选门槛）；
 * - scoreTarget：测绘盲区惩罚（knownResources 过少）；
 * - selectTarget：多候选择优 + 硬门槛过滤（活跃敌核/富集下限）；
 * - selectTarget：无候选通过 → null（ABORT 语义）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scoreTarget,
  selectTarget,
  DEFAULT_TARGET_SCORE_CONFIG,
  type TargetSurveyInput,
} from "../src/migration/target.ts";

const TICK = 10_000;
const CONFIG = DEFAULT_TARGET_SCORE_CONFIG;

function freshResources(positions: readonly (readonly [number, number])[]): TargetSurveyInput["resources"] {
  return positions.map(([x, y]) => ({ x, y, lastSeenTick: TICK }));
}

function staleResources(positions: readonly (readonly [number, number])[]): TargetSurveyInput["resources"] {
  return positions.map(([x, y]) => ({ x, y, lastSeenTick: TICK - 100 }));
}

test("scoreTarget：半径内新鲜矿计数 = 资源分；半径外不计", () => {
  const survey: TargetSurveyInput = {
    resources: freshResources([
      [0, 0], [5, 5], [10, 10], [-8, 9], // 半径 30 内 4 个
      [60, 0], [0, -60], // 半径外
    ]),
    enemyCores: [],
  };
  const score = scoreTarget({ x: 0, y: 0 }, survey, CONFIG, TICK);
  assert.equal(score.freshResources, 4, "半径内新鲜矿应计 4");
  assert.equal(score.activeEnemyCores, 0);
});

test("scoreTarget：活跃敌核在安全半径内 → 硬扣分（score 大幅下降）", () => {
  const survey: TargetSurveyInput = {
    resources: freshResources([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8], [9, 9], [10, 10], [11, 11], [12, 12]]),
    enemyCores: [{ x: 10, y: 0, lastSeenTick: TICK }], // 半径 30 内活跃敌核
  };
  const score = scoreTarget({ x: 0, y: 0 }, survey, CONFIG, TICK);
  assert.equal(score.activeEnemyCores, 1);
  assert.equal(score.score, 13 - 5, "活跃敌核应扣 5 分");
});

test("scoreTarget：陈旧敌核不算活跃（新鲜窗口 8 tick）", () => {
  const survey: TargetSurveyInput = {
    resources: freshResources([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8], [9, 9], [10, 10], [11, 11], [12, 12]]),
    enemyCores: [{ x: 10, y: 0, lastSeenTick: TICK - 100 }], // 陈旧
  };
  const score = scoreTarget({ x: 0, y: 0 }, survey, CONFIG, TICK);
  assert.equal(score.activeEnemyCores, 0, "陈旧敌核不判活跃");
});

test("scoreTarget：测绘盲区惩罚（knownResources 过少）", () => {
  const survey: TargetSurveyInput = {
    resources: [], // 无测绘
    enemyCores: [],
  };
  const score = scoreTarget({ x: 0, y: 0 }, survey, CONFIG, TICK);
  assert.equal(score.knownResources, 0);
  assert.ok(score.score < 0, "盲区惩罚后总分为负（目标不可选）");
  assert.ok(score.reasons.some((r) => r.includes("测绘覆盖不足")), `reasons 应含盲区原因：${score.reasons.join("|")}`);
});

test("selectTarget：多候选择优（资源多者胜）", () => {
  const survey: TargetSurveyInput = {
    // 半径 10 小窗区分：候选 {x:4} 覆盖 [0..9] 全 10 矿；候选 {x:15} 仅覆盖 [5..9] 5 矿
    resources: freshResources([
      [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0],
    ]),
    enemyCores: [],
  };
  const selected = selectTarget(
    [{ x: 4, y: 0 }, { x: 15, y: 0 }],
    survey,
    { radius: 10, minFreshResources: 4, enemySafeRadius: 10, unknownPenalty: 0.5 },
    TICK,
  );
  assert.notEqual(selected, null);
  assert.equal(selected!.target.x, 4, "富集更高的候选应胜出");
  assert.equal(selected!.score.freshResources, 10, "胜出候选新鲜矿应 10");
});

test("selectTarget：活跃敌核候选被硬门槛过滤", () => {
  const survey: TargetSurveyInput = {
    resources: freshResources([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8], [9, 9], [10, 10], [11, 11], [12, 12]]),
    enemyCores: [{ x: 5, y: 0, lastSeenTick: TICK }],
  };
  const selected = selectTarget([{ x: 0, y: 0 }], survey, CONFIG, TICK);
  assert.equal(selected, null, "活跃敌核候选必须被过滤（null = 无可用目标）");
});

test("selectTarget：富集下限过滤（新鲜矿 < 12 拒绝）", () => {
  const survey: TargetSurveyInput = {
    resources: freshResources([[0, 0], [1, 1], [2, 2], [3, 3]]), // 仅 4 个新鲜矿
    enemyCores: [],
  };
  const selected = selectTarget([{ x: 0, y: 0 }], survey, CONFIG, TICK);
  assert.equal(selected, null, "新鲜矿 < 下限必须拒绝");
});

test("selectTarget：陈旧资源不计入新鲜（富集下限用新鲜窗口）", () => {
  const survey: TargetSurveyInput = {
    resources: staleResources([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8], [9, 9], [10, 10], [11, 11], [12, 12]]),
    enemyCores: [],
  };
  const score = scoreTarget({ x: 0, y: 0 }, survey, CONFIG, TICK);
  assert.equal(score.freshResources, 0, "陈旧目击不算新鲜矿");
});
