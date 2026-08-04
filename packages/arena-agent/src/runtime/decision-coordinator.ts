/** W4 决策核心：每 Tick 在 selection deadline 前固定合法计划。
 *
 * 时序（GPT 裁决，硬顺序）：
 *   1. 构造 immutable DecisionContext
 *   2. 创建并注册 Lease（runId 精确索引）
 *   3. 立即计算并验证 SafetyPlan（不等 Agent）
 *   4. 启动 Agent run（runtime.startDecision）
 *   5. 等待：Lease 收到合法候选 或 agentSoftDeadline
 *   6. 候选到达 → PlanArbiter 合成（agent/hybrid/safety）
 *   7. soft deadline → 先 expire Lease → 固定 SafetyPlan → 后台异步 abort
 *   8. selection deadline 前固定 final Plan 并返回
 *   9. 从关键路径移除 Agent 清理（后台观察 settled）
 *
 * 绝不：await abort → 再选 Safety。先固定计划，再清理 Agent。
 */

import type { Plan, TickState } from "../domain/model.ts";
import { hashTickState } from "./state-hash.ts";
import { SafetyPlanner } from "../strategies/safety-planner.ts";
import { validatePlan } from "../domain/plan-validator.ts";
import { createDeadlineBudget, type DeadlineConfig } from "./deadline-budget.ts";
import type { Clock } from "./clock.ts";
import { DecisionLease } from "./decision-lease.ts";
import { LeaseRegistry } from "./lease-registry.ts";
import { PlanArbiter, type ArbitrateResult } from "./plan-arbiter.ts";
import type { MacroPolicy } from "./macro-policy.ts";
import type {
  AgentDecisionRequest,
  AgentDecisionRuntime,
  AgentRunHandle,
  AgentRunResult,
  CandidateEnvelope,
  CandidateSink,
  DecisionContext,
  DecisionExecution,
  DecisionModeName,
  DecisionObservation,
  DecisionResult,
  PlanProvider,
} from "./decision-types.ts";

export interface DecisionCoordinatorOptions {
  readonly runtime: AgentDecisionRuntime;
  /** 确定性 planner（SafetyPlanner/DeterministicPlanner 可互换——P0-1 planner 注入）。 */
  readonly planner: PlanProvider;
  readonly registry: LeaseRegistry;
  readonly clock: Clock;
  readonly budgetConfig: DeadlineConfig;
  readonly tenantId: string;
  readonly rulesVersion: string;
  readonly configHash: string;
  /** 3.2：生产 runId 前缀（启动 manifest 的 processRunId；缺省 "local"）。 */
  readonly processRunId?: string;
  readonly arbiter?: PlanArbiter;
  /** 等待到截止时刻的可注入实现（测试用 FakeClock 驱动，默认 setTimeout）。 */
  readonly sleepUntil?: (deadlineMs: number, clock: Clock) => Promise<void>;
  /** 3E：run 最终 settle 状态经此 telemetry 上报（不异步修改已返回的结果）。 */
  readonly onRunSettled?: (info: { readonly runId: string; readonly result: AgentRunResult }) => void;
  /** P0-1：决策模式（缺省 "hybrid"）。deterministic 使用确定性 planner 热路径。 */
  readonly decisionMode?: DecisionModeName;
  /** 低频 MacroPolicy 提供器（每 tick 调用；返回 undefined 时不覆盖 planner 默认）。 */
  readonly policyProvider?: (state: TickState) => MacroPolicy | undefined;
}

/** runtime 候选投递口：契约正式化（GPT 审核）——AgentDecisionRuntime.bindCandidateSink
 *  是必选方法，不再用 duck typing 可选探测；sink 返回结构化 LeaseSubmission。 */

const DEFAULT_SLEEP_UNTIL = (deadlineMs: number): Promise<void> =>
  new Promise((resolve) => {
    const delay = Math.max(0, deadlineMs - performance.now());
    setTimeout(resolve, delay);
  });

/** 轮询步进（FakeClock 下瞬时推进；真实时钟下也足够细）。 */
const POLL_STEP_MS = 10;

