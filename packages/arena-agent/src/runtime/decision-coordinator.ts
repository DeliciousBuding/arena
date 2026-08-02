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
}

/** runtime 候选投递口（FakeAgentRuntime 等 testing 工具实现；Pi runtime 集成时对齐）。 */
interface SinkSettable {
  setSink?(sink: (envelope: CandidateEnvelope) => void): void;
  setRunIdFor?(fn: (request: AgentDecisionRequest) => string): void;
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
    // 候选投递口：Agent runtime 经此投递（模拟 arena_plan 工具调用路径）
    this.sink = (envelope) => {
      // runId 精确索引：旧 run 的迟到调用命中旧 Lease（已终结 → 拒绝），永不漏到新 Tick
      this.registry.submit(envelope.runId, envelope);
    };
    const settable = this.runtime as AgentDecisionRuntime & SinkSettable;
    settable.setSink?.(this.sink);
    // runId 同源：runtime 生成的 runId 必须与 lease runId 一致（候选经 runId 命中 lease）
    settable.setRunIdFor?.((request) =>
      `${this.tenantId}-${request.tick}-${request.context.receivedAtMonotonic}`,
    );
  }

  /** 每 Tick 决策：永远在 selection deadline 前 resolve。 */
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
    const runId = `${this.tenantId}-${tick}-${t0}`;
    const lease = new DecisionLease({
      runId,
      tick,
      stateHash,
      deadlineAt: budget.agentSoftDeadline,
      clock: this.clock,
    });
    this.registry.register(lease);

    // 3) 启动 Agent run（异常 → 无 handle，走 safety）
    let handle: AgentRunHandle | null = null;
    try {
      const request: AgentDecisionRequest = {
        tenantId: this.tenantId,
        tick,
        state,
        stateHash,
        context,
      };
      handle = this.runtime.startDecision(request);
    } catch {
      handle = null;
    }

    // 4) 等待：Lease accepted（候选经 sink → registry 校验）或 soft deadline
    const candidate = await this.raceCandidate(runId, budget.agentSoftDeadline);
    const selectionAt = this.clock.now();
    const agentLatency = handle !== null ? selectionAt - t0 : null;

    let source: DecisionResult["source"];
    let plan: Plan;
    let agentActionCount = 0;
    let safetyReplacementCount = 0;
    let invalidAgentActionCount = 0;
    let repairCount = 0;
    let abortRequested = false;
    let abortSettled = false;

    if (candidate !== null && safetyError === null) {
      // 5) 候选路径：arbiter 合成（合法 Agent > Safety 补齐 > 无动作）
      this.registry.select(runId);
      const arbitration = this.arbiter.arbitrate({
        tick,
        state,
        safetyPlan,
        agentCandidate: candidate.plan,
      });
      source = arbitration.source;
      plan = arbitration.plan;
      agentActionCount = arbitration.agentActionCount;
      safetyReplacementCount = arbitration.safetyReplacementCount;
      invalidAgentActionCount = arbitration.invalidAgentActionCount;
      repairCount = arbitration.repairCount;
    } else {
      // 6) soft deadline 路径：先 expire → 固定 Safety → 后台 abort（不 await）
      this.registry.expire(runId);
      this.registry.select(runId); // expired → selected（终结 run）
      source = safetyError !== null ? "emergency" : "safety";
      plan = safetyPlan;
      if (handle !== null) {
        abortRequested = true;
        handle.abort(safetyError !== null ? "safety_error" : "soft_deadline");
        void handle.settled
          .then(() => {
            abortSettled = true;
          })
          .catch(() => {
            abortSettled = true;
          });
      }
    }

    // 7) 最终兜底校验（arbiter 已保证；此处修复并计数）
    const validation = validatePlan(state, plan);
    if (!validation.valid && validation.plan !== plan) {
      plan = validation.plan;
      repairCount += validation.issues.length;
    }

    return {
      tick,
      source,
      plan,
      agentActionCount,
      safetyReplacementCount,
      invalidAgentActionCount,
      repairCount,
      deadlineOutcome: candidate !== null ? "candidate" : "soft_deadline",
      agentLatencyMs: agentLatency,
      selectionLatencyMs: selectionAt - t0,
      abortRequested,
      abortSettled,
    };
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
