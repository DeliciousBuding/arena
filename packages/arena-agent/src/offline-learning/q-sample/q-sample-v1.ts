/**
 * M2c: q-sample-v1 contract — the LONG-TERM data SSOT of the Learned
 * Decision System (v4 ruling + user audit 2026-08-08).
 *
 * A q-sample is organized around a DECISION POINT, not around a flat
 * (state, candidate, q) triple. Every candidate evaluated at the same
 * state must be re-groupable under one decisionPointId — M2's real
 * training objective is "A vs B vs C at the same state", not global
 * pointwise regression across different states.
 *
 * SSOT discipline (written into the contract, not a convention):
 * - `evaluations` are POINTWISE candidate evaluations (decision S:
 *   A → +5, B → +2, C → -1) — the canonical, authoritative storage;
 * - PAIRWISE preferences (A > B > C) are a DERIVED artifact produced
 *   from the same decision point via derivePairwisePreferences(). They
 *   are never stored as an independent authoritative dataset, otherwise
 *   reward-semantics or confidence-filtering changes would silently
 *   drift the two copies apart.
 *
 * Label is not a single scalar q:
 * - horizonTicks is explicit and DECOUPLED from the macro-policy decision
 *   interval (~32 ticks): suggested 20 (short economic feedback, M1
 *   compatible), 32 (one full interval), 64 (two intervals). The schema
 *   accepts any positive integer so future Q data is never locked to 20 —
 *   learning only h20 would systematically bias toward myopic strategies
 *   whose payoff may land at tick 25–60.
 * - source is REAL | SIM | HEURISTIC, never mixed in one field:
 *   REAL       observed=true, confidence=1 (real execution outcome)
 *   SIM        observed=false, mandatory sim provenance (counterfactual
 *              rollout; confidence from simReplayConfidence mapping)
 *   HEURISTIC  weak supervision / teacher prior ONLY; confidence < 1 is
 *              enforced so it can never pose as outcome truth
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "../../sim/tools/artifacts.ts";
import {
  computeCandidateSetHash,
  type DecisionCandidateV1,
  type Posture,
  validateDecisionCandidateV1,
} from "../candidate/decision-candidate-v1.ts";

// Candidate-set identity lives with the candidate contract (M2a.1); q-sample
// re-exports it so the dataset layer and the shadow layer share one source.
export { computeCandidateSetHash } from "../candidate/decision-candidate-v1.ts";

export const Q_SAMPLE_SCHEMA_VERSION = "q-sample-v1";
export const PAIRWISE_PREFERENCE_SCHEMA_VERSION = "q-pairwise-preference-v1";

export const Q_LABEL_SOURCES = ["REAL", "SIM", "HEURISTIC"] as const;
export type QLabelSource = (typeof Q_LABEL_SOURCES)[number];

export const INITIAL_STATE_SCOPES = ["full-sim-world", "private-observation-completed"] as const;
export type InitialStateScope = (typeof INITIAL_STATE_SCOPES)[number];

/**
 * Suggested label horizons (ticks). The schema accepts any positive
 * integer; these are the recommended ladder for M2 data generation so a
 * macro-policy decision interval (~32 ticks) is covered by full intervals.
 */
export const SUGGESTED_LABEL_HORIZONS = [20, 32, 64] as const;

/** Current behavior policy snapshot at the decision point (policy input). */
export interface BehaviorPolicySnapshot {
  readonly policyVersion: string;
  readonly workerTarget: number | null;
  readonly militaryRatio: number | null;
  readonly posture: Posture | null;
  readonly focusRegion: string | null;
  readonly attackPriority: string | null;
  /** Free-form carry-over of other policy fields (stable serialization). */
  readonly note: string | null;
}

export interface QSampleLabel {
  /** Positive integer; suggested 20/32/64 — never locked to 20. */
  readonly horizonTicks: number;
  readonly outcome: {
    /** net resources at horizon (name kept from M1 for continuity). */
    readonly net: number | null;
    readonly deathProb: number | null;
    readonly coreRisk: 0 | 1 | null;
  };
  readonly source: QLabelSource;
  /** 0..1; REAL must be exactly 1; HEURISTIC must be < 1. */
  readonly confidence: number;
  readonly observed: boolean;
}

/**
 * Mandatory SIM provenance (from v1 — otherwise "which Simulator produced
 * these 3M labels?" becomes unauditable later).
 */
