/**
 * Alliance Simulator — sim 层类型定义（Phase 2）。
 *
 * 引用冻结合同（src/alliance/）的 AllianceDirective、AllianceSnapshot 等，
 * 在此之上定义模拟器专属的配置、KPI 与结果类型。
 *
 * 设计约束：
 * - 不写死 t1-t4；tenantId 泛型字符串
 * - 不含 Arena token、Plan、CandidateSink
 * - 所有输出路径仅 data/runs/sim
 * - 全部字段 deterministic（禁止 wall-clock / Math.random 进入语义）
 *
 * 最后更新：2026-08-08
 */

import type { EpisodeConfig, EpisodeResult } from "../harness/episode.ts";
import type { AllianceDirective, Mission, MissionKind, TaskForce } from "../../alliance/control-types.ts";
import type { RetreatCorridorAssessment } from "../../alliance/director-policy.ts";
import type { AllianceSnapshot } from "../../alliance/types.ts";

// ── Director 故障注入 ──────────────────────────────────────────

/**
 * 故障类型（v1 只实现有真实语义的四种；STALE_REVISION/DELAYED/MALFORMED
 * 在 v1 无语义，不声明不实现）。
 *
 * - NO_DIRECTIVE：该 tick 不调用 director，保留旧 directive（自然 stale/expired）
 * - WRONG_TENANT：该 tick 的 directive 被确定性改写为错误 tenant（→ invalid reject）
 * - THROW：该 tick 调用 director 时抛错（→ directorErrorCount++，保留旧 directive）
 * - DISAPPEAR：持续 durationTicks 个 tick 不产出（fail-open baseline）
 */
export type DirectorFaultKind = "NO_DIRECTIVE" | "WRONG_TENANT" | "THROW" | "DISAPPEAR";

export interface DirectorFaultEvent {
  /** 故障触发 tick（1-based）。 */
  readonly atTick: number;
  readonly fault: DirectorFaultKind;
  /** DISAPPEAR 的持续 tick 数（>= 1）。缺省 = 1。 */
  readonly durationTicks?: number;
}

// ── AllianceEpisodeConfig ──────────────────────────────────────

export interface AllianceEpisodeConfig {
  /** 复用现有 EpisodeConfig（tenant/seed/scenario/rulesPath 等）。 */
  readonly episode: EpisodeConfig;
  /** 参与联盟的租户 ID（必须是 episode.tenants 的非空子集，无重复）。 */
  readonly allianceTenants: readonly string[];
  /** AllianceDirector 实例。 */
  readonly director: AllianceDirector;
  /** Director 重规划周期（正整数 tick）；1 = 每 tick。 */
  readonly directorPeriodTicks: number;
  /** 固定 Treasury（v1 不支持 election；缺省 = allianceTenants[0]）。 */
  readonly treasuryTenant?: string;
  /** Director 故障注入事件流（缺省 = 无故障）。 */
  readonly directorFaults?: readonly DirectorFaultEvent[];
}

// ── AllianceDirector 接口 ──────────────────────────────────────

export interface AllianceDirectorDecision {
  readonly directives: readonly AllianceDirective[];
  readonly missions?: readonly Mission[];
  readonly taskForces?: readonly TaskForce[];
  readonly retreatAssessments?: readonly RetreatCorridorAssessment[];
}

export interface AllianceDirector {
  /** 稳定标识（参与 replay footprint）。 */
  readonly kind: string;
  /** 输入 snapshot + 确定性 rng，输出 per-tenant directives。 */
  decide(
    snapshot: AllianceSnapshot,
    rng: () => number,
  ): AllianceDirectorDecision;
}

// ── Plan 来源 ──────────────────────────────────────────────────

/**
 * 租户本 tick 的执行来源：
 * - "baseline"：无联盟指令 / 指令被拒绝 → 纯本地 planner
 * - "baseline-shadow"：directive 被 accepted，但 v1 不接管动作——仍执行 baseline，
 *   联盟层仅影子记录（KPI 不计为 fallback）
 */
export type PlanSource = "baseline" | "baseline-shadow";

// ── Alliance KPI ───────────────────────────────────────────────

export interface AllianceKPI {
  // Treasury
  readonly treasuryResourcesFinal: number;
  readonly treasuryResourceHighWater: number;
  readonly treasuryResourceAUC: number;
  readonly treasuryCoreSurvivalRate: number;
  // Directive stats（按 per-tenant evaluation 计）
  readonly directiveAccepted: number;
  readonly directiveRejected: number;
  readonly directiveStale: number;
  readonly expiredDirectiveConsumed: number;
  /** forced fallback：no-directive / invalid / expired / stale / wrong-tenant 的 evaluation 数。 */
  readonly baselineFallbackCount: number;
  /** director.decide 抛错次数。 */
  readonly directorErrorCount: number;
  /** 静态检测到的 SHOOT targetId ∈ 联盟成员实体 的次数（no-fire 硬规则监控）。 */
  readonly allianceSafetyRejectCount: number;
  /** true = allianceSafetyRejectCount 是真实静态扫描结果，不是占位 0。 */
  readonly friendlyFireMetricSupported: boolean;
  /** 1 - forcedFallbackEvaluations / totalAllianceEvaluations。 */
  readonly fallbackAvailability: number;
  // Per-tenant
  readonly perTenant: Readonly<Record<string, {
    readonly finalResources: number;
    readonly finalPopulation: number;
    readonly coreSurvived: boolean;
  }>>;
}

// ── Alliance Trace ─────────────────────────────────────────────

export interface DirectiveEvaluationTrace {
  readonly tenantId: string;
  /** 被评估的 directive revision（无 directive = null）。 */
  readonly revision: number | null;
  readonly consume: boolean;
  /** null = accepted；否则为 evaluateDirective 的拒绝原因。 */
  readonly reason: string | null;
  readonly planSource: PlanSource;
}

export interface AllianceTraceEntry {
  readonly tick: number;
  readonly snapshotRevision: number | null;
  readonly directorRan: boolean;
  readonly directiveCount: number;
  readonly missionCount: number;
  readonly missionKinds: readonly MissionKind[];
  /** Director 本次重规划生成的跨租户 TaskForce 数与涉及租户数；纯 shadow metadata。 */
  readonly taskForceCount: number;
  readonly taskForceTenantCount: number;
  readonly retreatRecommendationCount: number;
  readonly directorError: string | null;
  readonly evaluations: readonly DirectiveEvaluationTrace[];
}

// ── AllianceEpisodeResult ──────────────────────────────────────

export interface AllianceEpisodeResult {
  readonly episode: EpisodeResult;
  readonly kpi: AllianceKPI;
  readonly trace: readonly AllianceTraceEntry[];
  readonly replayFootprint: {
    readonly seed: number;
    readonly rulesVersion: string;
    readonly directorKind: string;
    readonly configHash: string;
  };
}



