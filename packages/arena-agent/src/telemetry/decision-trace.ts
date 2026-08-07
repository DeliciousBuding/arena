/**
 * 决策遥测记录（切片 4 阶段 5，Agent C 地界）。
 *
 * W9 三流分离（以 processRunId + tenantId + tick 关联）：
 *   - RuntimeTraceRecord：每 Tick 决策 run 的运行正确性痕迹（deadline/latency/abort/rotation/submit）；
 *   - DecisionTraceRecord：为什么选这个计划（来源/仲裁计数/修复/最终计划哈希）；
 *   - OutcomeTraceRecord：执行后发生了什么（资源变化/产出/损耗/事件）。
 *
 * 字段名对齐 W9 清单与 runtime/decision-types.ts 的 DecisionResult / DecisionSource
 * （deadlineOutcome、decisionSource 直接复用其值域，Leader 契约变更自动联动）。
 *
 * 安全：本模块不接触凭据；落盘脱敏在 jsonl-writer.ts 中执行。
 */

import type { DecisionResult, DecisionSource } from "../runtime/decision-types.ts";
import type { Position } from "../domain/model.ts";
import { validateTraceRecord } from "./schema.ts";

/** run 提交结果（对应 decision-lease.ts 的 LeaseSubmission：accepted/rejected/无提交）。 */
export type SubmitResult = "accepted" | "rejected" | "not_submitted";

/** deadline 结果值域与 DecisionResult.deadlineOutcome 完全一致（单源）。 */
export type DeadlineOutcome = DecisionResult["deadlineOutcome"];

/** RuntimeTrace：运行正确性（runId/deadline/latency/abort/rotation/submit/lease 拒绝）。 */
export interface RuntimeTraceRecord {
  readonly processRunId: string;
  readonly tenantId: string;
  readonly tick: number;
  readonly runId: string;
  readonly deadlineOutcome: DeadlineOutcome;
  /** agent 候选到达延迟（无候选为 null）。 */
  readonly agentLatencyMs: number | null;
  /** 最终计划固定延迟（含仲裁 + repair）。 */
  readonly selectionLatencyMs: number;
  readonly abortRequested: boolean;
  /** Pi runtime 会话轮换代数（decision-types/pi-agent-runtime generation）。 */
  readonly rotationGeneration: number;
  /** 配置热加载代数（2026-08-08）：每次 config 热替换 +1，tick 归属当前配置代。 */
  readonly configGeneration?: number;
  readonly submitResult: SubmitResult;
  /** turn.submit() 抛出的脱敏错误；成功/disabled 路径缺省。 */
  readonly submitError?: string;
  readonly notSubmittedReason?: "disabled" | "startup_sync" | "outcome_drain";
  /** submit 被拒时的拒绝码（LeaseRejectionCode，如 deadline_exceeded）。 */
  readonly leaseRejectionCode?: string;
  /** 旁路健康事件（stall detector/recovery 直接 append 的宽松记录；KPI 统计用）。
   *  stall_warning：检测器告警；stall_recovery：自愈状态机迁移。 */
  readonly telemetryType?: "stall_warning" | "stall_recovery";
  readonly stallKind?: string;
  readonly stallStreak?: number;
  /** stall_recovery 迁移目标状态（recovering/escalating/idle）。 */
  readonly recoveryState?: string;
  readonly escalated?: boolean;
  /** stall_recovery 结束结局（recovered/failed/expired；自愈成功率 KPI）。 */
  readonly outcome?: "recovered" | "failed" | "expired";
}

/** DecisionTrace：为什么选这个计划（来源/仲裁计数/修复/最终计划哈希）。 */
export interface DecisionTraceRecord {
  readonly processRunId: string;
  readonly tenantId: string;
  readonly tick: number;
  readonly runId: string;
  readonly decisionSource: DecisionSource;
  readonly agentActionCount: number;
  readonly safetyReplacementCount: number;
  readonly invalidAgentActionCount: number;
  readonly repairCount: number;
  /** 最终执行计划动作分布（经济闭环与空转诊断）。 */
  readonly moveCount?: number;
  readonly harvestCount?: number;
  readonly depositCount?: number;
  readonly waitCount?: number;
  /** 最终计划 intent 分布（patrol/go-resource/return-home/capacity-reroute 等）。 */
  readonly intentCounts?: Readonly<Record<string, number>>;
  /** 最终采纳计划的稳定哈希（planHashOf；用于审计/漂移比对）。 */
  readonly planHash: string;
  readonly reason?: string;
  /** 威胁评估诊断（v0.3-lite，2026-08-06）：tick 级威胁等级/原因/敌情计数。
   *  enemyHints 记忆增强（pursuit/moving）待 planner 侧暴露后补全。 */
  readonly threatLevel?: "NORMAL" | "ALERT" | "ENGAGED" | "BREAKOUT";
  readonly threatReason?: string | null;
  readonly threatClosingEnemies?: number;
  readonly threatMovingEnemies?: number;
  readonly threatAxes?: number;
}

/** 人类指令合并结果（遥测精简版；完整结果在 TickOutcome.humanOverride）。 */
export interface HumanOverrideTrace {
  readonly active: boolean;
  readonly applied: readonly string[];
  readonly rejected: readonly { readonly unitId: string; readonly reason: string }[];
  readonly satisfied: readonly string[];
  readonly updatedAt: string | null;
}

