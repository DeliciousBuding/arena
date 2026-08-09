/** W4 决策核心公共契约（2026-08-03 冻结，leader-only 维护）。
 *
 * 时序原则（GPT 裁决）：
 * 1. SafetyPlan 必须在等待 Agent 前就已经准备好；
 * 2. 先让 Lease 过期，再清理 Agent；不能为 abort 阻塞提交；
 * 3. Agent 只能提交候选，coordinator 永远保留最终执行权。
 */

import type { Plan, TickState } from "../domain/model.ts";
import type { MacroPolicy } from "../runtime/macro-policy.ts";
import type { LeaseSubmission } from "./decision-lease.ts";

/** 决策来源（4D-pre：统一单类型，5 值——不再有 domain/runtime 两套矛盾定义）。
 *  repaired-agent 仅供 loop 层使用（repair 只提升 agent 来源；safety 被修复仍记 safety）。 */
export type DecisionSource = "agent" | "hybrid" | "deterministic" | "safety" | "emergency" | "repaired-agent" | "human";

/** P0-1（GPT 裁决）：两个轴拆分——Agent 是否掌权（DecisionMode）与是否提交（SubmissionMode）。
 *  禁止用单一 shadow:boolean 同时表达两者。 */
export type DecisionModeName = "safety" | "deterministic" | "agent-shadow" | "hybrid";
export type SubmissionModeName = "disabled" | "live";

/** 确定性 planner 端口（SafetyPlanner 与 DeterministicPlanner 可互换注入——P0-1：
 *  deterministic 模式 = coordinator 短路 + planner 注入，coordinator 不感知差异）。
 *
 * 决策流水线端口（P4g，2026-08-09，可选）：
 *  - `prefetch` 异步发起决策（不阻塞），结果缓存在 provider 内部——持久桥
 *    实现 = worker 线程提交请求不等待；内置 planner = 直接同步计算缓存；
 *  - `decideCached` 取缓存结果（未完成则同步等待，保底逻辑）。必须在
 *    `prefetch` 之后成对调用。
 *  两个方法要么都实现要么都不实现；缺省不实现 = 调用方退回同步 `decide`
 *  （逐 tick 阻塞），行为与无流水线时逐字节一致。 */
export interface PlanProvider {
  decide(input: { readonly state: TickState; readonly policy?: MacroPolicy }): Plan;
  prefetch?(input: { readonly state: TickState; readonly policy?: MacroPolicy }): void;
  decideCached?(): Plan;
}

/** 决策上下文：不可变，一次决策全程共享（R9：World 必须在 Tick 开始时快照化）。 */
export interface DecisionContext {
  readonly tenantId: string;
  readonly tick: number;
  readonly stateHash: string;
  readonly mapRevision: number | null;
  readonly rulesVersion: string;
  readonly configHash: string;
  readonly receivedAtMonotonic: number;
}

/** 决策请求：coordinator → runtime。不携带 deadline（runtime 不负责游戏截止）。
 *  3E：runId 由 coordinator 唯一分配并显式携带；runtime 不得自行生成，
 *  返回的 handle.runId 必须严格等于 request.runId（不一致 → 契约违规）。 */
export interface AgentDecisionRequest {
  readonly runId: string;
  readonly tenantId: string;
  readonly tick: number;
  readonly state: TickState;
  readonly stateHash: string;
  readonly context: DecisionContext;
}

/** run 句柄：settled 与候选提交是两件独立的事（候选经 CandidateSink，不走 return）。 */
export interface AgentRunHandle {
  readonly runId: string;
  /** settle = 本轮 run 结束（无论有无候选）；abort 只是发出取消，不保证立即 settle。 */
  readonly settled: Promise<AgentRunResult>;
  abort(reason: string): void;
}

export type AgentRunResult =
  | { readonly outcome: "settled" }
  | { readonly outcome: "error"; readonly message: string };

/** Agent runtime 端口：coordinator 只依赖此接口（Pi 实现细节在 infrastructure 层）。
 *  GPT 审核：bindCandidateSink 是正式契约（非可选 duck typing）——runtime 忘记实现
 *  时编译直接失败；sink 返回结构化结果（LeaseSubmission），工具能反馈给模型。
 *  reportViolation 是 coordinator 检测到契约违规（如 runId 不一致）时的上报口，
 *  runtime 应据此标记 unhealthy（Pi：进入 rotation；Fake：记录 violationLog）。 */
