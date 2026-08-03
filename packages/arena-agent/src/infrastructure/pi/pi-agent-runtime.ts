/**
 * PiAgentRuntime（切片 4 阶段 3，总任务书 3.x）：AgentDecisionRuntime 的真实 Pi 实现。
 *
 * 生命周期：initializing → ready → running → ready；running → aborting → ready；
 * 严重错误 → unhealthy → rotating → ready。
 *
 * 关键约束（总任务书 + GPT 审核）：
 * - session 在 create() 时异步创建（长驻单 session，in-memory；失败才 rotation）；
 * - 工具定义在 session 创建时注册一次，持有 ctxRef（每 run 替换 ToolContext）；
 * - prompt() Promise 是 settle 主信号；settleOnce() 防 Promise/事件/abort 重复结算；
 * - abort 同步返回（不 await），后台等待 prompt 终止 → waitForIdle → ready；
 *   超过 idleTimeoutMs 未 settle → unhealthy → rotate session；
 * - rotation 期间 startDecision 抛错（coordinator 立即 Safety）；
 * - runId 由 coordinator 分配（3E 单源），runtime 绝不自行生成。
 */

import type {
  AgentDecisionRequest,
  AgentDecisionRuntime,
  AgentRunHandle,
  AgentRunResult,
  AgentRuntimeHealth,
  CandidateSink,
} from "../../runtime/decision-types.ts";
import { StrategyMemory } from "./strategy-memory.ts";
import { ActiveToolContextSlot } from "./tools/active-context-slot.ts";
import { createArenaMapToolDefinition } from "./tools/arena-map.ts";
import { createArenaPlanToolDefinition } from "./tools/arena-plan.ts";
import { createToolContext, type MapSnapshot, type ToolContext } from "./tools/tool-context.ts";
import { PiSessionFactory } from "./pi-session-factory.ts";
import type { PiSessionFactoryOptions, PiSessionArtifacts } from "./pi-types.ts";

export type PiRuntimeState =
  | "initializing"
  | "ready"
  | "running"
  | "aborting"
  | "unhealthy"
  | "rotating"
  | "closed";

export interface PiRuntimeTelemetry {
  readonly type:
    | "run_settled"
    | "abort_requested"
    | "prompt_error"
    | "unhealthy"
    | "rotating"
    | "rotated"
    | "rotation_failed"
    | "violation";
  readonly runId?: string;
  readonly reason?: string;
  readonly message?: string;
  readonly generation?: number;
}

export interface PiAgentRuntimeOptions {
  /** 会话工厂配置（customTools 由 runtime 注入，忽略调用方传入的）。 */
  readonly session: Omit<PiSessionFactoryOptions, "customTools">;
  readonly tenantId: string;
  /** 五段 prompt 构建（4C buildDecisionPrompt；测试注入 fake）。 */
  readonly promptBuilder: (input: {
    readonly state: AgentDecisionRequest["state"];
    readonly context: AgentDecisionRequest["context"];
    readonly memory: StrategyMemory;
    readonly runId: string;
  }) => string;
  /** 每 run 地图冻结快照构建（request.state 驱动，本 Tick 冻结；缺省 null = 地图不可用）。 */
  readonly mapSnapshotBuilder?: (state: AgentDecisionRequest["state"]) => MapSnapshot | null;
  /** 战略记忆（缺省自建）。 */
  readonly memory?: StrategyMemory;
  /** abort 后等待 settle 的超时（缺省 15000ms），超时 → unhealthy → rotate。 */
  readonly idleTimeoutMs?: number;
  /** 连续 prompt 失败阈值（缺省 3），达到 → unhealthy → rotate。 */
  readonly consecutiveErrorThreshold?: number;
  /** 生命周期/异常 telemetry。 */
  readonly onTelemetry?: (event: PiRuntimeTelemetry) => void;
  /** 启动预热 prompt（缺省无）。真实 LLM 冷启动 12s+（首调用）会让首 tick
   *  在 soft deadline 超时 → abort 残留 → 恶性循环；预热后 2-4s/轮稳定。 */
  readonly warmupPrompt?: string;
  /** 主动重置阈值（缺省 40）：每 N 个 run 主动 rotate 一次——对抗会话历史累积
   *  （每 tick prompt 追加，上下文增长让 LLM 变慢；rotate 后重新预热 1-2 tick）。 */
  readonly maxRunsBeforeRotate?: number;
}

