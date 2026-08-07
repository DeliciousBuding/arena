/**
 * Alliance Director — 核心合同类型（Phase 0 contract freeze）。
 *
 * 设计约束：
 * - tenantId 为泛型字符串，不写死为四租户；
 * - FleetRef 严格 tenant-local；TaskForce 才允许跨 tenant 绑定多个 FleetRef；
 * - 所有类型不含 Arena token、Plan、CandidateSink——合同层不能成为 writer；
 * - 所有字段 readonly，不可变 snapshot 语义。
 *
 * 最后更新：2026-08-08
 */

import type { Position } from "../domain/model.ts";

// ── 角色与控制模式 ───────────────────────────────────────────

/** 联盟角色：由 TreasuryElection 动态确定，不写死 tenant→role 映射。 */
export type AllianceRole = "TREASURY" | "DEFENDER" | "RAIDER" | "SCOUT";

/** 控制模式（AUTO/ASSIST/DIRECT），作用于 alliance / tenant / fleet / actor scope。 */
export type ControlMode = "AUTO" | "ASSIST" | "DIRECT";

// ── EntitySighting ───────────────────────────────────────────

export type SightingKind = "CORE" | "UNIT" | "RESOURCE";
export type SightingEvidence = "LIVE" | "CALIBRATION" | "HISTORY" | "LEADERBOARD";

/**
 * 敌方实体目击记录。每条目击必须保留来源 tenant、时间戳与新鲜度，
 * 避免历史累加被错误放大为当前兵力（§1.1 情报语义修正）。
 */
export interface EntitySighting {
  readonly key: string;
  readonly kind: SightingKind;
  readonly unitType?: "WORKER" | "VANGUARD" | "RANGER";
  readonly ownerUsername?: string;
  readonly position: Position;
  /** 目击来源租户。 */
  readonly sourceTenant: string;
  /** 首次目击 tick。 */
  readonly firstSeenTick: number;
  /** 最近一次目击 tick。 */
  readonly lastSeenTick: number;
  /** 当前 tick 是否仍在视野中。 */
  readonly currentlyVisible: boolean;
  /** 置信度 [0, 1]，按 confidence(age) = max(floor, exp(-age/tau)) 衰减。 */
  readonly confidence: number;
  /** 证据类型：live 目击 / calibration 回放 / 历史存档 / leaderboard 先验。 */
  readonly evidence: SightingEvidence;
}

// ── AllianceMemberReport ─────────────────────────────────────

export type MemberStatus = "READY" | "DEGRADED" | "STALE" | "RESPAWNING";

/**
 * 租户向 AllianceDirector 发送的压缩状态报告（§5.1）。
 * 不是完整 TickState 的复制——只包含联盟决策所需的最小信息。
 */
export interface AllianceMemberReport {
  readonly tenantId: string;
  readonly tick: number;
  /** Wall-clock 时间戳（ms），用于跨时钟新鲜度判断。 */
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
  /** 当前活跃的 Fleet ID 列表（tenant-local）。 */
  readonly activeFleetIds: readonly string[];
  /** 本地威胁估值（归一化，越高越危险）。 */
  readonly localThreat: number;
  /** 本地采集速率（资源/tick）。 */
  readonly localHarvestRate: number;
  readonly status: MemberStatus;
}

// ── AllianceSnapshot ─────────────────────────────────────────

/**
 * 不可变联盟世界快照（§5.4），由 Director 每 N tick 构建一次。
 * 共享事实使用不可变 snapshot；各 tenant 的 TickState/lease/CandidateSink 仍是私有。
 */
export interface AllianceSnapshot {
  readonly revision: number;
  /** 此快照覆盖的 tick 窗口 [start, end]。 */
  readonly tickWindow: readonly [number, number];
  readonly generatedAtMs: number;
  readonly members: ReadonlyMap<string, AllianceMemberReport>;
  readonly sightings: readonly EntitySighting[];
  /** 已知友方实体 ID 集合（用于 no-fire 硬规则）。 */
  readonly allyEntityIds: ReadonlySet<string>;
  readonly treasuryTenant: string;
  readonly activeMissions: readonly Mission[];
}

