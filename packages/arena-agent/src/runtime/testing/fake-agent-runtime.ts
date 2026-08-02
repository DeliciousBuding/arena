/** W4 故障注入载体：FakeAgentRuntime（2026-08-03）。
 *
 * 实现冻结端口 AgentDecisionRuntime（decision-types.ts）。所有行为确定性可复现、
 * 无真实 timer：延时/提交全部走 FakeClock 手动推进。
 *
 * 候选必须经注入的 sink 投递（模拟 arena_plan 工具调用路径），
 * 禁止 "函数 return candidate" 捷径——coordinator 只从 CandidateSink 收候选。
 *
 * 生命周期硬规则：
 * 1. 同一时刻最多一个 active run——上一 run 未 settle 时 startDecision 同步抛错
 *    （任意模式，含 rejects-overlap；rejects-overlap 作为显式表达意图的模式存在）；
 * 2. abort 只是置位取消信号，settled 是否结束取决于模式；
 * 3. settled 永远 resolve（outcome: "settled" | "error"），异常不得形成 unhandled rejection。
 */

import { emptyPlan, type Plan } from "../../domain/model.ts";
import {
  type AgentDecisionRequest,
  type AgentDecisionRuntime,
  type AgentRuntimeHealth,
  type AgentRunHandle,
  type AgentRunResult,
  type CandidateEnvelope,
} from "../decision-types.ts";

// ---------- 微型确定性时钟（无真实 timer） ----------

interface ScheduledTask {
  readonly id: number;
  readonly dueAt: number;
  readonly fn: () => void;
}

/** 手动推进的 fake timer：advance(ms) 按到期顺序触发任务，任务可再注册任务。 */
export class FakeClock {
  private currentMs = 0;
  private tasks: ScheduledTask[] = [];
  private nextId = 1;

  now(): number {
    return this.currentMs;
  }

  /** 注册延时任务，返回取消函数。 */
  setTimeout(fn: () => void, ms: number): () => void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`invalid fake delay: ${ms}`);
    }
    const task: ScheduledTask = { id: this.nextId++, dueAt: this.currentMs + ms, fn };
    this.tasks.push(task);
    return () => {
      this.tasks = this.tasks.filter((t) => t.id !== task.id);
    };
  }

  /** 推进时间并触发所有到期任务（同刻任务按注册顺序，任务可再注册）。 */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`invalid advance: ${ms}`);
    }
    this.currentMs += ms;
    for (;;) {
      const pick = this.nextDue();
      if (pick === null) {
        return;
      }
      this.tasks = this.tasks.filter((t) => t.id !== pick.id);
      pick.fn();
    }
  }

  private nextDue(): ScheduledTask | null {
    let pick: ScheduledTask | null = null;
    for (const task of this.tasks) {
      if (task.dueAt <= this.currentMs) {
        if (pick === null || task.dueAt < pick.dueAt || (task.dueAt === pick.dueAt && task.id < pick.id)) {
          pick = task;
        }
      }
    }
    return pick;
  }
}

// ---------- 模式与选项 ----------

export type FakeRuntimeMode =
  | "immediate-valid" // start 即提交合法候选并 settle
  | "delayed-valid" // delayMs 后提交合法候选并 settle
  | "never-settles" // 永不提交、永不 settle（abort 也不结束）
  | "throws" // delayMs 后以 error settle
  | "submits-wrong-run" // 提交 runId 错误的候选
  | "submits-wrong-tick" // 提交 tick 错误的候选
  | "submits-wrong-state" // 提交 stateHash 错误的候选
  | "submits-twice" // 提交两个候选（reason: "first"/"second"）
  | "submits-after-abort" // 等 abort 才提交候选并 settle；不 abort 则永不 settle
  | "ignores-abort" // 照常延时提交并 settle，abort 无任何效果
  | "rejects-overlap"; // 语义同 immediate-valid；重叠拒绝是任意模式下的硬规则

export type FakeRuntimeModeSelector =
  | FakeRuntimeMode
  | ((request: AgentDecisionRequest) => FakeRuntimeMode);

export interface FakeAgentRuntimeOptions {
  /** 候选投递口（coordinator 会把 sink 接到 LeaseRegistry.submit）。 */
  readonly sink: (envelope: CandidateEnvelope) => void;
  /** 每个 run 的行为：静态模式，或按请求动态选择（coordinator 逐 tick 控制用）。 */
  readonly mode: FakeRuntimeModeSelector;
  /** 共享时钟（缺省自建，经 runtime.clock 读取）。 */
  readonly clock?: FakeClock;
  /** 延时模式（delayed-valid / ignores-abort / throws）的延时，缺省 50。 */
  readonly delayMs?: number;
  /** 候选 plan（缺省 emptyPlan(request.tick)）。 */
  readonly plan?: Plan | ((request: AgentDecisionRequest) => Plan);
  readonly reason?: string;
  readonly confidence?: number | null;
  /** submits-wrong-run 用的错误 runId（缺省 "wrong-run"）。 */
  readonly wrongRunId?: string;
  /** submits-wrong-tick 用的错误 tick（缺省 request.tick + 1）。 */
  readonly wrongTick?: number;
  /** submits-wrong-state 用的错误 stateHash（缺省 "wrong-<stateHash>"）。 */
  readonly wrongStateHash?: string;
  /** throws 模式的错误信息（缺省 "fake runtime error"）。 */
  readonly failMessage?: string;
  /** 3E 故障注入：startDecision 返回的 handle 使用的 runId（缺省 request.runId 单源）。
   *  仅测试证明 runId 不一致违规时使用。 */
  readonly handleRunId?: (request: AgentDecisionRequest) => string;
}

