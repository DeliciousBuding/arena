/**
 * 快攻威胁评估（2026-08-07，raid-risk-v1）：
 * 用户裁决"这不对吧！实际上别人可以只派一些人来打啊"——威胁不能只看排行榜
 * 伤害（猛攻蛆画像）。任何玩家（含 STANDARD 低伤害）都可能派小股部队来偷家/
 * 骚扰，所以威胁等级必须以**实测接近**为主：
 *   - 敌核心距我方核心的距离（能多久打到我）
 *   - 我方视野/侦察中实测到的敌军战斗单位（Vanguard/Ranger）接近数量
 * 排行榜 tier 只作为**先验加成**（高伤害玩家更可能主动进攻），不作为是否防御
 * 的门槛。本模块纯函数、无副作用，供指挥面板 /api/intel 与 safety-planner
 * raid-defense-v1 共用同一事实。
 */

import type { ThreatTier } from "../strategies/safety-planner-config.ts";

/** 快攻风险等级（确定性级联，保守优先）。 */
export type RaidRiskTier = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface RaidRiskInput {
  /** 敌核心距最近我方核心的 Chebyshev 距离（格）。 */
  readonly enemyCoreDistance: number;
  /** 我方核心附近实测到的敌军战斗单位数（Vanguard/Ranger，非 Worker）。 */
  readonly combatUnitsNear: number;
  /** 排行榜威胁画像（先验加成；STANDARD = 无加成）。 */
  readonly tier: ThreatTier;
  /** 最近目击是否新鲜（决定"低威胁"是否成立；陈旧目击降级）。 */
  readonly freshSighting: boolean;
}

export interface RaidRisk {
  readonly tier: RaidRiskTier;
  /** 用户可读的判定原因（面板展示用）。 */
  readonly reason: string;
}

/** 实测敌军战斗单位距我方核心的"快攻警戒半径"（Manhattan，与 threat-recall
 *  12 格同口径放宽到 18）：范围内有战斗单位 = 小股进攻已接近家门口。 */
export const RAID_UNIT_WATCH_RADIUS = 18;
/** 敌核心距我方核心的"守家半径"（Chebyshev）：范围内存在敌核心 = 站立威胁，
 *  即使对方从不进攻也可能随时派人来——保持守家兵力。 */
export const RAID_CORE_RADIUS = 24;
/** 小股成建制（≥3 战斗单位在我方警戒圈内）= 已到门口，最高危。 */
export const RAID_PARTY_SIZE = 3;
/** 目击新鲜度窗口（tick）：超过该窗口的目击视为陈旧，降级。 */
export const RAID_SIGHTING_FRESH_TICKS = 12;

/** 快攻风险级联（确定性，保守优先）：
 *  - CRITICAL：≥3 战斗单位已入警戒圈（小股成建制已到门口）或敌核心 ≤8 格（贴脸）；
 *  - HIGH：≥1 战斗单位已入警戒圈（侦察兵/先头部队已到）或敌核心 ≤18 格（一个
 *    冲刺距离内，随时可发难）；
 *  - MEDIUM：敌核心 ≤32 格（中程可及，小股部队 ~1-2 个冲刺可到）或高伤害对手
 *    ≤48 格（猛攻蛆在中程，主动进攻概率高）；
 *  - LOW：敌核心 ≤64 格（长程存在）或高伤害对手 ≤96 格（猛攻蛆远位存在）；
 *  - NONE：其他（地图另一端，不构成当前威胁）。
 * 陈旧目击整体降一级（记忆已老化，威胁不确定）。 */
export function assessRaidRisk(input: RaidRiskInput): RaidRisk {
  const { enemyCoreDistance, combatUnitsNear, tier, freshSighting } = input;
  let tierRisk: RaidRiskTier;
  let reason: string;
  if (combatUnitsNear >= RAID_PARTY_SIZE) {
    tierRisk = "CRITICAL";
    reason = `raid_party: ${combatUnitsNear} enemy combat units within ${RAID_UNIT_WATCH_RADIUS} of our core`;
  } else if (combatUnitsNear >= 1) {
    tierRisk = "HIGH";
    reason = `raid_scout: ${combatUnitsNear} enemy combat unit(s) within ${RAID_UNIT_WATCH_RADIUS} of our core`;
  } else if (enemyCoreDistance <= 8) {
    tierRisk = "CRITICAL";
    reason = `core_adjacent: enemy core ${enemyCoreDistance} cells away`;
  } else if (enemyCoreDistance <= RAID_CORE_RADIUS) {
    tierRisk = "HIGH";
    reason = `core_close: enemy core ${enemyCoreDistance} cells away (within ${RAID_CORE_RADIUS})`;
  } else if (enemyCoreDistance <= 32) {
    tierRisk = "MEDIUM";
    reason = `core_medium: enemy core ${enemyCoreDistance} cells away`;
  } else if (tier !== "STANDARD" && enemyCoreDistance <= 48) {
    tierRisk = "MEDIUM";
    reason = `aggressor_medium: ${tier} core ${enemyCoreDistance} cells away`;
  } else if (enemyCoreDistance <= 64) {
    tierRisk = "LOW";
    reason = `core_far: enemy core ${enemyCoreDistance} cells away`;
  } else if (tier !== "STANDARD" && enemyCoreDistance <= 96) {
    tierRisk = "LOW";
    reason = `aggressor_far: ${tier} core ${enemyCoreDistance} cells away`;
  } else {
    return { tier: "NONE", reason: "out_of_range" };
  }
  // 陈旧目击降一级（记忆老化，威胁不确定——但不可直接降到 NONE，防止
  // "看一眼就忘、敌人在门口也当没事"）。
  if (!freshSighting && tierRisk !== "LOW") {
    const downgraded: RaidRiskTier =
      tierRisk === "CRITICAL" ? "HIGH" : tierRisk === "HIGH" ? "MEDIUM" : "LOW";
    return { tier: downgraded, reason: `${reason} (stale sighting)` };
  }
  return { tier: tierRisk, reason };
}
