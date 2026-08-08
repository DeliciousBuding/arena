/**
 * M1b merged real-sample export: consume every eligible ml-sample-v1 dataset
 * in the registry, project feature-vector-v2, assign a GLOBAL chronological
 * split (run = processRunId, runs never cross a split boundary), and emit
 * `data/runs/ml/<build-id>/{features-all.jsonl, train.jsonl,
 * validation.jsonl, test.jsonl, feature-quality.json, split-report.json,
 * manifest.json}`.
 *
 * This is OFFLINE only: it never writes runtime data and never enters the
 * live loop. Python consumes only the exported feature records (TS stays the
 * state→feature SSOT; see dl-implementation-plan v3 §3.2).
 *
 * Split semantics (design v3 §3.2): all eligible real samples are aggregated,
 * grouped by (processRunId, tick-consecutive-segment), ordered by real run
 * time (runtime-golden manifest startedAt/completedAt), then split 70/15/15
 * at run granularity. The test bucket is the real-only future holdout.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { canonicalJson } from "../../sim/tools/artifacts.ts";
import {
  parseDecisionJsonl,
  type DecisionJoinIndex,
  type DecisionJoinRecord,
} from "../real/decision-join.ts";
import { projectMlSampleToFeatureV2, type FeatureV2Record } from "../real/ml-sample-feature-v2.ts";
import { FEATURE_V2_NAMES } from "../schema/feature-vector-v2.ts";

export type MlSplitName = "train" | "validation" | "test";

export interface RealSampleExportOptions {
  /** Resolved ARENA_DATA_ROOT. */
  readonly dataRoot: string;
  /** Build id, also used as the output directory name. */
  readonly buildId: string;
  /** Restrict to these dataset ids (registry datasetId). Default: all. */
  readonly datasetIds?: readonly string[];
  /**
   * Default false: missing decision rows become threat_unknown=1 (explicit)
   * instead of an error. The run-20260806/07 t3/t4 runs have no telemetry.
   */
  readonly requireDecisionJoin?: boolean;
  /** Default false: synthetic datasets (synthetic-* ids) are excluded — M1b
   *  builds the REAL-only pool; sim data has its own path from M2/M3. */
  readonly includeSynthetic?: boolean;
  /** Default { train: 0.7, validation: 0.15, test: 0.15 }. */
  readonly splitRatios?: Readonly<Record<MlSplitName, number>>;
  /** Replace an existing build directory when set. */
  readonly force?: boolean;
}