// ---------- run 内部状态 ----------

class FakeRun {
  readonly runId: string;
  readonly request: AgentDecisionRequest;
  readonly mode: FakeRuntimeMode;
  readonly settled: Promise<AgentRunResult>;

  aborted = false;
  abortReason: string | null = null;

  private settleFn: (result: AgentRunResult) => void = () => {};
  private cancelers: (() => void)[] = [];
  private result: AgentRunResult | null = null;

  constructor(runId: string, request: AgentDecisionRequest, mode: FakeRuntimeMode) {
    this.runId = runId;
    this.request = request;
    this.mode = mode;
    this.settled = new Promise<AgentRunResult>((resolve) => {
      this.settleFn = resolve;
    });
  }

  get settledResult(): AgentRunResult | null {
    return this.result;
  }

  /** 注册延时任务；settle 时自动取消未执行任务。 */
  schedule(clock: FakeClock, fn: () => void, ms: number): void {
    if (this.result !== null) {
      return;
    }
    this.cancelers.push(clock.setTimeout(fn, ms));
  }

  /** 幂等：第一次 settle 生效，之后忽略；同时取消未执行的延时任务。 */
  settle(result: AgentRunResult): void {
    if (this.result !== null) {
      return;
    }
    this.result = result;
    for (const cancel of this.cancelers.splice(0)) {
      cancel();
    }
    this.settleFn(result);
  }
}

// ---------- FakeAgentRuntime ----------

export class FakeAgentRuntime implements AgentDecisionRuntime {
  readonly clock: FakeClock;

  /** 经 sink 投递出的候选（测试观测用，含被 sink 拒绝的投递尝试）。 */
  readonly submissions: CandidateEnvelope[] = [];
  /** 每次 settle 的记录（测试观测用）。 */
  readonly settleLog: Array<{ readonly runId: string; readonly result: AgentRunResult; readonly aborted: boolean }> = [];
  /** abort 记录（测试观测用）。 */
  readonly abortLog: Array<{ readonly runId: string; readonly reason: string }> = [];

  private options: FakeAgentRuntimeOptions;
  private sinkImpl: (envelope: CandidateEnvelope) => void;
  private active: FakeRun | null = null;
  private closedFlag = false;

  constructor(options: FakeAgentRuntimeOptions) {
    this.options = options;
    this.clock = options.clock ?? new FakeClock();
    this.sinkImpl = options.sink;
  }

  /** 候选投递口（DecisionCoordinator 构造时接入 LeaseRegistry.submit）。 */
  setSink(sink: (envelope: CandidateEnvelope) => void): void {
    this.sinkImpl = sink;
  }

  /** 3E：契约违规上报（coordinator 检测 runId 不一致时调用）→ 记录并标记不健康。 */
  readonly violationLog: string[] = [];
  private violated = false;
  reportViolation(reason: string): void {
    this.violationLog.push(reason);
    this.violated = true;
  }

  get activeRunId(): string | null {
    return this.active?.runId ?? null;
  }

  startDecision(request: AgentDecisionRequest): AgentRunHandle {
    if (this.closedFlag) {
      throw new Error("FakeAgentRuntime is closed");
    }
    if (this.active !== null) {
      throw new Error(`overlapping run: ${this.active.runId} is not settled`);
    }
    // 3E-1：handle.runId 默认严格等于 request.runId（单源）；handleRunId 仅故障注入用
    const run = new FakeRun(
      this.options.handleRunId !== undefined ? this.options.handleRunId(request) : request.runId,
      request,
      this.resolveMode(request),
    );
    this.active = run;
    this.arm(run);
    return {
      runId: run.runId,
      settled: run.settled,
      abort: (reason: string) => {
        this.abortRun(run, reason);
      },
    };
  }

  health(): AgentRuntimeHealth {
    if (this.closedFlag) {
      return { ready: false, activeRunId: null, reason: "closed" };
    }
    if (this.violated) {
      return {
        ready: false,
        activeRunId: this.active?.runId ?? null,
        reason: `violation: ${this.violationLog[this.violationLog.length - 1]}`,
      };
    }
    return { ready: true, activeRunId: this.active?.runId ?? null };
  }

