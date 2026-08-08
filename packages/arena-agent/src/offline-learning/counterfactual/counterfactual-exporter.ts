/**
 * M2c.1 batch exporter: real macro decision points → completed private worlds →
 * matched Simulator forks → q-sample-v1 + derived pairwise preferences.
 *
 * This is deliberately an offline/read-only data path. It never writes to
 * runtime telemetry or the official server; artifacts are confined to
 * data/runs/sim by the simulator artifact helpers.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { parseCalibrationCase } from "../../sim/calibration/schema.ts";
import {
  atomicWriteJson,
  atomicWriteJsonl,
  canonicalJson,
  defaultRunId,
  prepareRunDir,
  resolveOutputBase,
  sha256Text,
} from "../../sim/tools/artifacts.ts";
import {
  loadDecisionJoinIndex,
  lookupDecisionRecord,
  type DecisionJoinIndex,
} from "../real/decision-join.ts";
import type { FeatureV2Context } from "../schema/feature-vector-v2.ts";
import {
  derivePairwisePreferences,
  type QPairwisePreferenceV1,
  type QSampleV1,
  type SimContinuationPolicy,
} from "../q-sample/q-sample-v1.ts";
import {
  validateMacroDecisionPointV1,
  type MacroDecisionPointV1,
} from "../runtime/macro-decision-point.ts";
import { runCounterfactualRollouts } from "./counterfactual-rollout.ts";
import {
  createVisibleOnlyCompletionProvider,
  type DecisionWorldCompletionProvider,
} from "./world-completion.ts";

const DECISION_POINT_FIELDS = [
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
] as const;

interface DecisionPointTelemetryRecord {
  readonly tenantId: string;
  readonly event: MacroDecisionPointV1;
}

export interface CounterfactualDatasetExportOptions {
  readonly dataRoot: string;
  readonly tenantId: string;
  readonly decisionPointsPath: string;
  readonly decisionTelemetryPath: string;
  /** data/runtime/<tenant>/calibration */
  readonly calibrationRoot: string;
  readonly rulesPath: string;
  readonly scenarioSeeds: readonly number[];
  readonly horizons?: readonly number[];
  readonly simulatorVersion: string;
  readonly certificateVersion: string;
  /** DEV confidence is explicit; production weighting can later derive from certificate/provenance. */
  readonly confidence: number;
  readonly continuationPolicy?: SimContinuationPolicy;
  readonly completionProvider?: DecisionWorldCompletionProvider;
  readonly runId?: string;
  readonly force?: boolean;
  readonly maxDecisionPoints?: number;
}

export interface CounterfactualDatasetExportStats {
  readonly decisionPointsRead: number;
  readonly decisionPointsExported: number;
  readonly samples: number;
  readonly evaluations: number;
  readonly pairwisePreferences: number;
  readonly trajectories: number;
  readonly skippedCandidates: number;
  readonly missingThreatContext: number;
}

export interface CounterfactualDatasetExportResult {
  readonly runDir: string;
  readonly qSamplesPath: string;
  readonly pairwisePath: string;
  readonly manifestPath: string;
  readonly reportPath: string;
  readonly stats: CounterfactualDatasetExportStats;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDecisionPointTelemetryJsonl(text: string): DecisionPointTelemetryRecord[] {
  const records: DecisionPointTelemetryRecord[] = [];
  const seen = new Set<string>();
  let lineNumber = 0;
  for (const line of text.split(/\r?\n/u)) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      throw new Error(`decision-point JSONL line ${lineNumber}: invalid JSON: ${String(error)}`);
    }
    if (!isRecord(raw) || typeof raw.tenantId !== "string" || raw.tenantId.length === 0) {
      throw new Error(`decision-point JSONL line ${lineNumber}: tenantId is required`);
    }
    const eventRecord: Record<string, unknown> = {};
    for (const field of DECISION_POINT_FIELDS) eventRecord[field] = raw[field];
    const problems = validateMacroDecisionPointV1(eventRecord);
    if (problems.length > 0) {
      throw new Error(`decision-point JSONL line ${lineNumber}: ${problems.join("; ")}`);
    }
    const event = eventRecord as unknown as MacroDecisionPointV1;
    if (seen.has(event.decisionPointId)) {
      throw new Error(`duplicate decisionPointId ${event.decisionPointId}`);
    }
    seen.add(event.decisionPointId);
    records.push(Object.freeze({ tenantId: raw.tenantId, event }));
  }
  return records;
}

