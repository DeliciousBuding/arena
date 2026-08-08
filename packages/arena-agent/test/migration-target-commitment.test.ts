/**
 * W60 方向承诺迟滞测试（direction-commitment-v1，2026-08-09，竞品 "core
 * 方向承诺迟滞" 对照）：迁移目标评分中，已选方向（lastTarget）加迟滞带
 * 加分——候选落在 commitmentBand 内（方向未变）加 commitmentBonus，防
 * 每 tick REPLAN 因微小资源波动换方向（换向成本：重新探路/集结/清路）。
 *
 * 覆盖：
 * - scoreTarget：lastTarget 缺省 / band|bonus 未设 → 不加成（零回归）；
 * - scoreTarget：候选落在 band 内 → 加 bonus + directionCommitted=true；
 * - scoreTarget：候选落在 band 外 → 不加成 + directionCommitted=false；
 * - selectTarget：同分候选因承诺加成稳定（不换方向）；
 * - selectTarget：lastTarget=null → 零回归（纯资源分选优）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scoreTarget,
  selectTarget,
  type TargetSurveyInput,
} from "../src/migration/target.ts";

const TICK = 10_000;

function freshResources(positions: readonly (readonly [number, number])[]): TargetSurveyInput["resources"] {
  return positions.map(([x, y]) => ({ x, y, lastSeenTick: TICK }));
}

/** 富集足够（≥12 新鲜矿）、无敌核、有测绘覆盖的基准 survey。 */
function richSurvey(center: readonly [number, number]): TargetSurveyInput {
  const resources: (readonly [number, number])[] = [];
  for (let dx = 0; dx < 12; dx += 1) {
    for (let dy = 0; dy < 12; dy += 1) {
      resources.push([center[0] + dx, center[1] + dy]);
    }
  }
  return { resources: freshResources(resources), enemyCores: [] };
}

const COMMITMENT_CONFIG = {
  radius: 30,
  minFreshResources: 12,
  enemySafeRadius: 30,
  unknownPenalty: 0.5,
  commitmentBand: 5,
  commitmentBonus: 3,
};

test("W60 零回归：lastTarget 缺省 → 不加成（directionCommitted=false）", () => {
  const survey = richSurvey([0, 0]);
  const score = scoreTarget({ x: 0, y: 0 }, survey, COMMITMENT_CONFIG, TICK);
  assert.equal(score.directionCommitted, false, "无 lastTarget 不应命中承诺");
  assert.ok(!score.reasons.some((r) => r.includes("方向承诺")), "无 lastTarget 不应有承诺 reason");
});

test("W60 零回归：commitmentBand/Bonus 未设 → 不加成（即使有 lastTarget）", () => {
  const survey: TargetSurveyInput = { ...richSurvey([0, 0]), lastTarget: { x: 1, y: 1 } };
  const noCommitConfig = { radius: 30, minFreshResources: 12, enemySafeRadius: 30, unknownPenalty: 0.5 };
  const score = scoreTarget({ x: 0, y: 0 }, survey, noCommitConfig, TICK);
  assert.equal(score.directionCommitted, false, "无 band/bonus 不应加成");
});

test("W60：候选落在 lastTarget 的 band 内 → 加 bonus + directionCommitted=true", () => {
  // lastTarget [10,0]，候选 [12,0] → 偏差 2 ≤ band 5 → 命中
  const survey: TargetSurveyInput = {
    ...richSurvey([12, 0]),
    lastTarget: { x: 10, y: 0 },
  };
  const score = scoreTarget({ x: 12, y: 0 }, survey, COMMITMENT_CONFIG, TICK);
  assert.equal(score.directionCommitted, true, "偏差 ≤ band 应命中承诺");
  assert.ok(score.reasons.some((r) => r.includes("方向承诺命中")), `应含承诺 reason：${score.reasons.join("|")}`);
});

