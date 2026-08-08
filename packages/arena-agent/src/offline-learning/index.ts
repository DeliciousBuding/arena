/**
 * Arena TS 离线学习基础设施（offline-learning foundation）。
 *
 * 公开 API 契约层——生产 TS planner 零依赖、零行动权。
 * 消费者（BC/DAgger/Decision Transformer/MAPPO/QMIX）按需取用子模块。
 *
 * 模块：
 * - schema/    数据契约（trajectory-v1、feature-vector-v1/v2）
 * - export/    轨迹/特征导出器（JSONL，Arrow 契约声明）
 * - eval/      策略评估基准（benchmark-result-v1 + 标准指标）
 * - split/     Episode 级 train/val/test 分割（防泄漏）
 *
 * 版本：v1.0.0（初始 foundation）
 * 最后更新：2026-08-08
 */

// ── Schema ──
export {
  TRAJECTORY_SCHEMA_VERSION,
  computeTrajectoryId,
  projectStepState,
  projectTickState,
  projectStepAction,
  projectStepLabel,
  validateTrajectoryV1,
} from "./schema/trajectory.ts";
export type {
  TrajectoryV1,
  TrajectoryMetadata,
  TrajectoryStep,
  TrajectoryStepState,
  TrajectoryStepAction,
  TrajectoryStepLabel,
} from "./schema/trajectory.ts";

export {
  FEATURE_VECTOR_SCHEMA_VERSION,
  FEATURE_SPECS,
  FEATURE_NAMES,
  FEATURE_DIM,
  extractFeatureVector,
  featureVectorToRecord,
  featureNamesByGroup,
  featureIndicesByGroup,
  validateFeatureVector,
} from "./schema/feature-vector.ts";
export type { FeatureGroup, FeatureSpec } from "./schema/feature-vector.ts";

export {
  FEATURE_VECTOR_V2_SCHEMA_VERSION,
  FEATURE_V2_DISTANCE_CLIP,
  FEATURE_V2_RESOURCE_INNER_RADIUS,
  FEATURE_V2_RESOURCE_OUTER_RADIUS,
  FEATURE_V2_OBSTACLE_RADIUS,
  FEATURE_V2_THREAT_MEMORY_TICKS,
  FEATURE_V2_SPECS,
  FEATURE_V2_NAMES,
  FEATURE_V2_DIM,
  extractFeatureVectorV2,
  featureVectorV2ToRecord,
  validateFeatureVectorV2,
} from "./schema/feature-vector-v2.ts";
export type {
  FeatureV2Group,
  FeatureV2Spec,
  FeatureV2ThreatLevel,
  FeatureV2Posture,
  FeatureV2Context,
} from "./schema/feature-vector-v2.ts";

export {
  decisionJoinKey,
  parseDecisionJsonl,
  loadDecisionJoinIndex,
  lookupDecisionRecord,
} from "./real/decision-join.ts";
export type {
  DecisionJoinRecord,
  DecisionJoinStats,
  DecisionJoinIndex,
} from "./real/decision-join.ts";

export { projectMlSampleToFeatureV2 } from "./real/ml-sample-feature-v2.ts";
export type {
  MlSampleV1ForFeatures,
  FeatureV2Record,
  ProjectMlSampleOptions,
} from "./real/ml-sample-feature-v2.ts";

export {
  TRAJECTORY_V1_SCHEMA,
  FEATURE_VECTOR_V1_SCHEMA,
  BENCHMARK_RESULT_V1_SCHEMA,
  ALL_CONTRACTS,
} from "./schema/contracts.ts";

// ── Export ──
export { TrajectoryExporter } from "./export/trajectory-exporter.ts";
export type { TrajectoryExporterOptions, ExportStats } from "./export/trajectory-exporter.ts";

export { FeatureExporter } from "./export/feature-exporter.ts";
export type { FeatureExportOptions, FeatureExportStats } from "./export/feature-exporter.ts";

export { exportRealSamples } from "./export/real-sample-export.ts";
export type {
  MlSplitName,
  RealSampleExportOptions,
  RealSampleExportResult,
  RunTimeInfo,
  FeatureQualityEntry,
  FeatureQualityReport,
  MlSplitRunAssignment,
  MlSplitReport,
} from "./export/real-sample-export.ts";

// ── Candidate (M2a) ──
export {
  DECISION_CANDIDATE_SCHEMA_VERSION,
  CANDIDATE_KINDS,
  CANDIDATE_SOURCES,
  POSTURE_VALUES,
  TARGET_CLASSES,
  MIGRATE_DIRECTIONS,
  candidateSemanticRecord,
  computeCandidateDeterministicHash,
  computeCandidateSetHash,
  validateDecisionCandidateV1,
  makeCandidateV1,
} from "./candidate/decision-candidate-v1.ts";
export type {
  CandidateKind,
  CandidateSource,
  CandidateParameters,
  ParametersForKind,
  Posture,
  TargetClass,
  MigrateDirection,
  ResourceFocusParameters,
  AttackTargetParameters,
  MigrateParameters,
  DecisionCandidateV1,
} from "./candidate/decision-candidate-v1.ts";

