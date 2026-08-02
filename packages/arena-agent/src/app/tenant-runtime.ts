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
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { loadRuntimeConfig, resolveDeadlines, type TenantRuntimeConfig } from "./runtime-config.ts";
import { SingleWriterLock } from "./single-writer-lock.ts";
import { newProcessRunId, readGitSha, writeRunManifest, type RunManifest } from "./run-manifest.ts";
import { DecisionCoordinator } from "../runtime/decision-coordinator.ts";
import { LeaseRegistry } from "../runtime/lease-registry.ts";
import { runTenantLoop, type TickOutcome } from "../runtime/loop.ts";
import { SafetyPlanner, DEFAULT_SAFETY_CONFIG } from "../strategies/safety-planner.ts";
import { PiAgentRuntime, type PiRuntimeTelemetry } from "../infrastructure/pi/pi-agent-runtime.ts";
import { buildDecisionPrompt } from "../infrastructure/pi/prompt-builder.ts";
import { mapSnapshotOf } from "../infrastructure/pi/map-snapshot.ts";
import type { PiModel } from "../infrastructure/pi/pi-types.ts";
import type { AgentDecisionRuntime, DecisionModeName, DecisionResult, SubmissionModeName } from "../runtime/decision-types.ts";
import { JsonlWriter } from "../telemetry/jsonl-writer.ts";
import { decisionTrace, outcomeTrace, planHashOf, runtimeTrace } from "../telemetry/decision-trace.ts";

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
}

export interface TenantRunResult {
  readonly processRunId: string;
  readonly tenantId: string;
  readonly decisionMode: DecisionModeName;
  readonly submissionMode: SubmissionModeName;
  readonly tickCount: number;
  readonly manifestPath: string;
  readonly telemetryPaths: { readonly runtime: string; readonly decision: string; readonly outcome: string };
}

