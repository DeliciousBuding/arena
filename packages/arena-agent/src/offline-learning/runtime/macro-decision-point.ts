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
 * `chosenCandidateHash` is populated ONLY when one candidate exactly explains
 * the complete NEW policy. If the LLM changes multiple macro fields at once,
 * the executed policy is outside the one-dimensional candidate universe and
 * chosenCandidateHash=null. This is deliberate: REAL outcomes must never be
 * mislabeled as a candidate that was not actually executed.
 */

import { isValidMacroPolicy, type MacroPolicy } from "../../runtime/macro-policy.ts";
import {
  computeCandidateSetHash,
  validateDecisionCandidateV1,
  type DecisionCandidateV1,
} from "../candidate/decision-candidate-v1.ts";
import { resolveExactPolicyCandidate } from "../candidate/candidate-policy.ts";

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
  /** Exact candidate identity, or null when the executed policy is out-of-set. */
  readonly chosenCandidateHash: string | null;
  /** False means no single candidate exactly produced newPolicy. */
  readonly selectionRepresentable: boolean;
  /**
   * Probability that the behavior policy selected this candidate, when known.
   * Pi/LLM choices do not expose a calibrated propensity and therefore log
   * null. Future bounded randomized exploration can log an exact probability,
   * enabling IPS/doubly-robust OPE without inventing one retroactively.
   */
  readonly behaviorPropensity: number | null;
}

/**
 * Deterministic exact mapping policy → candidate in the set. No field-level
 * fallback is allowed: the whole applied policy must equal executedPolicy.
 */
export function resolveChosenCandidate(
  candidates: readonly DecisionCandidateV1[],
  previousPolicy: MacroPolicy,
  executedPolicy: MacroPolicy,
): DecisionCandidateV1 | null {
  return resolveExactPolicyCandidate(candidates, previousPolicy, executedPolicy);
}

/** Strict validator mirroring the record shape. */
export function validateMacroDecisionPointV1(value: unknown): readonly string[] {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["must be an object"];
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = new Set([
    "schema",
    "decisionPointId",
    "processRunId",
    "tick",
    "intervalTicks",
    "previousPolicy",
    "newPolicy",
    "chosenBy",
    "candidates",
    "candidateSetHash",
    "chosenCandidateHash",
    "selectionRepresentable",
    "behaviorPropensity",
  ]);
  for (const key of Object.keys(record)) {
    if (!expectedKeys.has(key)) problems.push(`${key} is not allowed`);
  }
  for (const key of expectedKeys) {
    if (!(key in record)) problems.push(`${key} is required`);
  }
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
  if (typeof record.intervalTicks !== "number" || !Number.isInteger(record.intervalTicks) || record.intervalTicks < 1) {
    problems.push("intervalTicks must be a positive integer");
  }
  if (
    typeof record.processRunId === "string" &&
    typeof record.tick === "number" &&
    record.decisionPointId !== `${record.processRunId}:${record.tick}`
  ) {
    problems.push("decisionPointId must equal `${processRunId}:${tick}`");
  }
  if (!isValidMacroPolicy(record.previousPolicy)) {
    problems.push("previousPolicy must be a valid MacroPolicy");
  }
  if (!isValidMacroPolicy(record.newPolicy)) {
    problems.push("newPolicy must be a valid MacroPolicy");
  }
  if (!DECISION_CHOOSERS.includes(record.chosenBy as DecisionChooser)) {
    problems.push(`chosenBy must be one of ${DECISION_CHOOSERS.join(", ")}`);
  }
  let candidates: readonly DecisionCandidateV1[] = [];
  if (!Array.isArray(record.candidates) || record.candidates.length < 1 || record.candidates.length > 20) {
    problems.push("candidates must be a non-empty array of at most 20 candidates");
  } else {
    candidates = record.candidates as readonly DecisionCandidateV1[];
    const hashes = new Set<string>();
    for (const [index, candidate] of candidates.entries()) {
      const candidateProblems = validateDecisionCandidateV1(candidate);
      if (candidateProblems.length > 0) {
        problems.push(`candidates[${index}]: ${candidateProblems.join("; ")}`);
        continue;
      }
      if (hashes.has(candidate.deterministicHash)) {
        problems.push(`candidates[${index}] duplicates candidate hash ${candidate.deterministicHash}`);
      }
      hashes.add(candidate.deterministicHash);
    }
    const expectedSetHash = computeCandidateSetHash(candidates);
    if (record.candidateSetHash !== expectedSetHash) {
      problems.push(`candidateSetHash mismatch: expected ${expectedSetHash}`);
    }
  }
  if (typeof record.candidateSetHash !== "string" || !/^[0-9a-f]{64}$/u.test(record.candidateSetHash)) {
    problems.push("candidateSetHash must be sha256 hex");
  }
  if (record.chosenCandidateHash !== null &&
      (typeof record.chosenCandidateHash !== "string" || !/^[0-9a-f]{64}$/u.test(record.chosenCandidateHash))) {
    problems.push("chosenCandidateHash must be sha256 hex or null");
  }
  if (typeof record.selectionRepresentable !== "boolean") {
    problems.push("selectionRepresentable must be a boolean");
  }
  if (record.behaviorPropensity !== null &&
      (typeof record.behaviorPropensity !== "number" || !Number.isFinite(record.behaviorPropensity) ||
        record.behaviorPropensity <= 0 || record.behaviorPropensity > 1)) {
    problems.push("behaviorPropensity must be null or a number in (0,1]");
  }
  if (record.selectionRepresentable === true && record.chosenCandidateHash === null) {
    problems.push("selectionRepresentable=true requires chosenCandidateHash");
  }
  if (record.selectionRepresentable === false && record.chosenCandidateHash !== null) {
    problems.push("selectionRepresentable=false requires chosenCandidateHash=null");
  }
  if (record.chosenCandidateHash !== null &&
      !candidates.some((candidate) => candidate.deterministicHash === record.chosenCandidateHash)) {
    problems.push("chosenCandidateHash must reference a candidate in candidates");
  }
  if (isValidMacroPolicy(record.previousPolicy) && isValidMacroPolicy(record.newPolicy) && candidates.length > 0) {
    const resolved = resolveChosenCandidate(candidates, record.previousPolicy, record.newPolicy);
    const expectedHash = resolved?.deterministicHash ?? null;
    if (record.chosenCandidateHash !== expectedHash) {
      problems.push(`chosenCandidateHash does not exactly explain newPolicy (expected ${expectedHash ?? "null"})`);
    }
    if (record.selectionRepresentable !== (resolved !== null)) {
      problems.push(`selectionRepresentable inconsistent with exact candidate resolution`);
    }
  }
  return problems;
}
