/**
 * 兵力统计语义（2026-08-08，spec §1.1/§5.4 落地）。
 *
 * 修正"83 敌单位"式重复放大假象：展示层必须区分四种口径——
 * - currentVisibleCombat：本 tick 视野内实际可见的战斗单位数（LIVE）；
 * - recentUniqueCombat：近期窗口内 unique 实体数（按 mergeKey 去重）；
 * - historicalSightingCount：历史目击**条数**（含重复，仅供审计/回放对比，
 *   不做兵力展示——这就是旧 intel.ts `enemyUnits += 1` 的错误用法）；
 * - estimatedForce：unique × confidence 加权（跨窗口平滑，非整数，反映
 *   "现在大概有多少敌人"的不确定估计）。
 */

import { type EntitySighting, type AllianceForceCounts, isCombatUnit } from "./types.ts";
import { currentConfidence } from "./sightings.ts";

/** 近期唯一兵力窗口（tick）：窗口内目击过的唯一战斗单位算"近期活动兵力"。 */
export const RECENT_UNIQUE_WINDOW = 300;

/** 当前可见判定：lastSeenTick === nowTick（本 tick 视野内出现）。 */
export function isCurrentlyVisible(sighting: EntitySighting, nowTick: number): boolean {
  return sighting.currentlyVisible || sighting.lastSeenTick === nowTick;
}

function isCombatSighting(s: EntitySighting): boolean {
  return s.kind === "UNIT" && isCombatUnit(s.unitType);
}

/** 当前可见敌战斗单位数（UNIT 且 VANGUARD/RANGER，本 tick 可见）。 */
export function currentVisibleCombat(sightings: readonly EntitySighting[], nowTick: number): number {
  return sightings.filter((s) => isCombatSighting(s) && isCurrentlyVisible(s, nowTick)).length;
}

/** 近期唯一敌战斗单位数：窗口内目击过的 unique mergeKey 数。 */
export function recentUniqueCombat(sightings: readonly EntitySighting[], nowTick: number, window = RECENT_UNIQUE_WINDOW): number {
  const keys = new Set<string>();
  for (const s of sightings) {
    if (!isCombatSighting(s)) continue;
    if (nowTick - s.lastSeenTick <= window) keys.add(s.key);
  }
  return keys.size;
}

/** 历史目击条数（含重复 key——仅审计用）。 */
export function historicalSightingCount(sightings: readonly EntitySighting[]): number {
  return sightings.filter(isCombatSighting).length;
}

/**
 * 估计兵力 = unique 战斗实体按当前 confidence 加权求和。
 * 同一实体多次目击只计一次（按 key 去重），置信度随时间衰减——
 * 这是对"重复累加"的系统性修正：10 条同一单位的目击记录 → 1 个实体 × confidence。
 */
export function estimatedForce(sightings: readonly EntitySighting[], nowTick: number): number {
  const byKey = new Map<string, EntitySighting>();
  for (const s of sightings) {
    if (!isCombatSighting(s)) continue;
    const prev = byKey.get(s.key);
    if (prev === undefined || s.lastSeenTick > prev.lastSeenTick) byKey.set(s.key, s);
  }
  let sum = 0;
  for (const s of byKey.values()) sum += currentConfidence(s, nowTick);
  return sum;
}

/** 汇总四种口径（counts.ts 语义的单一入口）。
 *  historicalSightingCount 语义是原始观测**条数**（含重复，审计用）——调用方若
 *  持有去重前的原始观测（如 snapshot 构建），应通过 opts.historicalSightingCount
 *  传入真实条数；缺省回退为去重后条数（保守下限）。 */
export function computeForceCounts(
  sightings: readonly EntitySighting[],
  nowTick: number,
  opts: { readonly historicalSightingCount?: number } = {},
): AllianceForceCounts {
  return {
    currentVisibleCombat: currentVisibleCombat(sightings, nowTick),
    recentUniqueCombat: recentUniqueCombat(sightings, nowTick),
    historicalSightingCount: opts.historicalSightingCount ?? historicalSightingCount(sightings),
    estimatedForce: estimatedForce(sightings, nowTick),
  };
}
