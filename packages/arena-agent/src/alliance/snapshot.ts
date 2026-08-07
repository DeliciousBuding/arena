/**
 * AllianceSnapshot 构建（2026-08-08，spec §5.4 落地）。
 *
 * 输入：各租户压缩成员状态 + 各租户原始观测（calibration case 对象形状的
 * 降采样）+ 联盟 roster。输出：不可变 AllianceSnapshot（生产 / Command Center
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

/** 构建不可变 AllianceSnapshot（spec §5.4）。 */
export function buildAllianceSnapshot(input: BuildSnapshotInput): AllianceSnapshot {
  const defaultEvidence = input.defaultEvidence ?? "CALIBRATION";
  const generatedAtMs = input.generatedAtMs ?? Date.now();
  const sightings = observationsToSightings(input.observations, input.nowTick, defaultEvidence);
  const rawCombatCount = input.observations.filter((o) => !o.controlled && o.kind === "UNIT" && (o.unitType === "VANGUARD" || o.unitType === "RANGER")).length;
  const counts: AllianceForceCounts = computeForceCounts(sightings, input.nowTick, { historicalSightingCount: rawCombatCount });
  let threat = projectThreatField(sightings, input.nowTick, { generatedAtMs });
  if (input.leaderboardAggression !== undefined && input.leaderboardAggression.size > 0) {
    threat = adjustWithLeaderboardPrior(threat, sightings, input.leaderboardAggression);
  }
  const members = new Map<string, AllianceMemberState>();
  for (const m of input.members) members.set(m.tenantId, m);
  return {
    revision: input.revision,
    tickWindow: sightings.length > 0
      ? [Math.min(...sightings.map((s) => s.firstSeenTick)), Math.max(...sightings.map((s) => s.lastSeenTick))]
      : [input.nowTick, input.nowTick],
    generatedAtMs,
    members,
    sightings,
    allyEntityIds: new Set(input.roster.allyEntityIds),
    threat,
    counts,
    treasuryTenant: "",
  };
}

