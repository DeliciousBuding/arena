/**
 * Alliance 域模型类型（2026-08-08，alliance-director-spec §5/§6 核心落地）。
 *
 * 纯函数核心：本目录**不 import 任何 domain/ 运行态模块**，只定义联盟共享
 * 知识所需的自包含类型，保证 simulator / Command Center / production 复用
 * 同一套联盟语义（spec 不变量 I5：确定性回放、I7：无隐藏跨租户可变世界）。
 *
 * 关键语义（spec §5.2）：
 * - EntitySighting 是"某租户在某 tick 对某实体的目击记录"，不是服务器全知状态；
 * - 每条目击保留来源租户、tick 窗口、新鲜度、confidence 与证据类型；
 * - leaderboard 证据只能修改威胁先验，不可凭空生成地图实体。
 */

/** 网格坐标（与 domain 的 Position 同形状 `[x, y]`，但保持独立以便跨包复用）。 */
export type Position = readonly [number, number];

/** 证据类型：LIVE=本 tick 直接观测；CALIBRATION=历史 case 重放；
 *  HISTORY=已过期但曾观测；LEADERBOARD=排行榜派生（仅威胁先验）。 */
export type EvidenceKind = "LIVE" | "CALIBRATION" | "HISTORY" | "LEADERBOARD";

export type SightingKind = "CORE" | "UNIT" | "RESOURCE";

export type UnitType = "WORKER" | "VANGUARD" | "RANGER";

/** 战斗单位（威胁投影只对 VANGUARD/RANGER 计 directCombat；WORKER 仅近身威胁）。 */
export function isCombatUnit(unitType: UnitType | undefined): boolean {
  return unitType === "VANGUARD" || unitType === "RANGER";
}

/**
 * 实体目击记录（spec §5.2）。
 *
 * key 是联盟内部稳定去重键（由 sightings.ts 的 mergeKey 决定）：
 * - 有稳定 id：`<kind>:<entityId>`
 * - enemy Core 无 id：`CORE:<ownerUsername>`（配合 spatial gate 合并）
 * - 普通 Unit 无 id：`UNIT:<tenant>:<tick>:<x>,<y>`（每次独立，不永久合并）
 */
export interface EntitySighting {
  readonly key: string;
  readonly kind: SightingKind;
  readonly unitType?: UnitType;
  /** 稳定实体 id（敌方 UNIT 通常有 id；enemy Core 有 id + owner_username）。 */
  readonly entityId?: string;
  readonly ownerUsername?: string;
  readonly position: Position;
  /** 目击来源租户（t1/t2/t3/t4）。 */
  readonly sourceTenant: string;
  readonly firstSeenTick: number;
  readonly lastSeenTick: number;
  /** 当前是否仍可见（本 tick 出现在视野内）。 */
  readonly currentlyVisible: boolean;
  /** 当前置信度（已按 age 衰减；0..1）。 */
  readonly confidence: number;
  readonly evidence: EvidenceKind;
}

/** 压缩联盟成员状态（spec §5.1）：不是完整 private TickState 的复制。 */
export interface AllianceMemberState {
  readonly tenantId: string;
  readonly tick: number;
  readonly observedAtMs: number;
  readonly core: {
    readonly id: string;
    readonly position: Position;
    readonly hp: number;
    readonly shield: number;
    readonly moving: boolean;
  } | null;
  readonly resources: number;
  readonly resourceCapacity: number;
  readonly population: number;
  readonly workers: number;
  readonly vanguards: number;
  readonly rangers: number;
  readonly carriedResources: number;
  readonly activeFleetIds: readonly string[];
  readonly localThreat: number;
  readonly localHarvestRate: number;
  readonly status: "READY" | "DEGRADED" | "STALE" | "RESPAWNING";
}

/** 威胁格（spec §6.1）：稀疏格/区域表示。 */
export interface ThreatCell {
  readonly position: Position;
  /** 当前可见战斗单位贡献（VANGUARD/RANGER，权重按 visibility 全量）。 */
  readonly directCombat: number;
  /** 近期唯一战斗目击 × confidence 衰减后的投影（非可见但记忆仍在）。 */
  readonly projectedCombat: number;
  /** 附近敌方 Core 的先验威胁（core raid prior）。 */
  readonly coreRaid: number;
  /** 不确定度（0..1）：目击越陈旧/证据越弱越高。 */
  readonly uncertainty: number;
}

/** 威胁场汇总（供 AllianceDirector / 面板消费）。 */
export interface ThreatField {
  readonly cells: ReadonlyMap<string, ThreatCell>;
  /** 所有威胁格中 directCombat 最大格（null=无威胁）。 */
  readonly maxDirect: ThreatCell | null;
  /** 联盟侧汇总：当前可见敌战斗单位估计兵力（按 confidence 加权）。 */
  readonly estimatedCombatForce: number;
  /** 生成时的 tick 窗口。 */
  readonly tickWindow: readonly [number, number];
  readonly generatedAtMs: number;
}

/** 联盟快照（spec §5.4）：不可变，各 tenant 私有状态不进入。 */
export interface AllianceSnapshot {
  readonly revision: number;
  readonly tickWindow: readonly [number, number];
  readonly generatedAtMs: number;
  readonly members: ReadonlyMap<string, AllianceMemberState>;
  readonly sightings: readonly EntitySighting[];
  readonly allyEntityIds: ReadonlySet<string>;
  readonly threat: ThreatField;
  /** 兵力统计（counts.ts 语义）。 */
  readonly counts: AllianceForceCounts;
  /** 当前联盟司库租户（treasury）。 */
  readonly treasuryTenant: string;
}

/** 兵力统计语义（spec §1.1 修正"83 敌单位"重复放大假象的地基）。 */
export interface AllianceForceCounts {
  /** 当前可见敌战斗单位数（UNIT 且 VANGUARD/RANGER，lastSeenTick === nowTick）。 */
  readonly currentVisibleCombat: number;
  /** 近期唯一敌战斗单位数（窗口内 unique entityId，按 spec §5.2 去重）。 */
  readonly recentUniqueCombat: number;
  /** 历史目击条数（含重复，用于审计/回放对比，不做兵力展示）。 */
  readonly historicalSightingCount: number;
  /** 估计兵力 = unique combat × confidence 加权（跨窗口平滑，非整数）。 */
  readonly estimatedForce: number;
}
