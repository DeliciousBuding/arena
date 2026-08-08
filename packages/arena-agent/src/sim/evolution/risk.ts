/** Deterministic cross-seed risk aggregation for evolutionary/search experiments. */

export interface RiskSummary {
  readonly mean: number;
  readonly std: number;
  readonly worst: number;
  readonly p10: number;
  readonly riskAdjusted: number;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Sample standard deviation, matching arena-evolve's statistics.stdev semantics. */
export function sampleStd(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function summarizeRisk(values: readonly number[], riskLambda = 0): RiskSummary {
  if (values.length === 0) throw new Error("risk summary requires at least one score");
  if (!Number.isFinite(riskLambda) || riskLambda < 0) throw new Error("riskLambda must be finite and >= 0");
  if (values.some((value) => !Number.isFinite(value))) throw new Error("risk scores must be finite");
  const sorted = [...values].sort((a, b) => a - b);
  const avg = mean(values);
  const std = sampleStd(values);
  // Mirror arena-evolve's conservative empirical lower-tail convention.
  const p10Index = Math.max(0, Math.floor(sorted.length * 0.1) - 1);
  return Object.freeze({
    mean: avg,
    std,
    worst: sorted[0]!,
    p10: sorted[p10Index]!,
    riskAdjusted: avg - riskLambda * std,
  });
}