export class DecisionCoordinator {
  private readonly runtime: AgentDecisionRuntime;
  private readonly planner: PlanProvider;
  private readonly registry: LeaseRegistry;
  private readonly clock: Clock;
  private readonly budgetConfig: DeadlineConfig;
  private readonly tenantId: string;
  private readonly rulesVersion: string;
  private readonly configHash: string;
  private readonly arbiter: PlanArbiter;
  private readonly sleepUntil: (deadlineMs: number, clock: Clock) => Promise<void>;
  private readonly onRunSettled: DecisionCoordinatorOptions["onRunSettled"];
  private readonly processRunId: string;
  /** P0-1：决策模式（"hybrid" 缺省；"safety" 短路；"agent-shadow" execution 恒 Safety）。 */
  private readonly decisionMode: DecisionModeName;
  private readonly policyProvider: DecisionCoordinatorOptions["policyProvider"];
  /** 3.2：进程内 run 序号（runId = processRunId:tenantId:tick:sequence）。 */
  private runSeq = 0;

  /** 候选投递口（公开：Agent runtime / 测试经此投递，模拟 arena_plan 工具调用）。
   *  返回 registry.submit 的结构化结果（accepted / 具体拒绝 code）——工具反馈给模型用。 */
  readonly sink: CandidateSink;

  constructor(options: DecisionCoordinatorOptions) {
    this.runtime = options.runtime;
    this.planner = options.planner;
    this.registry = options.registry;
    this.clock = options.clock;
    this.budgetConfig = options.budgetConfig;
    this.tenantId = options.tenantId;
    this.rulesVersion = options.rulesVersion;
    this.configHash = options.configHash;
    this.arbiter = options.arbiter ?? new PlanArbiter();
    this.sleepUntil = options.sleepUntil ?? DEFAULT_SLEEP_UNTIL;
    this.onRunSettled = options.onRunSettled;
    this.processRunId = options.processRunId ?? "local";
    this.decisionMode = options.decisionMode ?? "hybrid";
    this.policyProvider = options.policyProvider;
    // 候选投递口：runId 精确索引——旧 run 的迟到调用命中旧 Lease（已终结 → 拒绝），
    // 永不漏到新 Tick；结构化结果原样返回（LeaseSubmission）。
    this.sink = (envelope) => this.registry.submit(envelope.runId, envelope);
    // 契约绑定（GPT 审核）：bindCandidateSink 是必选方法，runtime 忘记实现时编译失败
    this.runtime.bindCandidateSink(this.sink);
  }

