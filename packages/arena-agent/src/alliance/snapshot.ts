/**
 * AllianceSnapshot 构建（2026-08-08，spec §5.4 落地）。
 *
 * 输入：各租户压缩成员状态 + 各租户原始观测（calibration case 对象形状的
 * 降采样）+ 联盟 roster。输出：不可变 AllianceSnapshot（production / Command Center
 * / simulator 共用同一构建函数——spec 不变量 I5 确定性回放、I7 无隐藏跨租户
 * 可变世界）。
 *
 * 本模块**不持有 submit 权限**：只产生只读快照，供 AllianceDirector / 面板消费。
 */

import {
  type AllianceMemberState,
  type AllianceSnapshot,
  type AllianceForceCounts,
  type EntitySighting,
  type EvidenceKind,
  type Position,
  type UnitType,
} from "./types.ts";
import { mergeSightings } from "./sightings.ts";
import { computeForceCounts } from "./counts.ts";
import { projectThreatField, adjustWithLeaderboardPrior } from "./threat-field.ts";
import { type AllianceRoster } from "./roster.ts";

/** 原始观测（calibration case 对象形状的联盟侧降采样；controlled=true 是
 *  本租户自己的实体，不入敌方 sightings）。 */
export interface AllianceObservation {
  readonly tenantId: string;
  readonly tick: number;
  readonly kind: "CORE" | "UNIT" | "RESOURCE";
  readonly entityId?: string;
  readonly ownerUsername?: string;
  readonly unitType?: UnitType;
  /** true = 本租户 controlled（盟军实体，进入 roster 侧而非敌方 sightings）。 */
  readonly controlled: boolean;
  readonly position: Position;
  readonly evidence: EvidenceKind;
}

export interface BuildSnapshotInput {
  readonly revision: number;
  readonly members: readonly AllianceMemberState[];
  readonly observations: readonly AllianceObservation[];
  readonly roster: AllianceRoster;
  readonly nowTick: number;
  readonly generatedAtMs?: number;
  /** leaderboard 威胁先验：username -> 0..1（弱权重，仅威胁场加成）。 */
  readonly leaderboardAggression?: ReadonlyMap<string, number>;
  /** 敌方目击证据默认类型（CALIBRATION=历史 case 重放）。 */
  readonly defaultEvidence?: EvidenceKind;
  /** 当前 treasury；Phase 1 未选举时保持空字符串。 */
  readonly treasuryTenant?: string;
}

/**
 * 已融合 sightings → canonical snapshot。
 *
 * 用于 live shadow/simulator/supervisor 已经维护跨 tick sighting memory 的场景。
 * 调用方负责 sighting key 的融合；本入口负责统一 ally filter、counts、threat、
 * timestamp 和 members 投影，避免各运行面复制 Snapshot 语义。
 */
export interface BuildSnapshotFromSightingsInput {
  readonly revision: number;
  readonly members: readonly AllianceMemberState[];
  readonly sightings: readonly EntitySighting[];
  readonly allyEntityIds: ReadonlySet<string> | readonly string[];
  readonly nowTick: number;
  readonly generatedAtMs?: number;
  readonly leaderboardAggression?: ReadonlyMap<string, number>;
  /** 原始战斗目击条数（含重复）；缺省为融合后的保守下限。 */
  readonly historicalSightingCount?: number;
  readonly treasuryTenant?: string;
}

/** 由观测构建敌方目击集（去重 + confidence 归一化）。 */
export function observationsToSightings(
  observations: readonly AllianceObservation[],
  nowTick: number,
  defaultEvidence: EvidenceKind = "CALIBRATION",
): EntitySighting[] {
  const raws = observations
    .filter((o) => !o.controlled) // 盟军实体不进敌方目击
    .map((o) => ({
      kind: o.kind,
      unitType: o.unitType,
      entityId: o.entityId,
      ownerUsername: o.ownerUsername,
      position: o.position,
      sourceTenant: o.tenantId,
      tick: o.tick,
      evidence: o.evidence ?? defaultEvidence,
    }));
  return mergeSightings([], raws, nowTick);
}

function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** canonical Snapshot 的单一收口入口。 */
export function buildAllianceSnapshotFromSightings(input: BuildSnapshotFromSightingsInput): AllianceSnapshot {
  const generatedAtMs = input.generatedAtMs ?? Date.now();
  const allyEntityIds = new Set(input.allyEntityIds);
  // roster 保存 raw entityId；兼容极少数旧调用把完整 key 存入 roster 的情况。
  const sightings = input.sightings
    .filter((s) => !allyEntityIds.has(s.key) && (s.entityId === undefined || !allyEntityIds.has(s.entityId)))
    .slice()
    .sort((a, b) => stableCompare(a.key, b.key) || b.lastSeenTick - a.lastSeenTick || stableCompare(a.sourceTenant, b.sourceTenant));
  const counts: AllianceForceCounts = computeForceCounts(sightings, input.nowTick, {
    historicalSightingCount: input.historicalSightingCount,
  });
  let threat = projectThreatField(sightings, input.nowTick, { generatedAtMs });
  if (input.leaderboardAggression !== undefined && input.leaderboardAggression.size > 0) {
    threat = adjustWithLeaderboardPrior(threat, sightings, input.leaderboardAggression);
  }
  const members = new Map<string, AllianceMemberState>();
  for (const m of input.members) members.set(m.tenantId, m);
  return {
    revision: input.revision,
    // 窗口末端必须是 snapshot 的 current tick，而不是最后一次敌情 tick；
    // 否则无新目击时 control-plane TTL 会被陈旧 sighting 时间倒退。
    tickWindow: sightings.length > 0
      ? [Math.min(...sightings.map((s) => s.firstSeenTick)), input.nowTick]
      : [input.nowTick, input.nowTick],
    generatedAtMs,
    members,
    sightings,
    allyEntityIds,
    threat,
    counts,
    treasuryTenant: input.treasuryTenant ?? "",
  };
}

/** 构建不可变 AllianceSnapshot（spec §5.4）。 */
export function buildAllianceSnapshot(input: BuildSnapshotInput): AllianceSnapshot {
  const defaultEvidence = input.defaultEvidence ?? "CALIBRATION";
  const sightings = observationsToSightings(input.observations, input.nowTick, defaultEvidence);
  const rawCombatCount = input.observations.filter(
    (o) => !o.controlled && o.kind === "UNIT" && (o.unitType === "VANGUARD" || o.unitType === "RANGER"),
  ).length;
  return buildAllianceSnapshotFromSightings({
    revision: input.revision,
    members: input.members,
    sightings,
    allyEntityIds: input.roster.allyEntityIds,
    nowTick: input.nowTick,
    generatedAtMs: input.generatedAtMs,
    leaderboardAggression: input.leaderboardAggression,
    historicalSightingCount: rawCombatCount,
    treasuryTenant: input.treasuryTenant,
  });
}