test("W60：候选落在 band 外 → 不加成（directionCommitted=false）", () => {
  // lastTarget [0,0]，候选 [20,0] → 偏差 20 > band 5 → 不命中
  const survey: TargetSurveyInput = {
    ...richSurvey([20, 0]),
    lastTarget: { x: 0, y: 0 },
  };
  const score = scoreTarget({ x: 20, y: 0 }, survey, COMMITMENT_CONFIG, TICK);
  assert.equal(score.directionCommitted, false, "偏差 > band 不应命中");
});

test("W60 selectTarget：承诺加成稳定方向——资源略低但同向候选胜出", () => {
  // 两个候选都在 band 外起步富集足够；候选 A 资源略多但远离 lastTarget，
  // 候选 B 资源略少但落在 lastTarget band 内 + bonus → B 胜（防换方向）。
  const surveyA: TargetSurveyInput = {
    // A [50,0]：12 矿富集
    resources: freshResources([
      [50, 0], [50, 1], [50, 2], [50, 3], [50, 4], [50, 5], [50, 6], [50, 7], [50, 8], [50, 9], [50, 10], [50, 11],
    ]),
    enemyCores: [],
    lastTarget: { x: 10, y: 0 },
  };
  const surveyB: TargetSurveyInput = {
    // B [12,0]：15 矿富集（本就更高，且落 band 内）——构造 B 既富集又同向
    resources: freshResources([
      [12, 0], [12, 1], [12, 2], [12, 3], [12, 4], [12, 5], [12, 6], [12, 7], [12, 8], [12, 9], [12, 10], [12, 11], [12, 12], [12, 13], [12, 14],
    ]),
    enemyCores: [],
    lastTarget: { x: 10, y: 0 },
  };
  const scoreA = scoreTarget({ x: 50, y: 0 }, surveyA, COMMITMENT_CONFIG, TICK);
  const scoreB = scoreTarget({ x: 12, y: 0 }, surveyB, COMMITMENT_CONFIG, TICK);
  assert.equal(scoreA.directionCommitted, false, "A 远离 lastTarget 不命中");
  assert.equal(scoreB.directionCommitted, true, "B 落 band 内命中");
  // B 总分 = 15 资源 + 3 bonus = 18 > A 12 资源 = 12
  assert.ok(scoreB.score > scoreA.score, "承诺加成应让同向候选胜出");
});

test("W60 selectTarget：lastTarget=null → 零回归纯资源分选优", () => {
  const survey: TargetSurveyInput = {
    ...richSurvey([4, 0]),
    lastTarget: null,
  };
  const selected = selectTarget(
    [{ x: 4, y: 0 }, { x: 15, y: 0 }],
    survey,
    { radius: 10, minFreshResources: 4, enemySafeRadius: 10, unknownPenalty: 0.5, commitmentBand: 5, commitmentBonus: 3 },
    TICK,
  );
  assert.notEqual(selected, null);
  assert.equal(selected!.target.x, 4, "无 lastTarget 时纯资源分选优");
  assert.equal(selected!.score.directionCommitted, false, "无 lastTarget 不应命中承诺");
});

test("W60 selectTarget：承诺加成让同向候选在资源持平时胜出", () => {
  // 两个候选资源相同（各 12 矿富集）；A 远离 lastTarget，B 落 band 内 → B +bonus 胜
  const baseResources = freshResources([
    [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 0], [11, 0],
  ]);
  const survey: TargetSurveyInput = {
    resources: baseResources,
    enemyCores: [],
    lastTarget: { x: 0, y: 0 },
  };
  // 候选 [0,0] 落 band 内（偏差 0），候选 [15,0] 落 band 外（偏差 15）
  // 两候选都覆盖同样 12 矿（半径 30）→ 资源分相同 → 承诺加成决定
  const selected = selectTarget(
    [{ x: 15, y: 0 }, { x: 0, y: 0 }],
    survey,
    { radius: 30, minFreshResources: 4, enemySafeRadius: 30, unknownPenalty: 0.5, commitmentBand: 5, commitmentBonus: 3 },
    TICK,
  );
  assert.notEqual(selected, null);
  assert.equal(selected!.target.x, 0, "同向候选（落 band 内）应因承诺加成胜出");
  assert.equal(selected!.score.directionCommitted, true);
});
