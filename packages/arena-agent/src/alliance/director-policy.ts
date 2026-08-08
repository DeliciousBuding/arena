/**
 * Pure Alliance Shadow Director policy.
 *
 * Produces auditable Missions + ASSIST directives only. It has no Arena Plan/action,
 * no submit capability and RETREAT is a threat-feasible recommendation, not START_MOVE.
 *
 * 三阶段（2026-08-08 vnext 回流）：
 * - Phase A：本地生存任务（rebuild/retreat/intercept/directional-defend），硬优先级。
 *   未被占用的成员进入 flexible pool。
 * - Phase B：全局 task market——urgent 时空闲成员竞标 ESCORT 支援；
 *   平静期竞标 enemy-Core RAID（guarded core 展开多 slot → 联合攻坚）。
 *   Hungarian 全局清算（每 tenant 至多一任务、每 slot 至多一 tenant）。
 * - Phase C：market 未分配的成员本地 fallback（ASSEMBLE / SCOUT / DEFEND 兜底）。
 *
 * StrategicPolicyProfile（strategic-policy.ts）只通过 missionPriority（柔性任务
 * 允许集 + 取舍顺序）与 thresholds（参数覆盖）影响决策——profile 不可产出
 * AUTO/DIRECT 指令、不可绕过 ASSIST 硬约束。
 */
import type { AllianceSnapshot, AllianceMemberState, EntitySighting, Position } from "./types.ts";
import type {
  AllianceDirective,
  AllianceRole,
  Mission,
  MissionKind,
  TaskForce,
} from "./control-types.ts";
import {
  buildAllianceThreatSummariesFromSnapshot,
  type TenantThreatSummary,
  type ThreatDirection,
  type ThreatSummaryConfig,
} from "./threat-summary.ts";
import { allocateAllianceTaskMarket, type AllianceMarketTask } from "./task-market.ts";

const DIRECTIONS: readonly ThreatDirection[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const VECTOR: Readonly<Record<ThreatDirection, readonly [number, number]>> = {
  N: [0, 1], NE: [1, 1], E: [1, 0], SE: [1, -1],
  S: [0, -1], SW: [-1, -1], W: [-1, 0], NW: [-1, 1],
};

export interface ShadowDirectorPolicyConfig {
  readonly directiveDurationTicks: number;
  readonly retreatDistance: number;
  readonly scoutDistance: number;
  readonly retreatTotalScoreThreshold: number;
  readonly retreatDurabilityThreshold: number;
  readonly interceptDistance: number;
  readonly minInterceptMilitary: number;
  readonly assembleMilitaryBelow: number;
  readonly minRaidMilitary: number;
  readonly raidMinConfidence: number;
  readonly raidMaxDistance: number;
  readonly raidMaxAgeTicks: number;
  /** guarded Core 联合攻坚：目标周围该半径内的近期战斗单位算守军。 */
  readonly jointRaidGuardRadius: number;
  readonly jointRaidGuardThreshold: number;
  readonly jointRaidSlots: number;
  readonly jointRaidMinMilitaryPerTenant: number;
  readonly threatSummary: Partial<ThreatSummaryConfig>;
}

export const DEFAULT_SHADOW_DIRECTOR_POLICY: ShadowDirectorPolicyConfig = Object.freeze({
  directiveDurationTicks: 8,
  retreatDistance: 10,
  scoutDistance: 12,
  retreatTotalScoreThreshold: 1.2,
  retreatDurabilityThreshold: 6,
  interceptDistance: 12,
  minInterceptMilitary: 2,
  assembleMilitaryBelow: 2,
  minRaidMilitary: 6,
  raidMinConfidence: 0.65,
  raidMaxDistance: 64,
  raidMaxAgeTicks: 24,
  jointRaidGuardRadius: 8,
  jointRaidGuardThreshold: 2,
  jointRaidSlots: 2,
  jointRaidMinMilitaryPerTenant: 5,
  // Enemy Core is strategic context, not equivalent to combat units already at the door.
  threatSummary: { coreWeight: 1, unitWeight: 1, highScoreThreshold: 0.55 },
});

export interface RetreatCorridorAssessment {
  readonly tenantId: string;
  readonly pressuredDirections: readonly ThreatDirection[];
  readonly candidateDirections: readonly ThreatDirection[];
  readonly recommendedDirection: ThreatDirection | null;
  readonly waypoint: Position | null;
  readonly effectiveRisk: Readonly<Record<ThreatDirection, number>>;
  /** THREAT_ONLY: terrain/path legality remains the local planner/core-migrate driver's job. */
  readonly basis: "THREAT_ONLY";
}

export interface ShadowPolicyDecision {
  readonly treasuryTenant: string;
  readonly missions: readonly Mission[];
  readonly directives: readonly AllianceDirective[];
  readonly roles: ReadonlyMap<string, AllianceRole>;
  /** 仅当所有联合参与者都有真实 activeFleetId 时生成；仍是 shadow control contract。 */
  readonly taskForces: readonly TaskForce[];
  readonly retreatAssessments: readonly RetreatCorridorAssessment[];
}

/**
 * StrategicProfile 的 Director 消费面——strategic-policy.ts 的 StrategicPolicyProfile
 * 结构兼容（多出的字段被忽略）。missionPriority 只约束柔性战略任务，生存分支固定优先。
 */
export interface ShadowPolicyProfileSurface {
  readonly missionPriority: readonly MissionKind[];
  readonly thresholds?: Partial<ShadowDirectorPolicyConfig>;
}

function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 无 profile 时的柔性任务默认允许集（与生产 v1 行为一致：ESCORT/RAID/SCOUT 全开）。 */
const DEFAULT_MISSION_ALLOWED: readonly MissionKind[] = ["ESCORT", "RAID", "SCOUT"];

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) >= 0 ? (value as number) : fallback;
}