export interface AgentDecisionRuntime {
  /** 候选投递口绑定（coordinator 构造时调用，此后 sink 固定）。 */
  bindCandidateSink(sink: CandidateSink): void;
  startDecision(request: AgentDecisionRequest): AgentRunHandle;
  health(): AgentRuntimeHealth;
  reportViolation?(reason: string): void;
  close(): Promise<void>;
}

export interface AgentRuntimeHealth {
  readonly ready: boolean;
  readonly activeRunId: string | null;
  readonly reason?: string;
}

/** 候选信封：arena_plan 工具调用经 CandidateSink → LeaseRegistry（runId 精确索引）。
 *  runId 必须由工具参数显式携带，不能依赖"当前全局 Lease"。 */
export interface CandidateEnvelope {
  readonly protocolVersion: "1";
  readonly runId: string;
  readonly tenantId: string;
  readonly tick: number;
  readonly stateHash: string;
  readonly plan: Plan;
  readonly reason: string;
  readonly confidence: number | null;
}

/** 候选投递口（GPT 审核契约）：返回结构化提交结果——arena_plan 工具
 *  需要把 accepted / deadline_exceeded / tick_mismatch 等准确反馈给模型。
 *  LeaseSubmission 定义在 decision-lease.ts（runId 精确索引的裁决结果）。 */
export type CandidateSink = (envelope: CandidateEnvelope) => LeaseSubmission;

/** Deadline 预算（单调时钟 performance.now()；测试注入 FakeClock）。
 *  边界语义：now >= deadline 即过期。 */
export interface DeadlineBudget {
  readonly receivedAtMonotonic: number;
  /** 停止等待 Agent 候选（soft deadline）。 */
  readonly agentSoftDeadline: number;
  /** 最终计划必须固定（selection deadline）。 */
  readonly selectionDeadline: number;
  /** 必须开始/完成提交。 */
  readonly submitDeadline: number;
  /** 游戏窗口结束（hard deadline）。 */
  readonly hardDeadline: number;
}

/** 实际执行结果（agent-shadow 下恒为 Safety；hybrid 下为仲裁结果）。 */
export interface DecisionExecution {
  readonly source: DecisionSource;
  readonly plan: Plan;
}

/** 候选评估观测（agent-shadow 下 execution=Safety、observation=Agent 候选真实评估）。 */
export interface DecisionObservation {
  readonly outcome: "accepted" | "rejected" | "soft_deadline" | "selection_timeout" | "error";
  readonly proposedSource: DecisionSource;
  readonly proposedPlan: Plan;
  readonly repairCount: number;
}

/** Coordinator 决策结果：永远在 selection deadline 前返回。
 *  P0-1：execution（实际执行）与 observation（Agent 候选评估）分离——模式判断错误
 *  不会让 Agent 意外获得执行权。 */
export interface DecisionResult {
  /** 3.2 单源 runId（遥测三流关联键；loop 层透传给 TickOutcome）。 */
  readonly runId: string;
  readonly tick: number;
  readonly execution: DecisionExecution;
  readonly observation?: DecisionObservation;
  readonly agentActionCount: number;
  readonly safetyReplacementCount: number;
  readonly invalidAgentActionCount: number;
  /** 本 Tick 总修复数（execution 兜底修复 + 候选仲裁修复；observation.repairCount 只计候选评估侧）。 */
  readonly repairCount: number;
  readonly deadlineOutcome: "candidate" | "soft_deadline" | "selection_timeout" | "not_applicable" | "error";
  /** Agent 候选到达延迟（raceCandidate 返回时刻 - t0；无 handle/无候选为 null）。 */
  readonly agentLatencyMs: number | null;
  /** 最终计划固定延迟（selectionLatencyMs = 计划固定时刻 - t0，覆盖 arbitration+repair）。 */
  readonly selectionLatencyMs: number;
  readonly abortRequested: boolean;
}
