/**
 * Arena TS 离线学习基础设施（offline-learning foundation）。
 *
 * 公开 API 契约层——生产 TS planner 零依赖、零行动权。
 * 消费者（BC/DAgger/Decision Transformer/MAPPO/QMIX）按需取用子模块。
 *
 * 模块：
 * - schema/    数据契约（trajectory-v1、feature-vector-v1）
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
