/**
 * 租户运行时（切片 4 阶段 6，GPT issue #2 集成顺序：B/C → tenant-runtime）。
 *
 * 组装：ArenaHeroClient（真实游戏 API）→ loop.runTenantLoop
 * → DecisionCoordinator（Pi runtime + SafetyPlanner）→ SingleWriterLock → manifest → telemetry 三流。
 *
 * 安全红线（用户裁决）：
 * - 同一租户 Python/TS 只能一个提交者——启动即 acquire 单写者锁，拿不到直接失败（不降级）；
 * - 密钥只从 process.env[arenaTokenEnv] 读取，不落盘、不进 manifest/日志；
 * - SIGINT/SIGTERM 优雅关闭：停止接收 Turn → 不再提交 → flush telemetry → 释放锁 → 退出。
 *
 * 模式映射（P0-1）：
 * - decisionMode "deterministic" 未启用（WorkerTaskPlanner 完整集成在 D 验收后，leader 契约）；
 * - submissionMode 缺省取 config.submitEnabled（false = 只观察）。
 */

import { ArenaHeroClient } from "@arena/arena-hero-ts";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";

import { loadRuntimeConfig, resolveDeadlines, type TenantRuntimeConfig } from "./runtime-config.ts";
import { SingleWriterLock } from "./single-writer-lock.ts";
import { newProcessRunId, readGitSha, writeRunManifest, type RunManifest } from "./run-manifest.ts";
import { DecisionCoordinator } from "../runtime/decision-coordinator.ts";
import { LeaseRegistry } from "../runtime/lease-registry.ts";
import { runTenantLoop, type TickOutcome } from "../runtime/loop.ts";
import { SafetyPlanner, DEFAULT_SAFETY_CONFIG } from "../strategies/safety-planner.ts";
import { DeterministicPlanner } from "../planning/deterministic-planner.ts";
import { PiAgentRuntime, type PiRuntimeTelemetry } from "../infrastructure/pi/pi-agent-runtime.ts";
import { buildDecisionPrompt } from "../infrastructure/pi/prompt-builder.ts";
import { mapSnapshotOf } from "../infrastructure/pi/map-snapshot.ts";
import type { PiModel } from "../infrastructure/pi/pi-types.ts";
import { manhattan } from "../domain/nav.ts";
import type { AgentDecisionRuntime, DecisionModeName, DecisionResult, SubmissionModeName } from "../runtime/decision-types.ts";
import { JsonlWriter } from "../telemetry/jsonl-writer.ts";
import { sanitizeValue } from "../telemetry/jsonl-writer.ts";
import { planHashOf } from "../telemetry/decision-trace.ts";
import type { DecisionTraceRecord, OutcomeTraceRecord, RuntimeTraceRecord } from "../telemetry/decision-trace.ts";
import { sha256Canonical } from "../domain/integrity.ts";
import {
  RuntimeGoldenRecorder,
  type RuntimeGoldenRecorderResult,
} from "../runtime-golden/recorder.ts";

export const RULES_VERSION = "v0.11";

/** safety 模式占位 runtime：coordinator 短路不会调用（P0-1），
 *  避免 Pi session 创建（模型认证）成为 safety Canary 的前置失败点。 */