export interface QSampleSimProvenance {
  readonly simulatorVersion: string;
  readonly certificateVersion: string;
  readonly scenarioSeed: number;
  readonly opponentId: string;
  /** Whether the rollout started from a complete SimWorld or a completed private observation. */
  readonly initialStateScope: InitialStateScope;
  /** Named completion/belief policy; "none" for a full SimWorld. */
  readonly completionPolicy: string;
  /** Completion randomness if the belief completion is stochastic. */
  readonly completionSeed: number | null;
  readonly rolloutHorizon: number;
  readonly unknownEffectCount: number;
  readonly firstUnknownTick: number | null;
  readonly terminatedByUnknown: boolean;
}

export interface QSampleEvaluation {
  /** Must reference a candidate in the decision point's candidateSet. */
  readonly candidateHash: string;
  /**
   * Matched comparison cohort. SIM candidates with the same scenario/opponent/
   * completion seed share one id so pairwise ranking uses common randomness;
   * different seeds must never be crossed.
   */
  readonly comparisonGroupId: string;
  readonly label: QSampleLabel;
  /** Required when label.source === "SIM". */
  readonly sim?: QSampleSimProvenance;
  /**
   * Behavior action propensity for REAL labels, when known. Pi/LLM rows use
   * null; future randomized exploration records the exact probability. This
   * keeps IPS/doubly-robust OPE possible without inventing propensities later.
   */
  readonly behaviorPropensity?: number | null;
  /** Teacher-prior explanation for HEURISTIC labels (never outcome truth). */
  readonly heuristicNote?: string;
}

export interface QSampleV1 {
  readonly schema: "q-sample-v1";
  /**
   * Group key: every candidate evaluated at the same state shares one
   * decisionPointId (A vs B vs C at the same s).
   */
  readonly decisionPointId: string;
  readonly processRunId: string;
  readonly tenantId: string;
  readonly tick: number;
  readonly state: {
    readonly featureSchema: string;
    readonly features: Readonly<Record<string, number>>;
    /** sha256(canonical features) — state identity for dedupe/audit. */
    readonly featureHash: string;
  };
  readonly behaviorPolicy: BehaviorPolicySnapshot;
  readonly candidateSet: readonly DecisionCandidateV1[];
  /** sha256(sorted candidate deterministicHashes) — the candidate-set identity. */
  readonly candidateSetHash: string;
  /** POINTWISE evaluations — the canonical SSOT; pairwise is derived. */
  readonly evaluations: readonly QSampleEvaluation[];
}

/** Derived pairwise preference (NOT authoritative storage — see header). */
export interface QPairwisePreferenceV1 {
  readonly schema: "q-pairwise-preference-v1";
  readonly decisionPointId: string;
  readonly source: QLabelSource;
  readonly horizonTicks: number;
  readonly comparisonGroupId: string;
  readonly preferredCandidateHash: string;
  readonly dispreferredCandidateHash: string;
  /** |q_preferred − q_dispreferred| — magnitude of the preference. */
  readonly margin: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Canonical (key-sorted, compact) serialization of a feature map. */
export function canonicalFeatures(features: Readonly<Record<string, number>>): string {
  return canonicalJson(features, false);
}

export function computeFeatureHash(features: Readonly<Record<string, number>>): string {
  return createHash("sha256").update(canonicalFeatures(features), "utf8").digest("hex");
}

/**
 * Derive pairwise preferences from a decision point's pointwise
 * evaluations (the SSOT → derived transformation). Pairs are formed only
 * within the same (source, horizonTicks, comparisonGroupId) group — mixing
 * REAL and SIM absolute values, different horizons, or different simulator
 * seeds/opponents would fabricate comparisons.
 * Equal values produce no pair; any null outcome skips that evaluation.
 */
export function derivePairwisePreferences(sample: QSampleV1): readonly QPairwisePreferenceV1[] {
  const preferences: QPairwisePreferenceV1[] = [];
  const byGroup = new Map<string, QSampleEvaluation[]>();
  for (const evaluation of sample.evaluations) {
    const label = evaluation.label;
    const net = label.outcome.net;
    if (net === null) continue;
    const key = `${label.source}:${label.horizonTicks}:${evaluation.comparisonGroupId}`;
    const group = byGroup.get(key) ?? [];
    group.push(evaluation);
    byGroup.set(key, group);
  }
  for (const group of byGroup.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i]!;
        const b = group[j]!;
        const netA = a.label.outcome.net;
        const netB = b.label.outcome.net;
        if (netA === null || netB === null) continue;
        if (netA > netB) {
          preferences.push({
            schema: PAIRWISE_PREFERENCE_SCHEMA_VERSION,
            decisionPointId: sample.decisionPointId,
            source: a.label.source,
            horizonTicks: a.label.horizonTicks,
            comparisonGroupId: a.comparisonGroupId,
            preferredCandidateHash: a.candidateHash,
            dispreferredCandidateHash: b.candidateHash,
            margin: netA - netB,
          });
        } else if (netB > netA) {
          preferences.push({
            schema: PAIRWISE_PREFERENCE_SCHEMA_VERSION,
            decisionPointId: sample.decisionPointId,
            source: b.label.source,
            horizonTicks: b.label.horizonTicks,
            comparisonGroupId: b.comparisonGroupId,
            preferredCandidateHash: b.candidateHash,
            dispreferredCandidateHash: a.candidateHash,
            margin: netB - netA,
          });
        }
      }
    }
  }
  return preferences;
}

