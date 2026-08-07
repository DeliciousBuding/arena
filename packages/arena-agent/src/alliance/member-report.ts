/**
 * AllianceMemberReport / EntitySighting / AllianceSnapshot 纯函数助手。
 *
 * 所有函数严格 deterministic、无 I/O、无副作用。
 * 最后更新：2026-08-08
 */

import type { AllianceSnapshot, EntitySighting } from "./types.ts";
import type { AllianceMemberReport } from "./control-types.ts";

/** 默认成员报告 stale 阈值（tick）。 */
export const DEFAULT_REPORT_STALE_TICKS = 8;

/** 默认 sighting 新鲜度窗口（tick）。 */
export const DEFAULT_SIGHTING_FRESH_TICKS = 8;

/** 置信度衰减默认 tau（tick）。 */
export const DEFAULT_CONFIDENCE_TAU = 8;

/** 置信度下界——即使完全过期也不低于此值。 */
export const REPORT_CONFIDENCE_FLOOR = 0.05;

/**
 * 判断成员报告是否 stale：tick 落后当前 tick 超过阈值。
 * stale 报告不应被用于高风险 mission 分配，但其他 tenant 仍继续运行。
 */
export function isMemberReportStale(
  report: AllianceMemberReport,
  currentTick: number,
  maxStaleTicks: number = DEFAULT_REPORT_STALE_TICKS,
): boolean {
  return currentTick - report.tick > maxStaleTicks;
}

/**
 * 计算目击的新鲜度（age in ticks）。
 * 0 = 当前 tick 目击。
 */
export function sightingAge(sighting: EntitySighting, currentTick: number): number {
  return Math.max(0, currentTick - sighting.lastSeenTick);
}

/**
 * 判断目击是否仍新鲜（lastSeenTick 在 maxAge 窗口内）。
 */
export function isSightingFresh(
  sighting: EntitySighting,
  currentTick: number,
  maxAge: number = DEFAULT_SIGHTING_FRESH_TICKS,
): boolean {
  return sightingAge(sighting, currentTick) <= maxAge;
}

/**
 * 统一置信度衰减函数（§5.3）：
 *   confidence(age) = max(floor, exp(-age / tau))
 *
 * 参数：
 * - sighting: 目击记录
 * - currentTick: 当前 tick
 * - tau: 衰减时间常数（tick），默认 DEFAULT_CONFIDENCE_TAU
 * - floor: 置信度下界，默认 CONFIDENCE_FLOOR
 *
 * 初始实验量级：
 * - active enemy Unit：tau ≈ 4-8 ticks
 * - enemy Core：tau ≈ 64-128 ticks
 */
export function computeConfidence(
  sighting: EntitySighting,
  currentTick: number,
  tau: number = DEFAULT_CONFIDENCE_TAU,
  floor: number = REPORT_CONFIDENCE_FLOOR,
): number {
  const age = sightingAge(sighting, currentTick);
  const confidence = Math.exp(-age / tau);
  return Math.max(floor, confidence);
}

/**
 * 从 snapshot 中筛选仍新鲜的目击（可选过滤 kind）。
 */
export function freshSightings(
  snapshot: AllianceSnapshot,
  currentTick: number,
  maxAge: number = DEFAULT_SIGHTING_FRESH_TICKS,
  kind?: EntitySighting["kind"],
): readonly EntitySighting[] {
  return snapshot.sightings.filter((s) => {
    if (kind !== undefined && s.kind !== kind) return false;
    return isSightingFresh(s, currentTick, maxAge);
  });
}

/**
 * 按 ownerUsername 对目击分组（用于同一 enemy Core/Unit 的去重与合并）。
 */
export function groupSightingsByOwner(
  sightings: readonly EntitySighting[],
): ReadonlyMap<string, readonly EntitySighting[]> {
  const groups = new Map<string, EntitySighting[]>();
  for (const s of sightings) {
    const owner = s.ownerUsername ?? "_unknown_";
    let list = groups.get(owner);
    if (list === undefined) {
      list = [];
      groups.set(owner, list);
    }
    list.push(s);
  }
  return groups;
}

/**
 * 验证 AllianceSnapshot 的基本结构完整性。
 * 返回问题列表（空 = 有效）。
 */
export function validateSnapshot(snapshot: AllianceSnapshot): readonly string[] {
  const issues: string[] = [];
  if (snapshot.revision < 0) issues.push("revision must be >= 0");
  if (snapshot.tickWindow[0] > snapshot.tickWindow[1]) {
    issues.push("tickWindow start must be <= end");
  }
  if (!snapshot.members.has(snapshot.treasuryTenant)) {
    issues.push("treasuryTenant must be a member");
  }
  return issues;
}