function resolveConfig(input: Partial<ShadowDirectorPolicyConfig>): ShadowDirectorPolicyConfig {
  return {
    directiveDurationTicks: positiveInt(input.directiveDurationTicks, DEFAULT_SHADOW_DIRECTOR_POLICY.directiveDurationTicks),
    retreatDistance: positiveInt(input.retreatDistance, DEFAULT_SHADOW_DIRECTOR_POLICY.retreatDistance),
    scoutDistance: positiveInt(input.scoutDistance, DEFAULT_SHADOW_DIRECTOR_POLICY.scoutDistance),
    retreatTotalScoreThreshold: finiteNonNegative(input.retreatTotalScoreThreshold, DEFAULT_SHADOW_DIRECTOR_POLICY.retreatTotalScoreThreshold),
    retreatDurabilityThreshold: finiteNonNegative(input.retreatDurabilityThreshold, DEFAULT_SHADOW_DIRECTOR_POLICY.retreatDurabilityThreshold),
    interceptDistance: positiveInt(input.interceptDistance, DEFAULT_SHADOW_DIRECTOR_POLICY.interceptDistance),
    minInterceptMilitary: positiveInt(input.minInterceptMilitary, DEFAULT_SHADOW_DIRECTOR_POLICY.minInterceptMilitary),
    assembleMilitaryBelow: finiteNonNegative(input.assembleMilitaryBelow, DEFAULT_SHADOW_DIRECTOR_POLICY.assembleMilitaryBelow),
    minRaidMilitary: positiveInt(input.minRaidMilitary, DEFAULT_SHADOW_DIRECTOR_POLICY.minRaidMilitary),
    raidMinConfidence: finiteNonNegative(input.raidMinConfidence, DEFAULT_SHADOW_DIRECTOR_POLICY.raidMinConfidence),
    raidMaxDistance: positiveInt(input.raidMaxDistance, DEFAULT_SHADOW_DIRECTOR_POLICY.raidMaxDistance),
    raidMaxAgeTicks: positiveInt(input.raidMaxAgeTicks, DEFAULT_SHADOW_DIRECTOR_POLICY.raidMaxAgeTicks),
    jointRaidGuardRadius: positiveInt(input.jointRaidGuardRadius, DEFAULT_SHADOW_DIRECTOR_POLICY.jointRaidGuardRadius),
    jointRaidGuardThreshold: positiveInt(input.jointRaidGuardThreshold, DEFAULT_SHADOW_DIRECTOR_POLICY.jointRaidGuardThreshold),
    jointRaidSlots: positiveInt(input.jointRaidSlots, DEFAULT_SHADOW_DIRECTOR_POLICY.jointRaidSlots),
    jointRaidMinMilitaryPerTenant: positiveInt(
      input.jointRaidMinMilitaryPerTenant, DEFAULT_SHADOW_DIRECTOR_POLICY.jointRaidMinMilitaryPerTenant,
    ),
    threatSummary: { ...DEFAULT_SHADOW_DIRECTOR_POLICY.threatSummary, ...(input.threatSummary ?? {}) },
  };
}

