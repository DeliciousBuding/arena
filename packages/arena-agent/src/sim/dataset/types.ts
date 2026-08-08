/** Shared types for the offline ml-sample-v1 dataset builder (P1-1). */

import type { CalibrationCaseV1 } from "../calibration/schema.ts";

export const SUPPORTED_RULES_VERSION = "v0.14";

/** A runtime-golden dataset manifest entry (mirrors recorder.ts entry shape). */
export interface GoldenCaseEntry {
  readonly caseId: string;
  readonly tick: number;
  readonly file: string;
  readonly caseSha256: string;
  readonly beforeSha256: string;
  readonly planSha256: string;
  readonly afterSha256: string;
}

/** Strict local view of a runtime-golden dataset manifest. */
export interface GoldenDatasetManifest {
  readonly schema: "runtime-golden-dataset-v1";
  readonly datasetId: string;
  readonly tenantId: string;
  readonly rulesVersion: string;
  readonly sourceCommit: string;
  readonly configHash: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly caseCount: number;
  readonly skippedRejected: number;
  readonly droppedPending: number;
  readonly errorCount: number;
  readonly cases: readonly GoldenCaseEntry[];
  readonly errors: readonly string[];
}

/** A calibration case plus its derived context inside one (processRunId, runId) group. */
export interface ParsedCase {
  readonly entry: GoldenCaseEntry;
  readonly caseValue: CalibrationCaseV1;
  readonly caseFilePath: string;
  readonly runId: string;
  readonly sampleStatus: "conclusive" | "inconclusive" | null;
}

export type SplitName = "train" | "validation" | "test";

export interface QuarantineRecord {
  readonly caseId: string;
  readonly reason: string;
}

export interface DatasetBuildOptions {
  /** Path to a runtime-golden manifest.json or to a calibration directory containing one. */
  readonly inputPath: string;
  readonly rulesPath: string;
  /** Resolved ARENA_DATA_ROOT (output base and telemetry root). */
  readonly dataRoot: string;
  /** Override the default datasetId (manifest.datasetId). */
  readonly datasetId?: string;
  /** Replace an existing dataset directory when set. */
  readonly force?: boolean;
}

export interface SplitRunAssignment {
  readonly processRunId: string;
  readonly runId: string;
  readonly completedAt: string;
  readonly split: SplitName;
  readonly sampleCount: number;
  readonly completeWindowSampleCount: number;
}

export interface SplitCounts {
  readonly runs: number;
  readonly samples: number;
  readonly completeLabelWindows: number;
}

/** The quality report is a stable builder output but NOT a shared schema (design 5.5). */
export interface QualityReport {
  readonly schema: "arena-dataset-quality-report";
  readonly datasetId: string;
  readonly createdAt: string;
  readonly rulesVersion: string;
  readonly rulesManifestHash: string;
  readonly input: {
    readonly manifestUri: string;
    readonly processRunId: string;
    readonly tenantId: string;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly skippedRejected: number;
    readonly droppedPending: number;
    readonly recorderErrorCount: number;
  };
  readonly counts: {
    readonly caseEntries: number;
    readonly casesParsed: number;
    readonly duplicateCases: number;
    readonly integrityFailures: number;
    readonly parseFailures: number;
    readonly calibrationErrors: number;
    readonly hardMismatchCases: number;
    readonly inconclusiveCases: number;
    readonly inconclusiveSamples: number;
    readonly conclusiveSamples: number;
    readonly absentOpponentPlansCount: number;
    readonly policyParseErrors: number;
    readonly policyPostureNormalized: number;
    readonly tickGapCases: number;
    readonly schemaFailures: number;
    readonly quarantineTotal: number;
    readonly samplesDerived: number;
    readonly samplesWritten: number;
    readonly completeLabelWindows: number;
    readonly incompleteLabelWindows: number;
  };
  readonly versionMixing: {
    readonly versionsSeen: Readonly<Record<string, number>>;
    readonly acceptedVersion: string;
    readonly mixed: boolean;
  };
  readonly sourceShare: {
    readonly live: number;
    readonly sim: number;
    readonly byTenant: Readonly<Record<string, number>>;
    readonly byEngine: Readonly<Record<string, number>>;
  };
  readonly calibration: {
    readonly statusCounts: Readonly<Record<string, number>>;
    readonly taxonomyCounts: Readonly<Record<string, number>>;
    readonly knownEventMatched: number;
    readonly knownEventCompared: number;
    readonly knownEventAccuracy: number | null;
    readonly hardMismatchCaseCount: number;
    readonly unclassifiedDifferenceCount: number;
    readonly expectedUnknownCount: number;
  };
  /** 2026-08-08 契约两维：真实监督样本资格（与 simReplayConfidence 正交）。 */
  readonly realLabelValidity: {
    readonly observedSamples: number;
    readonly lineageValidSamples: number;
    readonly windowCompleteSamples: number;
    readonly usableForSupervisedLearning: number;
  };
  /** 2026-08-08 契约两维：Simulator 对 transition 的证明强度分布。 */
  readonly simReplayConfidenceCounts: {
    readonly match: number;
    readonly expectedUnknown: number;
    readonly mismatch: number;
    readonly unsupported: number;
  };
  readonly coverage: {
    readonly combat: number;
    readonly core: number;
    readonly beacon: number;
    readonly respawn: number;
    readonly samplesWithDeaths: number;
  };
  readonly splits: {
    readonly rule: string;
    readonly ratios: Readonly<Record<SplitName, number>>;
    readonly runAssignments: readonly SplitRunAssignment[];
    readonly counts: Readonly<Record<SplitName, SplitCounts>>;
    readonly leakChecks: {
      readonly runCrossesSplit: number;
      readonly sampleInMultipleSplits: number;
    };
  };
  readonly gates: {
    readonly schemaFailures: number;
    readonly crossRulesMixing: number;
    readonly crossSplitLeakage: number;
    readonly manifestSelfCheckFailures: number;
    readonly passed: boolean;
  };
  readonly quarantine: readonly QuarantineRecord[];
  readonly quarantineByReason: Readonly<Record<string, number>>;
  readonly registry: {
    readonly appended: boolean;
    readonly entryUri: string;
    readonly reason: string;
  };
}

export interface DatasetBuildResult {
  readonly datasetId: string;
  readonly datasetDir: string;
  readonly samplesHash: string;
  readonly datasetHash: string;
  readonly sampleCount: number;
  readonly gatePassed: boolean;
  readonly report: QualityReport;
}