/** Strict validator mirroring the contract (additionalProperties:false). */
export function validateQSampleV1(value: unknown): readonly string[] {
  const problems: string[] = [];
  if (!isRecord(value)) {
    return ["must be an object"];
  }
  const expected = new Set([
    "schema", "decisionPointId", "processRunId", "tenantId", "tick", "state",
    "behaviorPolicy", "candidateSet", "candidateSetHash", "evaluations",
  ]);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) problems.push(`${key} is not allowed`);
  }
  for (const key of expected) {
    if (!(key in value)) problems.push(`${key} is required`);
  }
  if (value.schema !== Q_SAMPLE_SCHEMA_VERSION) {
    problems.push(`schema must be ${Q_SAMPLE_SCHEMA_VERSION}`);
  }
  for (const field of ["decisionPointId", "processRunId", "tenantId"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      problems.push(`${field} must be a non-empty string`);
    }
  }
  if (typeof value.tick !== "number" || !Number.isInteger(value.tick) || value.tick < 0) {
    problems.push("tick must be a non-negative integer");
  }

  if (!isRecord(value.state)) {
    problems.push("state must be an object");
  } else {
    if (typeof value.state.featureSchema !== "string" || value.state.featureSchema.length === 0) {
      problems.push("state.featureSchema must be a non-empty string");
    }
    if (!isRecord(value.state.features)) {
      problems.push("state.features must be an object");
    } else {
      for (const [name, feature] of Object.entries(value.state.features)) {
        if (!isFiniteNumber(feature)) {
          problems.push(`state.features.${name} must be a finite number`);
        }
      }
      const expectedFeatureHash = computeFeatureHash(
        value.state.features as Record<string, number>,
      );
      if (value.state.featureHash !== expectedFeatureHash) {
        problems.push(`state.featureHash mismatch: expected ${expectedFeatureHash}`);
      }
    }
  }

  if (!isRecord(value.behaviorPolicy)) {
    problems.push("behaviorPolicy must be an object");
  } else {
    if (typeof value.behaviorPolicy.policyVersion !== "string") {
      problems.push("behaviorPolicy.policyVersion must be a string");
    }
    for (const field of ["workerTarget", "militaryRatio", "posture", "focusRegion", "attackPriority", "note"] as const) {
      const fieldValue = value.behaviorPolicy[field];
      if (fieldValue !== null && typeof fieldValue !== "string" && !isFiniteNumber(fieldValue)) {
        problems.push(`behaviorPolicy.${field} must be a number, string, or null`);
      }
    }
  }

  if (!Array.isArray(value.candidateSet) || value.candidateSet.length === 0) {
    problems.push("candidateSet must be a non-empty array");
  } else {
    const hashes = new Set<string>();
    for (const [index, candidate] of value.candidateSet.entries()) {
      const candidateProblems = validateDecisionCandidateV1(candidate);
      if (candidateProblems.length > 0) {
        problems.push(`candidateSet[${index}]: ${candidateProblems.join("; ")}`);
        continue;
      }
      const hash = (candidate as DecisionCandidateV1).deterministicHash;
      if (hashes.has(hash)) {
        problems.push(`candidateSet[${index}] duplicates candidate hash ${hash}`);
      }
      hashes.add(hash);
    }
    const expectedSetHash = computeCandidateSetHash(value.candidateSet as DecisionCandidateV1[]);
    if (value.candidateSetHash !== expectedSetHash) {
      problems.push(`candidateSetHash mismatch: expected ${expectedSetHash}`);
    }
  }

  if (!Array.isArray(value.evaluations) || value.evaluations.length === 0) {
    problems.push("evaluations must be a non-empty array");
  } else {
    const setHashes = new Set(
      (value.candidateSet as DecisionCandidateV1[] | undefined)?.map((c) => c.deterministicHash) ?? [],
    );
    // Uniqueness key: one evaluation per
    // (candidateHash, source, horizonTicks, comparisonGroupId).
    // SIM can therefore retain many matched seed/opponent replicates without
    // collapsing them or mixing them in pairwise comparisons.
    const evaluatedKeys = new Set<string>();
    for (const [index, evaluation] of value.evaluations.entries()) {
      if (!isRecord(evaluation)) {
        problems.push(`evaluations[${index}] must be an object`);
        continue;
      }
      if (typeof evaluation.candidateHash !== "string") {
        problems.push(`evaluations[${index}].candidateHash must be a string`);
      } else if (!setHashes.has(evaluation.candidateHash)) {
        problems.push(`evaluations[${index}].candidateHash not in candidateSet`);
      }
      if (typeof evaluation.comparisonGroupId !== "string" || evaluation.comparisonGroupId.length === 0) {
        problems.push(`evaluations[${index}].comparisonGroupId must be a non-empty string`);
      }
      const labelProblems = validateQSampleLabel(evaluation.label);
      if (labelProblems.length > 0) {
        problems.push(`evaluations[${index}].label: ${labelProblems.join("; ")}`);
      }
      const source = (evaluation.label as QSampleLabel | undefined)?.source;
      const horizonTicks = (evaluation.label as QSampleLabel | undefined)?.horizonTicks;
      if (
        typeof evaluation.candidateHash === "string" &&
        typeof evaluation.comparisonGroupId === "string" &&
        source !== undefined && typeof horizonTicks === "number"
      ) {
        const evaluationKey = `${evaluation.candidateHash}:${source}:${horizonTicks}:${evaluation.comparisonGroupId}`;
        if (evaluatedKeys.has(evaluationKey)) {
          problems.push(`evaluations[${index}] duplicates evaluation key ${evaluationKey}`);
        }
        evaluatedKeys.add(evaluationKey);
      }
      if (source === "SIM") {
        if (!isRecord(evaluation.sim)) {
          problems.push(`evaluations[${index}].sim is required for SIM labels`);
        } else {
          problems.push(...validateSimProvenance(evaluation.sim, `evaluations[${index}].sim`));
        }
      } else if (evaluation.sim !== undefined) {
        problems.push(`evaluations[${index}].sim only allowed for SIM labels`);
      }
      if (source === "REAL") {
        const propensity = evaluation.behaviorPropensity;
        if (propensity !== undefined && propensity !== null &&
            (!isFiniteNumber(propensity) || propensity <= 0 || propensity > 1)) {
          problems.push(`evaluations[${index}].behaviorPropensity must be null or a number in (0,1]`);
        }
      } else if (evaluation.behaviorPropensity !== undefined) {
        problems.push(`evaluations[${index}].behaviorPropensity only allowed for REAL labels`);
      }
      if (source === "HEURISTIC" && evaluation.heuristicNote === undefined) {
        problems.push(`evaluations[${index}].heuristicNote should explain the teacher prior`);
      }
    }
  }
  return problems;
}

