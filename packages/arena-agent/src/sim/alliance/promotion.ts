/** Alliance shadow evidence gate. Passing never authorizes live control. */
import type { EpisodeResult } from "../harness/episode.ts";
import type { AllianceEpisodeResult } from "./types.ts";
import type { MissionKind } from "../../alliance/control-types.ts";

export type AllianceShadowPromotionDecision = "SHADOW_READY" | "HOLD" | "REJECT";
export interface AllianceShadowGate {
  readonly name: string;
  readonly pass: boolean;
  readonly actual: number | string | boolean;
  readonly expected: string;
  readonly severity: "HARD" | "EVIDENCE";
}
export interface AllianceFaultEvidence {
  readonly name: string;
  readonly baseline: EpisodeResult;
  readonly candidate: AllianceEpisodeResult;
}
export interface AllianceShadowPromotionInput {
  readonly baseline: EpisodeResult;
  readonly candidate: AllianceEpisodeResult;
  readonly deterministicReplayMatch: boolean;
  readonly faultEvidence?: readonly AllianceFaultEvidence[];
  readonly requiredMissionKinds?: readonly MissionKind[];
  readonly requireRetreatRecommendation?: boolean;
  readonly minFallbackAvailability?: number;
}
export interface AllianceShadowPromotionResult {
  readonly decision: AllianceShadowPromotionDecision;
  readonly maxAuthorizedStage: "SHADOW_READY";
  readonly gates: readonly AllianceShadowGate[];
  readonly reasons: readonly string[];
}

function g(name: string, pass: boolean, actual: number | string | boolean, expected: string, severity: "HARD" | "EVIDENCE" = "HARD"): AllianceShadowGate {
  return Object.freeze({ name, pass, actual, expected, severity });
}
function clampThreshold(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) >= 0 && (value as number) <= 1 ? value as number : 0.99;
}
function shadowOnly(result: AllianceEpisodeResult): boolean {
  return result.trace.every((entry) => entry.evaluations.every((e) => e.planSource === "baseline" || e.planSource === "baseline-shadow"));
}
function faultFailOpen(item: AllianceFaultEvidence): boolean {
  return item.candidate.episode.finalWorldHash === item.baseline.finalWorldHash
    && item.candidate.episode.records.length === item.baseline.records.length
    && item.candidate.episode.metrics.illegalPlans === item.baseline.metrics.illegalPlans
    && item.candidate.kpi.expiredDirectiveConsumed === 0
    && item.candidate.kpi.allianceSafetyRejectCount === 0
    && shadowOnly(item.candidate);
}

export function evaluateAllianceShadowPromotion(input: AllianceShadowPromotionInput): AllianceShadowPromotionResult {
  const candidate = input.candidate;
  const minAvailability = clampThreshold(input.minFallbackAvailability);
  const missionKinds = new Set(candidate.trace.flatMap((entry) => entry.missionKinds));
  const retreats = candidate.trace.reduce((sum, entry) => sum + entry.retreatRecommendationCount, 0);
  const faults = input.faultEvidence ?? [];
  const failedFaults = faults.filter((item) => !faultFailOpen(item)).map((item) => item.name).sort();
  const gates: AllianceShadowGate[] = [
    g("baseline_world_equivalence", candidate.episode.finalWorldHash === input.baseline.finalWorldHash, candidate.episode.finalWorldHash, input.baseline.finalWorldHash),
    g("baseline_record_count_equivalence", candidate.episode.records.length === input.baseline.records.length, candidate.episode.records.length, `== ${input.baseline.records.length}`),
    g("no_illegal_plan_regression", candidate.episode.metrics.illegalPlans === input.baseline.metrics.illegalPlans, candidate.episode.metrics.illegalPlans, `== baseline ${input.baseline.metrics.illegalPlans}`),
    g("friendly_fire_metric_supported", candidate.kpi.friendlyFireMetricSupported, candidate.kpi.friendlyFireMetricSupported, "true"),
    g("no_alliance_friendly_fire", candidate.kpi.allianceSafetyRejectCount === 0, candidate.kpi.allianceSafetyRejectCount, "== 0"),
    g("no_expired_directive_consumed", candidate.kpi.expiredDirectiveConsumed === 0, candidate.kpi.expiredDirectiveConsumed, "== 0"),
    g("nominal_director_no_error", candidate.kpi.directorErrorCount === 0, candidate.kpi.directorErrorCount, "== 0"),
    g("fallback_availability", candidate.kpi.fallbackAvailability >= minAvailability, candidate.kpi.fallbackAvailability, `>= ${minAvailability}`),
    g("shadow_only_plan_source", shadowOnly(candidate), shadowOnly(candidate), "baseline/baseline-shadow only"),
    g("deterministic_replay", input.deterministicReplayMatch, input.deterministicReplayMatch, "true"),
    g("fault_injection_fail_open", failedFaults.length === 0, failedFaults.length === 0 ? `${faults.length}/${faults.length}` : failedFaults.join(","), "all fault runs world-equivalent + shadow-only"),
  ];
  for (const kind of [...new Set(input.requiredMissionKinds ?? [])]) {
    gates.push(g(`mission_evidence_${kind.toLowerCase()}`, missionKinds.has(kind), missionKinds.has(kind), `observed ${kind}`, "EVIDENCE"));
  }
  if (input.requireRetreatRecommendation) gates.push(g("retreat_corridor_evidence", retreats > 0, retreats, "> 0", "EVIDENCE"));
  const hard = gates.filter((item) => item.severity === "HARD" && !item.pass);
  const evidence = gates.filter((item) => item.severity === "EVIDENCE" && !item.pass);
  const decision: AllianceShadowPromotionDecision = hard.length ? "REJECT" : evidence.length ? "HOLD" : "SHADOW_READY";
  const reasons = [...hard.map((item) => `${item.name}: ${String(item.actual)} (${item.expected})`), ...evidence.map((item) => `${item.name}: missing ${item.expected}`)];
  return Object.freeze({ decision, maxAuthorizedStage: "SHADOW_READY", gates: Object.freeze(gates), reasons: Object.freeze(reasons) });
}

