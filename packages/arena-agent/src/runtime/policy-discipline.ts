/**
 * PolicyDiscipline：策略层决策纪律状态机（决策指挥闭环的上游环节）。
 *
 * 背景（2026-08-05 生产事故）：policy 层（LLM）连续输出 [1500,1500]/
 * [-1500,1500]/[0,0] 等不可达 focusRegion，执行层防呆（maxFocusDistance）
 * 只负责"不被支走"，但 policy 层会**反复**产出坏焦点（每 32 tick 一次）——
 * 防呆是下游兜底，纪律是上游纠错。
 *
 * 设计：policy 层每次输出超距 focusRegion（以 Core 为圆心，> maxFocusDistance）
 * 记一次 invalidFocus；连续达阈值 → 禁言（silence）：禁言期内 policy 层的
 * focusRegion 一律强制 null（保留其余字段），期满自动解除。禁言/解除全部落盘
 * policy_discipline 事件（policy.jsonl），执行层（StallRecovery）与策略层
 * （prompt 摘要）都能感知指挥状态。
 *
 * 与 StallRecovery 分工：recovery 处理"已经卡死"（发现→跳出→升级）；discipline
 * 处理"产出坏决策"（防反复犯错）。两者都只改 focusRegion，最小干预。
 */

import type { Position } from "../domain/model.ts";
import type { MacroPolicy } from "./macro-policy.ts";

export interface PolicyDisciplineEvent {
  readonly kind: "invalid_focus" | "silence_started" | "silence_ended";
  readonly tick: number;
  /** invalid_focus：当前连续无效次数；silence_started：触发的次数。 */
  readonly count: number;
  readonly focusRegion: readonly [number, number] | null;
}

export interface PolicyDisciplineConfig {
  /** 与 SafetyPlanner 防呆一致：focusRegion 距 Core 超此距离视为无效。默认 32。 */
  readonly maxFocusDistance?: number;
  /** 连续无效焦点达此次数 → 禁言。默认 2（一次可能是失误，两次是模式）。 */
  readonly invalidFocusThreshold?: number;
  /** 禁言持续 tick 数（≈4 个 policy 周期）。默认 128。 */
  readonly silenceTicks?: number;
}

export const DEFAULT_POLICY_DISCIPLINE_CONFIG: Required<PolicyDisciplineConfig> = {
  maxFocusDistance: 32,
  invalidFocusThreshold: 2,
  silenceTicks: 128,
};

export class PolicyDiscipline {
  private readonly maxFocusDistance: number;
  private readonly invalidFocusThreshold: number;
  private readonly silenceTicks: number;
  private invalidFocusStreak = 0;
  private silencedUntilTick = -1;

  constructor(config: PolicyDisciplineConfig = {}) {
    const merged = { ...DEFAULT_POLICY_DISCIPLINE_CONFIG, ...config };
    this.maxFocusDistance = merged.maxFocusDistance;
    this.invalidFocusThreshold = merged.invalidFocusThreshold;
    this.silenceTicks = merged.silenceTicks;
  }

  /** 当前是否处于禁言期。 */
  isSilenced(tick: number): boolean {
    return tick <= this.silencedUntilTick;
  }

  /**
   * 对 policy 层产物应用纪律。返回修正后的 policy 与本次纪律事件（无事件为 null）。
   * 修正规则：禁言期内 focusRegion 强制 null；连续无效焦点达阈值触发禁言。
   */
  apply(
    policy: MacroPolicy,
    state: { readonly tick: number; readonly core: { readonly position: Position } | null },
  ): { readonly policy: MacroPolicy; readonly event: PolicyDisciplineEvent | null } {
    const focus = policy.focusRegion;
    if (this.isSilenced(state.tick)) {
      if (focus !== null) {
        return {
          policy: { ...policy, focusRegion: null },
          event: null,
        };
      }
      return { policy, event: null };
    }

    if (focus === null) {
      this.invalidFocusStreak = 0;
      return { policy, event: null };
    }

    const corePosition = state.core?.position;
    const tooFar = corePosition !== undefined && chebyshevDistance(corePosition, focus) > this.maxFocusDistance;
    if (!tooFar) {
      this.invalidFocusStreak = 0;
      return { policy, event: null };
    }

    this.invalidFocusStreak += 1;
    if (this.invalidFocusStreak >= this.invalidFocusThreshold) {
      this.silencedUntilTick = state.tick + this.silenceTicks;
      this.invalidFocusStreak = 0;
      return {
        policy: { ...policy, focusRegion: null },
        event: {
          kind: "silence_started",
          tick: state.tick,
          count: this.invalidFocusThreshold,
          focusRegion: focus,
        },
      };
    }
    return {
      policy,
      event: {
        kind: "invalid_focus",
        tick: state.tick,
        count: this.invalidFocusStreak,
        focusRegion: focus,
      },
    };
  }

  /** 禁言期结束（供 telemetry：下一 tick 首次恢复时由调用方比对 isSilenced）。 */
  silenceEndsAt(): number {
    return this.silencedUntilTick;
  }
}

function chebyshevDistance(a: Position, b: readonly [number, number]): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}
