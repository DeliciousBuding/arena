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

import { loadRuntimeConfig, resolveCircuitBreaker, resolveDeadlines, type TenantRuntimeConfig } from "./runtime-config.ts";
import { loadPersistentEnemyIntel } from "./enemy-intel.ts";
import { loadThreatProfiles } from "./official-intel.ts";
import { resolveArenaDataRoot, resolveTenantBaseDir } from "./data-root.ts";
import { SingleWriterLock } from "./single-writer-lock.ts";
import { newProcessRunId, readGitSha, writeRunManifest, type RunManifest } from "./run-manifest.ts";
import { DecisionCoordinator } from "../runtime/decision-coordinator.ts";
import { LeaseRegistry } from "../runtime/lease-registry.ts";
import { runTenantLoop, type TickOutcome } from "../runtime/loop.ts";
import { AGGRESSIVE_SAFETY_CONFIG, DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../strategies/safety-planner.ts";
import { resolveDeterministicVariantsConfig, resolveVariantsConfig } from "../strategies/variant-registry.ts";
import { DeterministicPlanner } from "../planning/deterministic-planner.ts";
import { WorkerTaskPlanner } from "../planning/worker-task-planner.ts";
import { PiAgentRuntime, type PiRuntimeTelemetry } from "../infrastructure/pi/pi-agent-runtime.ts";
import { PiSessionFactory } from "../infrastructure/pi/pi-session-factory.ts";
import { buildDecisionPrompt } from "../infrastructure/pi/prompt-builder.ts";
import { buildMacroPolicyPrompt, readLastAssistantText } from "../infrastructure/pi/policy-prompt.ts";
import { MacroPolicyOrchestrator } from "../runtime/macro-policy-orchestrator.ts";
import { serializeMacroPolicy } from "../runtime/macro-policy.ts";
import { StallDetector, type StallEvent } from "../runtime/stall-detector.ts";
import { StallRecovery } from "../runtime/stall-recovery.ts";
import { PolicyDiscipline } from "../runtime/policy-discipline.ts";
import { mapSnapshotOf } from "../infrastructure/pi/map-snapshot.ts";
import type { PiModel } from "../infrastructure/pi/pi-types.ts";
import { manhattan } from "../domain/nav.ts";
import { assessThreat, coreDamagedThisTick } from "../domain/threat.ts";
import type { TickState } from "../domain/model.ts";
import type { AgentDecisionRuntime, DecisionModeName, DecisionResult, SubmissionModeName } from "../runtime/decision-types.ts";
import {
  appendJsonlLine,
  JsonlWriter,
  sanitizeValue,
} from "../telemetry/jsonl-writer.ts";
import { planHashOf } from "../telemetry/decision-trace.ts";
import type { DecisionTraceRecord, OutcomeTraceRecord, RuntimeTraceRecord } from "../telemetry/decision-trace.ts";
import { sha256Canonical } from "../domain/integrity.ts";
import {
  RuntimeGoldenRecorder,
  type RuntimeGoldenRecorderResult,
} from "../runtime-golden/recorder.ts";

export const RULES_VERSION = "v0.14";

/** 经济停滞告警阈值：连续 N 个 tick 满载 Worker 无法回仓（delta=0 + cargoTot>0）即告警。
 *  生产实测 t1 capacity_wait:DEPOSIT 死锁 60+ ticks 才被人工发现，16 ticks（≈2 个
 *  MacroPolicy 周期）是"足够确认异常、又不会频繁误报"的折中。 */
export const STALL_WARNING_TICKS = 16;

/** 威胁评估诊断字段（v0.3-lite，2026-08-06）：从 outcome state 计算 tick 级威胁
 *  （可见敌/受击基础版；enemyHints 记忆增强——moving/pursuit——待 planner 侧
 *  暴露 world 后补全）。写入 decision.jsonl 供 replay/威胁分析。 */
function threatDiagnosticsOf(state: TickState): Pick<
  DecisionTraceRecord,
  "threatLevel" | "threatReason" | "threatClosingEnemies" | "threatMovingEnemies" | "threatAxes"
> {
  const assessment = assessThreat({
    core: state.core?.position ?? null,
    visibleEnemies: state.visibleEnemies,
    enemyHints: [],
    coreDamagedThisTick: coreDamagedThisTick(state.events),
    obstacles: state.obstacleCells,
    resourceCells: state.resourceCells,
  });
  return {
    threatLevel: assessment.level,
    threatReason: assessment.reason,
    threatClosingEnemies: assessment.closingEnemies,
    threatMovingEnemies: assessment.movingEnemies,
    threatAxes: assessment.axes,
  };
}

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

/** config.model → pi Model 结构（api = OpenAI 兼容协议；baseUrl 从 env 显式声明）。
 *  compat.supportsDeveloperRole=false 强制 system role（v0.2.15 生产修复）：
 *  Pi 0.83 在 thinkingLevel≠off 时把 system prompt 发成 OpenAI 的 developer role，
 *  DeepSeek/SenseNova 网关均拒绝（400 messages[0].role）——所有 OpenAI 兼容网关
 *  都接受 system，显式关掉 developer 是安全默认。 */
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
    compat: { supportsDeveloperRole: false },
  } as unknown as PiModel;
}