  /** 每 Tick 决策：永远在 selection deadline 前 resolve（启动失败/runId 违规则立即）。 */
  async decide(state: TickState): Promise<DecisionResult> {
    const t0 = this.clock.now();
    const budget = createDeadlineBudget(t0, this.budgetConfig);
    const stateHash = hashTickState(state);
    const tick = state.tick;
    const context: DecisionContext = {
      tenantId: this.tenantId,
      tick,
      stateHash,
      mapRevision: null,
      rulesVersion: this.rulesVersion,
      configHash: this.configHash,
      receivedAtMonotonic: t0,
    };
    // 3E-1/3.2：runId 由 coordinator 唯一分配（单源），格式 <processRunId>:<tenantId>:<tick>:<sequence>
    //（不用浮点性能时间：跨进程可追踪、跨 rotation 唯一、不暴露给模型）
    const runId = `${this.processRunId}:${this.tenantId}:${tick}:${this.runSeq++}`;

    // 1) Safety 预计算（立即，不等待 Agent）；低频 MacroPolicy 只注入 SafetyPlanner
    let safetyPlan: Plan;
    let safetyError: string | null = null;
    try {
      const policy = this.policyProvider?.(state);
      safetyPlan = policy !== undefined && this.planner instanceof SafetyPlanner
        ? this.planner.decide({ state, policy })
        : this.planner.decide({ state });
    } catch (exc) {
      safetyError = exc instanceof Error ? exc.message : String(exc);
      safetyPlan = this.arbiter.emergencyPlan(state);
    }

    // P0-1：safety/deterministic 短路——不启动 Agent、不注册 Lease（没有候选者）。
    // 这不是 deadline，遥测必须明确记为 not_applicable，避免把健康热路径误报成超时。
    if (this.decisionMode === "safety" || this.decisionMode === "deterministic") {
      let plan = safetyPlan;
      let repairCount = 0;
      const validation = validatePlan(state, plan);
      if (!validation.valid && validation.plan !== plan) {
        plan = validation.plan;
        repairCount = validation.issues.length;
      }
      return {
        runId,
        tick,
        execution: { source: safetyError !== null ? "emergency" : this.decisionMode, plan },
        agentActionCount: 0,
        safetyReplacementCount: 0,
        invalidAgentActionCount: 0,
        repairCount,
        deadlineOutcome: "not_applicable",
        agentLatencyMs: null,
        selectionLatencyMs: this.clock.now() - t0,
        abortRequested: false,
      };
    }

    // 2) Lease 注册（runId 精确索引；deadline = soft deadline，Lease 内部校验）
    const lease = new DecisionLease({
      runId,
      tick,
      stateHash,
      deadlineAt: budget.agentSoftDeadline,
      clock: this.clock,
    });
    this.registry.register(lease);

    // 3) 启动 Agent run（3E-2：启动失败/违规 → 立即 Safety，不等 soft deadline）
    let handle: AgentRunHandle | null = null;
    let startupError: string | null = null;
    try {
      const request: AgentDecisionRequest = {
        runId,
        tenantId: this.tenantId,
        tick,
        state,
        stateHash,
        context,
      };
      handle = this.runtime.startDecision(request);
      if (handle.runId !== runId) {
        // 3E-1：handle 必须携带 coordinator 分配的 runId；不一致 = 契约违规
        startupError = `run_id_mismatch: expected ${runId}, got ${handle.runId}`;
        handle.abort(startupError);
        this.runtime.reportViolation?.(startupError);
      }
    } catch (exc) {
      startupError = exc instanceof Error ? exc.message : String(exc);
      handle = null;
    }
    // GPT 审核：每个有效 handle 恰好观察一次 settle（runId 错误被 abort 的 handle 也观察）；
    // 后续所有路径不再重复绑定，settle 状态统一经 onRunSettled telemetry 上报。
    if (handle !== null) {
      this.observeSettle(runId, handle);
    }

    if (startupError !== null) {
      // 立即终结 lease → 固定 SafetyPlan → 返回（error），不等 soft deadline
      this.registry.expire(runId);
      this.registry.select(runId);
      return {
        runId,
        tick,
        execution: { source: safetyError !== null ? "emergency" : "safety", plan: safetyPlan },
        agentActionCount: 0,
        safetyReplacementCount: 0,
        invalidAgentActionCount: 0,
        repairCount: 0,
        deadlineOutcome: "error",
        agentLatencyMs: null,
        selectionLatencyMs: this.clock.now() - t0,
        abortRequested: false,
      };
    }

    // 4) 等待：Lease accepted（候选经 sink → registry 校验）或 soft deadline
    const candidate = await this.raceCandidate(runId, budget.agentSoftDeadline);
    const candidateAt = this.clock.now();
    const agentLatency = candidateAt - t0;

    let source: DecisionResult["execution"]["source"] = "safety";
    let plan: Plan = safetyPlan;
    let agentActionCount = 0;
    let safetyReplacementCount = 0;
    let invalidAgentActionCount = 0;
    let repairCount = 0;
    let abortRequested = false;
    let deadlineOutcome: DecisionResult["deadlineOutcome"] = "soft_deadline";
    // P0-1：候选评估观测（agent-shadow 的完整评估；hybrid 下与 execution 一致；soft_deadline 缺省）
    let observation: DecisionObservation | undefined;

    if (candidate !== null && safetyError === null) {
      // 5) 候选路径：arbiter 合成（合法 Agent > Safety 补齐 > 无动作）
      this.registry.select(runId);
      let candidatePlan: Plan;
      let arbitration: ArbitrateResult | null = null;
      let pipelineError: string | null = null;
      try {
        // GPT 审核：arbitration/validator 意外抛错时不得整体 reject——
        // coordinator 永远返回合法计划（除非进程本身崩溃）。
        arbitration = this.arbiter.arbitrate({
          tick,
          state,
          safetyPlan,
          agentCandidate: candidate.plan,
        });
        candidatePlan = arbitration.plan;
        repairCount = arbitration.repairCount;
        // 语义校验 + repair（并入选择过程，selectionLatency 覆盖完整固定流程）
        const validation = validatePlan(state, candidatePlan);
        if (!validation.valid && validation.plan !== candidatePlan) {
          candidatePlan = validation.plan;
          repairCount += validation.issues.length;
        }
      } catch (exc) {
        pipelineError = exc instanceof Error ? exc.message : String(exc);
        candidatePlan = candidate.plan; // 保留 Agent 原计划供 observation（不被采纳）
      }
      if (pipelineError !== null || arbitration === null) {
        // 候选管道异常/无仲裁结果 → 弃候选，固定预计算的 SafetyPlan（deadlineOutcome=error）
        source = safetyError !== null ? "emergency" : "safety";
        plan = safetyPlan;
        deadlineOutcome = "error";
        observation = { outcome: "error", proposedSource: "safety", proposedPlan: candidatePlan, repairCount: 0 };
        if (pipelineError !== null) {
          this.runtime.reportViolation?.(`candidate_pipeline_error: ${pipelineError}`);
        }
      } else if (this.clock.now() >= budget.selectionDeadline) {
        // 3E-3：selection deadline 真正落地——固定时刻超限则弃候选，用已准备好的 SafetyPlan；
        // GPT 审核：已放弃 Agent 结果 → 发出 abort，避免模型继续生成/追加工具调用
        source = "safety";
        plan = safetyPlan;
        deadlineOutcome = "selection_timeout";
        observation = { outcome: "selection_timeout", proposedSource: arbitration.source, proposedPlan: candidatePlan, repairCount };
        if (handle !== null) {
          abortRequested = true;
          handle.abort("selection_timeout");
        }
      } else {
        source = arbitration.source;
        plan = candidatePlan;
        agentActionCount = arbitration.agentActionCount;
        safetyReplacementCount = arbitration.safetyReplacementCount;
        invalidAgentActionCount = arbitration.invalidAgentActionCount;
        deadlineOutcome = "candidate";
        observation = { outcome: "accepted", proposedSource: arbitration.source, proposedPlan: candidatePlan, repairCount };
      }
    } else {
      // 6) soft deadline 路径：先 expire → 固定 Safety → 后台 abort（不 await；
      //    settle 观察已在步骤 3 统一绑定一次）。无候选 → 无 observation。
      this.registry.expire(runId);
      this.registry.select(runId); // expired → selected（终结 run）
      source = safetyError !== null ? "emergency" : "safety";
      plan = safetyPlan;
      deadlineOutcome = "soft_deadline";
      if (handle !== null) {
        abortRequested = true;
        handle.abort(safetyError !== null ? "safety_error" : "soft_deadline");
      }
    }

    // P0-1：execution 组装。agent-shadow 下 execution 恒为 Safety（observation 承载候选评估）；
    // hybrid 下 execution = 仲裁结果。
    let execution: DecisionExecution;
    if (this.decisionMode === "agent-shadow") {
      execution = { source: safetyError !== null ? "emergency" : "safety", plan: safetyPlan };
    } else {
      execution = { source, plan };
    }

    // 7) 兜底校验：非 candidate 路径（candidate 路径已在步骤 5 内校验）；
    //    agent-shadow 的 execution=Safety 计划未过步骤 5 → 一并兜底
    if (deadlineOutcome !== "candidate" || this.decisionMode === "agent-shadow") {
      const validation = validatePlan(state, execution.plan);
      if (!validation.valid && validation.plan !== execution.plan) {
        execution = { ...execution, plan: validation.plan };
        repairCount += validation.issues.length;
      }
    }

    return {
      runId,
      tick,
      execution,
      observation,
      agentActionCount,
      safetyReplacementCount,
      invalidAgentActionCount,
      repairCount,
      deadlineOutcome,
      agentLatencyMs: agentLatency,
      selectionLatencyMs: this.clock.now() - t0,
      abortRequested,
    };
  }