interface ActiveRun {
  readonly runId: string;
  /** P0-2：创建时的 generation——旧 generation 迟到回调不得影响新 session 状态。 */
  readonly generation: number;
  readonly ctx: ToolContext;
  readonly settled: Promise<AgentRunResult>;
  resolveSettled: (result: AgentRunResult) => void;
  aborted: boolean;
  abortReason: string | null;
  /** settleOnce 落位（abort 超时检查用：settled 已完成则无需 rotate）。 */
  settledResult: AgentRunResult | null;
}

export class PiAgentRuntime implements AgentDecisionRuntime {
  readonly memory: StrategyMemory;

  private readonly options: PiAgentRuntimeOptions;
  private readonly factory: PiSessionFactory;
  private state: PiRuntimeState = "initializing";
  private artifacts: PiSessionArtifacts | null = null;
  private sink: CandidateSink | null = null;
  private readonly slot = new ActiveToolContextSlot();
  private active: ActiveRun | null = null;
  private generation = 0;
  private consecutiveErrors = 0;
  /** P0-2：生命周期纪元——每次 rotate/close 递增；initialize 仅当纪元匹配才置 ready。 */
  private lifecycleEpoch = 0;
  private closing = false;
  private abortTimers = new Set<ReturnType<typeof setTimeout>>();
  /** 主动重置阈值（每 N 个 run rotate 一次——对抗会话历史累积）。 */
  private maxRunsBeforeRotate = 40;
  /** 自上次 rotate 以来的 run 数。 */
  private runsSinceRotate = 0;

  private constructor(options: PiAgentRuntimeOptions) {
    this.options = options;
    this.memory = options.memory ?? new StrategyMemory();
    this.maxRunsBeforeRotate = options.maxRunsBeforeRotate ?? 40;
    // 工具定义持有 ctxRef getter：session 创建时注册一次，每 run 替换 ctx 对象
    this.factory = new PiSessionFactory({
      ...options.session,
      // 4D-pre：工具定义持有 slot（长驻 session 每 run 激活/停用上下文）
      customTools: [createArenaPlanToolDefinition(this.slot), createArenaMapToolDefinition(this.slot)],
    });
  }

  /** 异步工厂：创建 session 完成后 runtime 才进入 ready（含可选预热）。 */
  static async create(options: PiAgentRuntimeOptions): Promise<PiAgentRuntime> {
    const runtime = new PiAgentRuntime(options);
    await runtime.initialize();
    // 预热：让 LLM 首调用（冷启动 12s+）在首 tick 前完成——首 tick 就 2-4s 稳定
    if (options.warmupPrompt !== undefined && options.warmupPrompt.length > 0) {
      await runtime.artifacts?.session.prompt(options.warmupPrompt).catch(() => {});
    }
    return runtime;
  }

  private async initialize(): Promise<void> {
    const epoch = ++this.lifecycleEpoch; // P0-2：本纪元（rotate/close 会递增使旧 initialize 失效）
    this.state = "initializing";
    this.artifacts = await this.factory.createSession(this.options.tenantId);
    // 关闭后复活的竞态守卫：仅当纪元未变且未在关闭中才可置 ready
    if (epoch === this.lifecycleEpoch && !this.closing) {
      this.state = "ready";
    } else {
      this.state = this.closing ? "closed" : "unhealthy";
    }
  }

  // ---------- AgentDecisionRuntime 端口 ----------

  bindCandidateSink(sink: CandidateSink): void {
    this.sink = sink;
  }