/** 主入口：加载配置 → 拿锁 → manifest → 组装 → 循环 → 优雅关闭。 */
export async function runTenant(
  configPath: string,
  repoRoot: string,
  options: TenantRunOptions = {},
): Promise<TenantRunResult> {
  const config = loadRuntimeConfig(configPath);
  const decisionMode = options.decisionMode ?? config.decisionMode;
  if (decisionMode === "deterministic") {
    // leader 契约：deterministic 是 D 验收（fixture/离线）后的里程碑，拆分前禁止"半个实现"上真机
    throw new Error("decisionMode=deterministic 未启用：WorkerTaskPlanner 集成在 ResourcePlanner 验收后（leader 契约）");
  }
  const submissionMode = options.submissionMode ?? (config.submitEnabled ? "live" : "disabled");
  const deadlines = resolveDeadlines(config);

  const processRunId = newProcessRunId();
  const dirs = tenantDirs(config.baseDir ?? "runtime", config.tenantId);

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
    // 2) run manifest（绝不含密钥）
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
      configHash: "sha256:cfg", // doctor 校验过 model.id 非空；configHash 由部署方注入
      startedAt: new Date().toISOString(),
    };
    const manifestPath = writeRunManifest(join(dirs.runDir, processRunId), manifest);

    // 3) telemetry 三流（append-only + 脱敏 + 校验）
    mkdirSync(dirs.telemetryDir, { recursive: true });
    const runtimeWriter = new JsonlWriter(join(dirs.telemetryDir, "runtime.jsonl"));
    const decisionWriter = new JsonlWriter(join(dirs.telemetryDir, "decision.jsonl"));
    const outcomeWriter = new JsonlWriter(join(dirs.telemetryDir, "outcome.jsonl"));

    // 4) 游戏客户端（密钥只在此处从 env 读取）
    const client =
      options.client ??
      new ArenaHeroClient({ apiKey: readEnvToken(config.arenaTokenEnv) });

    // 5) Agent runtime：safety 模式用 no-op 占位（coordinator 短路不调用，Pi 认证不阻断 Canary）；
    //    其他模式真实 Pi 或测试注入 fake；rotationGeneration 经 onTelemetry 透传
    let runtimeGeneration = 0;
    const onRuntimeTelemetry = (event: PiRuntimeTelemetry): void => {
      if (event.generation !== undefined) {
        runtimeGeneration = event.generation;
      }
    };
    const runtime =
      decisionMode === "safety" && options.runtime === undefined
        ? new NoopAgentRuntime()
        : (options.runtime ?? (await createPiRuntime(config, dirs.piBaseDir, onRuntimeTelemetry)));

    // 6) coordinator（P0-1：decisionMode 传递；deterministic 由 planner 注入，见入口守卫）
    const coordinator = new DecisionCoordinator({
      runtime,
      planner: new SafetyPlanner(DEFAULT_SAFETY_CONFIG),
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
    const holder: { prev: { tick: number; resources: number } | null } = { prev: null };

    const onTick = (outcome: TickOutcome): void => {
      const decision = outcome.decision;
      if (decision !== undefined) {
        // runtime trace + decision trace（三流以 runId 关联）
        runtimeWriter.write(
          runtimeTrace({
            runId: decision.runId,
            tick: outcome.tick,
            deadlineOutcome: decision.deadlineOutcome,
            agentLatencyMs: decision.agentLatencyMs,
            selectionLatencyMs: decision.selectionLatencyMs,
            abortRequested: decision.abortRequested,
            rotationGeneration: runtimeGeneration,
            submitResult: outcome.accepted ? "accepted" : submissionMode === "live" ? "rejected" : "not_submitted",
            leaseRejectionCode: outcome.leaseCode,
          }),
        );
        decisionWriter.write(
          decisionTrace({
            runId: decision.runId,
            tick: outcome.tick,
            decisionSource: outcome.source,
            agentActionCount: decision.agentActionCount,
            safetyReplacementCount: decision.safetyReplacementCount,
            invalidAgentActionCount: decision.invalidAgentActionCount,
            repairCount: decision.repairCount,
            planHash: planHashOf(outcome.plan),
          }),
        );
      }
      // outcome trace：t-1 决策时资源 → t 决策时资源（提交执行后的净变化）
      if (holder.prev !== null) {
        outcomeWriter.write(
          outcomeTrace({
            tick: outcome.tick,
            coreResourcesBefore: holder.prev.resources,
            coreResourcesAfter: outcome.state.resources,
            coreResourceDelta: outcome.state.resources - holder.prev.resources,
            events: outcome.state.events.map((e) => e.eventType),
          }),
        );
      }
      holder.prev = { tick: outcome.tick, resources: outcome.state.resources };
    };

    // 8) 主循环（signal 到达 → 终止 turns → 提交路径随 Turn 关闭自然停止）
    let stopping = false;
    let resolveStopped: () => void = () => {};
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const onSignal = options.onSignal ?? ((cb) => {
      process.once("SIGINT", cb);
      process.once("SIGTERM", cb);
    });
    onSignal(() => {
      if (!stopping) {
        stopping = true;
        client.close?.(); // 停止接收新 Turn（同步关闭 socket，turns() 随之终止）
        resolveStopped();
      }
    });

    const loopPromise = runTenantLoop({
      client,
      coordinator,
      submissionMode,
      decisionMode,
      onTick,
    });
    await Promise.race([loopPromise, stopped]);

    // 9) 优雅关闭：flush telemetry → 关闭 runtime → 释放锁
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
      manifestPath,
      telemetryPaths: {
        runtime: join(dirs.telemetryDir, "runtime.jsonl"),
        decision: join(dirs.telemetryDir, "decision.jsonl"),
        outcome: join(dirs.telemetryDir, "outcome.jsonl"),
      },
    };
  } catch (error) {
    await releaseLock();
    throw error;
  }
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
    onTelemetry,
  });
}

/** 供 CLI/测试用：读取 config 的决策模式（不抛）。 */
export function readDecisionMode(config: TenantRuntimeConfig): DecisionModeName {
  return config.decisionMode;
}
