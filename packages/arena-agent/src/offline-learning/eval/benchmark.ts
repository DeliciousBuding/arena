/**
 * 策略评估基准契约（benchmark-result-v1）。
 *
 * 定义策略评估的标准输入/输出格式，不绑定任何特定策略实现。
 * TS 生产 planner 零依赖——本模块只定义"如何评估"，不依赖被评估对象。
 *
 * 使用模式：
 * 1. 定义 BenchmarkConfig（seeds, ticks, rules）
 * 2. 对每个 seed 运行 episode，收集 EpisodeMetrics
 * 3. 聚合为 BenchmarkResult
 * 4. 输出 benchmark-result-v1 JSON
 */

import { createHash } from "node:crypto";
import { aggregateMetrics, type EpisodeMetrics } from "./metrics.ts";

export const BENCHMARK_RESULT_SCHEMA_VERSION = "benchmark-result-v1" as const;

export interface BenchmarkConfig {
  readonly seeds: readonly number[];
  readonly ticksPerEpisode: number;
  readonly rulesVersion: string;
  readonly rulesManifestHash: string;
  readonly sourceCommit: string;
  readonly engineVersion: string;
}

export interface BenchmarkEpisodeResult {
  readonly episodeId: string;
  readonly seed: number;
  readonly metrics: EpisodeMetrics;
}

export interface BenchmarkResult {
  readonly schema: typeof BENCHMARK_RESULT_SCHEMA_VERSION;
  readonly benchmarkId: string;
  readonly policyId: string;
  readonly createdAt: string;
  readonly config: BenchmarkConfig;
  readonly episodes: readonly BenchmarkEpisodeResult[];
  readonly aggregate: EpisodeMetrics;
}

/**
 * 策略评估接口——任何待评估策略必须实现此契约。
 * 不依赖 TS 生产 planner，Python 训练的策略也可以包装为 PlanProvider 调用。
 */
export interface PolicyUnderTest {
  /** 策略标识（用于结果标记）。 */
  readonly policyId: string;
  /** 策略版本（如 git commit hash 或训练 run id）。 */
  readonly policyVersion: string;
  /** 策略描述（供人类阅读）。 */
  readonly description: string;
}

/**
 * 创建 BenchmarkResult 的工厂函数。
 */
export function createBenchmarkResult(
  policy: PolicyUnderTest,
  config: BenchmarkConfig,
  episodes: readonly BenchmarkEpisodeResult[],
): BenchmarkResult {
  const aggregate = aggregateMetrics(episodes.map((e) => e.metrics));

  const contentForId = JSON.stringify({
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    seeds: [...config.seeds].sort((a, b) => a - b),
    ticksPerEpisode: config.ticksPerEpisode,
    episodeIds: episodes.map((e) => e.episodeId).sort(),
  });
  const benchmarkId = createHash("sha256").update(contentForId).digest("hex").slice(0, 16);

  return {
    schema: BENCHMARK_RESULT_SCHEMA_VERSION,
    benchmarkId,
    policyId: policy.policyId,
    createdAt: new Date().toISOString(),
    config,
    episodes: Object.freeze([...episodes]),
    aggregate,
  };
}

/**
 * 验证 BenchmarkResult 结构合法性。
 */
export function validateBenchmarkResult(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["root must be an object"];
  }
  const r = value as Record<string, unknown>;

  if (r.schema !== BENCHMARK_RESULT_SCHEMA_VERSION) {
    problems.push(`schema must be "${BENCHMARK_RESULT_SCHEMA_VERSION}"`);
  }
  if (typeof r.benchmarkId !== "string" || r.benchmarkId.length === 0) {
    problems.push("benchmarkId must be non-empty string");
  }
  if (typeof r.policyId !== "string" || r.policyId.length === 0) {
    problems.push("policyId must be non-empty string");
  }
  if (!Array.isArray(r.episodes)) {
    problems.push("episodes must be an array");
  } else {
    for (const [i, ep] of r.episodes.entries()) {
      const e = ep as Record<string, unknown> | undefined;
      if (typeof e !== "object" || e === null) {
        problems.push(`episodes[${i}] must be an object`);
        continue;
      }
      if (typeof e.episodeId !== "string") problems.push(`episodes[${i}].episodeId must be string`);
      if (typeof e.metrics !== "object" || e.metrics === null) {
        problems.push(`episodes[${i}].metrics must be an object`);
      }
    }
  }
  if (typeof r.aggregate !== "object" || r.aggregate === null) {
    problems.push("aggregate must be an object");
  }

  return problems;
}
