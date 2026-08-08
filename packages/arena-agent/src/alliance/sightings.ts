/**
 * 目击去重 + 置信度衰减（2026-08-08，alliance-director-spec §5.2/§5.3 落地）。
 *
 * 解决的问题（spec §1.1 点名）：calibration 扫描窗口内对同一单位多次目击
 * 若按"条数"累加会重复放大兵力（旧 intel.ts `enemyUnits += 1` → "83 敌单位"
 * 假象）。本模块提供纯函数合并规则：
 *
 * 1. 有稳定 entity id：按 id 合并（同 id 多 tick 目击只算一个实体）；
 * 2. enemy Core 无稳定 id：ownerUsername + spatial gate（位置移动阈值内合并）；
 * 3. 普通 Unit 无 id：不永久合并（每次新位置独立条目），仅同 tick 同格去重；
 * 4. leaderboard 只能改威胁先验，不生成地图实体（见 threat-field.ts）。
 *
 * confidence(age) = max(floor, exp(-age / tau))（spec §5.3）
 * - active enemy Unit：tau ≈ 4-8 ticks（取 6）
 * - enemy Core：tau ≈ 64-128 ticks（取 96）
 * - 常量是"初始实验量级"，最终由 simulator/live replay 校准，不是最优常数。
 */

import {
  type EntitySighting,
  type Position,
  type SightingKind,
  isCombatUnit,
} from "./types.ts";

/** 无 id 敌方 UNIT 的同 tick 同格去重窗口（tick 差 ≤ 该值视为同一瞬时观测）。 */
export const UNIT_SAME_TICK_GATE = 0;

/** enemy Core 无 id 时 ownerUsername + spatial gate 的最大位置漂移（Manhattan）。 */
export const CORE_SPATIAL_GATE = 8;

/** 置信度下限：陈旧目击不归零，保留弱记忆（防"重启即全忘"）。 */
export const CONFIDENCE_FLOOR = 0.05;

/**
 * 无 id ephemeral UNIT 目击的最大存活 tick 数（P0 修复：防 per-tick 无界累积）。
 * 超过此龄且当前不可见的条目在 updateSightingsTick 末尾被驱逐。
 * 值 48 ≈ 8× 典型战斗单位 tau (6)，过期后不再有军事参考价值。
 */
export const EPHEMERAL_UNIT_MAX_AGE_TICKS = 48;

/** 敌战斗单位衰减 tau（spec §5.3 初始量级 4-8，取中值 6）。 */
export const UNIT_TAU = 6;
/** 敌 Core 衰减 tau（spec §5.3 初始量级 64-128，取中值 96）。 */
export const CORE_TAU = 96;
/** 地形障碍：永久知识（tau=Infinity → 恒 1）。 */
export const OBSTACLE_TAU = Infinity;
/** 资源：按 depletion/refill 不确定度单独处理（暂用中等 tau，后续校准）。 */
export const RESOURCE_TAU = 24;

/** 由 kind/unitType 选择 tau（spec §5.3 量级表）。 */
export function tauFor(kind: SightingKind, unitType?: EntitySighting["unitType"]): number {
  switch (kind) {
    case "CORE":
      return CORE_TAU;
    case "RESOURCE":
      return RESOURCE_TAU;
    case "UNIT":
      return isCombatUnit(unitType) ? UNIT_TAU : UNIT_TAU * 2;
    default:
      return UNIT_TAU;
  }
}

/** confidence(age) = max(floor, exp(-age / tau))（spec §5.3）。 */
export function confidenceAt(ageTicks: number, tau: number): number {
  if (tau === Infinity) return ageTicks <= 0 ? 1 : CONFIDENCE_FLOOR;
  const c = Math.exp(-ageTicks / tau);
  return Math.max(CONFIDENCE_FLOOR, c);
}

/** 当前置信度：age = nowTick - lastSeenTick；currentlyVisible 强制 1。 */
export function currentConfidence(sighting: EntitySighting, nowTick: number): number {
  if (sighting.currentlyVisible) return 1;
  const age = Math.max(0, nowTick - sighting.lastSeenTick);
  return confidenceAt(age, tauFor(sighting.kind, sighting.unitType));
}

/** 无 id 普通 Unit 的合并键：`UNIT:<tenant>:<tick>:<x>,<y>`——不永久合并，
 *  仅同 tick 同格（±UNIT_SAME_TICK_GATE）去重，防单 tick 重复放大。 */