function manhattan(a: Position, b: Position): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function military(member: AllianceMemberState): number {
  return member.vanguards + member.rangers;
}

function directionRisk(summary: TenantThreatSummary): Record<ThreatDirection, number> {
  const raw = Object.fromEntries(summary.sectors.map((s) => [s.direction, s.score])) as Record<ThreatDirection, number>;
  const out = {} as Record<ThreatDirection, number>;
  for (let i = 0; i < DIRECTIONS.length; i += 1) {
    const d = DIRECTIONS[i]!;
    const left1 = DIRECTIONS[(i + DIRECTIONS.length - 1) % DIRECTIONS.length]!;
    const right1 = DIRECTIONS[(i + 1) % DIRECTIONS.length]!;
    const left2 = DIRECTIONS[(i + DIRECTIONS.length - 2) % DIRECTIONS.length]!;
    const right2 = DIRECTIONS[(i + 2) % DIRECTIONS.length]!;
    const value = raw[d] + 0.75 * (raw[left1] + raw[right1]) + 0.25 * (raw[left2] + raw[right2]);
    out[d] = Math.round(value * 1_000_000) / 1_000_000;
  }
  return out;
}

export function assessRetreatCorridor(
  member: AllianceMemberState,
  summary: TenantThreatSummary,
  distance = DEFAULT_SHADOW_DIRECTOR_POLICY.retreatDistance,
): RetreatCorridorAssessment {
  const risk = directionRisk(summary);
  const high = new Set(summary.highDirections);
  const candidates = [...DIRECTIONS].sort((a, b) => {
    const ah = high.has(a) ? 1 : 0;
    const bh = high.has(b) ? 1 : 0;
    return ah - bh || risk[a] - risk[b] || DIRECTIONS.indexOf(a) - DIRECTIONS.indexOf(b);
  });
  const recommendedDirection = member.core === null ? null : (candidates[0] ?? null);
  const vector = recommendedDirection === null ? null : VECTOR[recommendedDirection];
  const waypoint = member.core === null || vector === null
    ? null
    : [member.core.position[0] + vector[0] * distance, member.core.position[1] + vector[1] * distance] as const;
  return {
    tenantId: member.tenantId,
    pressuredDirections: [...summary.highDirections],
    candidateDirections: candidates,
    recommendedDirection,
    waypoint,
    effectiveRisk: risk,
    basis: "THREAT_ONLY",
  };
}

function nearestVisibleCombat(snapshot: AllianceSnapshot, member: AllianceMemberState): EntitySighting | null {
  if (member.core === null) return null;
  const candidates = snapshot.sightings
    .filter((s) => s.currentlyVisible && s.kind === "UNIT" && (s.unitType === "VANGUARD" || s.unitType === "RANGER"))
    .slice()
    .sort((a, b) => manhattan(member.core!.position, a.position) - manhattan(member.core!.position, b.position) || stableCompare(a.key, b.key));
  return candidates[0] ?? null;
}

function selectTreasury(snapshot: AllianceSnapshot, summaries: ReadonlyMap<string, TenantThreatSummary>): string {
  if (snapshot.treasuryTenant.length > 0 && snapshot.members.has(snapshot.treasuryTenant)) return snapshot.treasuryTenant;
  const members = [...snapshot.members.values()];
  if (members.length === 0) return "";
  members.sort((a, b) => {
    const at = summaries.get(a.tenantId)?.totalScore ?? 0;
    const bt = summaries.get(b.tenantId)?.totalScore ?? 0;
    return at - bt || b.resources - a.resources || stableCompare(a.tenantId, b.tenantId);
  });
  return members[0]!.tenantId;
}

function recentRaidTarget(
  snapshot: AllianceSnapshot,
  member: AllianceMemberState,
  config: ShadowDirectorPolicyConfig,
): EntitySighting | null {
  if (member.core === null) return null;
  const now = snapshot.tickWindow[1];
  return snapshot.sightings
    .filter((s) => s.kind === "CORE"
      && s.confidence >= config.raidMinConfidence
      && now - s.lastSeenTick <= config.raidMaxAgeTicks
      && manhattan(member.core!.position, s.position) <= config.raidMaxDistance)
    .slice()
    .sort((a, b) => manhattan(member.core!.position, a.position) - manhattan(member.core!.position, b.position)
      || b.confidence - a.confidence
      || stableCompare(a.key, b.key))[0] ?? null;
}

