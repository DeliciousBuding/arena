/**
 * M2b: MacroDecisionPointV1 — the shadow telemetry record emitted at every
 * real macro-policy decision boundary (MacroPolicyOrchestrator.runPolicyDecision,
 * ~every intervalTicks=32).
 *
 * Production semantics are untouched: Pi/LLM still selects the policy; this
 * record only shadows the candidate universe around the behavior policy so
 * M2 can later learn Q(s, candidate) from REAL decision points (and SIM
 * counterfactuals built from the same candidate sets). Zero action rights.
 *
 * `chosenCandidateHash` is resolved deterministically from the NEW policy:
 * exact match on workerTarget → MILITARY_RATIO → posture → KEEP fallback
 * (KEEP = "stayed as we were", e.g. sticky after a failed LLM decision).
 */

import { type MacroPolicy } from "../../runtime/macro-policy.ts";
import { computeCandidateSetHash, type DecisionCandidateV1 } from "../candidate/decision-candidate-v1.ts";
import { type CandidateKind } from "../candidate/decision-candidate-v1.ts";

export const MACRO_DECISION_POINT_SCHEMA_VERSION = "macro-decision-point-v1";

/** Who actually made the choice at this decision point. */
export const DECISION_CHOOSERS = ["policy-llm", "policy-sticky"] as const;
export type DecisionChooser = (typeof DECISION_CHOOSERS)[number];

export interface MacroDecisionPointV1 {
  readonly schema: "macro-decision-point-v1";
  /** `${processRunId}:${tick}` — unique per decision point. */
  readonly decisionPointId: string;
  readonly processRunId: string;
  readonly tick: number;
  readonly intervalTicks: number;
  /** Behavior policy BEFORE the decision (the state under evaluation). */
  readonly previousPolicy: MacroPolicy;
  /** Policy AFTER the decision (identical to previous on sticky). */
  readonly newPolicy: MacroPolicy;
  readonly chosenBy: DecisionChooser;
  /** Bounded candidate universe (5–20) generated around previousPolicy. */
  readonly candidates: readonly DecisionCandidateV1[];
  /** sha256(sorted candidate deterministicHashes). */
  readonly candidateSetHash: string;
  /** The candidate the executed policy corresponds to (see header). */
  readonly chosenCandidateHash: string;
}

/**
 * Deterministic mapping policy → candidate in the set: exact workerTarget
 * match first, then militaryRatio, then posture, then KEEP (no exact
 * correspondence — the executed policy stayed outside the neighborhood or
 * did not change).
 */
export function resolveChosenCandidate(
  candidates: readonly DecisionCandidateV1[],
  policy: MacroPolicy,
): { readonly candidate: DecisionCandidateV1; readonly kind: CandidateKind } {
  for (const candidate of candidates) {
    if (
      candidate.kind === "WORKER_TARGET" &&
      candidate.parameters.workerTarget === policy.workerTarget
    ) {
      return { candidate, kind: "WORKER_TARGET" };
    }
  }
  for (const candidate of candidates) {
    if (
      candidate.kind === "MILITARY_RATIO" &&
      candidate.parameters.militaryRatio === policy.militaryRatio
    ) {
      return { candidate, kind: "MILITARY_RATIO" };
    }
  }
  for (const candidate of candidates) {
    if (candidate.kind === "POSTURE" && candidate.parameters.posture === policy.posture) {
      return { candidate, kind: "POSTURE" };
    }
  }
  const keep = candidates.find((candidate) => candidate.kind === "KEEP");
  if (keep !== undefined) {
    return { candidate: keep, kind: "KEEP" };
  }
  throw new Error("candidate set must contain KEEP");
}

/** Strict validator mirroring the record shape. */
export function validateMacroDecisionPointV1(value: unknown): readonly string[] {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["must be an object"];
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== MACRO_DECISION_POINT_SCHEMA_VERSION) {
    problems.push(`schema must be ${MACRO_DECISION_POINT_SCHEMA_VERSION}`);
  }
  if (typeof record.decisionPointId !== "string" || record.decisionPointId.length === 0) {
    problems.push("decisionPointId must be a non-empty string");
  }
  if (typeof record.processRunId !== "string" || record.processRunId.length === 0) {
    problems.push("processRunId must be a non-empty string");
  }
  if (typeof record.tick !== "number" || !Number.isInteger(record.tick) || record.tick < 0) {
    problems.push("tick must be a non-negative integer");
  }
  if (!DECISION_CHOOSERS.includes(record.chosenBy as DecisionChooser)) {
    problems.push(`chosenBy must be one of ${DECISION_CHOOSERS.join(", ")}`);
  }
  return problems;
}
