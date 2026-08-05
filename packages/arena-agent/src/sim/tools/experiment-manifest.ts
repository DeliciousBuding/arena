/**
 * TS-003 实验 manifest（TS-only 候选晋级流水线的输入契约）。
 *
 * 每个实验固定声明：假设、基线/候选 variant、规则版本、seeds、tick 数、
 * 主指标、guardrails 与来源 hash。manifest 是离线 A/B 的单一入口——
 * TS-007 扩展 runAB 后直接消费此结构；生产默认行为不受影响。
 *
 * 约束：
 * - 只声明（纯数据），不携带执行逻辑；
 * - 必填字段校验失败 fail-fast（缺 experimentId/hypothesis 等直接抛错）；
 * - seeds/ticks 必须有限正整数，guardrails 是 P0 指标列表（0 表示"必须为 0"）。
 */

/** 命名 Planner variant 的引用（TS-004 registry 的 id；预留字符串以避免循环依赖）。 */
export type PlannerVariantRef = string;

export interface ExperimentGuardrail {
  /** 指标名（如 capacity_wait_count / illegal_plan_count）。 */
  readonly metric: string;
  /** 硬上限：候选超过即判失败；0 表示"必须恒为 0"。 */
  readonly max: number;
}

export interface ExperimentManifest {
  readonly experimentId: string;
  readonly hypothesis: string;
  readonly baselineVariant: PlannerVariantRef;
  readonly candidateVariant: PlannerVariantRef;
  readonly rulesVersion: string;
  readonly seeds: readonly number[];
  readonly ticks: number;
  readonly primaryMetric: string;
  readonly guardrails: readonly ExperimentGuardrail[];
  /** config 稳定哈希（sha256: 前缀；变体配置变更必须换值）。 */
  readonly configHash: string;
  /** 基线 commit（冻结后不可变；变体实验重新 manifest）。 */
  readonly gitSha: string;
}

const REQUIRED_KEYS = [
  "experimentId",
  "hypothesis",
  "baselineVariant",
  "candidateVariant",
  "rulesVersion",
  "seeds",
  "ticks",
  "primaryMetric",
  "guardrails",
  "configHash",
  "gitSha",
] as const;

/** 解析 + 校验实验 manifest（接受 JSON 对象或文本；不合法直接抛错）。 */
export function parseExperimentManifest(input: unknown): ExperimentManifest {
  const raw = typeof input === "string" ? (JSON.parse(input) as Record<string, unknown>) : (input as Record<string, unknown>);
  if (typeof raw !== "object" || raw === null) {
    throw new Error("experiment manifest must be an object");
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in raw)) throw new Error(`experiment manifest missing required field: ${key}`);
  }
  const seeds = raw.seeds;
  if (
    !Array.isArray(seeds) ||
    seeds.length === 0 ||
    !seeds.every((seed) => Number.isSafeInteger(seed) && (seed as number) > 0)
  ) {
    throw new Error("experiment manifest seeds must be a non-empty array of positive integers");
  }
  const ticks = raw.ticks;
  if (!Number.isSafeInteger(ticks) || (ticks as number) < 1) {
    throw new Error(`experiment manifest ticks must be a positive integer: ${String(ticks)}`);
  }
  const guardrails = raw.guardrails;
  if (!Array.isArray(guardrails)) {
    throw new Error("experiment manifest guardrails must be an array");
  }
  for (const guardrail of guardrails) {
    const entry = guardrail as Record<string, unknown>;
    if (typeof entry.metric !== "string" || entry.metric.length === 0) {
      throw new Error("experiment manifest guardrail.metric must be a non-empty string");
    }
    if (!Number.isFinite(entry.max) || (entry.max as number) < 0) {
      throw new Error(`experiment manifest guardrail.max must be a non-negative number: ${String(entry.max)}`);
    }
  }
  const manifest: ExperimentManifest = {
    experimentId: String(raw.experimentId),
    hypothesis: String(raw.hypothesis),
    baselineVariant: String(raw.baselineVariant),
    candidateVariant: String(raw.candidateVariant),
    rulesVersion: String(raw.rulesVersion),
    seeds: [...seeds] as number[],
    ticks: ticks as number,
    primaryMetric: String(raw.primaryMetric),
    guardrails: guardrails.map((guardrail) => {
      const entry = guardrail as Record<string, unknown>;
      return { metric: String(entry.metric), max: entry.max as number };
    }),
    configHash: String(raw.configHash),
    gitSha: String(raw.gitSha),
  };
  if (manifest.experimentId.trim().length === 0) throw new Error("experiment manifest experimentId must be non-empty");
  if (manifest.hypothesis.trim().length === 0) throw new Error("experiment manifest hypothesis must be non-empty");
  if (manifest.primaryMetric.trim().length === 0) throw new Error("experiment manifest primaryMetric must be non-empty");
  if (manifest.baselineVariant === manifest.candidateVariant) {
    throw new Error("experiment manifest baselineVariant must differ from candidateVariant");
  }
  return manifest;
}
