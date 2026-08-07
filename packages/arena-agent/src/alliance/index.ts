/**
 * Alliance Director — 合同层 barrel export（Phase 0 contract freeze）。
 *
 * 约束：
 * - 不含 Arena token、Plan、CandidateSink——合同层不能成为 writer；
 * - 所有导出为纯类型或纯函数，严格 deterministic、无 I/O；
 * - 供后续 intel/sim/runtime 三个并行分支 cherry-pick 后使用。
 *
 * 最后更新：2026-08-08
 */

// 核心类型
export type {
  AllianceRole,
  ControlMode,
  SightingKind,
  SightingEvidence,
  EntitySighting,
  MemberStatus,
  AllianceMemberReport,
  AllianceSnapshot,
  FleetState,
  FormationType,
  FleetRef,
  TaskForce,
  MissionKind,
  MissionStatus,
  MissionSource,
  Mission,
  DirectiveSource,
  AllianceDirective,
} from "./types.ts";

// Mission 助手
export {
  DEFAULT_MISSION_STALE_TICKS,
  isMissionExpired,
  isMissionTerminal,
  isMissionActive,
  isMissionStale,
  isNewerMissionRevision,
  compareMissionRevision,
  latestMission,
} from "./mission.ts";

// Member report / Sighting 助手
export {
  DEFAULT_REPORT_STALE_TICKS,
  DEFAULT_SIGHTING_FRESH_TICKS,
  DEFAULT_CONFIDENCE_TAU,
  CONFIDENCE_FLOOR,
  isMemberReportStale,
  sightingAge,
  isSightingFresh,
  computeConfidence,
  freshSightings,
  groupSightingsByOwner,
  validateSnapshot,
} from "./member-report.ts";

// Directive 助手
export {
  DEFAULT_DIRECTIVE_STALE_TICKS,
  MAX_DIRECTIVE_DURATION_TICKS,
  isDirectiveExpired,
  isDirectivePending,
  isDirectiveActive,
  isDirectiveStale,
  isNewerRevision,
  compareRevision,
  validateDirectiveForTenant,
  evaluateDirective,
} from "./directive.ts";

// Fleet / TaskForce 助手
export {
  validateFleetRefForTenant,
  fleetRefsForTenant,
} from "./fleet.ts";

export type {
  DirectiveValidationIssue,
  DirectiveValidationResult,
} from "./directive.ts";

// Shared intelligence fusion
export type {
  SharedIntelConfig,
  IntelFreshness,
  FusedEntitySighting,
  SharedIntelCounts,
  SharedIntelView,
  AggregateAllianceIntelInput,
} from "./shared-intel.ts";
export {
  DEFAULT_SHARED_INTEL_CONFIG,
  resolveSharedIntelConfig,
  fuseEntitySightings,
  aggregateAllianceIntel,
} from "./shared-intel.ts";

// Sparse threat summaries
export type {
  ThreatDirection,
  ThreatFieldConfig,
  ThreatSector,
  TenantThreatSummary,
} from "./threat-field.ts";
export {
  DEFAULT_THREAT_FIELD_CONFIG,
  resolveThreatFieldConfig,
  threatDirection,
  buildAllianceThreatSummaries,
} from "./threat-field.ts";