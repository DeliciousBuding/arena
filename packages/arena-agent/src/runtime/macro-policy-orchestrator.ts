/**
 * MacroPolicyOrchestrator：低频战略参数产出（MASTER.md：per-tick LLM 不作为
 * 生产主线；低频 MacroPolicy 异步输出有限战略参数）。
 *
 * - 每 intervalTicks（缺省 32）触发一次 Pi 策略决策，**不占 tick 窗口**：
 *   异步执行（60s 宽松超时），完成前 current 保持上次策略（sticky）；
 * - 失败/超时 → sticky 沿用上次策略，不降级为每 tick 重试轰炸；
 * - 输出仅限结构化 MacroPolicy（数值/枚举），执行层直接消费；
 * - telemetry：每次策略更新回调 onPolicyUpdate（tenant-runtime 落盘）；
 * - M2b：每个决策点生成 bounded candidate set（M2a.1 契约），决策完成后
 *   回调 onDecisionPoint（shadow telemetry，生产行为零变化——LLM 仍唯一
 *   选择者，事件只记录候选宇宙与选定候选）。
 */

import { type MacroPolicy, DEFAULT_MACRO_POLICY, isValidMacroPolicy, normalizeMacroPolicy } from "./macro-policy.ts";
import type { TickState } from "../domain/model.ts";
import { generateCandidateSet } from "../offline-learning/candidate/candidate-generator.ts";
import { computeCandidateSetHash } from "../offline-learning/candidate/decision-candidate-v1.ts";
import {
  resolveChosenCandidate,
  type MacroDecisionPointV1,
} from "../offline-learning/runtime/macro-decision-point.ts";

export interface MacroPolicyOrchestratorOptions {
  /** 策略决策周期（ticks，缺省 32）。 */
  readonly intervalTicks?: number;
  /** 宏观状态 → 策略 prompt（纯文本；模型只输出策略 JSON）。 */
  readonly promptBuilder: (state: TickState) => string;
  /** Pi session 单次决策（超时由调用方控制，不阻塞 tick 窗口）。 */
  readonly requestPolicy: (prompt: string) => Promise<string>;
  /** 策略更新回调（telemetry 落盘用；参数 = 新策略与产出 tick）。 */
  readonly onPolicyUpdate?: (policy: MacroPolicy, tick: number) => void;
  /** 策略决策失败回调（telemetry 落盘用；参数 = 失败原因与 tick）。 */
  readonly onPolicyError?: (message: string, tick: number) => void;
  /**
   * M2b：决策点 shadow 回调（候选宇宙 + 选定候选；决策点 identity 用）。
   * 生产语义不变——LLM 仍唯一选择者；事件仅记录。
   */
  readonly onDecisionPoint?: (event: MacroDecisionPointV1) => void;
  /** 决策点 identity 前缀（processRunId；tenant-runtime 注入）。 */
  readonly processRunId?: string;
  /** 决策超时（ms，缺省 60000）。 */
  readonly timeoutMs?: number;
  /** 时钟注入（测试用；缺省 performance.now）。 */
  readonly nowMs?: () => number;
  /** 固定策略覆盖（实验框架）：非 null 时 onTick 恒返回该策略，不触发 LLM 决策。 */
  readonly override?: MacroPolicy | null;
}

/** Core 被摧毁/重生期间的强制经济重建策略（覆盖 sticky/LLM 决策，避免激进前压送死）。 */
export const RESPAWN_OVERRIDE_POLICY: MacroPolicy = {
  posture: "harvest",
  workerTarget: 3,
  militaryRatio: 0,
  focusRegion: null,
  attackPriority: null,
};

/** 重生结束判定：恢复 ACTIVE 且存活 Worker 达到重建阈值（>=3）才释放覆盖。 */
export function isRespawnRecovered(state: TickState): boolean {
  return state.status === "ACTIVE" && state.workers.length >= 3;
}

export class MacroPolicyOrchestrator {
  readonly intervalTicks: number;
  /** 当前生效策略（sticky：失败/未产出时保持）。 */
  current: MacroPolicy = DEFAULT_MACRO_POLICY;

  private readonly promptBuilder: (state: TickState) => string;
  private readonly requestPolicy: (prompt: string) => Promise<string>;
  private readonly onPolicyUpdate?: (policy: MacroPolicy, tick: number) => void;
  private readonly onPolicyError?: (message: string, tick: number) => void;
  private readonly onDecisionPoint?: (event: MacroDecisionPointV1) => void;
  private readonly decisionPointPrefix: string;
  private readonly timeoutMs: number;
  /** 固定策略覆盖（实验框架）：非 null 时恒返回该策略，不触发 LLM 决策。 */
  private readonly override: MacroPolicy | null;
  private lastPolicyTick = Number.NEGATIVE_INFINITY;
  private inFlight = false;
  private lastError: string | null = null;
  /** 重生覆盖边沿检测：true = 上一 tick 处于重生/无 Core（恢复后立即决策一次）。 */
  private wasRespawning = false;

  constructor(options: MacroPolicyOrchestratorOptions) {
    if (!Number.isInteger(options.intervalTicks ?? 32) || (options.intervalTicks ?? 32) < 1) {
      throw new RangeError("intervalTicks must be a positive integer");
    }
    this.intervalTicks = options.intervalTicks ?? 32;
    this.promptBuilder = options.promptBuilder;
    this.requestPolicy = options.requestPolicy;
    this.onPolicyUpdate = options.onPolicyUpdate;
    this.onPolicyError = options.onPolicyError;
    this.onDecisionPoint = options.onDecisionPoint;
    this.decisionPointPrefix = options.processRunId ?? "no-process";
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.override = options.override ?? null;
    if (this.override !== null) {
      this.current = this.override;
    }
  }

