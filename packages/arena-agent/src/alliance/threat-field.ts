/**
 * 威胁场投影（2026-08-08，spec §6.1 落地）。
 *
 * ThreatCell 四分量：
 * - directCombat：当前可见战斗单位贡献（VANGUARD/RANGER，权重 1/可见，距离衰减）；
 * - projectedCombat：近期唯一战斗目击 × confidence 衰减后的投影（非可见但记忆仍在）；
 * - coreRaid：附近敌方 Core 的先验威胁（按距离衰减 + confidence）；
 * - uncertainty：0..1，该格威胁源中最弱（最陈旧）的一个的不确定度，取 max。
 *
 * 来源优先级（spec §6.1）：observed local threat > geometric proximity >
 * stale history > leaderboard prior。leaderboard 不生成地图实体，只做
 * 先验加成（adjustWithLeaderboardPrior）。
 */

import { type EntitySighting, type Position, type ThreatCell, type ThreatField, isCombatUnit } from "./types.ts";
import { currentConfidence } from "./sightings.ts";
import { estimatedForce } from "./counts.ts";

/** 威胁投影半径：只在该半径内落 ThreatCell 条目（Manhattan）。 */
export const THREAT_FIELD_RADIUS = 12;
/** 敌 Core 威胁衰减半径（core raid prior）。 */
export const CORE_RAID_RADIUS = 24;

/** 投影权重衰减：距离 d 的投影权重 = 1 / (1 + d)（格内=1）。 */
export function proximityWeight(distance: number): number {
  return 1 / (1 + distance);
}

function cellKey(pos: Position): string {
  return `${pos[0]},${pos[1]}`;
}

/** 单条目击对周围格的贡献（combat 或 core raid 共用）。uncertainty 取该
 *  格所有贡献源中最大的（1 - confidence），表示"威胁至少有多不确定"。 */
function projectAround(
  cells: Map<string, ThreatCell>,
  source: Position,
  radius: number,
  weight: number,
  uncertainty: number,
  field: keyof Pick<ThreatCell, "directCombat" | "projectedCombat" | "coreRaid">,
): void {
  const [sx, sy] = source;
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      const d = Math.abs(dx) + Math.abs(dy);
      if (d > radius) continue;
      const pos: Position = [sx + dx, sy + dy];
      const key = cellKey(pos);
      const prev = cells.get(key);
      const add = weight * proximityWeight(d);
      cells.set(key, prev === undefined
        ? { position: pos, directCombat: 0, projectedCombat: 0, coreRaid: 0, uncertainty, [field]: add }
        : { ...prev, [field]: prev[field] + add, uncertainty: Math.max(prev.uncertainty, uncertainty) });
    }
  }
}

/**
 * 由目击集投影威胁场。
 *
 * - 可见战斗单位：directCombat += 1（当前威胁，全量）；
 * - 非可见战斗单位（记忆）：projectedCombat += confidence（按衰减）；
 * - 敌 Core：coreRaid += confidence（按距离衰减）；
 * - uncertainty：每格取贡献源 max(1 - confidence)。
 */
export function projectThreatField(
  sightings: readonly EntitySighting[],
  nowTick: number,
  opts: { radius?: number; coreRaidRadius?: number; generatedAtMs?: number } = {},
): ThreatField {
  const radius = opts.radius ?? THREAT_FIELD_RADIUS;
  const coreRaidRadius = opts.coreRaidRadius ?? CORE_RAID_RADIUS;
  const cells = new Map<string, ThreatCell>();
  for (const s of sightings) {
    if (s.kind !== "UNIT" && s.kind !== "CORE") continue;
    if (s.kind === "UNIT" && !isCombatUnit(s.unitType)) continue; // WORKER 不投影威胁
    const confidence = currentConfidence(s, nowTick);
    const uncertainty = 1 - confidence;
    if (s.kind === "UNIT") {
      if (s.currentlyVisible || s.lastSeenTick === nowTick) {
        projectAround(cells, s.position, radius, 1, uncertainty, "directCombat");
      } else {
        projectAround(cells, s.position, radius, confidence, uncertainty, "projectedCombat");
      }
    } else {
      projectAround(cells, s.position, coreRaidRadius, confidence, uncertainty, "coreRaid");
    }
  }
  let maxDirect: ThreatCell | null = null;
  for (const cell of cells.values()) {
    if (maxDirect === null || cell.directCombat > maxDirect.directCombat) maxDirect = cell;
  }
  return {
    cells,
    maxDirect,
    estimatedCombatForce: estimatedForce(sightings, nowTick),
    tickWindow: sightings.length > 0
      ? [Math.min(...sightings.map((s) => s.firstSeenTick)), Math.max(...sightings.map((s) => s.lastSeenTick))]
      : [nowTick, nowTick],
    generatedAtMs: opts.generatedAtMs ?? Date.now(),
  };
}

/**
 * leaderboard 先验加成（spec §5.2 规则 4 / §6.1 弱权重）：不改地图实体，
 * 只对"已知敌 Core 附近"叠加威胁先验。ownerAggression: username -> 0..1 先验
 * （0=无）。返回新 ThreatField（幂等）。
 */
export function adjustWithLeaderboardPrior(
  field: ThreatField,
  sightings: readonly EntitySighting[],
  ownerAggression: ReadonlyMap<string, number>,
  strength = 0.3,
): ThreatField {
  if (ownerAggression.size === 0) return field;
  const cells = new Map(field.cells);
  for (const s of sightings) {
    if (s.kind !== "CORE" || s.ownerUsername === undefined) continue;
    const prior = ownerAggression.get(s.ownerUsername);
    if (prior === undefined || prior <= 0) continue;
    const weight = prior * strength;
    projectAround(cells, s.position, CORE_RAID_RADIUS, weight, 1 - prior, "coreRaid");
  }
  return { ...field, cells };
}