// ── Candidate Generator (M2b) ──
export { generateCandidateSet } from "./candidate/candidate-generator.ts";
export type { CandidateGeneratorOptions } from "./candidate/candidate-generator.ts";
export {
  macroPoliciesEqual,
  applyCandidateToMacroPolicy,
  resolveExactPolicyCandidate,
} from "./candidate/candidate-policy.ts";

// ── Q-Sample (M2c) ──
export {
  Q_SAMPLE_SCHEMA_VERSION,
  PAIRWISE_PREFERENCE_SCHEMA_VERSION,
  Q_LABEL_SOURCES,
  INITIAL_STATE_SCOPES,
  SIM_CONTINUATION_POLICIES,
  SIM_UNKNOWN_EFFECT_KINDS,
  SUGGESTED_LABEL_HORIZONS,
  canonicalFeatures,
  computeFeatureHash,
  derivePairwisePreferences,
  validateQSampleV1,
  makeQSampleV1,
} from "./q-sample/q-sample-v1.ts";
export type {
  QLabelSource,
  InitialStateScope,
  SimContinuationPolicy,
  SimUnknownEffectKind,
  BehaviorPolicySnapshot,
  QSampleLabel,
  QSampleSimProvenance,
  QSampleEvaluation,
  QSampleV1,
  QPairwisePreferenceV1,
} from "./q-sample/q-sample-v1.ts";

// ── Decision Point shadow (M2b) ──
export {
  MACRO_DECISION_POINT_SCHEMA_VERSION,
  DECISION_CHOOSERS,
  resolveChosenCandidate,
  validateMacroDecisionPointV1,
} from "./runtime/macro-decision-point.ts";
export type {
  DecisionChooser,
  MacroDecisionPointV1,
} from "./runtime/macro-decision-point.ts";

// ── Counterfactual rollout (M2c.1) ──
export { runCounterfactualRollouts } from "./counterfactual/counterfactual-rollout.ts";
export type {
  CounterfactualRolloutOptions,
  CounterfactualRolloutStats,
  CounterfactualRolloutResult,
} from "./counterfactual/counterfactual-rollout.ts";
export {
  createVisibleOnlyCompletionProvider,
  completeVisibleOnlyDecisionWorld,
} from "./counterfactual/world-completion.ts";
export type {
  DecisionWorldCompletion,
  DecisionWorldCompletionInput,
  DecisionWorldCompletionProvider,
  VisibleOnlyCompletionOptions,
} from "./counterfactual/world-completion.ts";
export {
  exportCounterfactualDataset,
  parseMacroDecisionPointTelemetryJsonl,
  counterfactualExportIdentityJson,
} from "./counterfactual/counterfactual-exporter.ts";
export type {
  CounterfactualDatasetExportOptions,
  CounterfactualDatasetExportStats,
  CounterfactualDatasetExportResult,
} from "./counterfactual/counterfactual-exporter.ts";

// ── Runtime (M1d-lite) ──
export {
  UnavailableScorer,
} from "./runtime/model-scorer.ts";
export type {
  ModelScorer,
  ModelScoreResult,
} from "./runtime/model-scorer.ts";
export {
  computeOodReport,
  oodReferenceFromFeatureQuality,
} from "./runtime/ood-telemetry.ts";
export type {
  OodReference,
  OodReport,
  ShadowPredictionRecord,
} from "./runtime/ood-telemetry.ts";

// ── Eval ──
export {
  BENCHMARK_RESULT_SCHEMA_VERSION,
  createBenchmarkResult,
  validateBenchmarkResult,
} from "./eval/benchmark.ts";
export type {
  BenchmarkConfig,
  BenchmarkEpisodeResult,
  BenchmarkResult,
  PolicyUnderTest,
} from "./eval/benchmark.ts";

export {
  computeEpisodeMetrics,
  aggregateMetrics,
} from "./eval/metrics.ts";
export type { EpisodeMetrics } from "./eval/metrics.ts";

// ── Split ──
export {
  DEFAULT_SPLIT_RATIOS,
  assignChronologicalSplits,
  assignStratifiedSplits,
  validateSplitIntegrity,
  filterBySplit,
} from "./split/episode-split.ts";
export type {
  SplitName,
  SplitRatios,
  EpisodeSummary,
  SplitAssignment,
  SplitReport,
} from "./split/episode-split.ts";
