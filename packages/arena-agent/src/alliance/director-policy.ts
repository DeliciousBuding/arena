/**
 * Pure Alliance Shadow Director policy.
 *
 * Produces auditable Missions + ASSIST directives only. It has no Arena Plan/action,
 * no submit capability and RETREAT is a threat-feasible recommendation, not START_MOVE.
 *
 * Strategic policy integration (2026-08-08):
 * - Accepts optional strategyName / strategicProfile in config
 * - missionPriority from the profile drives per-member evaluation order
 * - thresholds from the profile override ShadowDirectorPolicyConfig
 * - roleFor from the profile replaces hardcoded role mapping
 * - contentHash recorded in mission/directive metadata for audit
 */
import type { AllianceSnapshot, AllianceMemberState, EntitySighting, Position } from "./types.ts";
import type {
  AllianceDirective,
  AllianceRole,
  Mission,
  MissionKind,
} from "./control-types.ts";
import {
  buildAllianceThreatSummariesFromSnapshot,
  type TenantThreatSummary,
  type ThreatDirection,
  type ThreatSummaryConfig,
} from "./threat-summary.ts";
import type { StrategicPolicyProfile } from "./strategic-policy.ts";
import { STRATEGIC_REGISTRY } from "./strategic-policy.ts";

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
  readonly threatSummary: Partial<ThreatSummaryConfig>;
  /** 策略名（registry key）。指定后使用该 profile 的 missionPriority + thresholds + roleFor。
   *  未指定时使用 "balanced"（= v1 硬编码行为）。 */
  readonly strategyName?: string;
  /** 直接注入 StrategicPolicyProfile（优先级高于 strategyName）。用于测试与确定性注入。 */
  readonly strategicProfile?: StrategicPolicyProfile;
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
  readonly retreatAssessments: readonly RetreatCorridorAssessment[];
}

function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

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
    threatSummary: { ...DEFAULT_SHADOW_DIRECTOR_POLICY.threatSummary, ...(input.threatSummary ?? {}) },
    strategyName: input.strategyName,
    strategicProfile: input.strategicProfile,
  };
}

/** Resolve the strategic profile: explicit profile > strategyName lookup > registry default. */
function resolveStrategicProfile(input: Partial<ShadowDirectorPolicyConfig>): StrategicPolicyProfile {
  if (input.strategicProfile) return input.strategicProfile;
  if (input.strategyName) {
    const found = STRATEGIC_REGISTRY.get(input.strategyName);
    if (found) return found;
    // Invalid strategyName → fall back to default (fail-safe, don't crash Director)
  }
  return STRATEGIC_REGISTRY.get(STRATEGIC_REGISTRY.defaultName)!;
}