/** 目标核心周围半径内近期可见战斗单位（去重）数——守军判定。 */
function guardedCoreCombatCount(
  snapshot: AllianceSnapshot,
  target: EntitySighting,
  config: ShadowDirectorPolicyConfig,
): number {
  const now = snapshot.tickWindow[1];
  const ids = new Set<string>();
  for (const sighting of snapshot.sightings) {
    if (sighting.kind !== "UNIT" || (sighting.unitType !== "VANGUARD" && sighting.unitType !== "RANGER")) continue;
    if (sighting.confidence < 0.5 || now - sighting.lastSeenTick > config.raidMaxAgeTicks) continue;
    if (manhattan(target.position, sighting.position) > config.jointRaidGuardRadius) continue;
    ids.add(sighting.entityId ?? sighting.key);
  }
  return ids.size;
}

function missionId(revision: number, tenantId: string, kind: MissionKind): string {
  return `shadow-${revision}-${tenantId}-${kind.toLowerCase()}`;
}

function makeMission(
  snapshot: AllianceSnapshot,
  member: AllianceMemberState,
  kind: MissionKind,
  priority: number,
  duration: number,
  extra: Partial<Pick<Mission, "target" | "targetEntityKey" | "defendTenant" | "scope">> = {},
): Mission {
  const now = snapshot.tickWindow[1];
  return {
    id: missionId(snapshot.revision, member.tenantId, kind),
    revision: snapshot.revision,
    kind,
    priority,
    issuedAtTick: now,
    expiresAtTick: now + duration,
    status: "PROPOSED",
    source: "AUTO",
    ...extra,
  };
}

/**
 * Pure, deterministic shadow policy. Never returns Arena actions.
 *
 * @param profile 可选 StrategicProfile 消费面：thresholds 覆盖 config；
 *   missionPriority 决定柔性战略任务（ESCORT/RAID/SCOUT）的允许集与取舍顺序。
 */