/** OutcomeTrace：执行后发生了什么（核心资源变化/产出/损耗/事件流水）。 */
export interface OutcomeTraceRecord {
  readonly processRunId: string;
  readonly tenantId: string;
  readonly tick: number;
  readonly coreResourcesBefore: number;
  readonly coreResourcesAfter: number;
  readonly coreResourceDelta: number;
  /** 本 Tick 受控核心状态（2026-08-08）：迁移窗口 = 合法 0 卸货，供经济停摆检测区分。 */
  readonly coreState?: "NORMAL" | "MOVING" | null;
  /** 本 Tick 决策快照中的经济前置信号。 */
  readonly visibleResourceCellCount?: number;
  readonly workerCount?: number;
  readonly workersWithCargo?: number;
  readonly workerCargoTotal?: number;
  readonly uniqueWorkerCellCount?: number;
  readonly workerMaxDistanceFromCore?: number;
  readonly workerMeanDistanceFromCore?: number;
  /** 服务端失败事件 + 上一 Tick 实际提交动作，用于精确归因而非猜测。 */
  readonly failedEvents?: readonly FailedEventTrace[];
  readonly grossDeposit?: number;
  readonly spawnCount?: number;
  readonly healCount?: number;
  readonly unitLossCount?: number;
  readonly events: string[];
  /** 人类最高控制权合并结果（applied/rejected/satisfied，供指挥面板回显）。 */
  readonly humanOverride?: HumanOverrideTrace;
}

export interface FailedEventTrace {
  readonly eventType: string;
  readonly reasonCode: string | null;
  readonly actorId: string | null;
  readonly targetId: string | null;
  readonly position?: Position;
  readonly priorAction?: string;
  readonly priorIntent?: string;
}

/** 三种遥测记录的统一类型（JsonlWriter 的写入面）。 */
export type TraceRecord = RuntimeTraceRecord | DecisionTraceRecord | OutcomeTraceRecord;

/** MacroPolicy 遥测（policy.jsonl；tenant-runtime append，TS-001 KPI 统计用）。
 *  policy_update.policy 是 serializeMacroPolicy 的 JSON 文本。
 *  policy_discipline：策略层纪律事件（invalid_focus/silence_started）。 */
export interface PolicyTraceRecord {
  readonly at?: string;
  readonly tenantId?: string;
  readonly type: "policy_update" | "policy_error" | "policy_override" | "policy_init_error" | "policy_discipline";
  readonly tick?: number;
  readonly policy?: string;
  readonly message?: string;
  /** policy_discipline：事件种类（invalid_focus/silence_started）。 */
  readonly kind?: string;
  /** policy_discipline：连续无效次数。 */
  readonly count?: number;
  readonly focusRegion?: readonly [number, number] | null;
}

/** 工厂默认值：调用方（进程/租户/tick 上下文）必须显式覆盖。 */
const DEFAULT_PROCESS_RUN_ID = "unknown";
const DEFAULT_TENANT_ID = "unknown";
const DEFAULT_TICK = 0;

/**
 * 工厂函数：自动填 processRunId/tenantId 默认值，tick 由调用方显式传（遥测关联键，
 * 默认 0 是危险默认）；结果立即做 schema 校验（缺必填字段即抛错，fail-fast）。
 */
export function runtimeTrace(
  partial: Omit<RuntimeTraceRecord, "processRunId" | "tenantId">,
): RuntimeTraceRecord {
  const record: RuntimeTraceRecord = {
    processRunId: DEFAULT_PROCESS_RUN_ID,
    tenantId: DEFAULT_TENANT_ID,
    ...partial, // tick 由调用方必填（DEFAULT_TICK 不再作默认——遥测关联键不可猜）
  };
  validateTraceRecord(record);
  return record;
}

export function decisionTrace(
  partial: Omit<DecisionTraceRecord, "processRunId" | "tenantId">,
): DecisionTraceRecord {
  const record: DecisionTraceRecord = {
    processRunId: DEFAULT_PROCESS_RUN_ID,
    tenantId: DEFAULT_TENANT_ID,
    ...partial,
  };
  validateTraceRecord(record);
  return record;
}

export function outcomeTrace(
  partial: Omit<OutcomeTraceRecord, "processRunId" | "tenantId">,
): OutcomeTraceRecord {
  const record: OutcomeTraceRecord = {
    processRunId: DEFAULT_PROCESS_RUN_ID,
    tenantId: DEFAULT_TENANT_ID,
    ...partial,
  };
  validateTraceRecord(record);
  return record;
}

/**
 * 稳定计划哈希：stableStringify（键递归排序，键序无关）+ FNV-1a 32 位 → 8 位 hex。
 * 选 FNV-1a 而非 crypto sha256：零依赖、跨平台确定性（Math.imul，无 BigInt/字节序差异）、
 * 足够区分计划漂移（碰撞概率 ~1/2^32；非加密用途，仅审计一致性）。
 */
export function planHashOf(value: unknown): string {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 键排序的稳定 JSON 序列化（对象键序、数组序保留、undefined→"undefined" 确定性）。 */
function stableStringify(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