/** Merge profile thresholds into base config (profile wins on defined keys). */
function applyProfileThresholds(
  base: ShadowDirectorPolicyConfig,
  profile: StrategicPolicyProfile,
): ShadowDirectorPolicyConfig {
  const t = profile.thresholds;
  if (!t) return base;
  return {
    ...base,
    ...(t.directiveDurationTicks !== undefined ? { directiveDurationTicks: positiveInt(t.directiveDurationTicks, base.directiveDurationTicks) } : {}),
    ...(t.retreatDistance !== undefined ? { retreatDistance: positiveInt(t.retreatDistance, base.retreatDistance) } : {}),
    ...(t.scoutDistance !== undefined ? { scoutDistance: positiveInt(t.scoutDistance, base.scoutDistance) } : {}),
    ...(t.retreatTotalScoreThreshold !== undefined ? { retreatTotalScoreThreshold: finiteNonNegative(t.retreatTotalScoreThreshold, base.retreatTotalScoreThreshold) } : {}),
    ...(t.retreatDurabilityThreshold !== undefined ? { retreatDurabilityThreshold: finiteNonNegative(t.retreatDurabilityThreshold, base.retreatDurabilityThreshold) } : {}),
    ...(t.interceptDistance !== undefined ? { interceptDistance: positiveInt(t.interceptDistance, base.interceptDistance) } : {}),
    ...(t.minInterceptMilitary !== undefined ? { minInterceptMilitary: positiveInt(t.minInterceptMilitary, base.minInterceptMilitary) } : {}),
    ...(t.assembleMilitaryBelow !== undefined ? { assembleMilitaryBelow: finiteNonNegative(t.assembleMilitaryBelow, base.assembleMilitaryBelow) } : {}),
    ...(t.minRaidMilitary !== undefined ? { minRaidMilitary: positiveInt(t.minRaidMilitary, base.minRaidMilitary) } : {}),
    ...(t.raidMinConfidence !== undefined ? { raidMinConfidence: finiteNonNegative(t.raidMinConfidence, base.raidMinConfidence) } : {}),
    ...(t.raidMaxDistance !== undefined ? { raidMaxDistance: positiveInt(t.raidMaxDistance, base.raidMaxDistance) } : {}),
    ...(t.raidMaxAgeTicks !== undefined ? { raidMaxAgeTicks: positiveInt(t.raidMaxAgeTicks, base.raidMaxAgeTicks) } : {}),
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

// ── Per-MissionKind condition helpers (pure, deterministic) ─────
// Each returns a Mission if the condition matches for this member, null otherwise.
// These are the "leaf rules"; the strategic profile controls evaluation ORDER via missionPriority.

function tryRetreatMission(
  snapshot: AllianceSnapshot, member: AllianceMemberState,
  summary: TenantThreatSummary, config: ShadowDirectorPolicyConfig,
  retreatAssessments: RetreatCorridorAssessment[],
): Mission | null {
  if (member.core === null) return null;
  const durability = member.core.hp + member.core.shield;
  if (!summary.multiDirectionPressure) return null;
  if (summary.totalScore < config.retreatTotalScoreThreshold && durability > config.retreatDurabilityThreshold) return null;
  const assessment = assessRetreatCorridor(member, summary, config.retreatDistance);
  retreatAssessments.push(assessment);
  return makeMission(snapshot, member, "RETREAT", 100, config.directiveDurationTicks, {
    target: assessment.waypoint ?? undefined,
    defendTenant: member.tenantId,
    scope: `threat-only-corridor:${assessment.recommendedDirection ?? "none"}`,
  });
}

function tryInterceptMission(
  snapshot: AllianceSnapshot, member: AllianceMemberState, config: ShadowDirectorPolicyConfig,
): Mission | null {
  if (member.core === null) return null;
  const nearest = nearestVisibleCombat(snapshot, member);
  if (nearest === null || manhattan(member.core.position, nearest.position) > config.interceptDistance) return null;
  const kind: MissionKind = military(member) >= config.minInterceptMilitary ? "INTERCEPT" : "DEFEND";
  return makeMission(snapshot, member, kind, kind === "INTERCEPT" ? 90 : 95, config.directiveDurationTicks, {
    target: kind === "INTERCEPT" ? nearest.position : member.core.position,
    targetEntityKey: kind === "INTERCEPT" ? nearest.key : undefined,
    defendTenant: member.tenantId,
    scope: kind === "INTERCEPT" ? "visible-combat-near-core" : "understrength-home-defense",
  });
}

function tryDefendMission(
  snapshot: AllianceSnapshot, member: AllianceMemberState,
  summary: TenantThreatSummary, config: ShadowDirectorPolicyConfig,
): Mission | null {
  if (summary.highDirections.length === 0) return null;
  return makeMission(snapshot, member, "DEFEND", 85, config.directiveDurationTicks, {
    target: member.core?.position,
    defendTenant: member.tenantId,
    scope: `directional-pressure:${summary.highDirections.join("+")}`,
  });
}

function tryAssembleMission(
  snapshot: AllianceSnapshot, member: AllianceMemberState, config: ShadowDirectorPolicyConfig,
): Mission | null {
  if (military(member) >= config.assembleMilitaryBelow) return null;
  return makeMission(snapshot, member, "ASSEMBLE", 60, config.directiveDurationTicks, {
    target: member.core?.position,
    defendTenant: member.tenantId,
    scope: "military-below-shadow-floor",
  });
}

function tryScoutMission(
  snapshot: AllianceSnapshot, member: AllianceMemberState,
  summary: TenantThreatSummary, config: ShadowDirectorPolicyConfig,
): Mission | null {
  const scout = assessRetreatCorridor(member, summary, config.scoutDistance);
  return makeMission(snapshot, member, "SCOUT", 40, config.directiveDurationTicks, {
    target: scout.waypoint ?? member.core?.position ?? [0, 0],
    scope: `low-risk-sector:${scout.recommendedDirection ?? "none"}`,
  });
}

// Per-member, strategy-ordered evaluation (RETREAT/INTERCEPT/DEFEND/ASSEMBLE/SCOUT)
// ESCORT and RESERVE are meta-strategies expressed via missionPriority ordering
// (ESCORT = DEFEND-first, RESERVE = ASSEMBLE-first) rather than new mission kinds.
const MEMBER_RULES: Record<string, (snapshot: AllianceSnapshot, member: AllianceMemberState, summary: TenantThreatSummary, config: ShadowDirectorPolicyConfig, retreatAssessments: RetreatCorridorAssessment[]) => Mission | null> = {
  RETREAT: (s, m, sum, cfg, ra) => tryRetreatMission(s, m, sum, cfg, ra),
  INTERCEPT: (s, m, _sum, cfg, _ra) => tryInterceptMission(s, m, cfg),
  DEFEND: (s, m, sum, cfg, _ra) => tryDefendMission(s, m, sum, cfg),
  ASSEMBLE: (s, m, _sum, cfg, _ra) => tryAssembleMission(s, m, cfg),
  SCOUT: (s, m, sum, cfg, _ra) => tryScoutMission(s, m, sum, cfg),
};

/** Pure, deterministic shadow policy. Never returns Arena actions.
 *
 *  Strategic profile integration (2026-08-08):
 *  - Resolves profile from config.strategicProfile > config.strategyName > registry default
 *  - Profile thresholds merged into config (profile wins on defined keys)
 *  - Per-member evaluation iterates profile.missionPriority (not hardcoded order)
 *  - RESPAWNING/Core-null is always ASSEMBLE first (safety invariant, not profile-driven)
 *  - RAID is checked after per-member evaluation if no urgent missions exist
 *  - roleFor() replaces hardcoded role mapping
 *  - mode is always "ASSIST" (hard constraint, profile cannot override)
 *  - profile contentHash recorded in mission scope and directive explanation */
export function decideAllianceShadowPolicy(
  snapshot: AllianceSnapshot,
  configInput: Partial<ShadowDirectorPolicyConfig> = {},
): ShadowPolicyDecision {
  const baseConfig = resolveConfig(configInput);
  const profile = resolveStrategicProfile(configInput);
  const config = applyProfileThresholds(baseConfig, profile);
  const summaries = buildAllianceThreatSummariesFromSnapshot(snapshot, config.threatSummary);
  const summaryByTenant = new Map(summaries.map((s) => [s.tenantId, s] as const));
  const members = [...snapshot.members.values()].sort((a, b) => stableCompare(a.tenantId, b.tenantId));
  const treasuryTenant = selectTreasury(snapshot, summaryByTenant);
  const missionsByTenant = new Map<string, Mission>();
  const retreatAssessments: RetreatCorridorAssessment[] = [];

  for (const member of members) {
    const summary = summaryByTenant.get(member.tenantId)!;

    // Safety invariant: RESPAWNING or no core always gets ASSEMBLE first.
    // This is NOT strategy-driven — a dead member cannot execute any strategy.
    if (member.core === null || member.status === "RESPAWNING") {
      missionsByTenant.set(member.tenantId, makeMission(snapshot, member, "ASSEMBLE", 80, config.directiveDurationTicks, {
        defendTenant: member.tenantId,
        scope: `rebuild-before-external-task profile=${profile.name}@${profile.contentHash}`,
      }));
      continue;
    }

    // Strategy-driven evaluation: iterate profile.missionPriority, first match wins.
    let mission: Mission | null = null;
    for (const kind of profile.missionPriority) {
      const rule = MEMBER_RULES[kind];
      if (rule === undefined) continue; // skip kinds without rules (ESCORT/RESERVE are meta)
      const candidate = rule(snapshot, member, summary, config, retreatAssessments);
      if (candidate !== null) {
        mission = candidate;
        break;
      }
    }
    // Fallback: if no rule matched, use the last entry in missionPriority
    // as catch-all. If that also fails (condition not met), use ASSEMBLE
    // unconditionally — it is always safe (stay home, build up).
    if (mission === null) {
      const fallbackKind = profile.missionPriority[profile.missionPriority.length - 1] ?? "ASSEMBLE";
      const fallbackRule = MEMBER_RULES[fallbackKind];
      mission = fallbackRule?.(snapshot, member, summary, config, retreatAssessments) ?? null;
      if (mission === null) {
        // Ultimate safety net: ASSEMBLE without condition check
        mission = makeMission(snapshot, member, "ASSEMBLE", 60, config.directiveDurationTicks, {
          target: member.core?.position,
          defendTenant: member.tenantId,
          scope: `fallback:no-rule-matched profile=${profile.name}@${profile.contentHash}`,
        });
      }
    }
    missionsByTenant.set(member.tenantId, mission);
  }

  // RAID: post-loop check. Evaluated when no member has an urgent defensive mission.
  // Profile controls whether RAID appears in missionPriority and with what thresholds.
  if (profile.missionPriority.includes("RAID")) {
    const hasUrgent = [...missionsByTenant.values()].some(
      (m) => m.kind === "RETREAT" || m.kind === "DEFEND" || m.kind === "INTERCEPT",
    );
    if (!hasUrgent) {
      const raidCandidates = members
        .filter((m) => m.core !== null && m.status === "READY" && military(m) >= config.minRaidMilitary)
        .sort((a, b) => military(b) - military(a)
          || (a.tenantId === treasuryTenant ? 1 : 0) - (b.tenantId === treasuryTenant ? 1 : 0)
          || stableCompare(a.tenantId, b.tenantId));
      for (const member of raidCandidates) {
        const target = recentRaidTarget(snapshot, member, config);
        if (target === null) continue;
        missionsByTenant.set(member.tenantId, makeMission(snapshot, member, "RAID", 70, config.directiveDurationTicks, {
          target: target.position,
          targetEntityKey: target.key,
          scope: `recent-high-confidence-enemy-core profile=${profile.name}@${profile.contentHash}`,
        }));
        break;
      }
    }
  }

  const missions = [...missionsByTenant.values()].sort((a, b) => stableCompare(a.id, b.id));
  const roles = new Map<string, AllianceRole>();
  const directives: AllianceDirective[] = [];
  for (const member of members) {
    const mission = missionsByTenant.get(member.tenantId)!;
    const role: AllianceRole = profile.roleFor(mission.kind, treasuryTenant, member.tenantId);
    roles.set(member.tenantId, role);
    directives.push({
      tenantId: member.tenantId,
      revision: snapshot.revision,
      missionRefs: [mission.id],
      issuedAtTick: snapshot.tickWindow[1],
      expiresAtTick: snapshot.tickWindow[1] + config.directiveDurationTicks,
      source: "auto",
      // ASSIST is a hard constraint: the policy is shadow advice, not action ownership.
      // No profile can change this.
      mode: "ASSIST",
      explanation: `shadow-policy profile=${profile.name}@${profile.contentHash} role=${role} mission=${mission.kind} scope=${mission.scope ?? ""}`,
    });
  }

  return {
    treasuryTenant,
    missions,
    directives,
    roles,
    retreatAssessments: retreatAssessments.sort((a, b) => stableCompare(a.tenantId, b.tenantId)),
  };
}
