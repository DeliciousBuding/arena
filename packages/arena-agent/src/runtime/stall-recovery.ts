/**
 * StallRecovery：死循环自动跳出状态机（检测 → 干预 → 验证 → 升级）。
 *
 * 设计（2026-08-05 生产事故后）：StallDetector 只负责"发现"；本模块负责"跳出"。
 * 死循环的共同根因是 worker 被 policy 的 focusRegion 支走（go_focus 远征）或
 * 路径/容量互堵——干预以"最小覆盖"原则改 policy 的 focusRegion=null，让执行层
 * 的既有回仓巡逻逻辑自行恢复；经济恢复（delta>0）即提前退出并记成功。
 *
 * 状态机：idle → recovering（覆盖 focusRegion=null）→
 *   - 经济恢复 → 提前退出（success）→ idle
 *   - 到期未恢复 → 记失败一轮 → 连续失败达上限 → escalating（all-in 军事拆敌
 *     CORE 的终局翻盘尝试）→ 到期回 idle
 * 同 kind 冷却：recovering 结束后冷却期内同类事件不重复触发（防抖动）。
 *
 * 调用时序（tenant-runtime）：决策前 policyProvider 调 policyFor(base) 拿当前应
 * 下发策略；决策后 outcome 处理调 observe(events, obs) 推进状态机。状态迁移由
 * observe 返回（落盘 stall_recovery telemetry）。
 */

import type { MacroPolicy } from "./macro-policy.ts";
import type { StallEvent, StallKind } from "./stall-detector.ts";

export type RecoveryState = "idle" | "recovering" | "escalating";

export interface RecoveryTransition {
  readonly state: RecoveryState;
  readonly kind: StallKind | null;
  readonly tick: number;
  /** escalating 结束后回 idle 时标记（落盘审计用）。 */
  readonly escalated?: boolean;
}

export interface StallRecoveryConfig {
  /** 覆盖持续 tick 数（默认 128 ≈ 4 个 policy 周期）。 */
  readonly recoveryTicks?: number;
  /** 连续失败（到期未恢复）达此轮数 → escalating。默认 2。 */
  readonly escalateAfterFailures?: number;
  /** escalating 覆盖持续 tick 数。默认 256。 */
  readonly escalationTicks?: number;
  /** 恢复后同类事件冷却 tick（防抖动）。默认 64。 */
  readonly cooldownTicks?: number;
}

export const DEFAULT_STALL_RECOVERY_CONFIG: Required<StallRecoveryConfig> = {
  recoveryTicks: 128,
  escalateAfterFailures: 2,
  escalationTicks: 256,
  cooldownTicks: 64,
};

/** 经济恢复判据：资源正增长或有采集/卸货动作。 */
function economyRecovered(delta: number, harvestCount: number, depositCount: number): boolean {
  return delta > 0 || harvestCount > 0 || depositCount > 0;
}

/** escalating 的 all-in 军事覆盖：拆敌 CORE 翻盘（终局自救，非常规策略）。 */
function escalationPolicy(base: MacroPolicy): MacroPolicy {
  return {
    posture: "aggressive",
    workerTarget: Math.max(base.workerTarget, 1),
    militaryRatio: 1,
    focusRegion: null,
    attackPriority: "core",
  };
}

export class StallRecovery {
  private readonly recoveryTicks: number;
  private readonly escalateAfterFailures: number;
  private readonly escalationTicks: number;
  private readonly cooldownTicks: number;
  private state: RecoveryState = "idle";
  private activeKind: StallKind | null = null;
  private startTick: number | null = null;
  private failureRounds = 0;
  private cooldownUntilTick = new Map<StallKind, number>();

  constructor(config: StallRecoveryConfig = {}) {
    const merged = { ...DEFAULT_STALL_RECOVERY_CONFIG, ...config };
    this.recoveryTicks = merged.recoveryTicks;
    this.escalateAfterFailures = merged.escalateAfterFailures;
    this.escalationTicks = merged.escalationTicks;
    this.cooldownTicks = merged.cooldownTicks;
  }

  /** 当前状态。 */
  stateOf(): RecoveryState {
    return this.state;
  }

  /** 当前激活的检测 kind（idle 为 null）。 */
  kindOf(): StallKind | null {
    return this.activeKind;
  }

  /** 当前应下发给执行层的 policy（recovering/escalating 时为覆盖值，否则原样）。 */
  policyFor(base: MacroPolicy): MacroPolicy {
    if (this.state === "recovering") {
      return { ...base, focusRegion: null };
    }
    if (this.state === "escalating") {
      return escalationPolicy(base);
    }
    return base;
  }

  /**
   * 决策后推进状态机。返回本次状态迁移（无迁移返回 null；telemetry 落盘用）。
   */
  observe(
    events: readonly StallEvent[],
    obs: { readonly tick: number; readonly coreResourceDelta: number; readonly harvestCount: number; readonly depositCount: number },
  ): RecoveryTransition | null {
    const { tick } = obs;
    if (this.state === "idle") {
      // 冷却期内忽略同类事件；否则进入 recovering（取首个未冷却事件）。
      const first = events.find((event) => (this.cooldownUntilTick.get(event.kind) ?? 0) <= tick);
      if (first !== undefined) {
        this.state = "recovering";
        this.activeKind = first.kind;
        this.startTick = tick;
        return { state: "recovering", kind: first.kind, tick };
      }
      return null;
    }

    if (this.state === "recovering") {
      if (this.activeKind === null || this.startTick === null) {
        return this.resetToIdle(tick);
      }
      if (economyRecovered(obs.coreResourceDelta, obs.harvestCount, obs.depositCount)) {
        // 经济恢复 → 提前退出干预（自愈成功），进入冷却。
        return this.resetToIdle(tick);
      }
      if (tick - this.startTick >= this.recoveryTicks) {
        // 到期仍未恢复 → 记失败一轮；达上限升级 escalating。
        this.failureRounds += 1;
        if (this.failureRounds >= this.escalateAfterFailures) {
          this.state = "escalating";
          this.startTick = tick;
          return { state: "escalating", kind: this.activeKind, tick };
        }
        return this.resetToIdle(tick);
      }
      return null;
    }

    // escalating：到期回 idle（终局尝试结束），冷却同类。
    if (this.startTick !== null && tick - this.startTick >= this.escalationTicks) {
      return this.resetToIdle(tick);
    }
    return null;
  }

  /** 状态回 idle + 同类冷却（返回迁移记录）。 */
  private resetToIdle(tick: number): RecoveryTransition {
    const kind = this.activeKind;
    const previousState = this.state;
    this.state = "idle";
    this.activeKind = null;
    this.startTick = null;
    if (kind !== null) {
      this.cooldownUntilTick.set(kind, tick + this.cooldownTicks);
    }
    return { state: "idle", kind, tick, ...(previousState === "escalating" ? { escalated: true } : {}) };
  }
}