export interface TenantRunOptions {
  /** Shared data root used for relative config.baseDir values. */
  readonly dataRoot?: string;
  /** 覆盖 config.submitEnabled（CLI --live/--shadow）。 */
  readonly submissionMode?: SubmissionModeName;
  /** 覆盖 config.decisionMode（CLI --mode）。 */
  readonly decisionMode?: DecisionModeName;
  /** 游戏客户端（测试注入 fake；缺省真实 ArenaHeroClient）。 */
  readonly client?: ArenaHeroClient;
  /** Agent runtime（测试注入 fake；缺省真实 PiAgentRuntime）。 */
  readonly runtime?: AgentDecisionRuntime;
  /** 自定义信号回调注册（测试注入；缺省 process.on SIGINT/SIGTERM）。 */
  readonly onSignal?: (callback: () => void) => void | (() => void);
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
  const dataRoot = options.dataRoot ?? resolveArenaDataRoot(repoRoot);
  const baseDir = resolveTenantBaseDir(dataRoot, config.baseDir);
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

  type CleanupTask = () => void | Promise<void>;
  const cleanupStack: CleanupTask[] = [releaseLock];
  let cleanupStarted = false;
  let calibration: RuntimeGoldenRecorderResult | undefined;
  const cleanupAll = async (): Promise<void> => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    for (let index = cleanupStack.length - 1; index >= 0; index -= 1) {
      try {
        await cleanupStack[index]();
      } catch {
        // One failed close must never prevent later resources or the writer lock from closing.
      }
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
    cleanupStack.push(() => runtimeWriter.close());
    const decisionWriter = new JsonlWriter(join(dirs.telemetryDir, "decision.jsonl"));
    cleanupStack.push(() => decisionWriter.close());
    const outcomeWriter = new JsonlWriter(join(dirs.telemetryDir, "outcome.jsonl"));
    cleanupStack.push(() => outcomeWriter.close());

    // S8b recorder 默认关闭。初始化失败也只写独立告警，绝不阻断 live loop。
    const recorderWarningPath = join(dirs.telemetryDir, "calibration-recorder.jsonl");
    const recorderWarning = (message: string): void => {
      try {
        appendJsonlLine(
          recorderWarningPath,
          JSON.stringify(sanitizeValue({ at: new Date().toISOString(), type: "runtime_golden_recorder", message })),
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
    if (calibrationRecorder !== null) {
      cleanupStack.push(async () => {
        calibration = await calibrationRecorder!.close();
      });
    }

    // 4) 游戏客户端（密钥只在此处从 env 读取）
    const client =
      options.client ??
      new ArenaHeroClient({ apiKey: readEnvToken(config.arenaTokenEnv) });
    cleanupStack.push(() => client.close?.());

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
      return () => {
        process.off("SIGINT", cb);
        process.off("SIGTERM", cb);
      };
    });
    const disposeSignal = onSignal(requestStop);
    if (disposeSignal !== undefined) cleanupStack.push(disposeSignal);

    // 5) Agent runtime：safety/deterministic 模式用 no-op 占位（coordinator 短路不调用，
    //    Pi 认证不阻断 Canary）；其他模式真实 Pi 或测试注入 fake；rotationGeneration 经 onTelemetry 透传；
    //    Pi 事件流落盘 pi.jsonl（agent-shadow 门槛评估：prompt 错误率/rotation 率的观测源）
    let runtimeGeneration = 0;
    // Pi 事件流（pi.jsonl）：agent-shadow 门槛评估的观测源（prompt 错误率/rotation 率）。
    // 不走 JsonlWriter（TraceRecord schema 不承载 Pi 事件）——独立 append + 脱敏，IO 失败不阻塞。
    const piEventsPath = join(dirs.telemetryDir, "pi.jsonl");
    const onRuntimeTelemetry = (event: PiRuntimeTelemetry): void => {
      if (event.generation !== undefined) runtimeGeneration = event.generation;
      appendPiTelemetryEvent(piEventsPath, event);
    };
    const noAgent = decisionMode === "safety" || decisionMode === "deterministic";
    const runtime =
      noAgent && options.runtime === undefined
        ? new NoopAgentRuntime()
        : (options.runtime ?? (await createPiRuntime(config, dirs.piBaseDir, onRuntimeTelemetry)));
    cleanupStack.push(() => runtime.close());

    // 5b) 低频 MacroPolicy 策略层（独立 Pi session，异步产出不占 tick 窗口）：
    //     所有决策模式启用（deterministic 执行 + LLM 战略 = MASTER.md 设计）；
    //     失败/超时 → sticky 默认策略，不阻断执行层。
    let policyOrchestrator: MacroPolicyOrchestrator | null = null;
    // 经济趋势缓冲（最近 32 ticks 的 coreResourceDelta；策略 prompt 输入）
    const recentResourceDeltas: number[] = [];
    // 死循环检测与自动跳出（2026-08-05 生产事故后新增）：StallDetector 多模式
    // 发现（含"全巡逻/远征/0 产出"等盲区模式），StallRecovery 在发现后覆盖
    // policy.focusRegion=null 让执行层回仓自愈；恢复验证 + 连续失败升级 all-in
    // 军事拆敌 CORE。PolicyDiscipline 是上游纪律：policy 层连续输出超距焦点时
    // 禁言（focusRegion 强制 null），防反复产出坏决策。recentStallEvents 供
    // policy 层感知（低频策略 prompt 摘要）；commandState 告知策略层当前指挥状态。
    const stallDetector = new StallDetector();
    const stallRecovery = new StallRecovery();
    const policyDiscipline = new PolicyDiscipline();
    // 恢复结果反馈（agent 智能跳出闭环）：上次自愈结束的结局（成功/失败/到期），
    // 注入策略 prompt 让 LLM 基于结果调整战略（见 policy-prompt 渲染）。
    let lastRecoveryOutcome: { readonly outcome: "recovered" | "failed" | "expired"; readonly kind: string | null; readonly tick: number } | null = null;
    const recentStallEvents: string[] = [];
    const appendStallEvent = (event: StallEvent): void => {
      recentStallEvents.push(`kind=${event.kind}@tick=${event.tick}(streak=${event.streak})`);
      if (recentStallEvents.length > 4) recentStallEvents.shift();
    };
    // policy 流落盘（策略层事件 + discipline 事件共用；函数级作用域）
    const policyPath = join(dirs.telemetryDir, "policy.jsonl");
    const appendPolicyTelemetry = (record: Record<string, unknown>): void => {
      try {
        appendJsonlLine(
          policyPath,
          JSON.stringify(sanitizeValue({
            at: new Date().toISOString(),
            tenantId: config.tenantId,
            ...record,
          })),
        );
      } catch {}
    };
    if (options.runtime === undefined) {
      try {
        const policyFactory = new PiSessionFactory({
          baseDir: dirs.piBaseDir,
          model: resolvePiModel(config),
          thinkingLevel: config.model.thinkingLevel,
          configHash: `sha256:cfg:${config.tenantId}`,
          // 策略层不调用工具：空 customTools（factory 接受空数组 = 零 custom tool）。
          customTools: [],
        });
        const policySession = await policyFactory.createSession(config.tenantId);
        cleanupStack.push(() => policySession.close());
        policyOrchestrator = new MacroPolicyOrchestrator({
          intervalTicks: config.policyIntervalTicks ?? 32,
          promptBuilder: (state) => buildMacroPolicyPrompt(state, {
            recentResourceDeltas,
            // 最近 stall 告警摘要：策略层感知死循环并主动调整（见 prompt 应对指引）
            recentStallEvents,
            // 决策指挥状态：执行层临时接管（stall_recovery/escalation）时策略层
            // 必须配合（focusRegion=null / 维持 aggressive）
            commandState: stallRecovery.stateOf(),
            // 恢复结果反馈：上次自愈结局（recovered/failed/expired）——策略层
            // 据此判断是否需要改变战略（连续失败 → 维持军事姿态等）
            lastRecoveryOutcome,
            // 策略历史基线（低频演进，防 workerTarget 16→3 跳变）；
            // promptBuilder 在 orchestrator 创建前不触发（首次决策 previous=null）
            previousPolicy: policyOrchestrator === null ? null : serializeMacroPolicy(policyOrchestrator.current),
          }),
          requestPolicy: async (prompt) => {
            await policySession.session.prompt(prompt);
            return readLastAssistantText(policySession.session);
          },
          onPolicyUpdate: (policy, tick) => {
            appendPolicyTelemetry({ type: "policy_update", tick, policy: serializeMacroPolicy(policy) });
          },
          onPolicyError: (message, tick) => {
            appendPolicyTelemetry({ type: "policy_error", tick, message });
          },
          timeoutMs: 60000,
          // 实验框架：config.policyOverride 非空时绕过 LLM 恒用固定策略
          override: config.policyOverride ?? null,
        });
        if (config.policyOverride !== undefined) {
          appendPolicyTelemetry({
            type: "policy_override",
            policy: serializeMacroPolicy(config.policyOverride),
          });
        }
      } catch (error) {
        // 策略层初始化失败（认证/网络/配置）：执行层用默认策略继续，不阻断启动。
        // 失败必须可见（telemetry 首条即 init 失败告警），否则"策略层静默未运行"。
        try {
          appendJsonlLine(
            join(dirs.telemetryDir, "policy.jsonl"),
            JSON.stringify(sanitizeValue({
              at: new Date().toISOString(),
              tenantId: config.tenantId,
              type: "policy_init_error",
              message: error instanceof Error ? error.message : String(error),
            })),
          );
        } catch {}
      }
    }

    // 6) coordinator（P0-1：decisionMode 传递；deterministic = planner 注入 DeterministicPlanner，
    //    coordinator 短路语义同 safety——不启动 Agent）
    // 候选变体（config.variants）经注册表解析合并进 SafetyPlanner 配置（2026-08-06 架构整理）。
    const variantConfig = resolveVariantsConfig(config.variants);
    // deterministic 侧参数覆盖（2026-08-07）：变体可同时声明 core 生产参数
    // （vanguardRatio/accumulateThreshold/spawnReserve）——"变体启用=配置声明"
    // 在 deterministic 模式同样成立（如 strike-core-v1 爆兵打水晶）。
    const deterministicVariantConfig = resolveDeterministicVariantsConfig(config.variants);
    // 持久敌情测绘（2026-08-07）：启用 militaryHunt 变体时，从本租户历史
    // calibration cases 提取最后已知敌 Core 位置注入 planner——重启后军事仍
    // 记得敌方基地（解决"重启→记忆清零→军队空转"）。只读、有界、失败静默。
    const initialCoreHuntTargets =
      decisionMode === "deterministic" && variantConfig.militaryHunt === true
        ? loadPersistentEnemyIntel(dirs.calibrationDir)
        : [];
    // 官方排行榜威胁画像（2026-08-07，威胁自适应）：从 data/leaderboard/ 快照
    // 加载（纯只读，缺失/降级 = 空 Map 零回归）；供攻坚"留强"决策消费——
    // 攻坚目标所有者是高伤害玩家（猛攻蛆）时提高成型门槛 + 增加守家预留。
    const threatProfiles = loadThreatProfiles(dataRoot);
    const planner =
      decisionMode === "deterministic"
        ? Object.keys(variantConfig).length === 0
          ? new DeterministicPlanner()
          : new DeterministicPlanner(
              new WorkerTaskPlanner(),
              new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, ...variantConfig }),
              new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, ...variantConfig }),
              deterministicVariantConfig.vanguardRatio,
              deterministicVariantConfig.accumulateThreshold ?? 0,
              deterministicVariantConfig.spawnReserve,
              initialCoreHuntTargets,
              threatProfiles,
            )
        : new SafetyPlanner({ ...AGGRESSIVE_SAFETY_CONFIG, ...variantConfig }, undefined, threatProfiles);
    const coordinator = new DecisionCoordinator({
      runtime,
      planner,
      registry: new LeaseRegistry(),
      clock: { now: () => performance.now() },
      budgetConfig: deadlines,
      tenantId: config.tenantId,
      rulesVersion: RULES_VERSION,
      configHash: manifest.configHash,
      processRunId,
      decisionMode,
      // 决策指挥链：policy 层产物 → PolicyDiscipline（上游纪律：连续坏焦点禁言）→
      // StallRecovery（下游自愈：卡死时覆盖 focusRegion=null / all-in 军事）。
      // discipline 事件落盘 policy.jsonl（policy_discipline），供事后审计。
      policyProvider: policyOrchestrator === null
        ? undefined
        : (state) => {
            const base = policyOrchestrator!.onTick(state);
            const disciplined = policyDiscipline.apply(base, state);
            if (disciplined.event !== null) {
              appendPolicyTelemetry({
                type: "policy_discipline",
                tick: state.tick,
                kind: disciplined.event.kind,
                count: disciplined.event.count,
                focusRegion: disciplined.event.focusRegion,
              });
            }
            return stallRecovery.policyFor(disciplined.policy);
          },
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
      const intentCounts = decision === undefined
        ? {}
        : Object.values(outcome.plan.intents).reduce<Record<string, number>>((counts, intent) => {
            counts[intent] = (counts[intent] ?? 0) + 1;
            return counts;
          }, {});
      // 最终计划动作分布（decisionRecord 与 stall 检测共用；decision undefined 时全 0）
      const actionCounts = decision === undefined
        ? { moveCount: 0, harvestCount: 0, depositCount: 0, waitCount: 0 }
        : {
            moveCount: Object.values(outcome.plan.unitActions).filter((action) => action.type === "MOVE").length,
            harvestCount: Object.values(outcome.plan.unitActions).filter((action) => action.type === "HARVEST").length,
            depositCount: Object.values(outcome.plan.unitActions).filter((action) => action.type === "DEPOSIT").length,
            waitCount: Object.values(outcome.plan.unitActions).filter((action) => action.type === "WAIT").length,
          };
      if (decision !== undefined) {
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
          moveCount: actionCounts.moveCount,
          harvestCount: actionCounts.harvestCount,
          depositCount: actionCounts.depositCount,
          waitCount: actionCounts.waitCount,
          intentCounts,
          planHash: planHashOf(outcome.plan),
          // 威胁评估诊断（v0.3-lite）：outcome.state 可见敌/受击计算基础版；
          // enemyHints 记忆（moving/pursuit）待 planner 侧暴露后补全。
          ...threatDiagnosticsOf(outcome.state),
        };
        decisionWriter.write(decisionRecord);
      }
      // outcome trace：t-1 决策时资源 → t 决策时资源（提交执行后的净变化）
      if (holder.prev !== null) {
        const corePosition = outcome.state.core?.position;
        const workerDistances = corePosition === undefined
          ? []
          : outcome.state.workers.map((worker) => manhattan(worker.position, corePosition));        const failedEvents = outcome.state.events
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
          humanOverride: outcome.humanOverride === undefined || outcome.humanOverride === null
              || (!outcome.humanOverride.active && outcome.humanOverride.applied.length === 0
                && outcome.humanOverride.rejected.length === 0 && outcome.humanOverride.satisfied.length === 0)
            ? undefined
            : {
                active: outcome.humanOverride.active,
                applied: outcome.humanOverride.applied,
                rejected: outcome.humanOverride.rejected.map((r) => ({ unitId: r.unitId, reason: r.reason })),
                satisfied: outcome.humanOverride.satisfied,
                updatedAt: outcome.humanOverride.updatedAt ?? null,
              },
        };
        outcomeWriter.write(outcomeRecord);
        // 死循环检测与自动跳出（2026-08-05 生产事故后）：StallDetector 多模式
        // 检测（cargo_blocked/no_production/patrol_only/focus_exile/
        // capacity_wait_loop），事件落盘 runtime.jsonl 供监控查询/人工介入；
        // StallRecovery 状态机推进（触发/恢复/升级）落盘 stall_recovery。
        // 干预本身（focusRegion=null 覆盖）经 policyProvider 下发，见 coordinator。
        const cargoWorkerCells = outcome.state.workers
          .filter((worker) => worker.cargo > 0)
          .map((worker) => `${worker.position[0]},${worker.position[1]}`)
          .sort()
          .join("|");
        const stallEvents = stallDetector.onObservation({
          tick: outcome.tick,
          coreResourceDelta: outcomeRecord.coreResourceDelta,
          workerCount: outcomeRecord.workerCount ?? 0,
          workerCargoTotal: outcomeRecord.workerCargoTotal ?? 0,
          workerMeanDistanceFromCore: outcomeRecord.workerMeanDistanceFromCore,
          harvestCount: actionCounts.harvestCount,
          depositCount: actionCounts.depositCount,
          moveCount: actionCounts.moveCount,
          waitCount: actionCounts.waitCount,
          intentCounts,
          cargoWorkerFingerprint: cargoWorkerCells.length > 0 ? cargoWorkerCells : null,
        });
        for (const event of stallEvents) {
          appendStallEvent(event);
          appendJsonlLine(
            join(dirs.telemetryDir, "runtime.jsonl"),
            JSON.stringify(sanitizeValue({
              processRunId,
              tenantId: config.tenantId,
              tick: event.tick,
              telemetryType: "stall_warning",
              stallKind: event.kind,
              stallStreak: event.streak,
              detail: event.detail,
            })),
          );
        }
        const recoveryTransition = stallRecovery.observe(stallEvents, {
          tick: outcome.tick,
          coreResourceDelta: outcomeRecord.coreResourceDelta,
          harvestCount: actionCounts.harvestCount,
          depositCount: actionCounts.depositCount,
        });
        if (recoveryTransition !== null) {
          appendJsonlLine(
            join(dirs.telemetryDir, "runtime.jsonl"),
            JSON.stringify(sanitizeValue({
              processRunId,
              tenantId: config.tenantId,
              tick: recoveryTransition.tick,
              telemetryType: "stall_recovery",
              recoveryState: recoveryTransition.state,
              stallKind: recoveryTransition.kind,
              escalated: recoveryTransition.escalated ?? false,
              outcome: recoveryTransition.outcome ?? null,
            })),
          );
          // 恢复结果反馈：自愈结束（含 escalating 到期）时记录结局，供策略层
          // 决策参考（agent 智能跳出闭环的"结果感知"侧）。
          if (recoveryTransition.state === "idle" && recoveryTransition.outcome !== undefined) {
            lastRecoveryOutcome = {
              outcome: recoveryTransition.outcome,
              kind: recoveryTransition.kind ?? null,
              tick: recoveryTransition.tick,
            };
          }
        }
        // 经济趋势缓冲（策略 prompt 输入；保留最近 32 ticks）
        recentResourceDeltas.push(outcome.state.resources - holder.prev.resources);
        if (recentResourceDeltas.length > 32) recentResourceDeltas.shift();
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
      // 人类最高控制权：提交前从 data/runtime/human-commands/<tenant>.json 合并人类指令。
      humanCommands: { tenantId: config.tenantId, storeDir: join(baseDir, "human-commands") },
    });
    await Promise.race([loopPromise, stopped]);
    // requestStop 可能先于 async generator 完成；必须等待 loop 真正退出，避免 close writer 后迟到写入。
    if (stopping) {
      await loopPromise;
    }

    // 9) 正常与异常共用同一幂等 cleanup stack，避免两套关闭语义漂移。
    await cleanupAll();

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
    await cleanupAll();
    throw error;
  }
}