  /**
   * M2b shadow: emit a decision-point event AFTER the decision completes
   * (success → chosenBy=policy-llm; sticky failure → chosenBy=policy-sticky).
   * Candidate generation must never influence production: any failure here
   * only skips the shadow record.
   */
  private emitDecisionPoint(
    state: TickState,
    previousPolicy: MacroPolicy,
    newPolicy: MacroPolicy,
    chosenBy: "policy-llm" | "policy-sticky",
  ): void {
    if (this.onDecisionPoint === undefined) return;
    try {
      const candidates = generateCandidateSet(state, previousPolicy);
      const chosen = resolveChosenCandidate(candidates, newPolicy);
      this.onDecisionPoint({
        schema: "macro-decision-point-v1",
        decisionPointId: `${this.decisionPointPrefix}:${state.tick}`,
        processRunId: this.decisionPointPrefix,
        tick: state.tick,
        intervalTicks: this.intervalTicks,
        previousPolicy,
        newPolicy,
        chosenBy,
        candidates,
        candidateSetHash: computeCandidateSetHash(candidates),
        chosenCandidateHash: chosen.candidate.deterministicHash,
      });
    } catch (error) {
      // Shadow must never break production decision flow.
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  /** 每次决策 Tick 调用：返回当前生效策略；到周期且空闲时异步触发一次策略产出。
   *  重生覆盖：Core 不存在或 status=RESPAWNING 时强制返回经济重建策略
   *  （RESPAWN_OVERRIDE_POLICY），不消费 LLM 决策；恢复 ACTIVE 且 pop>=3 后
   *  立即触发一次新决策（重置周期边沿）。
   *  实验覆盖（override）：恒返回固定策略，不触发 LLM 决策。 */
  onTick(state: TickState): MacroPolicy {
    if (this.override !== null) {
      return this.override;
    }
    const respawning = state.core === null || state.status === "RESPAWNING";
    if (respawning) {
      this.wasRespawning = true;
      // 重生期不触发 LLM 决策（无意义且浪费）；周期持续推进避免恢复后误判超周期
      this.lastPolicyTick = state.tick;
      return RESPAWN_OVERRIDE_POLICY;
    }
    if (this.wasRespawning) {
      this.wasRespawning = false;
      this.lastPolicyTick = Number.NEGATIVE_INFINITY;
    }
    if (!this.inFlight && state.tick - this.lastPolicyTick >= this.intervalTicks) {
      this.inFlight = true;
      const previousPolicy = this.current;
      void this.runPolicyDecision(state)
        .catch((error: unknown) => {
          // 决策失败：sticky 上次策略；记录失败原因；推进周期（下一个 intervalTicks 再试，不轰炸）
          this.lastError = error instanceof Error ? error.message : String(error);
          this.lastPolicyTick = state.tick;
          this.onPolicyError?.(this.lastError, state.tick);
          // M2b shadow: the decision point still happened (sticky outcome).
          this.emitDecisionPoint(state, previousPolicy, this.current, "policy-sticky");
        })
        .finally(() => {
          this.inFlight = false;
        });
    }
    return this.current;
  }

  /** 上次决策失败原因（遥测/调试）。 */
  get lastDecisionError(): string | null {
    return this.lastError;
  }

  private async runPolicyDecision(state: TickState): Promise<void> {
    this.lastError = null;
    const previousPolicy = this.current;
    const prompt = this.promptBuilder(state);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<string>((_, reject) => {
      timer = setTimeout(() => reject(new Error("macro policy decision timeout")), this.timeoutMs);
    });
    try {
      const text = await Promise.race([this.requestPolicy(prompt), timeoutPromise]);
      const policy = parsePolicyText(text);
      this.current = policy;
      this.lastPolicyTick = state.tick;
      this.onPolicyUpdate?.(policy, state.tick);
      // M2b shadow: candidate universe + the LLM-selected candidate.
      this.emitDecisionPoint(state, previousPolicy, policy, "policy-llm");
    } finally {
      // The race timer must not outlive the decision (event-loop hygiene).
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** 解析 LLM 策略输出：剥 markdown 围栏 → 提取 JSON 对象 → 校验 → 规范化。
 *  非 JSON / 非法值域 → 抛错（调用方 sticky 处理）。
 *  2026-08-06 第十五轮修复（normalize-first）：生产 t1 实测 9/56（16%）policy
 *  被拒——LLM 把 attackPriority 序列化成字符串 "null"（`"attackPriority":"null"`），
 *  isValidMacroPolicy 严格校验先行拒绝整条策略。normalizeMacroPolicy 已对
 *  "null"→null、未知 posture→balanced、非法数值→默认值 全部容错——改为先
 *  normalize 后校验（校验永远通过：normalize 输出必合法），LLM 小错误不再
 *  浪费整条策略更新（16% → ~0%）。 */
export function parsePolicyText(text: string): MacroPolicy {
  const trimmed = text.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd <= jsonStart) {
    throw new Error("macro policy: no JSON object in model output");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
  } catch (error) {
    throw new Error(`macro policy: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("macro policy: value out of domain: non-object output");
  }
  return normalizeMacroPolicy(raw as Record<string, unknown>);
}
