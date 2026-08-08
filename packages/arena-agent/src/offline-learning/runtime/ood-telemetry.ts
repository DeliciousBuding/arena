/**
 * M1d-lite: OOD telemetry + shadow prediction record.
 *
 * The most dangerous failure of a learned model is not "a bit wrong" — it is
 * "confidently wrong on a world it has never seen". Every online prediction
 * therefore carries an OOD report derived from the TRAIN-ONLY reference (the
 * M1b feature-quality report records per-feature min/max over the
 * train-eligible pool only, P0 hygiene — validation/test never feed the
 * deployed range). OOD ↑ → learned weight ↓ → fallback deterministic.
 */

export interface OodReference {
  /** Feature name → training-range [min, max] (from feature-quality.json). */
  readonly ranges: Readonly<Record<string, readonly [number, number]>>;
}

export interface OodReport {
  readonly featureOutOfRangeCount: number;
  readonly featureCount: number;
  readonly outOfRangeFraction: number;
  /** Worst single-feature relative overshoot outside its train range. */
  readonly maxOutOfRangeRatio: number;
  /** Feature names outside the train range (bounded list). */
  readonly outOfRangeFeatures: readonly string[];
}

/** Shadow prediction record (shadow-telemetry-v1) — telemetry only, no action. */
export interface ShadowPredictionRecord {
  readonly schema: "shadow-telemetry-v1";
  readonly processRunId: string;
  readonly tick: number;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly predictedNet20: number;
  /** Filled 20 ticks later by the outcome resolver. */
  readonly actualNet20: number | null;
  readonly error: number | null;
  readonly ood: OodReport;
}

export function computeOodReport(
  features: Readonly<Record<string, number>>,
  reference: OodReference,
): OodReport {
  let outOfRangeCount = 0;
  let maxRatio = 0;
  const outOfRangeFeatures: string[] = [];
  const featureNames = Object.keys(features);
  for (const [name, value] of Object.entries(features)) {
    const range = reference.ranges[name];
    if (range === undefined || !Number.isFinite(value)) continue;
    const [min, max] = range;
    if (value < min || value > max) {
      outOfRangeCount += 1;
      outOfRangeFeatures.push(name);
      const span = max - min;
      if (span > 0) {
        const overshoot = value < min ? (min - value) / span : (value - max) / span;
        maxRatio = Math.max(maxRatio, overshoot);
      }
    }
  }
  return {
    featureOutOfRangeCount: outOfRangeCount,
    featureCount: featureNames.length,
    outOfRangeFraction: featureNames.length === 0 ? 0 : outOfRangeCount / featureNames.length,
    maxOutOfRangeRatio: maxRatio,
    outOfRangeFeatures: outOfRangeFeatures.slice(0, 20),
  };
}

/** Load the OOD reference from an M1b feature-quality.json report. */
export function oodReferenceFromFeatureQuality(
  report: Readonly<{
    entries: readonly {
      feature: string;
      min: number | null;
      max: number | null;
    }[];
  }>,
): OodReference {
  const ranges: Record<string, readonly [number, number]> = {};
  for (const entry of report.entries) {
    if (entry.min !== null && entry.max !== null) {
      ranges[entry.feature] = [entry.min, entry.max];
    }
  }
  return { ranges };
}
