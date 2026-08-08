/**
 * M2b: CandidateGenerator — bounded macro-strategy candidate sets for
 * decision-point shadow logging (v4 ruling + user audit 2026-08-09).
 *
 * At every real macro-policy decision point (MacroPolicyOrchestrator,
 * ~every intervalTicks=32), a bounded candidate set (5–20) is generated
 * around the CURRENT behavior policy: KEEP (baseline) + workerTarget ±Δ +
 * militaryRatio ±Δ + posture alternatives. The production policy path
 * (Pi/LLM) still makes the actual choice — this module only produces the
 * candidate universe that M2 will later learn to rank. Zero action rights.
 *
 * Candidates are built through makeCandidateV1 (M2a.1 per-kind contract),
 * so every candidate is structurally legal and carries a deterministicHash.
 */

import { type TickState } from "../../domain/model.ts";
import { type MacroPolicy } from "../../runtime/macro-policy.ts";
import {
  makeCandidateV1,
  type DecisionCandidateV1,
  type Posture,
  POSTURE_VALUES,
} from "./decision-candidate-v1.ts";

/** Candidate generation options (tuning knobs, defaults are the v1 plan). */
export interface CandidateGeneratorOptions {
  /** WORKER_TARGET neighborhood radius around the current target (default 1). */
  readonly workerTargetDelta?: number;
  /** MILITARY_RATIO neighborhood step (default 0.1). */
  readonly militaryRatioStep?: number;
  /** MILITARY_RATIO neighborhood radius in steps (default 1). */
  readonly militaryRatioDelta?: number;
  /** Include posture alternatives besides the current one (default true). */
  readonly postureAlternatives?: boolean;
}

const MIN_CANDIDATES = 5;
const MAX_CANDIDATES = 20;

/** Clamp into [min, max] with integer rounding for worker counts. */
function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Round to one decimal (militaryRatio steps of 0.1 avoid float dust). */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Generate the bounded candidate set for a decision point. The current
 * policy is ALWAYS representable: KEEP means "stay exactly as we are",
 * and the numeric neighborhoods include the current values.
 */
export function generateCandidateSet(
  _state: TickState,
  currentPolicy: MacroPolicy,
  options: CandidateGeneratorOptions = {},
): readonly DecisionCandidateV1[] {
  const workerTargetDelta = options.workerTargetDelta ?? 1;
  const militaryRatioStep = options.militaryRatioStep ?? 0.1;
  const militaryRatioDelta = options.militaryRatioDelta ?? 1;
  const candidates: DecisionCandidateV1[] = [];

  // KEEP — the baseline (no change).
  candidates.push(makeCandidateV1({
    candidateId: "keep",
    kind: "KEEP",
    parameters: {},
    source: "baseline",
  }));

  // WORKER_TARGET neighborhood (includes the current target).
  for (let delta = -workerTargetDelta; delta <= workerTargetDelta; delta += 1) {
    const workerTarget = clampInt(currentPolicy.workerTarget + delta, 1, 16);
    candidates.push(makeCandidateV1({
      candidateId: `worker-target-${workerTarget}`,
      kind: "WORKER_TARGET",
      parameters: { workerTarget },
      source: "local-neighborhood",
    }));
  }

  // MILITARY_RATIO neighborhood (includes the current ratio).
  for (let step = -militaryRatioDelta; step <= militaryRatioDelta; step += 1) {
    const militaryRatio = Math.min(
      1,
      Math.max(0, round1(currentPolicy.militaryRatio + step * militaryRatioStep)),
    );
    candidates.push(makeCandidateV1({
      candidateId: `military-ratio-${militaryRatio.toFixed(1)}`,
      kind: "MILITARY_RATIO",
      parameters: { militaryRatio },
      source: "local-neighborhood",
    }));
  }

  // POSTURE alternatives (the current posture is covered by KEEP).
  if (options.postureAlternatives ?? true) {
    for (const posture of POSTURE_VALUES) {
      if (posture === currentPolicy.posture) continue;
      candidates.push(makeCandidateV1({
        candidateId: `posture-${posture}`,
        kind: "POSTURE",
        parameters: { posture: posture as Posture },
        source: "local-neighborhood",
      }));
    }
  }

  if (candidates.length < MIN_CANDIDATES || candidates.length > MAX_CANDIDATES) {
    throw new Error(
      `candidate set size ${candidates.length} outside [${MIN_CANDIDATES}, ${MAX_CANDIDATES}]`,
    );
  }
  return Object.freeze(candidates);
}
