/**
 * TS-006 CandidateEvaluator：相对冻结基线（TS-002）的候选晋级决策器。
 *
 * 输入：实验 manifest（TS-003，含 guardrails/primaryMetric）+ runAB 报告（TS-007）。
 * 输出：promote / hold / reject + 结构化原因；exploratory 一律 hold（refill 未实现，
 * 长程经济结论不晋级）。未知主指标/guardrail metric 不猜数 → reject。
 *
 * 晋级门槛（与 docs/design/baseline-deterministic-v0.2.15.md 一致）：
 * - 主指标中位数提升 ≥10%（相对 baseline 均值）；
 * - 全部 guardrail 达标（max 上限）；
 * - 无灾难性回退（per-seed 最差 delta 不低于 baseline 的 -20%）。
 */

import type { ABReport } from "./experiments.ts";
import type { ExperimentManifest } from "./experiment-manifest.ts";

export type CandidateDecision = "promote" | "hold" | "reject";

export interface GuardrailCheck {
  readonly metric: string;
  readonly max: number;
  readonly observed: number | null;
  readonly pass: boolean;
}

export interface CandidateEvaluation {
  readonly experimentId: string;
  readonly candidateVariant: string;
  readonly decision: CandidateDecision;
  readonly reasons: readonly string[];
  readonly primaryMetric: string;
  /** candidate - baseline 的 per-seed 中位数（主指标口径）。 */
  readonly primaryDeltaMedian: number | null;
  readonly primaryImprovementPct: number | null;
  readonly worstSeedDelta: number | null;
  readonly guardrails: readonly GuardrailCheck[];
  readonly exploratory: boolean;
}

/** 主指标白名单（只支持已定义口径；未知 → reject，不猜数）。 */
function isPrimaryMetricKnown(metric: string): boolean {
  return metric === "net_core_gain_per_100_ticks" || metric === "mean_resource_delta";
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 候选相对基线的晋级评估（基线 = report 第一个 planner）。 */
export function evaluateCandidate(manifest: ExperimentManifest, report: ABReport): CandidateEvaluation {
  const baseline = report.planners[0];
  const candidate = manifest.candidateVariant;
  const reasons: string[] = [];

  if (report.planners[0] !== manifest.baselineVariant) {
    return {
      experimentId: manifest.experimentId,
      candidateVariant: candidate,
      decision: "reject",
      reasons: [`report baseline ${report.planners[0]} != manifest baseline ${manifest.baselineVariant}`],
      primaryMetric: manifest.primaryMetric,
      primaryDeltaMedian: null,
      primaryImprovementPct: null,
      worstSeedDelta: null,
      guardrails: [],
      exploratory: report.rankingStatus === "exploratory",
    };
  }

  const pairs = report.pairedDeltas.filter((pair) => pair.candidate === candidate);
  const baselineAggregate = report.aggregates.find((aggregate) => aggregate.planner === baseline);
  const deltas = pairs.map((pair) => pair.resourceDelta);
  const primaryDeltaMedian = deltas.length > 0 ? median(deltas) : null;
  const baselineMean = baselineAggregate?.meanResourceDelta ?? 0;
  const primaryImprovementPct =
    primaryDeltaMedian !== null && baselineMean !== 0
      ? (primaryDeltaMedian / Math.abs(baselineMean)) * 100
      : null;
  const worstSeedDelta = deltas.length > 0 ? Math.min(...deltas) : null;

  const guardrails: GuardrailCheck[] = manifest.guardrails.map((guardrail) => {
    const candidateAggregate = report.aggregates.find((aggregate) => aggregate.planner === candidate);
    let observed: number | null = null;
    switch (guardrail.metric) {
      case "illegal_plan_count":
        observed = candidateAggregate?.illegalPlans ?? null;
        break;
      case "repaired_plan_count":
        observed = candidateAggregate?.repairedPlans ?? null;
        break;
      case "capacity_wait_count":
        observed = null; // 当前 ABReport 无 capacity_wait 口径 → telemetry_gap，不猜数
        break;
      default:
        observed = null;
    }
    return { metric: guardrail.metric, max: guardrail.max, observed, pass: observed !== null && observed <= guardrail.max };
  });

  const primaryMetricMapped = isPrimaryMetricKnown(manifest.primaryMetric);
  const guardrailsMeasurable = guardrails.every((check) => check.observed !== null);
  const exploratory = report.rankingStatus === "exploratory";
  const disaster = worstSeedDelta !== null && baselineMean !== 0 && worstSeedDelta < -0.2 * Math.abs(baselineMean);

  if (!primaryMetricMapped) {
    reasons.push(`unknown primary metric ${manifest.primaryMetric} (no mapping, not guessing)`);
  }
  if (!guardrailsMeasurable) {
    const gaps = guardrails.filter((check) => check.observed === null).map((check) => check.metric);
    reasons.push(`guardrail metrics not measurable from ABReport: ${gaps.join(", ")}`);
  }
  const failingGuardrails = guardrails.filter((check) => !check.pass);
  for (const check of failingGuardrails) {
    reasons.push(`guardrail ${check.metric}: observed ${String(check.observed)} > max ${check.max}`);
  }
  if (exploratory) {
    reasons.push("exploratory (sim refill/opponent fidelity unresolved) - hold, not promote");
  }
  if (disaster) {
    reasons.push(`worst-seed delta ${worstSeedDelta} below -20% of baseline mean ${baselineMean.toFixed(2)}`);
  }
  if (primaryImprovementPct !== null && primaryImprovementPct < 10) {
    reasons.push(`primary improvement ${primaryImprovementPct.toFixed(1)}% < 10% threshold`);
  }

  const decision: CandidateDecision =
    reasons.length === 0 ? "promote" : exploratory || disaster ? "hold" : "reject";

  return {
    experimentId: manifest.experimentId,
    candidateVariant: candidate,
    decision,
    reasons: Object.freeze(reasons),
    primaryMetric: manifest.primaryMetric,
    primaryDeltaMedian,
    primaryImprovementPct: primaryImprovementPct === null ? null : Math.round(primaryImprovementPct * 10) / 10,
    worstSeedDelta,
    guardrails: Object.freeze(guardrails),
    exploratory,
  };
}