  /** 关停：强制 settle 未结束的 run（不走 abort 路径，abort 模式有副作用），之后拒绝新 run。 */
  async close(): Promise<void> {
    this.closedFlag = true;
    if (this.active !== null) {
      this.finish(this.active, { outcome: "settled" });
    }
  }

  // ---------- 内部 ----------

  private resolveMode(request: AgentDecisionRequest): FakeRuntimeMode {
    const mode = this.options.mode;
    return typeof mode === "function" ? mode(request) : mode;
  }

  private planFor(request: AgentDecisionRequest): Plan {
    const plan = this.options.plan;
    return typeof plan === "function" ? plan(request) : plan ?? emptyPlan(request.tick);
  }

  /** 按模式装配 run 的初始行为（startDecision 内同步执行，保证确定性）。 */
  private arm(run: FakeRun): void {
    const delayMs = this.options.delayMs ?? 50;
    const plan = this.planFor(run.request);
    switch (run.mode) {
      case "immediate-valid":
      case "rejects-overlap":
        this.deliver(run, plan);
        this.finish(run, { outcome: "settled" });
        break;
      case "delayed-valid":
      case "ignores-abort":
        run.schedule(this.clock, () => {
          this.deliver(run, plan);
          this.finish(run, { outcome: "settled" });
        }, delayMs);
        break;
      case "throws":
        run.schedule(this.clock, () => {
          this.finish(run, { outcome: "error", message: this.options.failMessage ?? "fake runtime error" });
        }, delayMs);
        break;
      case "never-settles":
      case "submits-after-abort":
        // 永不 settle（never-settles）；或等 abort 驱动（submits-after-abort）
        break;
      case "submits-wrong-run": {
        const wrongRunId = this.options.wrongRunId ?? "wrong-run";
        this.deliver(run, plan, (envelope) => ({ ...envelope, runId: wrongRunId }));
        this.finish(run, { outcome: "settled" });
        break;
      }
      case "submits-wrong-tick": {
        const wrongTick = this.options.wrongTick ?? run.request.tick + 1;
        this.deliver(run, plan, (envelope) => ({ ...envelope, tick: wrongTick }));
        this.finish(run, { outcome: "settled" });
        break;
      }
      case "submits-wrong-state": {
        const wrongStateHash = this.options.wrongStateHash ?? `wrong-${run.request.stateHash}`;
        this.deliver(run, plan, (envelope) => ({ ...envelope, stateHash: wrongStateHash }));
        this.finish(run, { outcome: "settled" });
        break;
      }
      case "submits-twice":
        this.deliver(run, plan, (envelope) => ({ ...envelope, reason: "first" }));
        this.deliver(run, plan, (envelope) => ({ ...envelope, reason: "second" }));
        this.finish(run, { outcome: "settled" });
        break;
    }
  }

  /** abort 只置位取消信号；settled 是否结束取决于模式。 */
  private abortRun(run: FakeRun, reason: string): void {
    if (run.settledResult !== null) {
      return; // 已 settle：abort 是 no-op
    }
    this.abortLog.push({ runId: run.runId, reason });
    run.aborted = true;
    run.abortReason = reason;
    switch (run.mode) {
      case "never-settles":
      case "ignores-abort":
        // 取消信号置位即可；settled 照旧由模式自己的节奏决定
        break;
      case "submits-after-abort":
        this.deliver(run, this.planFor(run.request));
        this.finish(run, { outcome: "settled" });
        break;
      default:
        // 正常模式：abort 立即结束 run（未执行的延时提交被 settle 取消）
        this.finish(run, { outcome: "settled" });
        break;
    }
  }

  /** 候选经 sink 投递（模拟 arena_plan 工具调用路径）。sink 抛错 → run 以 error settle。 */
  private deliver(
    run: FakeRun,
    plan: Plan,
    mutate?: (envelope: CandidateEnvelope) => CandidateEnvelope,
  ): void {
    const request = run.request;
    const envelope: CandidateEnvelope = {
      protocolVersion: "1",
      runId: request.runId, // 3E-1 单源：候选携带 coordinator 分配的 runId（工具参数来源）
      tenantId: request.tenantId,
      tick: request.tick,
      stateHash: request.stateHash,
      plan,
      reason: this.options.reason ?? "fake runtime candidate",
      confidence: this.options.confidence ?? null,
    };
    const final = mutate === undefined ? envelope : mutate(envelope);
    this.submissions.push(final);
    try {
      this.sinkImpl(final);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finish(run, { outcome: "error", message: `sink rejected: ${message}` });
    }
  }

  /** settle 并把 active 位清掉（结果先到先得，重复调用忽略）。 */
  private finish(run: FakeRun, result: AgentRunResult): void {
    if (run.settledResult !== null) {
      return; // 已 settle：本结果忽略（例如 sink 抛错后 arm 再补 settled）
    }
    run.settle(result);
    if (this.active === run) {
      this.active = null;
    }
    this.settleLog.push({ runId: run.runId, result, aborted: run.aborted });
  }
}
