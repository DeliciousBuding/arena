/** W4 决策核心公共契约（2026-08-03 冻结，leader-only 维护）。
 *
 * 时序原则（GPT 裁决）：
 * 1. SafetyPlan 必须在等待 Agent 前就已经准备好；
 * 2. 先让 Lease 过期，再清理 Agent；不能为 abort 阻塞提交；
 * 3. Agent 只能提交候选，coordinator 永远保留最终执行权。
 */

import type { Plan, TickState } from "../domain/model.ts";

export type DecisionSource = "agent" | "hybrid" | "safety" | "emergency";

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
 *  3E：reportViolation 是 coordinator 检测到契约违规（如 runId 不一致）时的上报口，
 *  runtime 应据此标记 unhealthy（Pi：进入 rotation；Fake：记录 violationLog）。 */
export interface AgentDecisionRuntime {
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

/** Coordinator 决策结果：永远在 selection deadline 前返回。 */
export interface DecisionResult {
  readonly tick: number;
  readonly source: DecisionSource;
  readonly plan: Plan;
  readonly agentActionCount: number;
  readonly safetyReplacementCount: number;
  readonly invalidAgentActionCount: number;
  readonly repairCount: number;
  readonly deadlineOutcome: "candidate" | "soft_deadline" | "selection_timeout" | "error";
  /** Agent 候选到达延迟（raceCandidate 返回时刻 - t0；无 handle/无候选为 null）。 */
  readonly agentLatencyMs: number | null;
  /** 最终计划固定延迟（selectionLatencyMs = 计划固定时刻 - t0，覆盖 arbitration+repair）。 */
  readonly selectionLatencyMs: number;
  readonly abortRequested: boolean;
}
