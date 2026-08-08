/**
 * M1d-lite: Model Runtime abstraction (v4 ruling 2026-08-08).
 *
 * The planner must never embed sklearn/joblib/ONNX details. Every learned
 * component (M1 StateScorer → M2 CandidateScorer → M3 PolicyModel) goes
 * through this single interface, so the inference backend (ONNX, Python
 * sidecar, TorchScript) can be swapped without touching the planner.
 *
 * A scorer NEVER decides: it returns a score plus an OOD report; the
 * deterministic layer decides (OOD up → learned weight down → fallback).
 */

import type { OodReport } from "./ood-telemetry.ts";

export interface ModelScorer<Input, Output> {
  readonly modelId: string;
  readonly modelVersion: string;
  /** OOD ↑ → learned weight ↓ → fallback deterministic (never decide alone). */
  score(input: Input): Promise<ModelScoreResult<Output>>;
}

export interface ModelScoreResult<Output> {
  readonly output: Output;
  readonly ood: OodReport;
}

/** A scorer that is not deployed yet — the safe default until a model ships. */
export class UnavailableScorer<Input, Output> implements ModelScorer<Input, Output> {
  readonly modelId = "unavailable";
  readonly modelVersion = "0";
  async score(_input: Input): Promise<ModelScoreResult<Output>> {
    throw new Error("model not deployed: scorer is unavailable");
  }
}