function ephemeralUnitKey(sighting: {
  readonly sourceTenant: string;
  readonly tick: number;
  readonly position: Position;
}): string {
  return `UNIT:${sighting.sourceTenant}:${sighting.tick}:${sighting.position[0]},${sighting.position[1]}`;
}

/** 计算目击的去重键（spec §5.2 规则 1-3）。
 *  - 有 id：`<kind>:<entityId>`
 *  - 无 id enemy CORE（有 ownerUsername）：`CORE:<ownerUsername>`（配合 spatial gate）
 *  - 无 id 普通 Unit：ephemeral key（不永久合并）
 *  - 其余（无 id 无 owner 的 RESOURCE 等）：`<kind>:<tenant>:<x>,<y>`（静态实体按格）
 */
export function mergeKey(sighting: {
  readonly kind: SightingKind;
  readonly entityId?: string;
  readonly ownerUsername?: string;
  readonly sourceTenant: string;
  readonly tick?: number;
  readonly position: Position;
}): string {
  if (sighting.entityId !== undefined && sighting.entityId.length > 0) {
    return `${sighting.kind}:${sighting.entityId}`;
  }
  if (sighting.kind === "CORE" && sighting.ownerUsername !== undefined && sighting.ownerUsername.length > 0) {
    return `CORE:${sighting.ownerUsername}`;
  }
  if (sighting.kind === "UNIT") {
    return ephemeralUnitKey({
      sourceTenant: sighting.sourceTenant,
      tick: sighting.tick ?? 0,
      position: sighting.position,
    });
  }
  return `${sighting.kind}:${sighting.sourceTenant}:${sighting.position[0]},${sighting.position[1]}`;
}

/**
 * 把一条原始观测归一化为 EntitySighting（计算 stable key、firstSeen）。
 * existing 为同 key 已有记录（或 undefined）。
 *
 * 合并语义：
 * - key 相同（有 id / 同 owner Core）→ 更新 lastSeenTick/position/currentlyVisible，
 *   保留 firstSeenTick，confidence 由 currentConfidence 重算；
 * - key 不同的无 id Unit → 独立新条目（不永久合并）；
 * - spatial gate：无 id enemy Core 位置漂移 ≤ CORE_SPATIAL_GATE 视为同一实体
 *   （ownerUsername 相同的相邻目击合并），超过则视为新实体。
 */
export function normalizeSighting(
  raw: {
    readonly kind: SightingKind;
    readonly unitType?: EntitySighting["unitType"];
    readonly entityId?: string;
    readonly ownerUsername?: string;
    readonly position: Position;
    readonly sourceTenant: string;
    readonly tick: number;
    readonly evidence: EntitySighting["evidence"];
  },
  existing: EntitySighting | undefined,
  nowTick: number,
): EntitySighting {
  const key = mergeKey({ ...raw, tick: raw.tick });

  // spatial gate：无稳定 id 的 enemy Core 即使 owner 相同，若位置漂移超过
  // CORE_SPATIAL_GATE 也视为新实体（旧条目保留为 HISTORY，新条目独立）——
  // 否则 owner CORE 的 key 恒同，gate 永远不触发，无法拆分"同名多基地"。
  if (existing !== undefined && existing.kind === "CORE" && raw.kind === "CORE"
      && existing.ownerUsername !== undefined && existing.ownerUsername === raw.ownerUsername
      && existing.entityId === undefined && raw.entityId === undefined
      && existing.key === key) {
    const drift = Math.abs(existing.position[0] - raw.position[0]) + Math.abs(existing.position[1] - raw.position[1]);
    if (drift > CORE_SPATIAL_GATE) {
      const splitKey = `CORE:${raw.ownerUsername}:${raw.position[0]},${raw.position[1]}`;
      return {
        key: splitKey,
        kind: raw.kind,
        unitType: raw.unitType,
        entityId: raw.entityId,
        ownerUsername: raw.ownerUsername,
        position: raw.position,
        sourceTenant: raw.sourceTenant,
        firstSeenTick: raw.tick,
        lastSeenTick: raw.tick,
        currentlyVisible: raw.tick === nowTick,
        confidence: 1,
        evidence: raw.evidence,
      };
    }
  }

  if (existing !== undefined && existing.key === key) {
    return {
      ...existing,
      position: raw.position,
      lastSeenTick: raw.tick,
      currentlyVisible: raw.tick === nowTick,
      confidence: currentConfidence(
        { ...existing, position: raw.position, lastSeenTick: raw.tick, currentlyVisible: raw.tick === nowTick },
        nowTick,
      ),
      evidence: raw.evidence === "LEADERBOARD" && existing.evidence !== "LEADERBOARD" ? existing.evidence : raw.evidence,
    };
  }

  // 无 id enemy Core 的 spatial gate 合并：owner 相同 + 漂移 ≤ 阈值（key 不同
  // 的场景：例如已有按坐标分拆的历史条目，新观测回到原位附近）。
  if (raw.kind === "CORE" && existing !== undefined && existing.kind === "CORE"
      && existing.ownerUsername !== undefined && existing.ownerUsername === raw.ownerUsername
      && existing.entityId === undefined && raw.entityId === undefined) {
    const drift = Math.abs(existing.position[0] - raw.position[0]) + Math.abs(existing.position[1] - raw.position[1]);
    if (drift <= CORE_SPATIAL_GATE) {
      return {
        ...existing,
        key,
        position: raw.position,
        lastSeenTick: raw.tick,
        currentlyVisible: raw.tick === nowTick,
        confidence: currentConfidence(
          { ...existing, key, position: raw.position, lastSeenTick: raw.tick, currentlyVisible: raw.tick === nowTick },
          nowTick,
        ),
      };
    }
  }

  return {
    key,
    kind: raw.kind,
    unitType: raw.unitType,
    entityId: raw.entityId,
    ownerUsername: raw.ownerUsername,
    position: raw.position,
    sourceTenant: raw.sourceTenant,
    firstSeenTick: raw.tick,
    lastSeenTick: raw.tick,
    currentlyVisible: raw.tick === nowTick,
    confidence: 1,
    evidence: raw.evidence,
  };
}