function calibrationCasePath(calibrationRoot: string, point: MacroDecisionPointV1): string {
  return join(
    calibrationRoot,
    point.processRunId,
    "cases",
    `${String(point.tick).padStart(10, "0")}.json`,
  );
}

function featureContextFor(
  point: MacroDecisionPointV1,
  decisionIndex: DecisionJoinIndex,
): { readonly context: FeatureV2Context; readonly missingThreat: boolean } {
  const decision = lookupDecisionRecord(decisionIndex, point.processRunId, point.tick);
  return {
    context: {
      threatLevel: decision?.threatLevel ?? null,
      recentNonNormalThreatTicks6: decision?.recentNonNormalThreatTicks6 ?? null,
      workerTarget: point.previousPolicy.workerTarget,
      militaryRatio: point.previousPolicy.militaryRatio,
      posture: point.previousPolicy.posture,
    },
    missingThreat: decision === null || decision.threatLevel === null,
  };
}

function behaviorPolicyVersion(sourceCommit: string | null): string {
  if (sourceCommit === null || sourceCommit.length === 0) {
    throw new Error("counterfactual export: calibration case sourceCommit is required for policy lineage");
  }
  return `commit:${sourceCommit}`;
}

function validateOptions(options: CounterfactualDatasetExportOptions): void {
  if (options.tenantId.length === 0) throw new Error("tenantId is required");
  if (options.simulatorVersion.length === 0) throw new Error("simulatorVersion is required");
  if (options.certificateVersion.length === 0) throw new Error("certificateVersion is required");
  if (!Number.isFinite(options.confidence) || options.confidence < 0 || options.confidence > 1) {
    throw new Error("confidence must be in [0,1]");
  }
  if (options.maxDecisionPoints !== undefined &&
      (!Number.isSafeInteger(options.maxDecisionPoints) || options.maxDecisionPoints < 1)) {
    throw new Error("maxDecisionPoints must be a positive safe integer");
  }
}