  startDecision(request: AgentDecisionRequest): AgentRunHandle {
    // 检查顺序：重叠 run 优先于 not-ready（语义上"上一 run 未 settle"更具体）
    if (this.active !== null) {
      throw new Error(`overlapping run: ${this.active.runId} is not settled`);
    }
    if (this.state !== "ready") {
      throw new Error(`runtime not ready (${this.state})`);
    }
    // 3.3：用 request.runId 建 ToolContext（权威值源），mapSnapshot 本 Tick 冻结
    const ctx = createToolContext({
      runId: request.runId,
      tenantId: request.tenantId,
      tick: request.tick,
      stateHash: request.stateHash,
      controlledUnits: new Set<string>(request.state.units.map((u) => u.id)),
      mapSnapshot: this.options.mapSnapshotBuilder?.(request.state) ?? null,
      sink: this.sink ?? (() => {
        throw new Error("candidate sink not bound");
      }),
    });
    this.slot.activate(ctx); // 4D-pre：激活当前 run 的 context

    const promptText = this.options.promptBuilder({
      state: request.state,
      context: request.context,
      memory: this.memory,
      runId: request.runId,
    });

    let resolveSettled: (result: AgentRunResult) => void = () => {};
    const settled = new Promise<AgentRunResult>((resolve) => {
      resolveSettled = resolve;
    });
    const run: ActiveRun = {
      runId: request.runId,
      generation: this.generation,
      ctx,
      settled,
      resolveSettled,
      aborted: false,
      abortReason: null,
      settledResult: null,
    };
    this.active = run;
    this.state = "running";

    // settleOnce：防 prompt/abort/事件重复结算（总任务书 3.3）
    let finished = false;
    const settleOnce = (result: AgentRunResult): void => {
      if (finished) {
        return;
      }
      finished = true;
      run.settledResult = result;
      run.resolveSettled(result);
      if (this.active === run) {
        this.active = null;
        this.state = "ready";
        this.slot.deactivate(run.runId); // 4D-pre：settle 后停用（只匹配本 run）
      }
      this.onTelemetry("run_settled", run.runId, undefined, undefined, undefined);
    };

    // prompt() 是主 settle 信号（GPT 裁决 2）
    // P0-2：旧 generation 迟到回调只允许 settle 旧 handle，不得影响当前 generation 的
    // consecutiveErrors / health（旧 session 的 Prompt 在新 session 已就绪后才结束）。
    void this.sessionPrompt(promptText)
      .then(() => {
        if (run.generation !== this.generation || this.closing) {
          settleOnce({ outcome: "settled" });
          return;
        }
        this.consecutiveErrors = 0;
        settleOnce({ outcome: "settled" });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (run.generation !== this.generation || this.closing) {
          settleOnce({ outcome: "error", message });
          return;
        }
        this.consecutiveErrors += 1;
        this.onTelemetry("prompt_error", run.runId, message);
        settleOnce({ outcome: "error", message });
        // 连续失败超阈值 → unhealthy（总任务书 3.1 严重错误）
        if (this.consecutiveErrors >= (this.options.consecutiveErrorThreshold ?? 3)) {
          this.markUnhealthy(`consecutive_prompt_errors: ${this.consecutiveErrors}`);
        }
      });

    return {
      runId: request.runId,
      settled: run.settled,
      abort: (reason: string) => this.abortRun(run, reason),
    };
  }

  health(): AgentRuntimeHealth {
    // P0-2：ready 严格等于 state==="ready"（running/aborting 不算 ready——
    // doctor/supervisor 不会误判可启动新 run）
    if (this.state === "ready") {
      return { ready: true, activeRunId: null };
    }
    return { ready: false, activeRunId: this.active?.runId ?? null, reason: this.state };
  }

  reportViolation(reason: string): void {
    this.onTelemetry("violation", this.active?.runId, undefined, reason);
    this.markUnhealthy(`violation: ${reason}`);
  }