function validateQSampleLabel(label: unknown): readonly string[] {
  const problems: string[] = [];
  if (!isRecord(label)) {
    return ["must be an object"];
  }
  if (typeof label.horizonTicks !== "number" || !Number.isInteger(label.horizonTicks) || label.horizonTicks <= 0) {
    problems.push("horizonTicks must be a positive integer");
  }
  if (!isRecord(label.outcome)) {
    problems.push("outcome must be an object");
  } else {
    for (const field of ["net", "deathProb"] as const) {
      if (label.outcome[field] !== null && !isFiniteNumber(label.outcome[field])) {
        problems.push(`outcome.${field} must be a finite number or null`);
      }
    }
    if (label.outcome.coreRisk !== null && label.outcome.coreRisk !== 0 && label.outcome.coreRisk !== 1) {
      problems.push("outcome.coreRisk must be 0, 1, or null");
    }
  }
  if (!Q_LABEL_SOURCES.includes(label.source as QLabelSource)) {
    problems.push(`source must be one of ${Q_LABEL_SOURCES.join(", ")}`);
  }
  if (!isFiniteNumber(label.confidence) || label.confidence < 0 || label.confidence > 1) {
    problems.push("confidence must be a number in [0,1]");
  } else {
    if (label.source === "REAL" && label.confidence !== 1) {
      problems.push("REAL confidence must be exactly 1");
    }
    if (label.source === "HEURISTIC" && label.confidence >= 1) {
      problems.push("HEURISTIC confidence must be < 1 (weak supervision only, never outcome truth)");
    }
  }
  if (typeof label.observed !== "boolean") {
    problems.push("observed must be a boolean");
  } else if (label.source === "REAL" && !label.observed) {
    problems.push("REAL labels must be observed=true");
  } else if (label.source !== "REAL" && label.observed) {
    problems.push("SIM/HEURISTIC labels must be observed=false");
  }
  return problems;
}