  /** 后台观察 run 最终 settle：telemetry 上报，不阻塞决策路径、不异步修改已返回结果（3E）。 */
  private observeSettle(runId: string, handle: AgentRunHandle): void {
    void handle.settled
      .then((result) => this.onRunSettled?.({ runId, result }))
      .catch((error) => {
        this.onRunSettled?.({
          runId,
          result: { outcome: "error", message: error instanceof Error ? error.message : String(error) },
        });
      });
  }

  /** 等待：Lease accepted（候选）或 soft deadline 到期（null）。
   *  顺序：先查 accepted（deadline 前 accepted 的候选即使发现于 deadline 后也算数，
   *  因为 Lease 内部已按 now>=deadline 拒绝迟到提交），再查 deadline。 */
  private async raceCandidate(runId: string, softDeadline: number): Promise<CandidateEnvelope | null> {
    for (;;) {
      const lease = this.registry.get(runId);
      if (lease !== undefined && lease.status === "accepted") {
        const accepted = lease.candidate;
        if (accepted !== null) {
          return accepted as CandidateEnvelope;
        }
      }
      if (this.clock.now() >= softDeadline) {
        return null;
      }
      await this.sleepUntil(Math.min(this.clock.now() + POLL_STEP_MS, softDeadline), this.clock);
    }
  }
}
