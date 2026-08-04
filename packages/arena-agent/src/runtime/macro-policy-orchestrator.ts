/**
 * MacroPolicyOrchestrator：低频战略参数产出（MASTER.md：per-tick LLM 不作为
 * 生产主线；低频 MacroPolicy 异步输出有限战略参数）。
 *
 * - 每 intervalTicks（缺省 32）触发一次 Pi 策略决策，**不占 tick 窗口**：
 *   异步执行（60s 宽松超时），完成前 current 保持上次策略（sticky）；
 * - 失败/超时 → sticky 沿用上次策略，不降级为每 tick 重试轰炸；
 * - 输出仅限结构化 MacroPolicy（数值/枚举），执行层直接消费；
 * - telemetry：每次策略更新回调 onPolicyUpdate（tenant-runtime 落盘）。
 */

import { MacroPolicy, DEFAULT_MACRO_POLICY, isValidMacroPolicy, normalizeMacroPolicy } from "./macro-policy.ts";
import type { TickState } from "../domain/model.ts";

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
  /** 决策超时（ms，缺省 60000）。 */
  readonly timeoutMs?: number;
  /** 时钟注入（测试用；缺省 performance.now）。 */
  readonly nowMs?: () => number;
}

export class MacroPolicyOrchestrator {
  readonly intervalTicks: number;
  /** 当前生效策略（sticky：失败/未产出时保持）。 */
  current: MacroPolicy = DEFAULT_MACRO_POLICY;

  private readonly promptBuilder: (state: TickState) => string;
  private readonly requestPolicy: (prompt: string) => Promise<string>;
  private readonly onPolicyUpdate?: (policy: MacroPolicy, tick: number) => void;
  private readonly onPolicyError?: (message: string, tick: number) => void;
  private readonly timeoutMs: number;
  private lastPolicyTick = Number.NEGATIVE_INFINITY;
  private inFlight = false;
  private lastError: string | null = null;

  constructor(options: MacroPolicyOrchestratorOptions) {
    if (!Number.isInteger(options.intervalTicks ?? 32) || (options.intervalTicks ?? 32) < 1) {
      throw new RangeError("intervalTicks must be a positive integer");
    }
    this.intervalTicks = options.intervalTicks ?? 32;
    this.promptBuilder = options.promptBuilder;
    this.requestPolicy = options.requestPolicy;
    this.onPolicyUpdate = options.onPolicyUpdate;
    this.onPolicyError = options.onPolicyError;
    this.timeoutMs = options.timeoutMs ?? 60000;
  }

  /** 每次决策 Tick 调用：返回当前生效策略；到周期且空闲时异步触发一次策略产出。 */
  onTick(state: TickState): MacroPolicy {
    if (!this.inFlight && state.tick - this.lastPolicyTick >= this.intervalTicks) {
      this.inFlight = true;
      void this.runPolicyDecision(state)
        .catch((error: unknown) => {
          // 决策失败：sticky 上次策略；记录失败原因；推进周期（下一个 intervalTicks 再试，不轰炸）
          this.lastError = error instanceof Error ? error.message : String(error);
          this.lastPolicyTick = state.tick;
          this.onPolicyError?.(this.lastError, state.tick);
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
    const prompt = this.promptBuilder(state);
    const timer = new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error("macro policy decision timeout")), this.timeoutMs);
    });
    const text = await Promise.race([this.requestPolicy(prompt), timer]);
    const policy = parsePolicyText(text);
    this.current = policy;
    this.lastPolicyTick = state.tick;
    this.onPolicyUpdate?.(policy, state.tick);
  }
}

/** 解析 LLM 策略输出：剥 markdown 围栏 → 提取 JSON 对象 → 校验 → 规范化。
 *  非 JSON / 非法值域 → 抛错（调用方 sticky 处理）。 */
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
  if (!isValidMacroPolicy(raw)) {
    throw new Error(`macro policy: value out of domain: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  return normalizeMacroPolicy(raw as unknown as Record<string, unknown>);
}