function validateSimProvenance(sim: Record<string, unknown>, path: string): readonly string[] {
  const problems: string[] = [];
  for (const field of ["simulatorVersion", "certificateVersion", "opponentId", "completionPolicy"] as const) {
    if (typeof sim[field] !== "string" || sim[field].length === 0) {
      problems.push(`${path}.${field} must be a non-empty string`);
    }
  }
  if (!INITIAL_STATE_SCOPES.includes(sim.initialStateScope as InitialStateScope)) {
    problems.push(`${path}.initialStateScope must be one of ${INITIAL_STATE_SCOPES.join(", ")}`);
  }
  for (const field of ["scenarioSeed", "rolloutHorizon", "unknownEffectCount"] as const) {
    if (!isFiniteNumber(sim[field]) || !Number.isInteger(sim[field])) {
      problems.push(`${path}.${field} must be an integer`);
    }
  }
  if (sim.completionSeed !== null &&
      (!isFiniteNumber(sim.completionSeed) || !Number.isInteger(sim.completionSeed))) {
    problems.push(`${path}.completionSeed must be an integer or null`);
  }
  if (sim.initialStateScope === "full-sim-world" && sim.completionPolicy !== "none") {
    problems.push(`${path}.completionPolicy must be "none" for full-sim-world`);
  }
  if (sim.initialStateScope === "full-sim-world" && sim.completionSeed !== null) {
    problems.push(`${path}.completionSeed must be null for full-sim-world`);
  }
  if (sim.firstUnknownTick !== null &&
      (!isFiniteNumber(sim.firstUnknownTick) || !Number.isInteger(sim.firstUnknownTick))) {
    problems.push(`${path}.firstUnknownTick must be an integer or null`);
  }
  if (typeof sim.terminatedByUnknown !== "boolean") {
    problems.push(`${path}.terminatedByUnknown must be a boolean`);
  }
  return problems;
}

/** Build a validated q-sample (throws on invalid content). */
export function makeQSampleV1(options: {
  readonly decisionPointId: string;
  readonly processRunId: string;
  readonly tenantId: string;
  readonly tick: number;
  readonly features: Readonly<Record<string, number>>;
  readonly featureSchema?: string;
  readonly behaviorPolicy: BehaviorPolicySnapshot;
  readonly candidateSet: readonly DecisionCandidateV1[];
  readonly evaluations: readonly QSampleEvaluation[];
}): QSampleV1 {
  const sample = {
    schema: Q_SAMPLE_SCHEMA_VERSION,
    decisionPointId: options.decisionPointId,
    processRunId: options.processRunId,
    tenantId: options.tenantId,
    tick: options.tick,
    state: {
      featureSchema: options.featureSchema ?? "feature-vector-v2",
      features: Object.freeze({ ...options.features }),
      featureHash: computeFeatureHash(options.features),
    },
    behaviorPolicy: Object.freeze({ ...options.behaviorPolicy }),
    candidateSet: Object.freeze([...options.candidateSet]),
    candidateSetHash: computeCandidateSetHash(options.candidateSet),
    evaluations: Object.freeze(
      options.evaluations.map((evaluation) => Object.freeze({
        ...evaluation,
        label: Object.freeze({ ...evaluation.label, outcome: Object.freeze({ ...evaluation.label.outcome }) }),
        sim: evaluation.sim === undefined ? undefined : Object.freeze({ ...evaluation.sim }),
      })),
    ),
  } as unknown as QSampleV1;
  const problems = validateQSampleV1(sample);
  if (problems.length > 0) {
    throw new Error(`invalid q-sample: ${problems.join("; ")}`);
  }
  return Object.freeze(sample);
}