// ── Fleet & TaskForce ────────────────────────────────────────

export type FleetState = "ASSEMBLE" | "MARCH" | "ENGAGE" | "HOLD" | "RETREAT" | "REBUILD";
export type FormationType = "FORTRESS_RING" | "ASSAULT_WEDGE" | "SCOUT_FAN";

/**
 * FleetRef：严格 tenant-local 引用。不能跨 tenant 引用单位——
 * 跨 tenant 协同必须通过 TaskForce。
 */
export interface FleetRef {
  readonly fleetId: string;
  readonly tenantId: string;
}

/**
 * TaskForce：跨 tenant 联合任务绑定（§10.2）。
 * 绑定多个 FleetRef（每个来自不同或相同 tenant），但不产生跨 tenant Plan。
 */
export interface TaskForce {
  readonly id: string;
  readonly missionId: string;
  /** 绑定的 FleetRef 列表（可来自多个 tenant）。 */
  readonly fleetRefs: readonly FleetRef[];
  /** 指挥租户（负责拆解 directive 到各 FleetController）。 */
  readonly commanderTenant: string;
  readonly synchronization: "LOOSE" | "RALLY_BEFORE_ENGAGE";
}

// ── Mission ──────────────────────────────────────────────────

export type MissionKind =
  | "DEFEND"
  | "SCOUT"
  | "ASSEMBLE"
  | "RAID"
  | "INTERCEPT"
  | "ESCORT"
  | "RETREAT";

export type MissionStatus =
  | "PROPOSED"
  | "ASSIGNED"
  | "ACTIVE"
  | "SATISFIED"
  | "CANCELLED"
  | "EXPIRED"
  | "FAILED";

export type MissionSource = "AUTO" | "HUMAN_ASSIST";

/**
 * 联盟任务（§9）。每类 Mission 必须有明确结束条件，禁止永久任务。
 * scope 字段指示任务适用范围（如 tenantId、fleetId 等），可选。
 */
export interface Mission {
  readonly id: string;
  readonly revision: number;
  readonly kind: MissionKind;
  /** 优先级（越高越优先，确定性 tie-break 用）。 */
  readonly priority: number;
  /** 目标任务位置（可选，如 SCOUT 可不指定精确坐标）。 */
  readonly target?: Position;
  /** 目标实体 key（可选，如 RAID 指定敌方 Core key）。 */
  readonly targetEntityKey?: string;
  /** 防御对象 tenantId（DEFEND 任务专用）。 */
  readonly defendTenant?: string;
  /** 任务适用范围（如 tenantId / fleetId），可选。 */
  readonly scope?: string;
  /** 任务下发 tick。 */
  readonly issuedAtTick: number;
  /** 任务过期 tick（含）。 */
  readonly expiresAtTick: number;
  readonly status: MissionStatus;
  readonly source: MissionSource;
}

// ── AllianceDirective ────────────────────────────────────────

export type DirectiveSource = "auto" | "human";

/**
 * 联盟指令合同（§16）。Director 下发给单个 tenant。
 * 不含 Arena token、Plan、CandidateSink——合同层不能成为 writer。
 * 过期/无效指令必须 fail-open：忽略联盟指令，回到现有 tenant planner。
 */
export interface AllianceDirective {
  readonly tenantId: string;
  readonly revision: number;
  /** 引用的 Mission ID 列表（不嵌套完整 Mission）。 */
  readonly missionRefs: readonly string[];
  readonly issuedAtTick: number;
  /** 指令过期 tick（含）。过期后必须忽略。 */
  readonly expiresAtTick: number;
  readonly source: DirectiveSource;
  readonly mode: ControlMode;
  /** 可选人类可读解释（调试/审计用）。 */
  readonly explanation?: string;
}
