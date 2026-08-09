/**
 * Candidate ↔ MacroPolicy semantics for M2.
 *
 * The learned candidate contract is broader than the current MacroPolicy
 * surface (e.g. MIGRATE is owned by the migration subsystem). This module is
 * the single explicit adapter for candidates that CAN be represented as a
 * MacroPolicy mutation. Unsupported candidates return null instead of being
 * guessed.
 */

import type { MacroPolicy } from "../../runtime/macro-policy.ts";
import type { DecisionCandidateV1 } from "./decision-candidate-v1.ts";

export function macroPoliciesEqual(a: MacroPolicy, b: MacroPolicy): boolean {
  return a.posture === b.posture &&
    a.workerTarget === b.workerTarget &&
    a.militaryRatio === b.militaryRatio &&
    a.attackPriority === b.attackPriority &&
    ((a.focusRegion === null && b.focusRegion === null) ||
      (a.focusRegion !== null && b.focusRegion !== null &&
        a.focusRegion[0] === b.focusRegion[0] && a.focusRegion[1] === b.focusRegion[1]));
}

/**
 * Apply one declarative candidate to a MacroPolicy.
 *
 * null means the candidate is not representable by MacroPolicy today and must
 * be handled by a different deterministic executor (e.g. MIGRATE) before it
 * can enter a policy-only counterfactual rollout.
 */
export function applyCandidateToMacroPolicy(
  previous: MacroPolicy,
  candidate: DecisionCandidateV1,
): MacroPolicy | null {
  switch (candidate.kind) {
    case "KEEP":
      return Object.freeze({ ...previous });
    case "WORKER_TARGET":
      return Object.freeze({ ...previous, workerTarget: candidate.parameters.workerTarget });
    case "MILITARY_RATIO":
      return Object.freeze({ ...previous, militaryRatio: candidate.parameters.militaryRatio });
    case "POSTURE":
      return Object.freeze({ ...previous, posture: candidate.parameters.posture });
    case "RESOURCE_FOCUS":
      if ("targetX" in candidate.parameters && "targetY" in candidate.parameters) {
        return Object.freeze({
          ...previous,
          focusRegion: [candidate.parameters.targetX, candidate.parameters.targetY] as const,
        });
      }
      return null;
    case "ATTACK_TARGET":
      if ("targetClass" in candidate.parameters && candidate.parameters.targetClass === "WORKER") {
        return Object.freeze({ ...previous, attackPriority: "workers" as const });
      }
      return null;
    case "MIGRATE":
      return null;
  }
}

/**
 * Resolve an EXACT single-candidate explanation for an executed policy.
 *
 * Important: matching one changed field is insufficient. If an LLM changes
 * workerTarget + militaryRatio + posture in the same decision, no single
 * one-dimensional candidate was actually executed and this returns null.
 * REAL outcomes must never be attributed to a candidate that did not produce
 * the executed policy.
 */
export function resolveExactPolicyCandidate(
  candidates: readonly DecisionCandidateV1[],
  previousPolicy: MacroPolicy,
  executedPolicy: MacroPolicy,
): DecisionCandidateV1 | null {
  const exact = candidates.filter((candidate) => {
    const applied = applyCandidateToMacroPolicy(previousPolicy, candidate);
    return applied !== null && macroPoliciesEqual(applied, executedPolicy);
  });
  if (exact.length === 0) return null;
  // KEEP is the canonical identity for an unchanged policy. Numeric candidates
  // that happen to equal the current value should not exist after generator
  // hardening, but this precedence keeps historical rows deterministic.
  const keep = exact.find((candidate) => candidate.kind === "KEEP");
  if (keep !== undefined && macroPoliciesEqual(previousPolicy, executedPolicy)) return keep;
  return exact.sort((a, b) => a.deterministicHash.localeCompare(b.deterministicHash))[0] ?? null;
}
