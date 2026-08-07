/** 快攻威胁评估测试（2026-08-07，raid-risk-v1）：
 * 用户裁决"别人可以只派一些人来打"——威胁不能只看排行榜伤害：
 *  - 实测敌军战斗单位接近（≥1 入 18 格警戒圈）= HIGH；≥3 成建制 = CRITICAL；
 *  - 敌核心 ≤24 格 = HIGH（随时可派人来打，即使 STANDARD 低伤害）；
 *  - 排行榜 tier 只做先验加成（中程/远程高伤害对手升级），不作为防御门槛；
 *  - 陈旧目击降级（记忆老化威胁不确定，但不掉到 NONE——防"看一眼就忘"）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessRaidRisk,
  RAID_CORE_RADIUS,
  RAID_PARTY_SIZE,
  RAID_UNIT_WATCH_RADIUS,
  type RaidRiskInput,
} from "../src/domain/raid-risk.ts";

function risk(over: Partial<RaidRiskInput>): ReturnType<typeof assessRaidRisk> {
  return assessRaidRisk({
    enemyCoreDistance: 100,
    combatUnitsNear: 0,
    tier: "STANDARD",
    freshSighting: true,
    ...over,
  });
}

test("快攻威胁：≥1 战斗单位入 18 格警戒圈 = HIGH（不依赖排行榜伤害）", () => {
  const r = risk({ combatUnitsNear: 1, tier: "STANDARD" });
  assert.equal(r.tier, "HIGH");
  assert.match(r.reason, /raid_scout/);
});

test("快攻威胁：≥3 战斗单位入警戒圈 = CRITICAL（小股成建制已到门口）", () => {
  const r = risk({ combatUnitsNear: RAID_PARTY_SIZE, tier: "STANDARD" });
  assert.equal(r.tier, "CRITICAL");
});

test("快攻威胁：敌核心 ≤24 格 = HIGH（STANDARD 低伤害也成立——用户核心关切）", () => {
  const r = risk({ enemyCoreDistance: RAID_CORE_RADIUS, tier: "STANDARD" });
  assert.equal(r.tier, "HIGH");
  assert.match(r.reason, /core_close/);
});

test("快攻威胁：敌核心 ≤8 格 = CRITICAL（贴脸）", () => {
  const r = risk({ enemyCoreDistance: 8, tier: "STANDARD" });
  assert.equal(r.tier, "CRITICAL");
  assert.match(r.reason, /core_adjacent/);
});

test("快攻威胁：敌核心 32 格内 = MEDIUM（中程可及）", () => {
  const r = risk({ enemyCoreDistance: 30, tier: "STANDARD" });
  assert.equal(r.tier, "MEDIUM");
});

test("快攻威胁：高伤害对手中程升级（STANDARD 同距离是 LOW）", () => {
  const far = risk({ enemyCoreDistance: 40, tier: "STANDARD" });
  assert.equal(far.tier, "LOW");
  const elite = risk({ enemyCoreDistance: 40, tier: "ELITE_AGGRESSOR" });
  assert.equal(elite.tier, "MEDIUM");
  assert.match(elite.reason, /aggressor_medium/);
});

test("快攻威胁：远距离高伤害对手 = LOW（先验存在但不可及）", () => {
  const r = risk({ enemyCoreDistance: 80, tier: "AGGRESSOR" });
  assert.equal(r.tier, "LOW");
});

test("快攻威胁：超远 = NONE", () => {
  const r = risk({ enemyCoreDistance: 120, tier: "ELITE_AGGRESSOR" });
  assert.equal(r.tier, "NONE");
});

test("快攻威胁：陈旧目击降级（HIGH→MEDIUM，但不掉 NONE）", () => {
  const r = risk({ enemyCoreDistance: RAID_CORE_RADIUS, tier: "STANDARD", freshSighting: false });
  assert.equal(r.tier, "MEDIUM");
  assert.match(r.reason, /stale/);
});

test("快攻威胁：警戒圈常数与 planner 同源", () => {
  assert.equal(RAID_UNIT_WATCH_RADIUS, 18);
  assert.equal(RAID_CORE_RADIUS, 24);
});
