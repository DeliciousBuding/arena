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
import { PlanArbiter } from "./plan-arbiter.ts";
import type {
  AgentDecisionRequest,
  AgentDecisionRuntime,
  AgentRunHandle,
  AgentRunResult,
  CandidateEnvelope,
  DecisionContext,
  DecisionResult,
} from "./decision-types.ts";

export interface DecisionCoordinatorOptions {
  readonly runtime: AgentDecisionRuntime;
  readonly planner: SafetyPlanner;
  readonly registry: LeaseRegistry;
  readonly clock: Clock;
  readonly budgetConfig: DeadlineConfig;
  readonly tenantId: string;
  readonly rulesVersion: string;
  readonly configHash: string;
  readonly arbiter?: PlanArbiter;
  /** 等待到截止时刻的可注入实现（测试用 FakeClock 驱动，默认 setTimeout）。 */
  readonly sleepUntil?: (deadlineMs: number, clock: Clock) => Promise<void>;
  /** 3E：run 最终 settle 状态经此 telemetry 上报（不异步修改已返回的结果）。 */
  readonly onRunSettled?: (info: { readonly runId: string; readonly result: AgentRunResult }) => void;
}

/** runtime 候选投递口（FakeAgentRuntime 等 testing 工具实现；Pi runtime 集成时对齐）。
 *  3E：runId 已随 AgentDecisionRequest 单源下发，setRunIdFor 侧通道删除。 */
interface SinkSettable {
  setSink?(sink: (envelope: CandidateEnvelope) => void): void;
}

const DEFAULT_SLEEP_UNTIL = (deadlineMs: number): Promise<void> =>
  new Promise((resolve) => {
    const delay = Math.max(0, deadlineMs - performance.now());
    setTimeout(resolve, delay);
  });

/** 轮询步进（FakeClock 下瞬时推进；真实时钟下也足够细）。 */
const POLL_STEP_MS = 10;

export class DecisionCoordinator {
  private readonly runtime: AgentDecisionRuntime;
  private readonly planner: SafetyPlanner;
  private readonly registry: LeaseRegistry;
  private readonly clock: Clock;
  private readonly budgetConfig: DeadlineConfig;
  private readonly tenantId: string;
  private readonly rulesVersion: string;
  private readonly configHash: string;
  private readonly arbiter: PlanArbiter;
  private readonly sleepUntil: (deadlineMs: number, clock: Clock) => Promise<void>;
  private readonly onRunSettled: DecisionCoordinatorOptions["onRunSettled"];

  /** 候选投递口（公开：Agent runtime / 测试经此投递，模拟 arena_plan 工具调用）。 */
  readonly sink: (envelope: CandidateEnvelope) => void;

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
    // 候选投递口：Agent runtime 经此投递（模拟 arena_plan 工具调用路径）
    this.sink = (envelope) => {
      // runId 精确索引：旧 run 的迟到调用命中旧 Lease（已终结 → 拒绝），永不漏到新 Tick
      this.registry.submit(envelope.runId, envelope);
    };
    const settable = this.runtime as AgentDecisionRuntime & SinkSettable;
    settable.setSink?.(this.sink);
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
    // 3E-1：runId 由 coordinator 唯一分配（单源），注册 Lease 后随 request 下发
    const runId = `${this.tenantId}-${tick}-${t0}`;

    // 1) Safety 预计算（立即，不等待 Agent）
    let safetyPlan: Plan;
    let safetyError: string | null = null;
    try {
      safetyPlan = this.planner.decide({ state });
    } catch (exc) {
      safetyError = exc instanceof Error ? exc.message : String(exc);
      safetyPlan = this.arbiter.emergencyPlan(state);
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
        handle = null;
        this.runtime.reportViolation?.(startupError);
      }
    } catch (exc) {
      startupError = exc instanceof Error ? exc.message : String(exc);
      handle = null;
    }

    if (startupError !== null) {
      // 立即终结 lease → 固定 SafetyPlan → 返回（error），不等 soft deadline
      this.registry.expire(runId);
      this.registry.select(runId);
      return {
        tick,
        source: safetyError !== null ? "emergency" : "safety",
        plan: safetyPlan,
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
    const agentLatency = handle !== null ? candidateAt - t0 : null;

    let source: DecisionResult["source"];
    let plan: Plan;
    let agentActionCount = 0;
    let safetyReplacementCount = 0;
    let invalidAgentActionCount = 0;
    let repairCount = 0;
    let abortRequested = false;
    let deadlineOutcome: DecisionResult["deadlineOutcome"];

    if (candidate !== null && safetyError === null) {
      // 5) 候选路径：arbiter 合成（合法 Agent > Safety 补齐 > 无动作）
      this.registry.select(runId);
      const arbitration = this.arbiter.arbitrate({
        tick,
        state,
        safetyPlan,
        agentCandidate: candidate.plan,
      });
      let candidatePlan = arbitration.plan;
      repairCount = arbitration.repairCount;
      // 语义校验 + repair（并入选择过程，selectionLatency 覆盖完整固定流程）
      const validation = validatePlan(state, candidatePlan);
      if (!validation.valid && validation.plan !== candidatePlan) {
        candidatePlan = validation.plan;
        repairCount += validation.issues.length;
      }
      // 3E-3：selection deadline 真正落地——固定时刻超限则弃候选，用已准备好的 SafetyPlan
      if (this.clock.now() >= budget.selectionDeadline) {
        source = "safety";
        plan = safetyPlan;
        deadlineOutcome = "selection_timeout";
      } else {
        source = arbitration.source;
        plan = candidatePlan;
        agentActionCount = arbitration.agentActionCount;
        safetyReplacementCount = arbitration.safetyReplacementCount;
        invalidAgentActionCount = arbitration.invalidAgentActionCount;
        deadlineOutcome = "candidate";
      }
    } else {
      // 6) soft deadline 路径：先 expire → 固定 Safety → 后台 abort（不 await）
      this.registry.expire(runId);
      this.registry.select(runId); // expired → selected（终结 run）
      source = safetyError !== null ? "emergency" : "safety";
      plan = safetyPlan;
      deadlineOutcome = "soft_deadline";
      if (handle !== null) {
        abortRequested = true;
        handle.abort(safetyError !== null ? "safety_error" : "soft_deadline");
        this.observeSettle(runId, handle);
      }
    }

    // 7) 兜底校验：safety/emergency/selection_timeout 路径（候选路径已并入 5）
    if (deadlineOutcome !== "candidate") {
      const validation = validatePlan(state, plan);
      if (!validation.valid && validation.plan !== plan) {
        plan = validation.plan;
        repairCount += validation.issues.length;
      }
    }

    return {
      tick,
      source,
      plan,
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