class NoopAgentRuntime implements AgentDecisionRuntime {
  bindCandidateSink(): void {}
  startDecision(): never {
    throw new Error("noop runtime: safety 模式不启动 Agent");
  }
  health() {
    return { ready: true, activeRunId: null };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** 运行时目录布局：<baseDir>/<tenantId>/{locks,runs,telemetry,pi}。 */
function tenantDirs(baseDir: string, tenantId: string) {
  const root = join(baseDir, tenantId);
  return {
    root,
    lockDir: join(root, "locks"),
    runDir: join(root, "runs"),
    telemetryDir: join(root, "telemetry"),
    calibrationDir: join(root, "calibration"),
    piBaseDir: join(baseDir, "pi"),
  };
}

/** 从 env 读模型网关地址（非密钥；newapi 网关）。缺省 undefined = pi 用自身配置。 */
function modelBaseUrl(): string | undefined {
  const url = process.env.ARENA_MODEL_BASE_URL;
  return url !== undefined && url.length > 0 ? url : undefined;
}

/** config.model → pi Model 结构（api = OpenAI 兼容协议；baseUrl 从 env 显式声明）。 */
export function resolvePiModel(config: TenantRuntimeConfig): PiModel {
  return {
    id: config.model.id,
    name: config.model.id,
    api: "openai-completions",
    provider: config.model.provider,
    ...(modelBaseUrl() !== undefined ? { baseUrl: modelBaseUrl() } : {}),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0 },
    contextWindow: 8000,
    maxTokens: 4096,
  } as unknown as PiModel;
}

export interface TenantRunOptions {
  /** 覆盖 config.submitEnabled（CLI --live/--shadow）。 */
  readonly submissionMode?: SubmissionModeName;
  /** 覆盖 config.decisionMode（CLI --mode）。 */
  readonly decisionMode?: DecisionModeName;
  /** 游戏客户端（测试注入 fake；缺省真实 ArenaHeroClient）。 */
  readonly client?: ArenaHeroClient;
  /** Agent runtime（测试注入 fake；缺省真实 PiAgentRuntime）。 */
  readonly runtime?: AgentDecisionRuntime;
  /** 自定义信号回调注册（测试注入；缺省 process.on SIGINT/SIGTERM）。 */
  readonly onSignal?: (callback: () => void) => void;
  /** 处理满 N 个 Turn 后由 runtime 自己优雅关闭；Canary/Burn-in 门禁使用。 */
  readonly maxTicks?: number;
  /** 精确提交 N 个 live Tick，并在最后一次提交后额外观察结算 Turn。 */
  readonly maxLiveTicks?: number;
  readonly outcomeDrainTurns?: number;
  /** live 启动时先观察 N 个 Turn，不提交；CLI 生产缺省为 1。 */
  readonly startupSyncTurns?: number;
  /** S8b：默认关闭；仅旁路记录 accepted full-plan + 相邻 raw states。 */
  readonly recordCalibration?: boolean;
  /** 测试注入；生产由 recordCalibration 创建。 */
  readonly calibrationRecorder?: RuntimeGoldenRecorder;
}

export interface TenantRunResult {
  readonly processRunId: string;
  readonly tenantId: string;
  readonly decisionMode: DecisionModeName;
  readonly submissionMode: SubmissionModeName;
  /** 兼容旧字段：最后处理的游戏 Tick 编号，不是数量。 */
  readonly tickCount: number;
  /** 本次进程实际处理的 Turn 数。 */
  readonly processedTickCount: number;
  readonly liveSubmitCount: number;
  readonly lastTick: number | null;
  readonly manifestPath: string;
  readonly telemetryPaths: { readonly runtime: string; readonly decision: string; readonly outcome: string };
  readonly calibration?: RuntimeGoldenRecorderResult;
}

/** 主入口：加载配置 → 拿锁 → manifest → 组装 → 循环 → 优雅关闭。 */
export async function runTenant(
  configPath: string,
  repoRoot: string,
  options: TenantRunOptions = {},
): Promise<TenantRunResult> {
  if (options.maxTicks !== undefined && (!Number.isInteger(options.maxTicks) || options.maxTicks < 1)) {
    throw new Error(`maxTicks 必须是正整数，实际=${String(options.maxTicks)}`);
  }
  if (options.maxLiveTicks !== undefined && (!Number.isInteger(options.maxLiveTicks) || options.maxLiveTicks < 1)) {
    throw new Error(`maxLiveTicks 必须是正整数，实际=${String(options.maxLiveTicks)}`);
  }
  if (options.maxTicks !== undefined && options.maxLiveTicks !== undefined) {
    throw new Error("maxTicks 与 maxLiveTicks 不能同时设置");
  }
  if (
    options.outcomeDrainTurns !== undefined &&
    (!Number.isInteger(options.outcomeDrainTurns) || options.outcomeDrainTurns < 1)
  ) {
    throw new Error(`outcomeDrainTurns 必须是正整数，实际=${String(options.outcomeDrainTurns)}`);
  }
  if (
    options.startupSyncTurns !== undefined &&
    (!Number.isInteger(options.startupSyncTurns) || options.startupSyncTurns < 0)
  ) {
    throw new Error(`startupSyncTurns 必须是非负整数，实际=${String(options.startupSyncTurns)}`);
  }
  const config = loadRuntimeConfig(configPath);
  const decisionMode = options.decisionMode ?? config.decisionMode;
  const submissionMode = submissionModeOf(options, config);
  if (options.recordCalibration === true && submissionMode !== "live") {
    throw new Error("recordCalibration 只能在 live 提交模式启用");
  }
  const deadlines = resolveDeadlines(config);

  const processRunId = newProcessRunId();
  // baseDir 相对 repoRoot 解析（绝对路径原样）——产物落点与 doctor/CLI 一致
  const baseDir = isAbsolute(config.baseDir ?? "runtime")
    ? (config.baseDir ?? "runtime")
    : join(repoRoot, config.baseDir ?? "runtime");
  const dirs = tenantDirs(baseDir, config.tenantId);

  // 1) 单写者锁（红线：同一租户一个提交者；拿不到直接失败）
  const lock = new SingleWriterLock(dirs.lockDir, config.tenantId, processRunId);
  await lock.acquire();

  let released = false;
  const releaseLock = async (): Promise<void> => {
    if (!released) {
      released = true;
      await lock.release();
    }
  };

  try {
    // 2) run manifest（绝不含密钥；config 只含 env 名，不含 env 值）
    const configHash = `sha256:${sha256Canonical(config)}`;
    const manifest: RunManifest = {
      processRunId,
      gitSha: readGitSha(repoRoot),
      piVersion: PI_VERSION,
      sdkVersion: "0.1.0",
      tenantId: config.tenantId,
      decisionMode,
      submitEnabled: submissionMode === "live",
      modelId: config.model.id,
      provider: config.model.provider,
      rulesVersion: RULES_VERSION,
      configHash,
      startedAt: new Date().toISOString(),
    };
    const manifestPath = writeRunManifest(join(dirs.runDir, processRunId), manifest);

    // 3) telemetry 三流（append-only + 脱敏 + 校验）
    mkdirSync(dirs.telemetryDir, { recursive: true });
    const runtimeWriter = new JsonlWriter(join(dirs.telemetryDir, "runtime.jsonl"));
    const decisionWriter = new JsonlWriter(join(dirs.telemetryDir, "decision.jsonl"));
    const outcomeWriter = new JsonlWriter(join(dirs.telemetryDir, "outcome.jsonl"));

    // S8b recorder 默认关闭。初始化失败也只写独立告警，绝不阻断 live loop。
    const recorderWarningPath = join(dirs.telemetryDir, "calibration-recorder.jsonl");
    const recorderWarning = (message: string): void => {
      try {
        appendFileSync(
          recorderWarningPath,
          `${JSON.stringify(sanitizeValue({ at: new Date().toISOString(), type: "runtime_golden_recorder", message }))}
`,
          "utf8",
        );
      } catch {}
    };
    let calibrationRecorder = options.calibrationRecorder ?? null;
    if (calibrationRecorder === null && options.recordCalibration === true) {
      try {
        calibrationRecorder = new RuntimeGoldenRecorder({
          outputDir: join(dirs.calibrationDir, processRunId),
          processRunId,
          tenantId: config.tenantId,
          rulesVersion: RULES_VERSION,
          sourceCommit: manifest.gitSha,
          configHash,
          onWarning: recorderWarning,
        });
      } catch (error) {
        recorderWarning(`init: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 4) 游戏客户端（密钥只在此处从 env 读取）
    const client =
      options.client ??
      new ArenaHeroClient({ apiKey: readEnvToken(config.arenaTokenEnv) });

    // 运行停止控制：signal 与 maxTicks 共用同一幂等路径。
    let stopping = false;
    let resolveStopped: () => void = () => {};
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const requestStop = (): void => {
      if (!stopping) {
        stopping = true;
        client.close?.();
        resolveStopped();
      }
    };
    const onSignal = options.onSignal ?? ((cb) => {
      process.once("SIGINT", cb);
      process.once("SIGTERM", cb);
    });
    onSignal(requestStop);

    // 5) Agent runtime：safety/deterministic 模式用 no-op 占位（coordinator 短路不调用，
    //    Pi 认证不阻断 Canary）；其他模式真实 Pi 或测试注入 fake；rotationGeneration 经 onTelemetry 透传；
    //    Pi 事件流落盘 pi.jsonl（agent-shadow 门槛评估：prompt 错误率/rotation 率的观测源）
    let runtimeGeneration = 0;
    // Pi 事件流（pi.jsonl）：agent-shadow 门槛评估的观测源（prompt 错误率/rotation 率）。
    // 不走 JsonlWriter（TraceRecord schema 不承载 Pi 事件）——独立 append + 脱敏，IO 失败不阻塞。
    const piEventsPath = join(dirs.telemetryDir, "pi.jsonl");
    const onRuntimeTelemetry = (event: PiRuntimeTelemetry): void => {
      if (event.generation !== undefined) {
        runtimeGeneration = event.generation;
      }
      try {
        appendFileSync(
          piEventsPath,
          `${JSON.stringify(sanitizeValue({ at: new Date().toISOString(), type: event.type, reason: event.reason ?? event.message ?? "" }))}\n`,
          "utf-8",
        );
      } catch {
        // IO 失败不阻塞决策路径
      }
    };
    const noAgent = decisionMode === "safety" || decisionMode === "deterministic";
    const runtime =
      noAgent && options.runtime === undefined
        ? new NoopAgentRuntime()
        : (options.runtime ?? (await createPiRuntime(config, dirs.piBaseDir, onRuntimeTelemetry)));

    // 6) coordinator（P0-1：decisionMode 传递；deterministic = planner 注入 DeterministicPlanner，
    //    coordinator 短路语义同 safety——不启动 Agent）
    const coordinator = new DecisionCoordinator({
      runtime,
      planner: decisionMode === "deterministic" ? new DeterministicPlanner() : new SafetyPlanner(DEFAULT_SAFETY_CONFIG),
      registry: new LeaseRegistry(),
      clock: { now: () => performance.now() },
      budgetConfig: deadlines,
      tenantId: config.tenantId,
      rulesVersion: RULES_VERSION,
      configHash: manifest.configHash,
      processRunId,
      decisionMode,
      onRunSettled: (info) => {
        // runtime trace 的 settle 补充事件（不阻塞决策路径）
        void info;
      },
    });

    // 7) outcome trace 的资源对比基准（t-1 → t）；holder 包装防 CFA 闭包窄化
    const holder: {
      prev: {
        tick: number;
        resources: number;
        plan: TickOutcome["plan"];
        coreId: string | null;
      } | null;
    } = { prev: null };
    let processedTickCount = 0;
    let liveSubmitCount = 0;

    const onTick = (outcome: TickOutcome): void => {
      const decision = outcome.decision;
      if (decision !== undefined) {
        const intentCounts = Object.values(outcome.plan.intents).reduce<Record<string, number>>((counts, intent) => {
          counts[intent] = (counts[intent] ?? 0) + 1;
          return counts;
        }, {});
        // runtime trace + decision trace（三流以 runId 关联；直接构造 record——
        // 工厂默认值（unknown）是危险默认，生产路径显式传全字段，validate 由 JsonlWriter 执行）
        const runtimeRecord: RuntimeTraceRecord = {
          processRunId,
          tenantId: config.tenantId,
          runId: decision.runId,
          tick: outcome.tick,
          deadlineOutcome: decision.deadlineOutcome,
          agentLatencyMs: decision.agentLatencyMs,
          selectionLatencyMs: decision.selectionLatencyMs,
          abortRequested: decision.abortRequested,
          rotationGeneration: runtimeGeneration,
          submitResult: outcome.submitAttempted
            ? outcome.accepted
              ? "accepted"
              : "rejected"
            : "not_submitted",
          submitError: outcome.error,
          notSubmittedReason: outcome.notSubmittedReason,
          leaseRejectionCode: outcome.leaseCode,
        };
        runtimeWriter.write(runtimeRecord);
        const decisionRecord: DecisionTraceRecord = {
          processRunId,
          tenantId: config.tenantId,
          runId: decision.runId,
          tick: outcome.tick,
          decisionSource: outcome.source,
          agentActionCount: decision.agentActionCount,
          safetyReplacementCount: decision.safetyReplacementCount,
          invalidAgentActionCount: decision.invalidAgentActionCount,
          repairCount: decision.repairCount,
          moveCount: Object.values(outcome.plan.unitActions).filter((action) => action.type === "MOVE").length,
          harvestCount: Object.values(outcome.plan.unitActions).filter((action) => action.type === "HARVEST").length,
          depositCount: Object.values(outcome.plan.unitActions).filter((action) => action.type === "DEPOSIT").length,
          waitCount: Object.values(outcome.plan.unitActions).filter((action) => action.type === "WAIT").length,
          intentCounts,
          planHash: planHashOf(outcome.plan),
        };
        decisionWriter.write(decisionRecord);
      }
      // outcome trace：t-1 决策时资源 → t 决策时资源（提交执行后的净变化）
      if (holder.prev !== null) {
        const corePosition = outcome.state.core?.position;
        const workerDistances = corePosition === undefined
          ? []
          : outcome.state.workers.map((worker) => manhattan(worker.position, corePosition));
        const failedEvents = outcome.state.events
          .filter((event) => event.eventType.endsWith("_FAILED") || event.reasonCode !== null)
          .map((event) => {
            const actorId = event.actorId;
            const priorAction =
              actorId === null
                ? undefined
                : actorId === holder.prev?.coreId
                  ? holder.prev.plan.coreAction
                  : holder.prev?.plan.unitActions[actorId];
            const priorIntent =
              actorId === null
                ? undefined
                : actorId === holder.prev?.coreId
                  ? holder.prev.plan.intents.core
                  : holder.prev?.plan.intents[actorId];
            return {
              eventType: event.eventType,
              reasonCode: event.reasonCode,
              actorId,
              targetId: event.targetId,
              position: event.position,
              priorAction: priorAction === undefined || priorAction === null ? undefined : JSON.stringify(priorAction),
              priorIntent,
            };
          });
        const outcomeRecord: OutcomeTraceRecord = {
          processRunId,
          tenantId: config.tenantId,
          tick: outcome.tick,
          coreResourcesBefore: holder.prev.resources,
          coreResourcesAfter: outcome.state.resources,
          coreResourceDelta: outcome.state.resources - holder.prev.resources,
          visibleResourceCellCount: outcome.state.resourceCells.size,
          workerCount: outcome.state.workers.length,
          workersWithCargo: outcome.state.workers.filter((worker) => worker.cargo > 0).length,
          workerCargoTotal: outcome.state.workers.reduce((total, worker) => total + worker.cargo, 0),
          uniqueWorkerCellCount: new Set(outcome.state.workers.map((worker) => `${worker.position[0]},${worker.position[1]}`)).size,
          workerMaxDistanceFromCore: workerDistances.length === 0 ? undefined : Math.max(...workerDistances),
          workerMeanDistanceFromCore: workerDistances.length === 0
            ? undefined
            : workerDistances.reduce((total, distance) => total + distance, 0) / workerDistances.length,
          failedEvents,
          events: outcome.state.events.map((e) => e.eventType),
        };
        outcomeWriter.write(outcomeRecord);
      }
      holder.prev = {
        tick: outcome.tick,
        resources: outcome.state.resources,
        plan: outcome.plan,
        coreId: outcome.state.core?.id ?? null,
      };
      processedTickCount += 1;
      if (outcome.submitAttempted) liveSubmitCount += 1;
      calibrationRecorder?.observe(outcome);
      if (options.maxTicks !== undefined && processedTickCount >= options.maxTicks) {
        requestStop();
      }
    };

    // 8) 主循环（signal/maxTicks → 终止 turns → 当前 Tick 提交完成后自然停止）
    const loopPromise = runTenantLoop({
      client,
      coordinator,
      submissionMode,
      decisionMode,
      startupSyncTurns: options.startupSyncTurns,
      maxLiveSubmissions: options.maxLiveTicks,
      outcomeDrainTurns: options.outcomeDrainTurns,
      onTick,
    });
    await Promise.race([loopPromise, stopped]);
    // requestStop 可能先于 async generator 完成；必须等待 loop 真正退出，避免 close writer 后迟到写入。
    if (stopping) {
      await loopPromise;
    }

    // loop 也可能因 maxLiveTicks + outcome drain 自然结束；与 signal/maxTicks 路径统一，
    // 在关闭 writer/runtime 前显式关闭客户端。close 必须幂等（真实 SDK 与 fake 均如此）。
    client.close?.();

    // 9) 优雅关闭：先等待旁路 recorder 队列，再 flush telemetry/runtime/lock。
    // recorder 内部 fail-open；这里不会改变已完成的提交结果。
    const calibration = calibrationRecorder === null ? undefined : await calibrationRecorder.close();
    runtimeWriter.close();
    decisionWriter.close();
    outcomeWriter.close();
    await runtime.close().catch(() => {});
    await releaseLock();

    return {
      processRunId,
      tenantId: config.tenantId,
      decisionMode,
      submissionMode,
      tickCount: holder.prev?.tick ?? 0,
      processedTickCount,
      liveSubmitCount,
      lastTick: holder.prev?.tick ?? null,
      manifestPath,
      telemetryPaths: {
        runtime: join(dirs.telemetryDir, "runtime.jsonl"),
        decision: join(dirs.telemetryDir, "decision.jsonl"),
        outcome: join(dirs.telemetryDir, "outcome.jsonl"),
      },
      ...(calibration === undefined ? {} : { calibration }),
    };
  } catch (error) {
    await releaseLock();
    throw error;
  }
}

/** 提交模式解析（options 覆盖 config.submitEnabled）。 */
function submissionModeOf(options: TenantRunOptions, config: TenantRuntimeConfig): SubmissionModeName {
  return options.submissionMode ?? (config.submitEnabled ? "live" : "disabled");
}

/** 读取 token env（密钥不落盘；缺失抛错——Canary 前 doctor 会先报）。 */
function readEnvToken(envName: string): string {
  const token = process.env[envName];
  if (token === undefined || token.length === 0) {
    throw new Error(`env ${envName} 缺失：请先设置密钥（绝不写入配置/仓库）`);
  }
  return token;
}

/** 真实 Pi runtime（session 创建失败 → 抛错 → 锁已释放，不降级运行）。 */
async function createPiRuntime(
  config: TenantRuntimeConfig,
  piBaseDir: string,
  onTelemetry: (event: PiRuntimeTelemetry) => void,
): Promise<PiAgentRuntime> {
  return PiAgentRuntime.create({
    session: {
      baseDir: piBaseDir,
      model: resolvePiModel(config),
      thinkingLevel: config.model.thinkingLevel,
      configHash: `sha256:cfg:${config.tenantId}`,
    },
    tenantId: config.tenantId,
    promptBuilder: buildDecisionPrompt,
    mapSnapshotBuilder: (state) => mapSnapshotOf(state),
    // 预热：LLM 冷启动 12s+ 会让首 tick 超时 → abort 残留恶性循环；预热后 2-4s 稳定。
    // 实测依据：无 abort 连续调用 2.3-3.4s（latency2 诊断），冷启动首调用 12-19s
    //（完整真实 prompt 冷启动实测 22.8s——deadline 已放大到 24s 兜底，预热失败 fail-open）。
    // warmup 文本明确禁止工具调用（slot 未激活，工具执行会抛错；#4 要求不污染 ToolContext）。
    warmupPrompt: "预热：请用一句话确认你已就绪。禁止调用任何工具，只回答「就绪」。",
    warmupTimeoutMs: 30000,
    onTelemetry,
  });
}

/** 供 CLI/测试用：读取 config 的决策模式（不抛）。 */
export function readDecisionMode(config: TenantRuntimeConfig): DecisionModeName {
  return config.decisionMode;
}