export function decideAllianceShadowPolicy(
  snapshot: AllianceSnapshot,
  configInput: Partial<ShadowDirectorPolicyConfig> = {},
  profile?: ShadowPolicyProfileSurface,
): ShadowPolicyDecision {
  // profile.thresholds 是策略卡的参数覆盖（编译时注册，不含 undefined 键）
  const config = resolveConfig({ ...configInput, ...(profile?.thresholds ?? {}) });
  // 柔性任务允许集：profile 未传时全开（生产 v1 行为）；profile 传入时未列出的 kind 不产出
  // （生存分支 RETREAT/INTERCEPT/DEFEND/ASSEMBLE 恒允许，不受 profile 约束）
  const allowed = new Set<MissionKind>([
    ...(profile?.missionPriority ?? []),
    ...(profile === undefined ? DEFAULT_MISSION_ALLOWED : []),
  ]);
  const summaries = buildAllianceThreatSummariesFromSnapshot(snapshot, config.threatSummary);
  const summaryByTenant = new Map(summaries.map((s) => [s.tenantId, s] as const));
  const members = [...snapshot.members.values()].sort((a, b) => stableCompare(a.tenantId, b.tenantId));
  const treasuryTenant = selectTreasury(snapshot, summaryByTenant);
  const missionsByTenant = new Map<string, Mission>();
  const retreatAssessments: RetreatCorridorAssessment[] = [];

  // Phase A — mandatory local survival missions. Flexible members are intentionally left
  // unassigned so Phase B can clear global tasks across the whole alliance instead of
  // running four independent single-agent policies side by side.
  for (const member of members) {
    const summary = summaryByTenant.get(member.tenantId)!;
    const duration = config.directiveDurationTicks;
    if (member.core === null || member.status === "RESPAWNING") {
      missionsByTenant.set(member.tenantId, makeMission(snapshot, member, "ASSEMBLE", 80, duration, {
        defendTenant: member.tenantId, scope: "rebuild-before-external-task",
      }));
      continue;
    }
    const durability = member.core.hp + member.core.shield;
    if (summary.multiDirectionPressure
      && (summary.totalScore >= config.retreatTotalScoreThreshold || durability <= config.retreatDurabilityThreshold)) {
      const assessment = assessRetreatCorridor(member, summary, config.retreatDistance);
      retreatAssessments.push(assessment);
      missionsByTenant.set(member.tenantId, makeMission(snapshot, member, "RETREAT", 100, duration, {
        target: assessment.waypoint ?? undefined, defendTenant: member.tenantId,
        scope: `threat-only-corridor:${assessment.recommendedDirection ?? "none"}`,
      }));
      continue;
    }
    const nearest = nearestVisibleCombat(snapshot, member);
    if (nearest !== null && manhattan(member.core.position, nearest.position) <= config.interceptDistance) {
      const kind: MissionKind = military(member) >= config.minInterceptMilitary ? "INTERCEPT" : "DEFEND";
      missionsByTenant.set(member.tenantId, makeMission(snapshot, member, kind, kind === "INTERCEPT" ? 90 : 95, duration, {
        target: kind === "INTERCEPT" ? nearest.position : member.core.position,
        targetEntityKey: kind === "INTERCEPT" ? nearest.key : undefined,
        defendTenant: member.tenantId,
        scope: kind === "INTERCEPT" ? "visible-combat-near-core" : "understrength-home-defense",
      }));
      continue;
    }
    if (summary.highDirections.length > 0) {
      missionsByTenant.set(member.tenantId, makeMission(snapshot, member, "DEFEND", 85, duration, {
        target: member.core.position, defendTenant: member.tenantId,
        scope: `directional-pressure:${summary.highDirections.join("+")}`,
      }));
    }
  }

  // Phase B — global task market. Under pressure, free tenants bid to reinforce threatened
  // allies. In calm periods they bid on fresh enemy-Core raids. Central clearing is the
  // Supervisor equivalent of a CBBA auction: utility contains force, travel, local threat,
  // resources and a treasury-preservation penalty; Hungarian clearing removes greedy traps.
  const flexibleMembers = members.filter((member) => !missionsByTenant.has(member.tenantId));
  const marketTasks: AllianceMarketTask[] = [];
  const urgentMissions = [...missionsByTenant.entries()]
    .filter(([, mission]) => mission.kind === "DEFEND" || mission.kind === "INTERCEPT")
    .sort((a, b) => b[1].priority - a[1].priority || stableCompare(a[0], b[0]));
  if (allowed.has("ESCORT") && urgentMissions.length > 0) {
    for (const [tenantId, mission] of urgentMissions) {
      const defended = snapshot.members.get(tenantId);
      if (defended?.core === null || defended?.core === undefined) continue;
      marketTasks.push({
        id: `assist-${snapshot.revision}-${tenantId}`, kind: "ESCORT", priority: Math.max(72, mission.priority - 8),
        target: defended.core.position, defendTenant: tenantId, minMilitary: 2, maxDistance: config.raidMaxDistance,
      });
    }
  } else if (allowed.has("RAID")) {
    const now = snapshot.tickWindow[1];
    const coreTargets = snapshot.sightings
      .filter((s) => s.kind === "CORE" && s.confidence >= config.raidMinConfidence && now - s.lastSeenTick <= config.raidMaxAgeTicks)
      .slice()
      .sort((a, b) => b.confidence - a.confidence || b.lastSeenTick - a.lastSeenTick || stableCompare(a.key, b.key));
    for (const target of coreTargets) {
      const guardCount = guardedCoreCombatCount(snapshot, target, config);
      const joint = guardCount >= config.jointRaidGuardThreshold;
      marketTasks.push({
        id: `raid-${snapshot.revision}-${target.key}`, kind: "RAID",
        priority: 70 + Math.round(target.confidence * 8) + (joint ? 2 : 0),
        target: target.position, targetEntityKey: target.key,
        minMilitary: joint ? config.jointRaidMinMilitaryPerTenant : config.minRaidMilitary,
        maxDistance: config.raidMaxDistance,
        slotCount: joint ? config.jointRaidSlots : 1,
      });
    }
  }

  const market = allocateAllianceTaskMarket(flexibleMembers, marketTasks, summaryByTenant, treasuryTenant);
  for (const assignment of market.assignments) {
    const member = snapshot.members.get(assignment.tenantId)!;
    const task = assignment.task;
    missionsByTenant.set(member.tenantId, makeMission(snapshot, member, task.kind, task.priority, config.directiveDurationTicks, {
      target: task.target, targetEntityKey: task.targetEntityKey, defendTenant: task.defendTenant,
      scope: `alliance-market:utility=${assignment.bid.utility}:distance=${assignment.bid.distance}`,
    }));
  }

  // Multi-slot RAID → existing TaskForce contract. Never fabricate fleet ids: every selected
  // tenant must report at least one activeFleetId, otherwise only per-tenant ASSIST missions remain.
  const taskForces: TaskForce[] = [];
  const raidGroups = new Map<string, typeof market.assignments>();
  for (const assignment of market.assignments) {
    if (assignment.task.kind !== "RAID") continue;
    const group = assignment.task.baseTaskId ?? assignment.task.id;
    raidGroups.set(group, [...(raidGroups.get(group) ?? []), assignment]);
  }
  for (const [groupId, assignments] of raidGroups) {
    if (assignments.length < 2) continue;
    const ranked = [...assignments].sort((a, b) =>
      b.bid.utility - a.bid.utility || stableCompare(a.tenantId, b.tenantId));
    const refs = ranked.flatMap((assignment) => {
      const member = snapshot.members.get(assignment.tenantId);
      // 联合攻坚只引用真实 strike fleet；home-defense 永不被 TaskForce 借走。
      const fleetId = member?.activeFleetIds
        .filter((id) => id.includes(":strike:"))
        .slice().sort(stableCompare)[0];
      return fleetId === undefined ? [] : [{ fleetId, tenantId: assignment.tenantId }];
    });
    if (refs.length !== assignments.length) continue;
    const commanderTenant = ranked[0]!.tenantId;
    const commanderMission = missionsByTenant.get(commanderTenant);
    if (commanderMission === undefined) continue;
    taskForces.push({
      id: `shadow-tf-${snapshot.revision}-${groupId}`,
      missionId: commanderMission.id,
      fleetRefs: refs,
      commanderTenant,
      synchronization: "RALLY_BEFORE_ENGAGE",
    });
  }

  // Phase C — local fallback for market-unassigned members.
  for (const member of flexibleMembers) {
    if (missionsByTenant.has(member.tenantId)) continue;
    if (military(member) < config.assembleMilitaryBelow) {
      missionsByTenant.set(member.tenantId, makeMission(snapshot, member, "ASSEMBLE", 60, config.directiveDurationTicks, {
        target: member.core?.position, defendTenant: member.tenantId, scope: "military-below-shadow-floor",
      }));
      continue;
    }
    if (allowed.has("SCOUT")) {
      const summary = summaryByTenant.get(member.tenantId)!;
      const scout = assessRetreatCorridor(member, summary, config.scoutDistance);
      missionsByTenant.set(member.tenantId, makeMission(snapshot, member, "SCOUT", 40, config.directiveDurationTicks, {
        target: scout.waypoint ?? member.core?.position, scope: `low-risk-sector:${scout.recommendedDirection ?? "none"}`,
      }));
      continue;
    }
    // Profile 禁用 SCOUT（如 defend-only）时的安全兜底：守家。
    missionsByTenant.set(member.tenantId, makeMission(snapshot, member, "DEFEND", 50, config.directiveDurationTicks, {
      target: member.core?.position, defendTenant: member.tenantId, scope: "profile-undefined-fallback",
    }));
  }

  const missions = [...missionsByTenant.values()].sort((a, b) => stableCompare(a.id, b.id));
  const roles = new Map<string, AllianceRole>();
  const directives: AllianceDirective[] = [];
  for (const member of members) {
    const mission = missionsByTenant.get(member.tenantId)!;
    const role: AllianceRole = mission.kind === "RAID"
      ? "RAIDER"
      : mission.kind === "SCOUT"
        ? "SCOUT"
        : (mission.kind === "DEFEND" || mission.kind === "INTERCEPT" || mission.kind === "RETREAT" || mission.kind === "ESCORT")
          ? "DEFENDER"
          : member.tenantId === treasuryTenant ? "TREASURY" : "DEFENDER";
    roles.set(member.tenantId, role);
    directives.push({
      tenantId: member.tenantId,
      revision: snapshot.revision,
      missionRefs: [mission.id],
      issuedAtTick: snapshot.tickWindow[1],
      expiresAtTick: snapshot.tickWindow[1] + config.directiveDurationTicks,
      source: "auto",
      // ASSIST is intentional: the v1 policy is shadow advice, not action ownership.
      mode: "ASSIST",
      explanation: `shadow-policy role=${role} mission=${mission.kind} scope=${mission.scope ?? ""}`,
    });
  }

  return {
    treasuryTenant,
    missions,
    directives,
    roles,
    taskForces: taskForces.sort((a, b) => stableCompare(a.id, b.id)),
    retreatAssessments: retreatAssessments.sort((a, b) => stableCompare(a.tenantId, b.tenantId)),
  };
}
