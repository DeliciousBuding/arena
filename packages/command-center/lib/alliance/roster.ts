/**
 * 联盟花名册 / no-fire（2026-08-08，spec §5.5 落地）。
 *
 * 问题：敌方 Unit 视图不总是暴露 owner username（真实 calibration 实证：
 * enemy UNIT 只有 id、无 owner_username），四账号物理接近时不能仅靠 username
 * 判断友军。因此每个 tenant 发布自己当前 controlled Core/Unit UUID 到联盟
 * roster；其他 tenant 看到这些 UUID 时标记为 ALLY_EXTERNAL。
 *
 * 硬规则（spec §5.5）：
 *   knownAllianceEntityId => never deliberate target
 * 命中即记 allianceNoFirePreventedCount（KPI）。
 */

export interface AllianceRoster {
  readonly revision: number;
  readonly updatedAtMs: number;
  /** 盟军 controlled 实体 id 全集（Core + Units，跨租户并集）。 */
  readonly allyEntityIds: ReadonlySet<string>;
  /** tenantId -> ownerUsername（Core 迁移/易主时更新）。 */
  readonly ownerByTenant: ReadonlyMap<string, string>;
  /** 命中 no-fire 的次数（KPI：knownAllianceEntityId => never deliberate target）。 */
  readonly noFirePreventedCount: number;
  /** 每个 tenant 最近一次发布的 tick。 */
  readonly tenantLastTick: ReadonlyMap<string, number>;
}

export const EMPTY_ROSTER: AllianceRoster = {
  revision: 0,
  updatedAtMs: 0,
  allyEntityIds: new Set(),
  ownerByTenant: new Map(),
  noFirePreventedCount: 0,
  tenantLastTick: new Map(),
};

/** 登记一个租户当前 controlled 实体集合（幂等：重复登记同 tick 不增 revision）。 */
export function registerAlliedEntities(
  roster: AllianceRoster,
  input: {
    readonly tenantId: string;
    readonly ownerUsername: string | null;
    readonly entityIds: readonly string[];
    readonly tick: number;
    readonly nowMs?: number;
  },
): AllianceRoster {
  const prevTick = roster.tenantLastTick.get(input.tenantId);
  if (prevTick !== undefined && prevTick === input.tick) return roster; // 同 tick 重复登记
  const ally = new Set(roster.allyEntityIds);
  for (const id of input.entityIds) {
    if (id.length > 0) ally.add(id);
  }
  const owners = new Map(roster.ownerByTenant);
  if (input.ownerUsername !== null && input.ownerUsername.length > 0) {
    owners.set(input.tenantId, input.ownerUsername);
  }
  const ticks = new Map(roster.tenantLastTick);
  ticks.set(input.tenantId, input.tick);
  return {
    revision: roster.revision + 1,
    updatedAtMs: input.nowMs ?? Date.now(),
    allyEntityIds: ally,
    ownerByTenant: owners,
    noFirePreventedCount: roster.noFirePreventedCount,
    tenantLastTick: ticks,
  };
}

/** 该实体是否为盟军已知实体（knownAllianceEntityId）。 */
export function isAllyEntity(roster: AllianceRoster, entityId: string | null | undefined): boolean {
  if (entityId === null || entityId === undefined || entityId.length === 0) return false;
  return roster.allyEntityIds.has(entityId);
}

/**
 * 目标合法性检查：knownAllianceEntityId => never deliberate target。
 * 命中时返回 blocked 并累计 noFirePreventedCount（KPI）。
 */
export function assertNoDeliberateTarget(
  roster: AllianceRoster,
  targetId: string | null | undefined,
): { readonly allowed: boolean; readonly reason: "ALLOWED" | "NO_FIRE_PREVENTED" | "UNKNOWN_ENTITY" } {
  if (targetId === null || targetId === undefined || targetId.length === 0) {
    return { allowed: true, reason: "UNKNOWN_ENTITY" }; // 无 id 无法判定，放行（由其他层把关）
  }
  if (roster.allyEntityIds.has(targetId)) {
    return { allowed: false, reason: "NO_FIRE_PREVENTED" };
  }
  return { allowed: true, reason: "ALLOWED" };
}

/** 记录一次 no-fire 拦截（KPI 累计）。返回新 roster（不可变）。 */
export function recordNoFirePrevented(roster: AllianceRoster, nowMs?: number): AllianceRoster {
  return {
    ...roster,
    revision: roster.revision + 1,
    updatedAtMs: nowMs ?? Date.now(),
    noFirePreventedCount: roster.noFirePreventedCount + 1,
  };
}