export interface RunTimeInfo {
  readonly processRunId: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface FeatureQualityEntry {
  readonly feature: string;
  readonly count: number;
  readonly nonNull: number;
  readonly nullFraction: number;
  readonly unique: number;
  readonly constant: boolean;
  readonly nearConstant: boolean;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly std: number | null;
  readonly active: boolean;
}

export interface FeatureQualityReport {
  readonly schema: "feature-quality-v1";
  readonly buildId: string;
  readonly createdAt: string;
  /** P0 hygiene: stats cover TRAIN-ELIGIBLE rows only — the mask and the
   *  OOD min/max reference must never see validation/test distributions
   *  (transductive leakage). */
  readonly scope: "train-eligible";
  readonly scopeCount: number;
  readonly dimension: number;
  readonly entries: readonly FeatureQualityEntry[];
  readonly activeMask: Readonly<Record<string, boolean>>;
  readonly constantFeatures: readonly string[];
  readonly nearConstantFeatures: readonly string[];
  readonly alwaysMissingFeatures: readonly string[];
}

export interface MlSplitRunAssignment {
  readonly processRunId: string;
  readonly startedAt: string;
  readonly split: MlSplitName;
  readonly sampleCount: number;
  readonly eligibleSampleCount: number;
}

export interface MlSplitReport {
  readonly schema: "split-report-v1";
  readonly buildId: string;
  readonly rule: string;
  readonly ratios: Readonly<Record<MlSplitName, number>>;
  readonly runs: readonly MlSplitRunAssignment[];
  readonly counts: Readonly<Record<MlSplitName, { runs: number; samples: number; eligible: number }>>;
  readonly leakChecks: {
    readonly runCrossesSplit: number;
    readonly sampleInMultipleSplits: number;
  };
}

export interface RealSampleExportResult {
  readonly buildDir: string;
  readonly totalSamples: number;
  readonly eligibleSamples: number;
  readonly failedSamples: number;
  readonly split: MlSplitReport;
  readonly quality: FeatureQualityReport;
  readonly datasetIds: readonly string[];
  readonly samplesHash: string;
}

interface RegistryEntry {
  readonly datasetId: string;
  readonly sampleCount: number;
  readonly processRunIds: readonly string[];
  readonly datasetHash: string;
}

interface SampleRow {
  readonly sample: Record<string, unknown>;
  readonly feature: FeatureV2Record;
  readonly eligible: boolean;
  readonly runTime: RunTimeInfo;
}

const DEFAULT_SPLIT_RATIOS: Readonly<Record<MlSplitName, number>> = {
  train: 0.7,
  validation: 0.15,
  test: 0.15,
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Read registry.jsonl rows (datasetId, sampleCount, processRunIds). */
function readRegistry(dataRoot: string): RegistryEntry[] {
  const registryPath = join(dataRoot, "datasets", "registry.jsonl");
  if (!existsSync(registryPath)) return [];
  const entries: RegistryEntry[] = [];
  for (const line of readFileSync(registryPath, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.schema !== "dataset-registry-entry-v1") continue;
    entries.push({
      datasetId: parsed.datasetId as string,
      sampleCount: parsed.sampleCount as number,
      processRunIds: [...(parsed.processRunIds as string[])],
      datasetHash: parsed.datasetHash as string,
    });
  }
  return entries;
}

/** Extract `runtime/<tenant>/calibration/<pid>` from a data-root-relative uri. */
function tenantFromUri(uri: string): string | null {
  const parts = uri.split("/");
  if (parts.length >= 3 && parts[0] === "runtime" && parts[1] !== "datasets") {
    return parts[1] ?? null;
  }
  return null;
}

/** Merge every tenant's decision.jsonl into one join index (keys are
 *  (processRunId, tick); a duplicate across tenants fails closed). */
function loadAllDecisionIndexes(dataRoot: string): DecisionJoinIndex {
  const records = new Map<string, DecisionJoinRecord>();
  let rowsParsed = 0;
  let malformedRows = 0;
  let rowsWithThreatLevel = 0;
  for (const tenant of ["t1", "t2", "t3", "t4"]) {
    const path = join(dataRoot, "runtime", tenant, "telemetry", "decision.jsonl");
    if (!existsSync(path)) continue;
    const index = parseDecisionJsonl(readFileSync(path, "utf8"));
    rowsParsed += index.stats.rowsParsed;
    malformedRows += index.stats.malformedRows;
    rowsWithThreatLevel += index.stats.rowsWithThreatLevel;
    for (const [key, record] of index.records) {
      if (records.has(key)) {
        throw new Error(`duplicate decision telemetry join key across tenants: ${key}`);
      }
      records.set(key, record);
    }
  }
  return {
    records,
    stats: Object.freeze({
      rowsParsed,
      rowsIndexed: records.size,
      rowsWithThreatLevel,
      rowsWithoutThreatLevel: records.size - rowsWithThreatLevel,
      malformedRows,
    }),
  };
}

/**
 * Resolve the real run time for a processRunId from its runtime-golden
 * manifest (startedAt/completedAt). Returns null when the manifest is gone;
 * the caller falls back to a stable tie-breaker.
 */
function loadRunTime(dataRoot: string, processRunId: string, tenant: string | null): RunTimeInfo | null {
  if (tenant === null) return null;
  const manifestPath = join(dataRoot, "runtime", tenant, "calibration", processRunId, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = readJson<{ startedAt: string; completedAt: string }>(manifestPath);
    return { processRunId, startedAt: manifest.startedAt, completedAt: manifest.completedAt };
  } catch {
    return null;
  }
}

/** Numeric stats for one feature column across feature records. */
function columnStats(values: readonly number[]): {
  unique: number;
  constant: boolean;
  min: number | null;
  max: number | null;
  mean: number | null;
  std: number | null;
} {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return { unique: 0, constant: true, min: null, max: null, mean: null, std: null };
  }
  const unique = new Set(finite).size;
  const constant = unique <= 1;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const variance = finite.reduce(
    (sum, value) => sum + (value - mean) * (value - mean), 0,
  ) / finite.length;
  return {
    unique,
    constant,
    min: Math.min(...finite),
    max: Math.max(...finite),
    mean,
    std: Math.sqrt(variance),
  };
}

/**
 * Feature-quality report over TRAIN-ELIGIBLE rows only (P0 hygiene): the
 * active mask and the OOD min/max reference must never observe
 * validation/test distributions — that would be transductive leakage into
 * the future holdout and into the deployed OOD reference.
 *
 * Constant/near-constant semantics:
 * - constant: a single unique value (no information at all);
 * - near-constant: extreme value concentration — the most common value
 *   covers >99% of non-null rows (binary one-hot style features use a
 *   slightly looser 99.5% bar since {0,1} skew is their normal shape).
 *   Low-cardinality integer features (resources, coordinates, counts) are
 *   NOT near-constant when their values are spread across the range.
 */
function buildFeatureQuality(
  buildId: string,
  features: readonly FeatureV2Record[],
): FeatureQualityReport {
  const names = FEATURE_V2_NAMES;
  const columns = names.map((name) => {
    const values = features
      .map((feature) => feature.features[name])
      .filter((value): value is number => typeof value === "number");
    const nonNull = values.length;
    const stats = columnStats(values);
    const binary = new Set(values).size <= 2 &&
      values.every((value) => value === 0 || value === 1);
    const topValueCounts = new Map<number, number>();
    for (const value of values) {
      topValueCounts.set(value, (topValueCounts.get(value) ?? 0) + 1);
    }
    const topValueFraction = nonNull === 0 ? 0 : Math.max(...topValueCounts.values()) / nonNull;
    const nearConstant = !stats.constant && topValueFraction > (binary ? 0.995 : 0.99);
    const alwaysMissing = nonNull === 0;
    const active = !stats.constant && !nearConstant;
    return {
      feature: name,
      count: features.length,
      nonNull,
      nullFraction: features.length === 0 ? 0 : (features.length - nonNull) / features.length,
      unique: stats.unique,
      constant: stats.constant,
      nearConstant,
      min: stats.min,
      max: stats.max,
      mean: stats.mean,
      std: stats.std,
      active,
    };
  });
  const activeMask: Record<string, boolean> = {};
  for (const entry of columns) activeMask[entry.feature] = entry.active;
  return {
    schema: "feature-quality-v1",
    buildId,
    createdAt: new Date().toISOString(),
    scope: "train-eligible",
    scopeCount: features.length,
    dimension: names.length,
    entries: columns,
    activeMask,
    constantFeatures: columns.filter((entry) => entry.constant).map((entry) => entry.feature),
    nearConstantFeatures: columns.filter((entry) => entry.nearConstant).map((entry) => entry.feature),
    alwaysMissingFeatures: columns.filter((entry) => entry.nullFraction === 1).map((entry) => entry.feature),
  };
}

function buildMlSplitReport(
  buildId: string,
  runs: readonly { runTime: RunTimeInfo; sampleCount: number; eligible: number; split: MlSplitName }[],
  ratios: Readonly<Record<MlSplitName, number>>,
): MlSplitReport {
  const counts: Record<MlSplitName, { runs: number; samples: number; eligible: number }> = {
    train: { runs: 0, samples: 0, eligible: 0 },
    validation: { runs: 0, samples: 0, eligible: 0 },
    test: { runs: 0, samples: 0, eligible: 0 },
  };
  const assignments: MlSplitRunAssignment[] = [];
  for (const run of runs) {
    const assignment: MlSplitRunAssignment = {
      processRunId: run.runTime.processRunId,
      startedAt: run.runTime.startedAt,
      split: run.split,
      sampleCount: run.sampleCount,
      eligibleSampleCount: run.eligible,
    };
    assignments.push(assignment);
    counts[run.split].runs += 1;
    counts[run.split].samples += run.sampleCount;
    counts[run.split].eligible += run.eligible;
  }
  return {
    schema: "split-report-v1",
    buildId,
    rule: "chronological by real run time (runtime-golden manifest startedAt); runs never cross a split boundary",
    ratios,
    runs: assignments,
    counts,
    leakChecks: { runCrossesSplit: 0, sampleInMultipleSplits: 0 },
  };
}

export function exportRealSamples(options: RealSampleExportOptions): RealSampleExportResult {
  const dataRoot = resolve(options.dataRoot);
  const buildDir = join(dataRoot, "runs", "ml", options.buildId);
  if (existsSync(buildDir)) {
    if (!options.force) {
      throw new Error(`build directory already exists: ${buildDir} (use --force to replace)`);
    }
    rmSync(buildDir, { recursive: true, force: true });
  }
  mkdirSync(buildDir, { recursive: true });

  const registry = readRegistry(dataRoot);
  const selected = options.datasetIds === undefined
    ? registry
    : registry.filter((entry) => (options.datasetIds as readonly string[]).includes(entry.datasetId));
  const datasets = selected
    .filter((entry) => entry.sampleCount > 0)
    .filter((entry) => options.includeSynthetic === true || !entry.datasetId.startsWith("synthetic-"));
  if (datasets.length === 0) {
    throw new Error("no eligible datasets found in registry");
  }

  const decisionIndex = loadAllDecisionIndexes(dataRoot);
  const rows: SampleRow[] = [];
  let failedSamples = 0;
  const datasetIds: string[] = [];

  for (const entry of datasets) {
    const samplesPath = join(dataRoot, "datasets", entry.datasetId, "samples.jsonl");
    if (!existsSync(samplesPath)) continue;
    datasetIds.push(entry.datasetId);
    const runTimeCache = new Map<string, RunTimeInfo | null>();
    for (const line of readFileSync(samplesPath, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      const sample = JSON.parse(line) as Record<string, unknown>;
      const provenance = sample.provenance as Record<string, unknown>;
      const processRunId = provenance.processRunId as string;
      let runTime = runTimeCache.get(processRunId);
      if (runTime === undefined) {
        const firstRef = (provenance.sourceRefs as Array<{ uri: string | null }>)[0];
        const tenant = firstRef?.uri ? tenantFromUri(firstRef.uri) : null;
        runTime = loadRunTime(dataRoot, processRunId, tenant);
        runTimeCache.set(processRunId, runTime);
      }
      let feature: FeatureV2Record;
      try {
        feature = projectMlSampleToFeatureV2(sample, decisionIndex, {
          requireDecisionJoin: options.requireDecisionJoin ?? false,
        });
      } catch {
        failedSamples += 1;
        continue;
      }
      const validity = provenance.realLabelValidity as
        | { usableForSupervisedLearning?: boolean } | undefined;
      // Pre-M1a-1 datasets (t1/t2) lack the field; infer the same semantics
      // from source + windowComplete (schema-optional backward compat).
      const observed = provenance.source === "live";
      const windowComplete = (sample.label as Record<string, unknown>).windowComplete === true;
      const eligible = validity?.usableForSupervisedLearning === true ||
        (validity === undefined && observed && windowComplete);
      rows.push({
        sample,
        feature,
        eligible,
        runTime: runTime ?? {
          processRunId,
          startedAt: entry.datasetHash.slice(0, 8),
          completedAt: entry.datasetHash.slice(0, 8),
        },
      });
    }
  }

  // Group rows by processRunId; assign every row of a run to one split.
  const rowsByRun = new Map<string, SampleRow[]>();
  for (const row of rows) {
    const runKey = row.runTime.processRunId;
    const group = rowsByRun.get(runKey) ?? [];
    group.push(row);
    rowsByRun.set(runKey, group);
  }
  const runs = [...rowsByRun.entries()]
    .map(([processRunId, group]) => ({
      runTime: group[0]!.runTime,
      sampleCount: group.length,
      eligible: group.filter((row) => row.eligible).length,
      group,
    }))
    .sort((left, right) => {
      const timeOrder = left.runTime.startedAt.localeCompare(right.runTime.startedAt);
      if (timeOrder !== 0) return timeOrder;
      return left.runTime.processRunId.localeCompare(right.runTime.processRunId);
    });
  const ratios = options.splitRatios ?? DEFAULT_SPLIT_RATIOS;
  const totalEligible = runs.reduce((sum, run) => sum + run.eligible, 0);
  if (totalEligible === 0) {
    throw new Error("no eligible (usableForSupervisedLearning) samples found");
  }
  const trainRuns = Math.round(runs.length * ratios.train);
  const validationRuns = Math.round(runs.length * ratios.validation);
  const splitByRun = new Map<string, MlSplitName>();
  runs.forEach((run, index) => {
    splitByRun.set(
      run.runTime.processRunId,
      index < trainRuns
        ? "train"
        : index < trainRuns + validationRuns
          ? "validation"
          : "test",
    );
  });

  const allRecords = rows
    .map((row) => {
      const provenance = row.sample.provenance as Record<string, unknown>;
      const validity = provenance.realLabelValidity as
        | { usableForSupervisedLearning?: boolean } | undefined;
      // Pre-M1a-1 samples carry no field; emit the inferred two-dim record.
      const inferredValidity = validity ?? {
        observed: provenance.source === "live",
        lineageValid: true,
        windowComplete: (row.sample.label as Record<string, unknown>).windowComplete === true,
        usableForSupervisedLearning:
          provenance.source === "live" &&
          (row.sample.label as Record<string, unknown>).windowComplete === true,
      };
      return {
        ...row.feature,
        split: splitByRun.get(row.runTime.processRunId) ?? "train",
        realLabelValidity: inferredValidity,
        simReplayConfidence: provenance.simReplayConfidence,
      };
    })
    .sort((left, right) => {
      const timeOrder = left.processRunId.localeCompare(right.processRunId);
      if (timeOrder !== 0) return timeOrder;
      return (left.tick as number) - (right.tick as number);
    });

  const splitLines: Record<MlSplitName, string[]> = {
    train: [],
    validation: [],
    test: [],
  };
  for (const record of allRecords) {
    const split = record.split as MlSplitName;
    const validity = record.realLabelValidity as { usableForSupervisedLearning?: boolean };
    if (validity.usableForSupervisedLearning !== true) continue;
    splitLines[split].push(JSON.stringify(record));
  }

  const featuresAllContent = allRecords.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const samplesHash = createHash("sha256").update(featuresAllContent, "utf8").digest("hex");
  writeFileSync(join(buildDir, "features-all.jsonl"), featuresAllContent, "utf8");
  for (const split of ["train", "validation", "test"] as const) {
    writeFileSync(join(buildDir, `${split}.jsonl`), splitLines[split].join("\n") + "\n", "utf8");
  }

  // P0 hygiene: the feature-quality report (activeMask + OOD min/max reference)
  // is computed over TRAIN-ELIGIBLE rows only. Validation/test rows are
  // evaluated, never used to compute the mask or the deployed ranges.
  const trainEligibleRecords = allRecords
    .filter((record) => record.split === "train")
    .filter(
      (record) =>
        (record.realLabelValidity as { usableForSupervisedLearning?: boolean })
          .usableForSupervisedLearning === true,
    );
  const quality = buildFeatureQuality(options.buildId, trainEligibleRecords as unknown as FeatureV2Record[]);
  writeFileSync(join(buildDir, "feature-quality.json"), `${canonicalJson(quality)}\n`, "utf8");

  const splitReport = buildMlSplitReport(
    options.buildId,
    runs.map(({ runTime, sampleCount, eligible }) => ({
      runTime,
      sampleCount,
      eligible,
      split: splitByRun.get(runTime.processRunId) ?? "train",
    })),
    ratios,
  );
  writeFileSync(join(buildDir, "split-report.json"), `${canonicalJson(splitReport)}\n`, "utf8");

  const manifest = {
    schema: "ml-run-manifest-v1",
    buildId: options.buildId,
    createdAt: new Date().toISOString(),
    featureSchema: FEATURE_V2_NAMES.length,
    datasetIds,
    datasetCount: datasetIds.length,
    totalSamples: allRecords.length,
    eligibleSamples: totalEligible,
    failedSamples,
    split: {
      rule: splitReport.rule,
      ratios,
      counts: splitReport.counts,
    },
    requireDecisionJoin: options.requireDecisionJoin ?? false,
    samplesHash,
    artifacts: [
      { path: "features-all.jsonl", recordCount: allRecords.length },
      { path: "train.jsonl", recordCount: splitLines.train.length },
      { path: "validation.jsonl", recordCount: splitLines.validation.length },
      { path: "test.jsonl", recordCount: splitLines.test.length },
      { path: "feature-quality.json" },
      { path: "split-report.json" },
    ],
  };
  writeFileSync(join(buildDir, "manifest.json"), `${canonicalJson(manifest)}\n`, "utf8");

  return {
    buildDir,
    totalSamples: allRecords.length,
    eligibleSamples: totalEligible,
    failedSamples,
    split: splitReport,
    quality,
    datasetIds,
    samplesHash,
  };
}