export function exportCounterfactualDataset(
  options: CounterfactualDatasetExportOptions,
): CounterfactualDatasetExportResult {
  validateOptions(options);
  const decisionPointText = readFileSync(options.decisionPointsPath, "utf8");
  const allPoints = parseDecisionPointTelemetryJsonl(decisionPointText)
    .filter((record) => record.tenantId === options.tenantId);
  const selected = options.maxDecisionPoints === undefined
    ? allPoints
    : allPoints.slice(-options.maxDecisionPoints);
  if (selected.length === 0) {
    throw new Error(`counterfactual export: no decision points for tenant ${options.tenantId}`);
  }
  const decisionIndex = loadDecisionJoinIndex(options.decisionTelemetryPath);
  const completionProvider = options.completionProvider ?? createVisibleOnlyCompletionProvider();

  const samples: QSampleV1[] = [];
  const pairwise: QPairwisePreferenceV1[] = [];
  const usedCases: Array<{
    readonly decisionPointId: string;
    readonly path: string;
    readonly sha256: string;
    readonly sourceCommit: string;
  }> = [];
  let trajectories = 0;
  let skippedCandidates = 0;
  let missingThreatContext = 0;

  for (const { event: point } of selected) {
    const casePath = calibrationCasePath(options.calibrationRoot, point);
    if (!existsSync(casePath)) {
      throw new Error(`counterfactual export: calibration case missing for ${point.decisionPointId}: ${casePath}`);
    }
    const caseText = readFileSync(casePath, "utf8");
    const calibrationCase = parseCalibrationCase(JSON.parse(caseText));
    const completion = completionProvider.complete({ decisionPoint: point, calibrationCase });
    const feature = featureContextFor(point, decisionIndex);
    if (feature.missingThreat) missingThreatContext += 1;

    const rollout = runCounterfactualRollouts({
      decisionPoint: point,
      tenantId: options.tenantId,
      initialWorld: completion.world,
      rulesPath: options.rulesPath,
      scenarioSeeds: options.scenarioSeeds,
      horizons: options.horizons,
      behaviorPolicyVersion: behaviorPolicyVersion(calibrationCase.metadata.sourceCommit),
      simulatorVersion: options.simulatorVersion,
      certificateVersion: options.certificateVersion,
      opponentId: completion.opponentId,
      initialStateScope: completion.initialStateScope,
      completionPolicy: completion.completionPolicy,
      completionSeed: completion.completionSeed,
      completionAssumptions: completion.completionAssumptions,
      confidence: options.confidence,
      featureContext: feature.context,
      continuationPolicy: options.continuationPolicy ?? "revert-baseline",
    });
    samples.push(rollout.sample);
    pairwise.push(...derivePairwisePreferences(rollout.sample));
    trajectories += rollout.stats.trajectories;
    skippedCandidates += rollout.stats.skippedCandidates.length;
    usedCases.push(Object.freeze({
      decisionPointId: point.decisionPointId,
      path: casePath,
      sha256: sha256Text(caseText),
      sourceCommit: calibrationCase.metadata.sourceCommit!,
    }));
  }

  const identity = {
    tenantId: options.tenantId,
    simulatorVersion: options.simulatorVersion,
    certificateVersion: options.certificateVersion,
    completionPolicy: completionProvider.id,
    seeds: [...options.scenarioSeeds],
    horizons: [...(options.horizons ?? [20, 32, 64])],
    decisionPointInputSha256: sha256Text(decisionPointText),
  };
  const outputBase = resolveOutputBase(options.dataRoot, null);
  const runId = options.runId ?? defaultRunId("counterfactual-q", identity);
  const runDir = prepareRunDir(outputBase, runId, options.force ?? false);
  const qSamplesPath = join(runDir, "q-samples.jsonl");
  const pairwisePath = join(runDir, "pairwise-preferences.jsonl");
  const reportPath = join(runDir, "report.json");
  const manifestPath = join(runDir, "manifest.json");
  const qSamplesSha256 = atomicWriteJsonl(qSamplesPath, samples);
  const pairwiseSha256 = atomicWriteJsonl(pairwisePath, pairwise);

  const stats: CounterfactualDatasetExportStats = Object.freeze({
    decisionPointsRead: allPoints.length,
    decisionPointsExported: selected.length,
    samples: samples.length,
    evaluations: samples.reduce((sum, sample) => sum + sample.evaluations.length, 0),
    pairwisePreferences: pairwise.length,
    trajectories,
    skippedCandidates,
    missingThreatContext,
  });
  atomicWriteJson(reportPath, {
    schema: "counterfactual-q-report-v1",
    stats,
    completionPolicy: completionProvider.id,
    caveat: completionProvider.id === "private-visible-only-v1"
      ? "DEV_ONLY_PRIVATE_COMPLETION"
      : null,
  });
  atomicWriteJson(manifestPath, {
    schema: "counterfactual-q-manifest-v1",
    createdAt: new Date().toISOString(),
    tenantId: options.tenantId,
    inputs: {
      decisionPointsPath: options.decisionPointsPath,
      decisionPointsSha256: sha256Text(decisionPointText),
      decisionTelemetryPath: options.decisionTelemetryPath,
      decisionTelemetrySha256: sha256Text(readFileSync(options.decisionTelemetryPath, "utf8")),
      calibrationRoot: options.calibrationRoot,
      usedCases,
    },
    simulator: {
      simulatorVersion: options.simulatorVersion,
      certificateVersion: options.certificateVersion,
      rulesPath: options.rulesPath,
      scenarioSeeds: [...options.scenarioSeeds],
      horizons: [...(options.horizons ?? [20, 32, 64])],
      continuationPolicy: options.continuationPolicy ?? "revert-baseline",
      confidence: options.confidence,
      completionPolicy: completionProvider.id,
    },
    outputs: {
      qSamples: { file: basename(qSamplesPath), sha256: qSamplesSha256 },
      pairwisePreferences: { file: basename(pairwisePath), sha256: pairwiseSha256 },
      report: { file: basename(reportPath) },
    },
    stats,
  });

  return Object.freeze({
    runDir,
    qSamplesPath,
    pairwisePath,
    manifestPath,
    reportPath,
    stats,
  });
}

/** Exposed for CLI/tests; strict parse, no silent malformed-row skipping. */
export function parseMacroDecisionPointTelemetryJsonl(text: string): readonly DecisionPointTelemetryRecord[] {
  return Object.freeze(parseDecisionPointTelemetryJsonl(text));
}

/** Stable digest helper for manifests/tests. */
export function counterfactualExportIdentityJson(options: {
  readonly tenantId: string;
  readonly simulatorVersion: string;
  readonly certificateVersion: string;
  readonly completionPolicy: string;
  readonly scenarioSeeds: readonly number[];
  readonly horizons: readonly number[];
}): string {
  return canonicalJson(options, false);
}
