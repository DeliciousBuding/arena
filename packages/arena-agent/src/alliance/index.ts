/**
 * Alliance public surface.
 *
 * Canonical world/intel domain:
 *   types / sightings / counts / threat-field / roster / snapshot
 * Control plane:
 *   control-types / mission / directive / fleet / member-report / runtime
 * Derived views:
 *   shared-intel / threat-summary
 */
export * from "./types.ts";
export * from "./sightings.ts";
export * from "./counts.ts";
export * from "./threat-field.ts";
export * from "./roster.ts";
export * from "./snapshot.ts";

export type {
  AllianceMemberReport,
  MemberStatus,
  AllianceRole,
  ControlMode,
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
} from "./control-types.ts";

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

export {
  DEFAULT_REPORT_STALE_TICKS,
  DEFAULT_SIGHTING_FRESH_TICKS,
  DEFAULT_CONFIDENCE_TAU,
  REPORT_CONFIDENCE_FLOOR,
  isMemberReportStale,
  sightingAge,
  isSightingFresh,
  computeConfidence,
  freshSightings,
  groupSightingsByOwner,
  validateSnapshot,
} from "./member-report.ts";

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
export type { DirectiveValidationIssue, DirectiveValidationResult } from "./directive.ts";

export { validateFleetRefForTenant, fleetRefsForTenant } from "./fleet.ts";

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

export type {
  ThreatDirection,
  ThreatSummaryConfig,
  ThreatSector,
  TenantThreatSummary,
} from "./threat-summary.ts";
export {
  DEFAULT_THREAT_SUMMARY_CONFIG,
  resolveThreatSummaryConfig,
  threatDirection,
  buildAllianceThreatSummaries,
} from "./threat-summary.ts";
