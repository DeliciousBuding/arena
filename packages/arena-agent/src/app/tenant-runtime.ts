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
import { mkdirSync, renameSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import { loadRuntimeConfig, resolveCircuitBreaker, resolveDeadlines, type TenantRuntimeConfig } from "./runtime-config.ts";
import { loadPersistentEnemyIntel } from "./enemy-intel.ts";
import type { CoreHuntTarget, CoreWatchMemory } from "../domain/world.ts";
import { World } from "../domain/world.ts";
import { loadThreatProfiles, threatProfilesEqual } from "./official-intel.ts";
import { resolveArenaDataRoot, resolveTenantBaseDir } from "./data-root.ts";
import { SingleWriterLock } from "./single-writer-lock.ts";
import { newProcessRunId, readGitSha, writeRunManifest, type RunManifest } from "./run-manifest.ts";
import { DecisionCoordinator } from "../runtime/decision-coordinator.ts";
import { LeaseRegistry } from "../runtime/lease-registry.ts";
import { runTenantLoop, type TickOutcome } from "../runtime/loop.ts";
import { AGGRESSIVE_SAFETY_CONFIG, DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../strategies/safety-planner.ts";
import { compileRuntimeStrategy, compileRuntimeStrategyFile, hotReloadCompatibility } from "./strategy-config.ts";
import { isConfigReloadRequest, type ConfigReloadResult, type RuntimeConfigStatus } from "./config-reload-protocol.ts";
import { knownChunks, knownCoreHunts, knownObstacles, knownResourceAbsenceCounts, knownResourceCooldownTiers, knownResources, openSurveyDb } from "../intel/survey-db.ts";
import { loadRefillPredictions, type RefillPrediction } from "../intel/refill-predictions.ts";
import { migrationOverlay as applyMigrationOverlay } from "../migration/overlay.ts";
import { migrationAssist, detectMigrationFailure, type AssistCoreSnapshot } from "../migration/assist.ts";
import { migrationPlanPath, readMigrationPlan } from "../migration/io.ts";
import { appendMigrationReport, migrationReportPath } from "../migration/report.ts";
import { coreReceptiveRatio, idealEtaTicks } from "../migration/pacing.ts";
import { loadMigrationRuntimeConfig, type MigrationRuntimeConfig } from "../migration/config.ts";
import { checkAndMirrorOfficialManual, type OfficialManualMirror, type ReceiptLike } from "../command-plane/official-bridge.ts";
import { DeterministicPlanner } from "../planning/deterministic-planner.ts";
import { WorkerTaskPlanner } from "../planning/worker-task-planner.ts";
import { PiAgentRuntime, type PiRuntimeTelemetry } from "../infrastructure/pi/pi-agent-runtime.ts";
import { PiSessionFactory } from "../infrastructure/pi/pi-session-factory.ts";
import { buildDecisionPrompt } from "../infrastructure/pi/prompt-builder.ts";
import { buildMacroPolicyPrompt, readLastAssistantText } from "../infrastructure/pi/policy-prompt.ts";
import { MacroPolicyOrchestrator } from "../runtime/macro-policy-orchestrator.ts";
import { serializeMacroPolicy } from "../runtime/macro-policy.ts";
import type { MacroDecisionPointV1 } from "../offline-learning/runtime/macro-decision-point.ts";
import { StallDetector, type StallEvent } from "../runtime/stall-detector.ts";
import { StallRecovery, type RecoverySideEffect } from "../runtime/stall-recovery.ts";
import {
  WorkerLivenessTracker,
  MOVE_CONTESTED_BLOCK_PENALTY,
  OTHER_MOVE_FAIL_BLOCK_PENALTY,
  type WorkerLivenessEvent,
  type WorkerLivenessKind,
} from "../runtime/worker-liveness.ts";
import { PolicyDiscipline } from "../runtime/policy-discipline.ts";
import { mapSnapshotOf } from "../infrastructure/pi/map-snapshot.ts";
import type { PiModel } from "../infrastructure/pi/pi-types.ts";
import { manhattan } from "../domain/nav.ts";
import { assessThreat, coreDamagedThisTick } from "../domain/threat.ts";
import type { Position, TickState } from "../domain/model.ts";
import type { AgentDecisionRuntime, DecisionModeName, DecisionResult, SubmissionModeName } from "../runtime/decision-types.ts";
import {
  appendJsonlLine,
  JsonlWriter,
  sanitizeValue,
} from "../telemetry/jsonl-writer.ts";
import { countOutcomeEvents, planHashOf } from "../telemetry/decision-trace.ts";
import type { DecisionTraceRecord, OutcomeTraceRecord, RuntimeTraceRecord } from "../telemetry/decision-trace.ts";
import { AllianceShadowWriter } from "../alliance/shadow.ts";
import type { AllianceShadowFrameV1 } from "../alliance/shadow-frame.ts";
import { EMPTY_ROSTER_ID_SET, loadAllianceRosterFile, type AllianceRosterRef } from "../alliance/roster-file.ts";
import {
  RuntimeGoldenRecorder,
  type RuntimeGoldenRecorderResult,
} from "../runtime-golden/recorder.ts";

export const RULES_VERSION = "v0.14";

/** 经济停滞告警阈值：连续 N 个 tick 满载 Worker 无法回仓（delta=0 + cargoTot>0）即告警。
 *  生产实测 t1 capacity_wait:DEPOSIT 死锁 60+ ticks 才被人工发现，16 ticks（≈2 个
 *  MacroPolicy 周期）是"足够确认异常、又不会频繁误报"的折中。 */
export const STALL_WARNING_TICKS = 16;

/** 威胁画像热刷新间隔（2026-08-08）：leaderboard 快照由外部计划任务每 15 分钟
 *  拉取（ArenaLeaderboardIntel → docs/progress/leaderboard-intel.py），四线每 5
 *  分钟重读一次（间隔 < 快照间隔，保证拉取后 5 分钟内生效；内容不变零抖动）。 */
const THREAT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** 联盟 no-fire roster 热刷新间隔（2026-08-08，alliance-no-fire-v1）：supervisor
 *  聚合帧写入 <dataRoot>/runtime/alliance/roster.json，租户每 30s 重读——
 *  比威胁画像更实时（roster 影响 no-fire 安全边界）。 */
const ALLIANCE_ROSTER_REFRESH_INTERVAL_MS = 30 * 1000;

/** 打转封锁（W5）penalty 映射：WorkerLivenessEvent.blockedTarget 存在时，按
 *  kind 选 penaltyTicks 调 workerLiveness.blockCell。oscillation 用 16（与
 *  STUCK_TICKS 同量级，打转需更长冷却让 worker 转向新区域）；moveNoEffect 用
 *  MOVE_CONTESTED_BLOCK_PENALTY(12)（MOVE_CONTESTED/DESTINATION_OCCUPIED 等
 *  强竞争类，目标实际被占）；其他 movement-failure 类兜底 4
 *  （=OTHER_MOVE_FAIL_BLOCK_PENALTY，路径瞬时拥堵）。blockedTarget 仅对
 *  oscillation/move_no_effect 填充（见 worker-liveness.computeBlockedTarget），
 *  其他 kind 字段缺省 undefined → 不调 blockCell。 */
const OSCILLATION_BLOCK_PENALTY_TICKS = 16;

/** 打转封锁（W5）penalty 选择（纯函数，便于单测）：oscillation=16、
 *  move_no_effect=12（MOVE_CONTESTED 强竞争类）、其他=4。调用方在
 *  event.blockedTarget 存在时据此调 blockCell。 */
export function blockadePenaltyTicksFor(kind: WorkerLivenessKind): number {
  if (kind === "oscillation") return OSCILLATION_BLOCK_PENALTY_TICKS;
  if (kind === "move_no_effect") return MOVE_CONTESTED_BLOCK_PENALTY;
  return OTHER_MOVE_FAIL_BLOCK_PENALTY;
}

/** 打转封锁（W5）UNIT_MOVE_SUCCEEDED 清账：遍历 resolution events，对
 *  UNIT_MOVE_SUCCEEDED 的 actorId 调 sink.clearPlannedMove。spinBlockadeEnabled
 *  =false 时 no-op（零回归）。纯函数便于单测——sink 是最小接口
 *  （clearPlannedMove），生产传 WorkerLivenessTracker，测试传 fake。 */
export function applyBlockadeClearPlannedMoves(
  events: readonly { readonly eventType: string; readonly actorId: string | null }[],
  sink: { clearPlannedMove(unitId: string): void },
  spinBlockadeEnabled: boolean,
): void {
  if (!spinBlockadeEnabled) return;
  for (const event of events) {
    if (event.eventType !== "UNIT_MOVE_SUCCEEDED") continue;
    if (event.actorId === null) continue;
    sink.clearPlannedMove(event.actorId);
  }
}

/** 打转封锁（W5）recoverWorker 后 blockCell：遍历 liveness events，对
 *  blockedTarget 存在的 event 调 sink.blockCell(target, tick, penalty)。
 *  spinBlockadeEnabled=false 时 no-op（零回归）。penalty 经
 *  blockadePenaltyTicksFor(kind) 选择。纯函数便于单测——sink 是最小接口
 *  （blockCell），生产传 WorkerLivenessTracker，测试传 fake。 */
export function applyBlockadeBlocks(
  events: readonly WorkerLivenessEvent[],
  sink: { blockCell(target: Position, currentTick: number, penaltyTicks: number): void },
  spinBlockadeEnabled: boolean,
): void {
  if (!spinBlockadeEnabled) return;
  for (const event of events) {
    if (event.blockedTarget === undefined) continue;
    sink.blockCell(event.blockedTarget, event.tick, blockadePenaltyTicksFor(event.kind));
  }
}

/** 威胁评估诊断字段（v0.3-lite，2026-08-06）：从 outcome state 计算 tick 级威胁
 *  （可见敌/受击基础版；enemyHints 记忆增强——moving/pursuit——待 planner 侧
 *  暴露 world 后补全）。写入 decision.jsonl 供 replay/威胁分析。 */
function threatDiagnosticsOf(
  state: TickState,
  coreWatch: readonly CoreWatchMemory[] = [],
): Pick<
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
    coreWatch,
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
  /** Alliance shadow（Phase 1 收尾）：默认关闭；每 interval tick 从 live state
   *  构建联盟快照写 telemetry/alliance-shadow.jsonl（只读影子，零决策影响）。 */
  readonly recordAllianceShadow?: boolean;
  readonly allianceShadowIntervalTicks?: number;
  /** 完整 shadow frame 的只读内存出口（Supervisor IPC 用）；callback 异常由调用方 fail-open。 */
  readonly onAllianceShadowFrame?: (frame: AllianceShadowFrameV1) => void;
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
  // Compile the complete registered strategy before acquiring the writer lock. Unknown/duplicate
  // variants therefore fail before production ownership changes hands.
  const startupStrategy = compileRuntimeStrategy(config);
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
    const configHash = startupStrategy.configHash;
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
    // Alliance shadow（默认关）：每 interval tick 输出联盟快照帧（spec Phase 1）。
    const allianceShadowWriter = options.recordAllianceShadow === true
      ? new AllianceShadowWriter({
          tenantId: config.tenantId,
          processRunId,
          path: join(dirs.telemetryDir, "alliance-shadow.jsonl"),
          intervalTicks: options.allianceShadowIntervalTicks,
          onFrame: options.onAllianceShadowFrame,
        })
      : null;

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
    // WorkerLivenessTracker 与 StallDetector 分层：前者按 unitId 抓局部假活/振荡并
    // 做 targeted recovery；后者继续负责半数/全租户经济停摆与全局恢复。
    const workerLiveness = new WorkerLivenessTracker();
    const policyDiscipline = new PolicyDiscipline();
    // 恢复结果反馈（agent 智能跳出闭环）：上次自愈结束的结局（成功/失败/到期），
    // 注入策略 prompt 让 LLM 基于结果调整战略（见 policy-prompt 渲染）。
    let lastRecoveryOutcome: { readonly outcome: "recovered" | "failed" | "expired"; readonly kind: string | null; readonly tick: number } | null = null;
    const recentStallEvents: string[] = [];
    const appendHealthEvent = (message: string): void => {
      recentStallEvents.push(message);
      if (recentStallEvents.length > 4) recentStallEvents.shift();
    };
    const appendStallEvent = (event: StallEvent): void => {
      appendHealthEvent(`kind=${event.kind}@tick=${event.tick}(streak=${event.streak})`);
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
    // M2b：决策点 shadow 流（candidate universe + 选定候选；生产行为零变化——
    // LLM 仍唯一选择者，此处只 append telemetry，供 M2c REAL decision point 消费）
    const decisionPointPath = join(dirs.telemetryDir, "policy-decision-points.jsonl");
    const appendDecisionPointTelemetry = (event: MacroDecisionPointV1): void => {
      try {
        appendJsonlLine(
          decisionPointPath,
          JSON.stringify(sanitizeValue({
            at: new Date().toISOString(),
            tenantId: config.tenantId,
            ...event,
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
          // M2b：决策点 shadow 落盘（candidate universe + 选定候选）。
          // 生产路径零影响——LLM 仍唯一选择者，此回调只 append telemetry。
          onDecisionPoint: (event) => {
            appendDecisionPointTelemetry(event);
          },
          processRunId,
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
    let activeStrategy = startupStrategy;
    const variantConfig = activeStrategy.safetyOverrides;
    // deterministic 侧参数覆盖（2026-08-07）：变体可同时声明 core 生产参数
    // （vanguardRatio/accumulateThreshold/spawnReserve）——"变体启用=配置声明"
    // 在 deterministic 模式同样成立（如 strike-core-v1 爆兵打水晶）。
    // Strategy compiler owns both variant defaults and mission parameter overrides, so startup,
    // hot reload and release preflight consume one identical effective configuration.
    const deterministicVariantConfig = activeStrategy.deterministicOverrides;
    // 持久敌情测绘（2026-08-07）：启用 militaryHunt 变体时，从本租户历史
    // calibration cases 提取最后已知敌 Core 位置注入 planner——重启后军事仍
    // 记得敌方基地（解决"重启→记忆清零→军队空转"）。只读、有界、失败静默。
    // 跨 run 测绘种子（2026-08-08 统一捕获链路）：敌核记忆优先从测绘库读
    // （跨 run 全量，比 calibration 扫描更全），缺失/损坏回退 calibration 扫描。
    const surveyCoreHunts = loadSurveyCoreHuntSeed(dataRoot, config.tenantId);
    const initialCoreHuntTargets =
      decisionMode === "deterministic" && (variantConfig.militaryHunt === true || surveyCoreHunts.length > 0)
        ? (surveyCoreHunts.length > 0 ? surveyCoreHunts : loadPersistentEnemyIntel(dirs.calibrationDir))
        : [];
    // 官方排行榜威胁画像（2026-08-07，威胁自适应）：从 data/leaderboard/ 快照
    // 加载（纯只读，缺失/降级 = 空 Map 零回归）；供攻坚"留强"决策消费——
    // 攻坚目标所有者是高伤害玩家（猛攻蛆）时提高成型门槛 + 增加守家预留。
    const threatProfiles = loadThreatProfiles(dataRoot);
    // 热加载配置代数（2026-08-08）：每次 config 热替换 +1，tick 归属当前配置代。
    let configGeneration = 1;
    const baseSafetyConfig =
      decisionMode === "deterministic"
        ? { ...DEFAULT_SAFETY_CONFIG, ...variantConfig }
        : { ...AGGRESSIVE_SAFETY_CONFIG, ...variantConfig };
    const surveyResourceCells = loadSurveyResourceSeed(dataRoot, config.tenantId);
    const surveyObstacleCells = loadSurveyObstacleSeed(dataRoot, config.tenantId);
    const surveyChunks = loadSurveyChunkSeed(dataRoot, config.tenantId);
    // 分级冷却（2026-08-08，缺席实证）：survey-db 缺席统计高频格 → 升级失败冷却
    // （96/192/384 tick），worker 重启后不每 32 tick 白试长期死格。与 seed 死格
    // 过滤互补：过滤管"启动候选"，分级管"运行期证伪后的重试节奏"。visible 优先
    // 语义不变（refill 后重新可见立即恢复）。
    const surveyCooldownTiers = loadSurveyCooldownTiers(dataRoot, config.tenantId);
    // Worker coverage liveness shares the same persisted survey SSOT as frontier planning. Historical
    // chunks are evidence, not automatic progress: a survey worker must still expand spatially.
    workerLiveness.seedKnownChunks(surveyChunks.map((chunk) => chunk.key));
    // 联盟 no-fire 花名册（2026-08-08，alliance-no-fire-v1）：可变引用对象——
    // 构造时注入 SafetyPlanner，刷新时原子替换引用（World/巡逻/攻坚记忆不丢）。
    // 变体关闭或文件缺失 = 空集合（零回归）；只加载受信 supervisor 聚合产物。
    const allianceRosterRef: AllianceRosterRef = { allyEntityIds: new Set(EMPTY_ROSTER_ID_SET) };
    // Stable component graph: instantiate the same planner bundle regardless of which registered
    // variants are currently enabled. Hot reload only swaps immutable config values; it never needs
    // to rebuild World/SafetyPlanner/WorkerTaskPlanner or retrofit dependencies such as no-fire.
    const planner: DeterministicPlanner | SafetyPlanner =
      decisionMode === "deterministic"
        ? new DeterministicPlanner(
            new WorkerTaskPlanner(),
            new SafetyPlanner(baseSafetyConfig, undefined, threatProfiles, allianceRosterRef),
            // patrolPlanner 永远看不到资源格（decide 传空 resourceCells）——其 World
            // 关闭 visionInvalidation（2026-08-08 修复）：A2 视野证伪对"本轮资源恒空"
            // 的 patrol world 会把全部 seed 记忆标 harvested（且永远无法恢复 visible），
            // 系统性破坏 patrol 侧记忆（当前潜伏，任何未来消费会读到假数据）。
            new SafetyPlanner(
              baseSafetyConfig,
              new World({ visionInvalidation: false }),
              threatProfiles,
              allianceRosterRef,
            ),
            deterministicVariantConfig.vanguardRatio,
            deterministicVariantConfig.accumulateThreshold ?? 0,
            deterministicVariantConfig.spawnReserve,
            initialCoreHuntTargets,
            threatProfiles,
            surveyResourceCells,
            surveyObstacleCells,
            deterministicVariantConfig.mission,
          )
        : new SafetyPlanner(baseSafetyConfig, undefined, threatProfiles, allianceRosterRef);
    if (planner instanceof SafetyPlanner) {
      if (surveyResourceCells.length > 0) planner.world.seedResourceMemory(surveyResourceCells, 0);
      if (surveyObstacleCells.length > 0) planner.world.seedObstacleMemory(surveyObstacleCells);
      if (surveyCoreHunts.length > 0) planner.world.seedCoreHuntTargets(surveyCoreHunts);
      if (surveyChunks.length > 0) planner.world.seedChunkMemory(surveyChunks);
      if (surveyCooldownTiers.length > 0) planner.world.seedFailedCooldownTiers(surveyCooldownTiers);
    } else if (surveyCooldownTiers.length > 0) {
      // deterministic 模式：fallback（经济分配）与 patrol（勘探基线）各持独立
      // World，两个都注入——死格冷却对"分配候选"与"巡逻重试"同时生效。
      planner.seedFailedCooldownTiers(surveyCooldownTiers);
    }
    // 打转封锁（W5）消费端注入：deterministic 模式下把 WorkerLivenessTracker
    // 作为 BlockadeSink 注入 DeterministicPlanner。sink 总是注入（结构化满足
    // 接口——isCellBlocked + recordPlannedMove），实际消费由 spinBlockadeEnabled
    // 控制（updateConfig 从 safetyConfig.spinBlockade 读，变体关=零回归）。
    // baseSafetyConfig 已含变体合并（{...DEFAULT_SAFETY_CONFIG, ...variantConfig}），
    // 构造后立即同步一次初始 spinBlockadeEnabled 状态（updateConfig 在热加载时
    // 再刷新）。SafetyPlanner 模式跳过（safety 模式不跑 WorkerTaskPlanner.plan）。
    if (planner instanceof DeterministicPlanner) {
      planner.setBlockadeSink(workerLiveness);
    }

    // Runtime config is split into a small hot surface (`variants`) and an explicit restart surface.
    // Candidate compilation happens before touching the planner; last-good stays active on every
    // failure. The coordinator hash callback is installed after coordinator construction below.
    type ReloadAttempt = Omit<ConfigReloadResult, "type" | "requestId" | "tenantId">;
    let onConfigHashApplied: (configHash: string) => void = () => {};
    const sendConfigStatus = (): void => {
      if (typeof process.send !== "function") return;
      const status: RuntimeConfigStatus = {
        type: "arena.config_status",
        tenantId: config.tenantId,
        configGeneration,
        activeConfigHash: activeStrategy.configHash,
        activeStrategyHash: activeStrategy.strategyHash,
      };
      process.send(status);
    };
    const configTelemetry = (telemetryType: string, payload: Readonly<Record<string, unknown>>): void => {
      appendJsonlLine(
        join(dirs.telemetryDir, "runtime.jsonl"),
        JSON.stringify(sanitizeValue({
          processRunId,
          tenantId: config.tenantId,
          telemetryType,
          configGeneration,
          activeConfigHash: activeStrategy.configHash,
          activeStrategyHash: activeStrategy.strategyHash,
          ...payload,
        })),
      );
    };
    const reloadConfig = (expectedConfigHash?: string): ReloadAttempt => {
      let candidate;
      try {
        candidate = compileRuntimeStrategyFile(configPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        configTelemetry("config_reload_failed", { errorCode: "invalid_config", message });
        return {
          applied: false,
          configGeneration,
          activeConfigHash: activeStrategy.configHash,
          activeStrategyHash: activeStrategy.strategyHash,
          errorCode: "invalid_config",
          error: message,
        };
      }

      if (expectedConfigHash !== undefined && candidate.configHash !== expectedConfigHash) {
        const message = `candidate changed after supervisor preflight: expected=${expectedConfigHash} actual=${candidate.configHash}`;
        configTelemetry("config_reload_failed", {
          errorCode: "candidate_changed",
          desiredConfigHash: candidate.configHash,
          message,
        });
        return {
          applied: false,
          configGeneration,
          activeConfigHash: activeStrategy.configHash,
          activeStrategyHash: activeStrategy.strategyHash,
          errorCode: "candidate_changed",
          error: message,
        };
      }

      const compatibility = hotReloadCompatibility(activeStrategy.config, candidate.config);
      if (!compatibility.compatible) {
        const message = `restart required for config fields: ${compatibility.restartRequiredFields.join(", ")}`;
        configTelemetry("config_reload_failed", {
          errorCode: "restart_required",
          desiredConfigHash: candidate.configHash,
          restartRequiredFields: compatibility.restartRequiredFields,
          message,
        });
        return {
          applied: false,
          configGeneration,
          activeConfigHash: activeStrategy.configHash,
          activeStrategyHash: activeStrategy.strategyHash,
          errorCode: "restart_required",
          error: message,
          restartRequiredFields: compatibility.restartRequiredFields,
        };
      }

      if (candidate.configHash === activeStrategy.configHash) {
        sendConfigStatus();
        return {
          applied: true,
          configGeneration,
          activeConfigHash: activeStrategy.configHash,
          activeStrategyHash: activeStrategy.strategyHash,
        };
      }

      try {
        const nextSafety = decisionMode === "deterministic"
          ? { ...DEFAULT_SAFETY_CONFIG, ...candidate.safetyOverrides }
          : { ...AGGRESSIVE_SAFETY_CONFIG, ...candidate.safetyOverrides };
        if (planner instanceof DeterministicPlanner) {
          planner.updateConfig(nextSafety, candidate.deterministicOverrides);
        } else {
          planner.updateConfig(nextSafety);
        }
        activeStrategy = candidate;
        configGeneration += 1;
        onConfigHashApplied(candidate.configHash);
        configTelemetry("config_reload", {
          variants: candidate.variants,
          configHash: candidate.configHash,
          strategyHash: candidate.strategyHash,
        });
        sendConfigStatus();
        return {
          applied: true,
          configGeneration,
          activeConfigHash: candidate.configHash,
          activeStrategyHash: candidate.strategyHash,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        configTelemetry("config_reload_failed", {
          errorCode: "apply_failed",
          desiredConfigHash: candidate.configHash,
          message,
        });
        return {
          applied: false,
          configGeneration,
          activeConfigHash: activeStrategy.configHash,
          activeStrategyHash: activeStrategy.strategyHash,
          errorCode: "apply_failed",
          error: message,
        };
      }
    };

    // 威胁画像热刷新（2026-08-08）：leaderboard 快照由外部计划任务每 15 分钟
    // 拉取（ArenaLeaderboardIntel → docs/progress/leaderboard-intel.py），四线每 5
    // 分钟重读一次快照，内容变化才替换（掉榜用户立即移除，零抖动；纯只读 +
    // 降级：快照缺失/解析失败返回空 Map → 威胁自适应关闭，与"无情报"历史一致，
    // 下次快照恢复自动回来）。
    let lastThreatProfiles = threatProfiles;
    const refreshThreatProfiles = (): void => {
      try {
        const next = loadThreatProfiles(dataRoot);
        if (threatProfilesEqual(lastThreatProfiles, next)) return;
        lastThreatProfiles = next;
        planner.replaceThreatProfiles(next);
        appendJsonlLine(
          join(dirs.telemetryDir, "runtime.jsonl"),
          JSON.stringify(sanitizeValue({
            processRunId,
            tenantId: config.tenantId,
            telemetryType: "threat_profiles_refreshed",
            profiles: next.size,
          })),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendJsonlLine(
          join(dirs.telemetryDir, "runtime.jsonl"),
          JSON.stringify(sanitizeValue({
            processRunId,
            tenantId: config.tenantId,
            telemetryType: "threat_profiles_refresh_failed",
            message,
          })),
        );
      }
    };
    const threatRefreshTimer = setInterval(refreshThreatProfiles, THREAT_REFRESH_INTERVAL_MS);
    refreshThreatProfiles(); // 启动立即检查一次（避免首次快照缺失导致长空窗）

    // 矿刷新预测（2026-08-08，worker-mission-v1 Phase 2，G3 数据管道）：
    // per-tenant survey-db 的 resource_seen_history 每 5 分钟重算一次预测（与
    // 威胁画像同节奏）；survey-sync 每次运行后 history 更新，5min 内生效。
    // 纯只读 + 降级：db 缺失/无历史 = 空 Map（分配走既有行为零回归）。
    // 预测随 tick 老化：planner 侧按当前 tick 折算 dueInTicks（存 predictedNextTick）。
    // 启动前预载一次（与 threatProfiles 同模式）——启动刷新对比相同则跳过，
    // 不产生额外 telemetry 记录（保持既有记录节奏零回归）。
    // W7 chunk-resurvey-v1（2026-08-09）：SafetyPlanner 消费需要完整
    // RefillPrediction Map（planChunkResurvey 契约：windows/avgGapTicks 等），
    // 不能走 loadPredictedTicks 的扁平 Map<string,number>（仅 predictedNextTick）。
    // 这里加载一次原 Map，扁平化给 DeterministicPlanner、原 Map 给 SafetyPlanner
    // ——避免重复调 loadRefillPredictions（db 双读）。setter 默认 null = 零回归。
    let lastRefillPredictedTicks = new Map<string, number>();
    let lastRefillPredictionsFull: ReadonlyMap<string, RefillPrediction> = new Map();
    const loadPredictedTicks = (): Map<string, number> => {
      const predictions = loadRefillPredictions(dataRoot, config.tenantId, 0);
      lastRefillPredictionsFull = predictions;
      const predictedTicks = new Map<string, number>();
      for (const [key, prediction] of predictions) predictedTicks.set(key, prediction.predictedNextTick);
      return predictedTicks;
    };
    const refreshRefillPredictions = (): void => {
      try {
        const predictedTicks = loadPredictedTicks();
        if (predictedTicks.size === lastRefillPredictedTicks.size) {
          let same = true;
          for (const [key, value] of predictedTicks) {
            if (lastRefillPredictedTicks.get(key) !== value) { same = false; break; }
          }
          if (same) return;
        }
        lastRefillPredictedTicks = predictedTicks;
        if (planner instanceof DeterministicPlanner) planner.replaceRefillPredictions(predictedTicks);
        if (planner instanceof SafetyPlanner) planner.setRefillPredictions(lastRefillPredictionsFull);
        if (predictedTicks.size > 0) {
          appendJsonlLine(
            join(dirs.telemetryDir, "runtime.jsonl"),
            JSON.stringify(sanitizeValue({
              processRunId,
              tenantId: config.tenantId,
              telemetryType: "refill_predictions_refreshed",
              cells: predictedTicks.size,
            })),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendJsonlLine(
          join(dirs.telemetryDir, "runtime.jsonl"),
          JSON.stringify(sanitizeValue({
            processRunId,
            tenantId: config.tenantId,
            telemetryType: "refill_predictions_refresh_failed",
            message,
          })),
        );
      }
    };
    // 启动预载：与 threatProfiles 同模式——先算好 last-good，启动刷新对比相同即
    // 跳过（不写 telemetry）；首次加载同时注入 planner（空预测 = 零回归）。
    try {
      lastRefillPredictedTicks = loadPredictedTicks();
      if (planner instanceof DeterministicPlanner) {
        planner.replaceRefillPredictions(lastRefillPredictedTicks);
      }
      if (planner instanceof SafetyPlanner) {
        planner.setRefillPredictions(lastRefillPredictionsFull);
      }
    } catch {
      lastRefillPredictedTicks = new Map();
      lastRefillPredictionsFull = new Map();
    }
    const refillPredictionsTimer = setInterval(refreshRefillPredictions, THREAT_REFRESH_INTERVAL_MS);
    refreshRefillPredictions(); // 启动立即检查一次（对比预载值，无变化不写日志）
    cleanupStack.push(() => clearInterval(refillPredictionsTimer));
    cleanupStack.push(() => clearInterval(threatRefreshTimer));

    // 联盟 no-fire roster 热刷新（2026-08-08，alliance-no-fire-v1）：supervisor
    // 每周期把聚合 roster 原子写入 data/runtime/alliance/roster.json，本进程每
    // 30s 重读；revision 变化才替换引用（内容不变零抖动）。变体关闭 = 不加载
    // （SafetyPlanner 保持空集合零回归）；文件缺失/损坏 = 保持 last-good 或空。
    let lastRosterRevision = -1;
    const refreshAllianceRoster = (): void => {
      if (activeStrategy.safetyOverrides.allianceNoFire !== true) return;
      try {
        const next = loadAllianceRosterFile(dataRoot);
        const revision = next?.revision ?? -1;
        if (revision === lastRosterRevision) return;
        lastRosterRevision = revision;
        allianceRosterRef.allyEntityIds = next === null ? new Set(EMPTY_ROSTER_ID_SET) : new Set(next.allyEntityIds);
        appendJsonlLine(
          join(dirs.telemetryDir, "runtime.jsonl"),
          JSON.stringify(sanitizeValue({
            processRunId,
            tenantId: config.tenantId,
            telemetryType: "alliance_roster_refreshed",
            revision,
            allyIds: allianceRosterRef.allyEntityIds.size,
          })),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendJsonlLine(
          join(dirs.telemetryDir, "runtime.jsonl"),
          JSON.stringify(sanitizeValue({
            processRunId,
            tenantId: config.tenantId,
            telemetryType: "alliance_roster_refresh_failed",
            message,
          })),
        );
      }
    };
    const allianceRosterTimer = setInterval(refreshAllianceRoster, ALLIANCE_ROSTER_REFRESH_INTERVAL_MS);
    refreshAllianceRoster(); // 启动立即检查一次
    cleanupStack.push(() => clearInterval(allianceRosterTimer));

    // 触发源 1：文件监听（父目录 + 400ms debounce，兼容编辑器原子替换/重命名）。
    let configWatch: ReturnType<typeof watch> | null = null;
    let configReloadTimer: NodeJS.Timeout | null = null;
    try {
      configWatch = watch(dirname(configPath), { persistent: false }, (_eventType, filename) => {
        if (filename !== basename(configPath)) return;
        if (configReloadTimer !== null) clearTimeout(configReloadTimer);
        configReloadTimer = setTimeout(() => {
          configReloadTimer = null;
          reloadConfig();
        }, 400);
      });
      cleanupStack.push(() => {
        if (configReloadTimer !== null) clearTimeout(configReloadTimer);
        configWatch?.close();
      });
    } catch {
      // 文件监听失败不阻断 live（仍可用 Supervisor API 触发）。
    }
    // 触发源 2：Supervisor IPC。Supervisor sends the hash it preflighted; the child reads the
    // candidate again and must ACK the exact same hash, closing the file-change race between the
    // two processes. File-watch reloads still use the same compiler/compatibility boundary.
    const onIpcMessage = (msg: unknown): void => {
      if (!isConfigReloadRequest(msg)) return;
      const attempt = reloadConfig(msg.expectedConfigHash);
      if (typeof process.send !== "function") return;
      const result: ConfigReloadResult = {
        type: "arena.config_reload_result",
        requestId: msg.requestId,
        tenantId: config.tenantId,
        ...attempt,
      };
      process.send(result);
    };
    process.on("message", onIpcMessage);
    cleanupStack.push(() => {
      process.off("message", onIpcMessage);
    });
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
    onConfigHashApplied = (nextHash) => coordinator.updateConfigHash(nextHash);
    // Initial child→supervisor config attestation. `/ready` remains writer-lock readiness;
    // config readiness is tracked separately from this hash/generation signal.
    sendConfigStatus();

    // 7) outcome trace 的资源对比基准（t-1 → t）；holder 包装防 CFA 闭包窄化
    const holder: {
      prev: {
        tick: number;
        resources: number;
        plan: TickOutcome["plan"];
        coreId: string | null;
        /** 上一权威 tick 的自有单位 id；W50 ownership-aware outcome 归属使用。 */
        unitIds: readonly string[];
      } | null;
    } = { prev: null };
    let processedTickCount = 0;
    let liveSubmitCount = 0;
    // 官方 web 手操镜像去重（内容哈希：同内容不重复写盘/审计）。
    let officialMirrorHash: string | null = null;

    const onTick = (outcome: TickOutcome): void => {
      // Alliance shadow（默认关）：只读快照，IO 失败不阻塞。
      allianceShadowWriter?.onState(outcome.state);
      // 官方 web 手操镜像（Phase 3 命令打通，只读回显）：官方事件流广播 MANUAL
      // 回执（官方 web 手动提交）→ 结构化镜像 + 审计；不合并进 human-commands
      // （官方已接受执行，agent 重发 = 双提交冲突；single-writer 纪律保持）。
      checkAndMirrorOfficialManual(
        client.latestReceipts as Readonly<Record<string, ReceiptLike>>,
        {
          tenant: config.tenantId,
          dataRoot,
          writeMirror: (mirror) => {
            const mirrorDir = join(baseDir, "official-mirror");
            mkdirSync(mirrorDir, { recursive: true });
            const record: OfficialManualMirror = {
              ...mirror,
              updatedAt: new Date().toISOString(),
            };
            const tmpPath = join(mirrorDir, `${config.tenantId}.json.tmp`);
            const targetPath = join(mirrorDir, `${config.tenantId}.json`);
            appendJsonlLine(tmpPath, JSON.stringify(record));
            // 原子替换（与 human-commands store 同纪律：不落半截坏 JSON）
            renameSync(tmpPath, targetPath);
          },
          previousHash: officialMirrorHash,
        },
      );
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
          configGeneration,
          configHash: activeStrategy.configHash,
          strategyHash: activeStrategy.strategyHash,
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
          // 信标遥测（2026-08-08）：官方坐标全员公开——每 tick 落盘真实位置/
          // 状态/携带者，指挥面板可实时核实信标动向（不再依赖 case 投影的
          // [0,0] 占位与历史 trail 推断）。
          beacon: {
            position: outcome.state.beacon.position,
            status: outcome.state.beacon.status,
            carrierId: outcome.state.beacon.carrierId,
          },
          // 威胁评估诊断（v0.3-lite）：outcome.state 可见敌/受击 + 近核入侵观察
          // （core-threat-watch-v1）长 TTL 记忆——威胁遥测持续显示入侵（ALERT
          // invasion_watch），指挥面板可实时看到"敌贴脸但当前不可见"。
          ...threatDiagnosticsOf(
            outcome.state,
            planner instanceof SafetyPlanner
              ? planner.world.coreWatchTargets(planner.config.coreThreatWatchTicks ?? 60)
              : [],
          ),
        };
        decisionWriter.write(decisionRecord);
      }
      // outcome trace：t-1 决策时资源 → t 决策时资源（提交执行后的净变化）
      if (holder.prev !== null) {
        const corePosition = outcome.state.core?.position;
        const workerDistances = corePosition === undefined
          ? []
          : outcome.state.workers.map((worker) => manhattan(worker.position, corePosition));        const failedEvents = outcome.state.events
          .filter((event) =>
            event.eventType.endsWith("_FAILED") ||
            event.eventType === "SHOT_MISSED" ||
            event.reasonCode !== null
          )
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
        const outcomeCounters = countOutcomeEvents(outcome.state.events, {
          priorUnitIds: new Set(holder.prev.unitIds),
          currentUnitIds: new Set(outcome.state.units.map((unit) => unit.id)),
          priorCoreId: holder.prev.coreId,
          currentCoreId: outcome.state.core?.id ?? null,
        });
        const outcomeRecord: OutcomeTraceRecord = {
          processRunId,
          tenantId: config.tenantId,
          tick: outcome.tick,
          coreResourcesBefore: holder.prev.resources,
          coreResourcesAfter: outcome.state.resources,
          coreResourceDelta: outcome.state.resources - holder.prev.resources,
          coreState: outcome.state.core?.state ?? null,
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
          // W50 四计数器：唯一 ownership-aware SSOT，避免把敌方事件计入本租户。
          ...outcomeCounters,
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

        // Worker 级活性检测：租户整体 moveCount>0 不能证明每个 Worker 都在工作。
        // 生产实证：t1/t4 有 Worker 36 tick GO_RESOURCE+WAIT 原地不动；t3 单 Worker
        // 每 tick MOVE 却只在两格振荡。这里按 unitId 关联“上一 tick 计划 → 当前结果”，
        // 局部异常只 reset+rotate 对应 Worker，不触发全租户 StallRecovery。
        const humanControlledUnitIds = new Set(
          outcome.humanOverride?.active === true ? outcome.humanOverride.applied : [],
        );
        const workerLivenessEvents = workerLiveness.onObservation({
          tick: outcome.tick,
          workers: outcome.state.workers,
          unitActions: outcome.plan.unitActions,
          intents: outcome.plan.intents,
          progressExpectations: planner instanceof DeterministicPlanner
            ? planner.workerProgressExpectations()
            : undefined,
          humanControlledUnitIds,
        });
        // 打转封锁（W5）UNIT_MOVE_SUCCEEDED 清账：目标已到达不再是封锁候选，
        // 在 onObservation 之后、recoverWorker 之前清 plannedMove，避免刚成功的
        // worker 因残留 plannedMove 在后续 MOVE_FAILED 时被误封锁。变体关时
        // applyBlockadeClearPlannedMoves no-op（零回归）。
        applyBlockadeClearPlannedMoves(
          outcome.state.events,
          workerLiveness,
          activeStrategy.safetyOverrides.spinBlockade === true,
        );
        for (const event of workerLivenessEvents) {
          let recovery: ReturnType<typeof planner.recoverWorker> | null = null;
          let recoveryError: string | null = null;
          try {
            recovery = planner.recoverWorker(event.unitId, event.tick);
          } catch (error) {
            recoveryError = error instanceof Error ? error.message : String(error);
          }
          // 打转封锁（W5）blockCell：recoverWorker 后把死目标格写入封锁冷却，
          // Hungarian 下一 tick 重派时 isCellBlocked 排后——根治"检测→恢复→
          // 重派→再打转"循环。penalty 按 kind（blockadePenaltyTicksFor）：
          // oscillation=16、moveNoEffect=12、其他=4。blockedTarget 缺省
          // （非 movement-failure 类或新鲜目标保护）= 不调。变体关时
          // applyBlockadeBlocks no-op（零回归）。
          applyBlockadeBlocks(
            workerLivenessEvents,
            workerLiveness,
            activeStrategy.safetyOverrides.spinBlockade === true,
          );
          appendHealthEvent(
            `worker=${event.unitId.slice(0, 8)} kind=${event.kind}@tick=${event.tick}(streak=${event.streak})`,
          );
          appendJsonlLine(
            join(dirs.telemetryDir, "runtime.jsonl"),
            JSON.stringify(sanitizeValue({
              processRunId,
              tenantId: config.tenantId,
              tick: event.tick,
              telemetryType: "worker_liveness",
              workerLivenessKind: event.kind,
              unitId: event.unitId,
              streak: event.streak,
              position: event.position,
              cargo: event.cargo,
              priorActionType: event.priorActionType,
              priorIntent: event.priorIntent,
              recentPositions: event.recentPositions,
              uniqueRecentPositions: event.uniqueRecentPositions,
              explorationChunk: event.explorationChunk,
              knownExplorationChunks: event.knownExplorationChunks,
              recoveryCount: event.recoveryCount,
              recoveryApplied: recovery !== null,
              recovery,
              recoveryError,
            })),
          );
        }

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
        // 2026-08-10 GAP fix：4 新 stall 模式（military_interlock /
        // shot_missed_spiral / migration_stall / spawn_stall）的数据源是
        // failedEventCounts + militaryCount + shotHitCount。82c1ca7 新增了
        // 这些字段到 StallObservation 接口，但调用方未传入 → 4 模式恒
        // false（obs.failedEventCounts === undefined → failedCount=0）。
        // 修复：从已计算的 failedEvents 数组聚合 counts，从 events 取
        // SHOT_HIT 计数，从 units 取军事单位数。
        const stallFailedEventCounts: Record<string, number> = {};
        for (const ev of failedEvents) {
          const type = ev.eventType;
          stallFailedEventCounts[type] = (stallFailedEventCounts[type] ?? 0) + 1;
        }
        const stallShotHitCount = outcome.state.events.filter(
          (event) => event.eventType === "SHOT_HIT",
        ).length;
        const stallMilitaryCount =
          outcome.state.vanguards.length + outcome.state.rangers.length;

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
          failedEventCounts: stallFailedEventCounts,
          militaryCount: stallMilitaryCount,
          shotHitCount: stallShotHitCount,
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
          failedEventCounts: stallFailedEventCounts,
          shotHitCount: stallShotHitCount,
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
        // GAP 1.1 fix（2026-08-10）：per-kind 恢复副作用。StallRecovery 在
        // recovering 状态的首个 tick 返回一次 side effect，调用方据此执行
        // 代码级干预（MacroPolicy 只能间接引导，某些 stall 需直接操作记忆）。
        // clear_enemy_core_memory：shot_missed_spiral 清陈旧敌核记忆 → 游侠
        //   不再对死核/迁移核空枪。
        // trigger_migration_replan：migration_stall 重规划迁移路径。
        // trigger_worker_yield：spawn_stall 让 Core 格 worker 让位。
        const recoverySideEffect = stallRecovery.recoverySideEffect();
        if (recoverySideEffect !== null && planner instanceof SafetyPlanner) {
          switch (recoverySideEffect) {
            case "clear_enemy_core_memory": {
              const cleared = planner.world.clearCoreHuntMemory();
              appendJsonlLine(
                join(dirs.telemetryDir, "runtime.jsonl"),
                JSON.stringify(sanitizeValue({
                  processRunId,
                  tenantId: config.tenantId,
                  tick: outcome.tick,
                  telemetryType: "stall_recovery_side_effect",
                  sideEffect: "clear_enemy_core_memory",
                  clearedCount: cleared,
                })),
              );
              break;
            }
            case "trigger_migration_replan":
              appendJsonlLine(
                join(dirs.telemetryDir, "runtime.jsonl"),
                JSON.stringify(sanitizeValue({
                  processRunId,
                  tenantId: config.tenantId,
                  tick: outcome.tick,
                  telemetryType: "stall_recovery_side_effect",
                  sideEffect: "trigger_migration_replan",
                })),
              );
              break;
            case "trigger_worker_yield":
              appendJsonlLine(
                join(dirs.telemetryDir, "runtime.jsonl"),
                JSON.stringify(sanitizeValue({
                  processRunId,
                  tenantId: config.tenantId,
                  tick: outcome.tick,
                  telemetryType: "stall_recovery_side_effect",
                  sideEffect: "trigger_worker_yield",
                })),
              );
              break;
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
        unitIds: outcome.state.units.map((unit) => unit.id),
      };
      processedTickCount += 1;
      if (outcome.submitAttempted) liveSubmitCount += 1;
      calibrationRecorder?.observe(outcome);
      if (options.maxTicks !== undefined && processedTickCount >= options.maxTicks) {
        requestStop();
      }
    };

    // 8) 主循环（signal/maxTicks → 终止 turns → 当前 Tick 提交完成后自然停止）
    // 迁移运行时配置（migration-system-v1 §7）：默认全关；显式注入
    // ARENA_MIGRATION_CONFIG=<json 路径> 才激活（enabled+enableCoreOrders 置 true）。
    const migrationConfig: MigrationRuntimeConfig = loadMigrationRuntimeConfig(
      process.env.ARENA_MIGRATION_CONFIG ?? null,
    );
    let lastReportTick = 0;
    let lastReportPhase: string | null = null;
    // M6 迁移助手（migration-assist-v1）：上一 tick 核心快照（失败签名对比用）。
    let prevAssistCore: AssistCoreSnapshot | null = null;
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
      // 迁移 overlay（migration-system-v1 §1/§6.2）：plan → overlay → override → submit。
      // 模块默认关；无计划文件 = 零影响。lease/epoch/coreId 任一不满足 → fail-closed。
      migrationOverlay: ({ state, plan, nowMs, phase }) => {
        if (!migrationConfig.enabled) return null;
        // M6 迁移助手核心快照（手动窗口抑制/清路订单/失败签名共用）。
        const assistCore: AssistCoreSnapshot = state.core === null
          ? { position: null, state: null, destination: null, moveProgress: null, moveRequiredTicks: null }
          : {
              position: state.core.position ?? null,
              state: state.core.state,
              destination: null,
              moveProgress: null,
              moveRequiredTicks: null,
            };
        const read = readMigrationPlan(migrationPlanPath(dataRoot, config.tenantId));
        if (!read.ok) {
          // M6 手动窗口抑制（migration-assist-v1 §4-E）：核心 MOVING 且无计划
          // 文件 = 用户手操迁移窗口——planner 不抢方向（START_MOVE → null）。
          // 必须在 read 之前生效（手操场景恰是无计划文件）。
          if (phase === "pre-submit" && assistCore.state === "MOVING" && plan.coreAction?.type === "START_MOVE") {
            return { plan: { ...plan, coreAction: null }, active: false, failClosed: false };
          }
          return null;
        }
        if (phase === "pre-decision") {
          // 勘探前向约束（migration-system-v1 §3.3，评审 P1）：决策前把计划注入
          // planner——EXPLORE worker 朝计划路径前向探路（替代 core 坐标差分触发）；
          // SafetyPlanner 迁移激活期（LEG_MOVE）军事守位统一外环（防军事贴核心
          // 围死移动中的核心，2026-08-09）。
          if (planner instanceof DeterministicPlanner) planner.setMigrationPlan(read.plan);
          if (planner instanceof SafetyPlanner) planner.setMigrationPlan(read.plan);
          return null; // 预决策钩子不产订单
        }
        const result = applyMigrationOverlay({
          state: { tick: state.tick, core: state.core ?? null },
          plan,
          migrationPlan: read.plan,
          nowMs,
          // M2：overlay 在提交时点读文件，文件即最新；epoch 错配场景由单测
          // 覆盖，conductor 落线后经 tick 起始快照校验真正 fencing。
          fileEpoch: read.plan.conductorEpoch,
          config: migrationConfig,
        });
        // worker 集结带（migration-system-v1 §3.3）：min 叠加既有权威上限；
        // 仅 SafetyPlanner（DeterministicPlanner 的 fallback config 由
        // deterministicOverrides 路径管理，conductor 落线时一并接线）。
        if (
          planner instanceof SafetyPlanner &&
          result.workerBand !== (planner.config.migrationWorkerBand ?? null)
        ) {
          planner.updateConfig({
            ...planner.config,
            migrationWorkerBand: result.workerBand ?? undefined,
          });
        }
        // KPI 报告（migration-system-v1 §8）：活跃期相位变化或每 60 tick 落一条
        // JSONL（报告失败不阻断决策——遥测侧兜底）。
        if (result.active) {
          const currentPhase = read.plan.state;
          if (currentPhase !== lastReportPhase || state.tick - lastReportTick >= 60) {
            lastReportPhase = currentPhase;
            lastReportTick = state.tick;
            try {
              const cellsRemaining = Math.max(
                0,
                read.plan.path.cells.length - read.plan.legProgress.cellsThisLeg - read.plan.legProgress.legIndex,
              );
              appendMigrationReport(migrationReportPath(dataRoot, config.tenantId), {
                schema: "migration-report-v1",
                tick: state.tick,
                tenant: config.tenantId,
                operationId: read.plan.operationId,
                phase: currentPhase,
                burstCells: read.plan.pace.burstCells,
                settleTicks: read.plan.pace.settleTarget,
                coreReceptiveRatio: coreReceptiveRatio(read.plan.pace.burstCells, read.plan.pace.settleTarget),
                grossDeposit: null, // 经济真值由遥测统计接入（conductor 落线后补）
                harvest: null,
                net: null,
                cellsRemaining,
                idealEtaTicks: idealEtaTicks(cellsRemaining, read.plan.legs.length - read.plan.legProgress.legIndex - 1, read.plan.pace.settleTarget),
                observedEtaTicks: null,
                observedCellsPerTick: null,
                reasons: [...result.reasons],
                updatedAt: new Date().toISOString(),
              });
            } catch {
              // 报告落盘失败不阻断决策
            }
          }
        }
        // M6 迁移助手（migration-assist-v1）：手动窗口抑制 + 清路订单 + 失败签名。
        // 在 overlay 之后、humanOverride 之前生效（loop 内 overlay 即在此点）。
        // assistCore 已在闭包头部提取（read 失败分支的手动窗口抑制共用）。
        const assist = migrationAssist({
          tick: state.tick,
          core: assistCore,
          units: (state.units ?? []).map((unit) => ({
            id: unit.id,
            unitType: unit.unitType,
            position: unit.position,
            cargo: unit.cargo ?? 0,
          })),
          plan: read.plan,
          planActive: result.active,
        });
        let assistPlan = result.plan;
        // 手动窗口抑制（§4-E）：用户手操核心方向时 planner 不抢方向（START_MOVE → null）。
        if (assist.suppressCoreOrder && assistPlan.coreAction?.type === "START_MOVE") {
          assistPlan = { ...assistPlan, coreAction: null };
        }
        // 清路订单（§4-A）：clearRequests 格上的我方单位 → 让位 MOVE（覆盖 planner 该单位动作）。
        if (assist.clearOrders.length > 0) {
          const unitActions = { ...assistPlan.unitActions };
          for (const order of assist.clearOrders) {
            unitActions[order.unitId] = { type: "MOVE", direction: order.direction };
          }
          assistPlan = { ...assistPlan, unitActions };
        }
        // M8 卸货等待订单（migration-survival-v1 §5）：核心格容量已满 → 满载 worker
        // 停在邻格（WAIT，不挤入核心格），空出卸货位后自然放行。
        if (assist.waitOrders.length > 0) {
          const unitActions = { ...assistPlan.unitActions };
          for (const order of assist.waitOrders) {
            unitActions[order.unitId] = { type: "WAIT" };
          }
          assistPlan = { ...assistPlan, unitActions };
        }
        // 失败签名遥测（§4-D）：MOVING→NORMAL 位置未变 = 引擎拒（占位者不移走等）。
        if (prevAssistCore !== null && detectMigrationFailure(prevAssistCore, assistCore)) {
          try {
            appendJsonlLine(
              join(baseDir, config.tenantId, "telemetry", "assist-events.jsonl"),
              JSON.stringify({
                schema: "migration-assist-event-v1",
                tick: state.tick,
                tenant: config.tenantId,
                event: "migrate_failed",
                position: assistCore.position,
                reason: "MOVING→NORMAL 位置未变（引擎拒：占位者不移走/争抢/容量 R3/R4）",
              }),
            );
          } catch {
            // 遥测失败不阻断决策
          }
        }
        prevAssistCore = assistCore;
        return { plan: assistPlan, active: result.active, failClosed: result.failClosed };
      },
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



/** 跨 run 测绘种子（2026-08-08，survey-db 联动）：从测绘库读最近确认的活跃矿
 *  （state ∈ visible/stale、last_seen 距今 ≤ maxAgeTicks）注入 worker 记忆——
 *  重启后不再从零探索。库缺失/损坏/无矿 = 空数组零回归（不阻塞生产启动）。
 *
 *  死格过滤（2026-08-08，缺席实证）：已知矿格近 absentWindowTicks 内缺席
 *  （我方视野确认无矿，A15 负观测）次数 ≥ absenceThreshold 的格视为长期死格
 *  ——官方 refill 是 chunk 级补充（Replenishment may later create a natural
 *  replacement elsewhere in the chunk），格级缺席往往永久；t2 实证缺席→恢复
 *  中位 133 tick、561 格中 p90 缺席 1378 次。把这些格从 seed 剔除，worker
 *  重启后不扑死种子（t2 实证 12 worker 反复追死种子的根因之一）。
 *  seed 语义只影响"启动时的候选矿"，运行期可见矿 / markResourceFailed 照常。 */
function loadSurveyResourceSeed(
  dataRoot: string,
  tenantId: string,
  maxAgeTicks = 20_000,
  absenceThreshold = 512,
  absentWindowTicks = 20_000,
): readonly Position[] {
  try {
    const db = openSurveyDb(dataRoot, tenantId, false);
    const rows = knownResources(db, { states: ["visible", "stale"] });
    if (rows.length === 0) {
      db.close();
      return [];
    }
    let maxTick = 0;
    for (const row of rows) if (row.lastSeenTick > maxTick) maxTick = row.lastSeenTick;
    const cutoff = maxTick - maxAgeTicks;
    const active = rows.filter((row) => row.lastSeenTick >= cutoff);
    if (active.length === rows.length) {
      db.close();
      return active.map((row) => [row.x, row.y] as const);
    }
    // 死格过滤：缺席 ≥ 阈值的格不注入（只过滤有缺席记录的格，缺表/空表零回归）。
    const absenceCounts = knownResourceAbsenceCounts(db, maxTick - absentWindowTicks);
    db.close();
    return active
      .filter((row) => (absenceCounts.get(row.cell) ?? 0) < absenceThreshold)
      .map((row) => [row.x, row.y] as const);
  } catch {
    return [];
  }
}

/** 分级冷却加载（2026-08-08，缺席实证）：survey-db 缺席统计 → per-cell 失败冷却
 *  分级（cooldownTierForAbsenceCount：≥128 → 96 / ≥512 → 192 / ≥2048 → 384 tick）。
 *  返回 { position, cooldownTicks }[] 供 World.seedFailedCooldownTiers 注入——
 *  高频缺席格证伪后冷却更长，worker 不每 32 tick 白试长期死格。可见优先语义
 *  不变（refill 后重新可见立即恢复，冷却只压 stale/seeded 记忆）。空表 = 零回归。 */
function loadSurveyCooldownTiers(
  dataRoot: string,
  tenantId: string,
  absentWindowTicks = 20_000,
): readonly { position: Position; cooldownTicks: number }[] {
  try {
    const db = openSurveyDb(dataRoot, tenantId, false);
    let maxTick = 0;
    const maxRow = db.prepare("SELECT MAX(tick) AS m FROM resource_absences").get() as { m: number | null } | undefined;
    if (maxRow !== undefined && typeof maxRow.m === "number") maxTick = maxRow.m;
    if (maxTick === 0) {
      db.close();
      return [];
    }
    const tiers = knownResourceCooldownTiers(db, maxTick - absentWindowTicks);
    db.close();
    const out: { position: Position; cooldownTicks: number }[] = [];
    for (const [cell, cooldownTicks] of tiers) {
      const [x, y] = cell.split(",").map((v) => Number(v));
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      out.push({ position: [x, y] as Position, cooldownTicks });
    }
    return out;
  } catch {
    return [];
  }
}
/** 跨 run 测绘种子（2026-08-08，统一捕获链路）：从测绘库读最近确认的敌核心
 *  （core_hunts，last_seen 距今 ≤ maxAgeTicks）注入 World 敌情狩猎记忆——
 *  重启后军事仍记得敌方基地（比 calibration 扫描更全：跨 run 累积，不受
 *  最新 run 采样窗口限制）。库缺失/损坏 = 空数组零回归。 */
function loadSurveyCoreHuntSeed(dataRoot: string, tenantId: string, maxAgeTicks = 20_000): readonly CoreHuntTarget[] {
  try {
    const db = openSurveyDb(dataRoot, tenantId, false);
    const rows = knownCoreHunts(db);
    db.close();
    if (rows.length === 0) return [];
    let maxTick = 0;
    for (const row of rows) if (row.lastSeenTick > maxTick) maxTick = row.lastSeenTick;
    const cutoff = maxTick - maxAgeTicks;
    return rows
      .filter((row) => row.lastSeenTick >= cutoff)
      .map((row) => ({
        position: [row.x, row.y] as const,
        lastSeenTick: row.lastSeenTick,
        source: row.source,
        owner: row.owner ?? null,
      }));
  } catch {
    return [];
  }
}

/** 跨 run 测绘种子（2026-08-08，统一捕获链路）：从测绘库读全部已知障碍
 *  （obstacles，静态地形跨 run 稳定，不做新鲜度过滤）注入 World 障碍记忆——
 *  重启后导航/寻路直接准确。库缺失/损坏 = 空数组零回归。 */
function loadSurveyObstacleSeed(dataRoot: string, tenantId: string): readonly Position[] {
  try {
    const db = openSurveyDb(dataRoot, tenantId, false);
    const rows = knownObstacles(db);
    db.close();
    if (rows.length === 0) return [];
    return rows.map((row) => [row.x, row.y] as const);
  } catch {
    return [];
  }
}
/** 跨 run 测绘种子（2026-08-08，探索分区记忆）：从测绘库读最近探索的 chunk
 *  （chunks 表，last_seen 距今 ≤ maxAgeTicks）注入 World.chunkMemory——
 *  "探索过的区域"跨重启保留，frontier 探索（未观察分区优先）不丢。 */
function loadSurveyChunkSeed(dataRoot: string, tenantId: string, maxAgeTicks = 20_000): readonly { key: string; lastSeenTick: number }[] {
  try {
    const db = openSurveyDb(dataRoot, tenantId, false);
    const rows = knownChunks(db, 0);
    db.close();
    if (rows.length === 0) return [];
    let maxTick = 0;
    for (const row of rows) if (row.lastSeenTick > maxTick) maxTick = row.lastSeenTick;
    const cutoff = maxTick - maxAgeTicks;
    return rows.filter((row) => row.lastSeenTick >= cutoff);
  } catch {
    return [];
  }
}