  /** 关停：abort 当前 run（100ms 兜底不等无限 settle），取消全部 abort timer，
   *  session 关闭；之后拒绝新 run。 */
  async close(): Promise<void> {
    if (this.state === "closed") {
      return;
    }
    this.closing = true;
    this.lifecycleEpoch += 1; // P0-2：使进行中的 initialize 失效（防关闭后复活）
    if (this.active !== null && !this.active.aborted) {
      this.abortRun(this.active, "runtime_close");
    }
    if (this.active !== null) {
      await Promise.race([
        this.active.settled.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 100)),
      ]);
    }
    for (const timer of this.abortTimers) {
      clearTimeout(timer);
    }
    this.abortTimers.clear();
    await this.artifacts?.close();
    this.state = "closed";
  }

  // ---------- 内部 ----------

  private sessionPrompt(text: string): Promise<void> {
    if (this.artifacts === null) {
      return Promise.reject(new Error("session not initialized"));
    }
    return this.artifacts.session.prompt(text);
  }

  /** 同步返回；后台等待 prompt 终止 → ready；超时 → unhealthy → rotate（总任务书 3.4）。
   *  主动重置检查：runsSinceRotate 达到阈值 → 立即 rotate（对抗会话历史累积）。 */
  private abortRun(run: ActiveRun, reason: string): void {
    if (this.active !== run || run.aborted) {
      return;
    }
    run.aborted = true;
    run.abortReason = reason;
    this.state = "aborting";
    this.onTelemetry("abort_requested", run.runId, undefined, reason);
    this.runsSinceRotate += 1;
    // 不 await：void 后台完成（coordinator 永不阻塞在 abort 上）
    if (this.runsSinceRotate >= this.maxRunsBeforeRotate) {
      // 主动重置：会话历史累积到阈值——rotate 清空上下文（LLM 恢复 2-4s）
      this.onTelemetry("rotating", undefined, "periodic_reset", undefined, this.generation + 1);
      this.runsSinceRotate = 0;
      void this.rotate();
      return;
    }
    void this.abortAndSettle(run, reason);
  }

  private async abortAndSettle(run: ActiveRun, reason: string): Promise<void> {
    const timer = setTimeout(() => {
      this.abortTimers.delete(timer);
      // P0-2：旧 generation 的 abort 超时不得触发 rotate（新 session 已就绪）
      if (
        this.active === run &&
        run.generation === this.generation &&
        run.settledResult === null
      ) {
        this.markUnhealthy(`abort_idle_timeout: ${reason}`);
        void this.rotate();
      }
    }, this.options.idleTimeoutMs ?? 15000);
    this.abortTimers.add(timer);
    const clear = (): void => {
      this.abortTimers.delete(timer);
      clearTimeout(timer);
    };
    try {
      // pi abort 内部 waitForIdle；prompt promise 随之终止 → settleOnce → ready
      await this.artifacts?.session.abort();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markUnhealthy(`abort_failed: ${message}`);
    } finally {
      // 等待 prompt settle（可能已发生）；无论结果如何清除超时
      void run.settled.then(clear, clear);
    }
  }

  /** 标记 unhealthy 并触发 rotation（不 await——调用方不被阻塞）。 */
  private markUnhealthy(reason: string): void {
    if (this.state === "unhealthy" || this.state === "rotating" || this.state === "closed") {
      return;
    }
    this.state = "unhealthy";
    this.onTelemetry("unhealthy", this.active?.runId, undefined, reason);
    void this.rotate();
  }

  private async rotate(): Promise<void> {
    if (this.state === "rotating" || this.state === "closed") {
      return;
    }
    this.lifecycleEpoch += 1; // P0-2：旧 initialize/回调全部失效
    this.state = "rotating";
    this.slot.forceClear(); // 4D-pre：rotation 强制清空残留上下文
    this.active = null; // 旧 run 作废（hang 无法 settle 时不再引用）
    this.generation += 1;
    this.onTelemetry("rotating", undefined, undefined, undefined, this.generation);
    try {
      // 超时保护：hang 的 prompt 会让 session.abort() 永不返回（真实冒烟暴露）——
      // rotation 必须推进（新 session 就绪），旧 session 泄漏可接受（已作废）
      await Promise.race([
        this.artifacts?.close(),
        new Promise((resolve) => setTimeout(resolve, 100)),
      ]);
      await this.initialize();
      // 新 session 同样预热（rotate 后首 tick 不冷启动超时）
      if (this.options.warmupPrompt !== undefined && this.options.warmupPrompt.length > 0) {
        await this.artifacts?.session.prompt(this.options.warmupPrompt).catch(() => {});
      }
      this.consecutiveErrors = 0;
      this.onTelemetry("rotated", undefined, undefined, undefined, this.generation);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onTelemetry("rotation_failed", undefined, message, undefined, this.generation);
      // rotation 失败保持 unhealthy（下一 Tick startDecision 抛错 → Safety）
      this.state = "unhealthy";
    }
  }

  private onTelemetry(
    type: PiRuntimeTelemetry["type"],
    runId?: string,
    message?: string,
    reason?: string,
    generation?: number,
  ): void {
    this.options.onTelemetry?.({ type, runId, reason, message, generation });
  }
}