/**
 * 批量合并：把一组原始观测合并进现有 sightings（按 key），返回新数组。
 * 幂等：重复调用同一组观测不产生重复条目。
 */
export function mergeSightings(
  existing: readonly EntitySighting[],
  raws: readonly Parameters<typeof normalizeSighting>[0][],
  nowTick: number,
): EntitySighting[] {
  const byKey = new Map<string, EntitySighting>();
  for (const s of existing) byKey.set(s.key, s);
  for (const raw of raws) {
    const prev = byKey.get(mergeKey({ ...raw, tick: raw.tick }));
    const merged = normalizeSighting(raw, prev, nowTick);
    byKey.set(merged.key, merged);
  }
  return [...byKey.values()];
}

/**
 * 跨 tick 目击更新（shadow/live 累积用）：
 * 1) 用本次观测 merge（同 key 更新 lastSeen/position）；
 * 2) 本 tick 观测中未出现的 previously-visible 条目标记为不可见（confidence 衰减）；
 * 3) 返回新数组（不可变）。
 */
export function updateSightingsTick(
  existing: readonly EntitySighting[],
  observations: readonly Parameters<typeof normalizeSighting>[0][],
  nowTick: number,
): EntitySighting[] {
  const merged = mergeSightings(existing, observations, nowTick);
  const visibleKeys = new Set(observations.map((o) => mergeKey({ ...o, tick: o.tick })));
  const updated = merged.map((s) =>
    s.currentlyVisible && !visibleKeys.has(s.key)
      ? { ...s, currentlyVisible: false, confidence: currentConfidence({ ...s, currentlyVisible: false }, nowTick) }
      : s,
  );
  // P0 修复：驱逐过期的无 id ephemeral UNIT 条目，防 per-tick 无界累积。
  // 有稳定 entityId 或 CORE/RESOURCE/OBSTACLE 的条目不受此驱逐（由各自的 tau/合并规则管理）。
  return updated.filter((s) => {
    if (s.currentlyVisible) return true;
    if (s.entityId !== undefined && s.entityId.length > 0) return true;
    if (s.kind !== "UNIT") return true;
    return nowTick - s.lastSeenTick <= EPHEMERAL_UNIT_MAX_AGE_TICKS;
  });
}

/** 把陈旧目击标记为非可见（跨 tick 衰减用：调用方每个 tick 把 not-currently-seen 的
 *  currentlyVisible 置 false；此函数返回拷贝，不原地修改）。 */
export function markNotVisible(sightings: readonly EntitySighting[], nowTick: number): EntitySighting[] {
  return sightings.map((s) =>
    s.currentlyVisible
      ? { ...s, currentlyVisible: false, confidence: currentConfidence({ ...s, currentlyVisible: false }, nowTick) }
      : s,
  );
}
