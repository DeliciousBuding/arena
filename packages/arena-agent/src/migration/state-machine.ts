/**
 * 迁移状态机（migration-system-v1 §2，2026-08-08 设计，评审 P0-4 纳入）。
 *
 * 纯函数：`transition(phase, event)` 输出新状态；非法转移 no-op（applied=false，
 * fail-closed 语义——事件乱序/过期一律不推动迁移）。
 *
 * 中止分级（评审定稿）：
 * - CORE_DAMAGED = 暂停（DEFENSIVE_HOLD，可恢复，滞回退出）；
 * - 活跃敌核贴脸/取消 = ABORT（路线/目标失效重审）；
 * - CORE_DESTROYED / core 代际变化 = RECOVERY_ABORT（禁止旧 legProgress 续迁）。
 */

export const MIGRATION_PHASES = [
  "IDLE",
  "PLAN",
  "LEG_MOVE",
  "LEG_SETTLE",
  "DEFENSIVE_HOLD",
  "RECOVERY_ABORT",
  "ARRIVED",
  "ABORT",
] as const;

export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

export type MigrationEvent =
  /** 用户/指挥面下达迁移意图（含目标与理由）。 */
  | { readonly type: "INTENT_ACCEPTED" }
  /** 走廊审计通过 → 开始推进。 */
  | { readonly type: "PLAN_AUDITED" }
  /** 走廊审计拒绝（或 --force 未授权）→ 终止。 */
  | { readonly type: "PLAN_REJECTED" }
  /** 本 burst 格数达标 → 休整。 */
  | { readonly type: "LEG_BURST_DONE" }
  /** 休整 readiness 达成；lastLeg=true → ARRIVED。 */
  | { readonly type: "LEG_SETTLE_DONE"; readonly lastLeg: boolean }
  /** 核心受击（CORE_DAMAGED）→ 防御暂停。 */
  | { readonly type: "CORE_DAMAGED" }
  /** HOLD 滞回满足（≤18 格无活跃敌情 ≥8-12 tick 且 HP 满）→ 回休整。 */
  | { readonly type: "THREAT_CLEARED" }
  /** 活跃敌核新鲜目击 ≤12 格持续 → 中止。 */
  | { readonly type: "THREAT_ESCALATED" }
  /** HOLD 重复进入（X tick 内 ≥2 次）/ 走廊偏离 → 重审路线。 */
  | { readonly type: "REPLAN_REQUESTED" }
  /** 核心被毁（CORE_DESTROYED）→ 恢复中止。 */
  | { readonly type: "CORE_DESTROYED" }
  /** currentCoreId ≠ originCoreId → 恢复中止。 */
  | { readonly type: "CORE_GENERATION_CHANGED" }
  /** 用户取消（migration_cancel / 手操覆盖）。 */
  | { readonly type: "CANCEL" }
  /** ARRIVED 冷却结束 → 回 IDLE。 */
  | { readonly type: "ARRIVED_SETTLE_DONE" }
  /** ABORT 清理完成 → 回 IDLE。 */
  | { readonly type: "CLEANED" }
  /** RECOVERY_ABORT 经济重建完成 → 回 IDLE（重新 PLAN 新 operation）。 */
  | { readonly type: "RECOVERY_DONE" };

export interface MigrationTransitionResult {
  readonly phase: MigrationPhase;
  /** false = 非法转移（fail-closed no-op）。 */
  readonly applied: boolean;
}

const ACTIVE_PHASES: readonly MigrationPhase[] = [
  "PLAN",
  "LEG_MOVE",
  "LEG_SETTLE",
  "DEFENSIVE_HOLD",
];

export function transition(phase: MigrationPhase, event: MigrationEvent): MigrationTransitionResult {
  const noop = (): MigrationTransitionResult => ({ phase, applied: false });

  // 恢复中止优先：核心被毁/代际变化在任何进行中状态都立即生效。
  if (event.type === "CORE_DESTROYED" || event.type === "CORE_GENERATION_CHANGED") {
    if (ACTIVE_PHASES.includes(phase)) return { phase: "RECOVERY_ABORT", applied: true };
    return noop();
  }
  // 取消在任何非终态都可生效。
  if (event.type === "CANCEL") {
    if (phase !== "IDLE" && phase !== "ABORT" && phase !== "RECOVERY_ABORT" && phase !== "ARRIVED")
      return { phase: "ABORT", applied: true };
    return noop();
  }

  switch (phase) {
    case "IDLE":
      return event.type === "INTENT_ACCEPTED"
        ? { phase: "PLAN", applied: true }
        : noop();
    case "PLAN":
      if (event.type === "PLAN_AUDITED") return { phase: "LEG_MOVE", applied: true };
      if (event.type === "PLAN_REJECTED") return { phase: "ABORT", applied: true };
      return noop();
    case "LEG_MOVE":
      if (event.type === "LEG_BURST_DONE") return { phase: "LEG_SETTLE", applied: true };
      if (event.type === "CORE_DAMAGED") return { phase: "DEFENSIVE_HOLD", applied: true };
      return noop();
    case "LEG_SETTLE":
      if (event.type === "LEG_SETTLE_DONE")
        return { phase: event.lastLeg ? "ARRIVED" : "LEG_MOVE", applied: true };
      if (event.type === "CORE_DAMAGED") return { phase: "DEFENSIVE_HOLD", applied: true };
      return noop();
    case "DEFENSIVE_HOLD":
      if (event.type === "THREAT_CLEARED") return { phase: "LEG_SETTLE", applied: true };
      if (event.type === "THREAT_ESCALATED") return { phase: "ABORT", applied: true };
      if (event.type === "REPLAN_REQUESTED") return { phase: "PLAN", applied: true };
      return noop();
    case "ARRIVED":
      return event.type === "ARRIVED_SETTLE_DONE"
        ? { phase: "IDLE", applied: true }
        : noop();
    case "ABORT":
      return event.type === "CLEANED" ? { phase: "IDLE", applied: true } : noop();
    case "RECOVERY_ABORT":
      return event.type === "RECOVERY_DONE" ? { phase: "IDLE", applied: true } : noop();
    default:
      return noop();
  }
}