/** Append one sanitized Pi lifecycle/circuit event. IO failure is deliberately fail-open. */
export function appendPiTelemetryEvent(
  path: string,
  event: PiRuntimeTelemetry,
  at = new Date().toISOString(),
): void {
  try {
    appendJsonlLine(
      path,
      JSON.stringify(sanitizeValue({
        at,
        type: event.type,
        reason: event.reason ?? event.message ?? "",
        ...(event.circuitState === undefined ? {} : { circuitState: event.circuitState }),
        ...(event.consecutiveFailures === undefined ? {} : { consecutiveFailures: event.consecutiveFailures }),
        ...(event.lastTripAt === undefined ? {} : { lastTripAt: event.lastTripAt }),
        ...(event.fallbackReason === undefined ? {} : { fallbackReason: event.fallbackReason }),
      })),
    );
  } catch {
    // Telemetry must never take down the decision or cleanup path.
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
  const circuit = resolveCircuitBreaker(config);
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
    consecutiveErrorThreshold: circuit.failureThreshold,
    circuitOpenMs: circuit.openMs,
    onTelemetry,
  });
}

/** 供 CLI/测试用：读取 config 的决策模式（不抛）。 */
export function readDecisionMode(config: TenantRuntimeConfig): DecisionModeName {
  return config.decisionMode;
}
