/**
 * 核心代际检测（migration-system-v1 §2 RECOVERY_ABORT，评审 P0-4）。
 *
 * 官方规则：Core 被毁时所有己方 Unit 一并消失，随后新 Core/Worker 获得
 * 全新 UUID，且可能在完全不同的位置重生。旧迁移计划（含 legProgress）在
 * 新代际下必须作废——禁止从旧路线续迁。
 *
 * 本模块纯函数：从 calibration case 的核心对象/事件流提取代际事实。
 */

export interface CoreIdentitySnapshot {
  /** 我方核心 id（无核心 = null）。 */
  readonly coreId: string | null;
  /** 代际计数（conductor 维护；id 每变化一次 +1）。 */
  readonly generation: number;
}

/** calibration case 事件类型常量（引擎事件）。 */
export const CORE_DESTROYED_EVENT = "CORE_DESTROYED";
export const CORE_RESPAWNED_EVENT = "CORE_RESPAWNED";

/** 代际变化：核心 id 不同（含旧核消失/新核出现）。 */
export function detectCoreGenerationChange(
  previous: CoreIdentitySnapshot,
  current: CoreIdentitySnapshot,
): boolean {
  return previous.coreId !== current.coreId;
}

/** 事件流中是否出现核心被毁事件（RECOVERY_ABORT 触发条件之一）。 */
export function hasCoreDestroyedEvent(events: readonly { readonly type?: string }[]): boolean {
  return events.some((event) => event.type === CORE_DESTROYED_EVENT);
}

/** 事件流中是否出现核心重生事件（旧核消失 → 新核出现）。 */
export function hasCoreRespawnedEvent(events: readonly { readonly type?: string }[]): boolean {
  return events.some((event) => event.type === CORE_RESPAWNED_EVENT);
}

/** 从 calibration case 的 objects 提取我方核心身份（kind==="CORE" 且 controlled）。 */
export function coreIdentityFromObjects(
  objects: readonly { readonly kind?: string; readonly controlled?: boolean; readonly id?: string }[],
): CoreIdentitySnapshot {
  const core = objects.find((obj) => obj.kind === "CORE" && obj.controlled === true);
  return {
    coreId: core?.id ?? null,
    generation: 0, // 代际由 conductor 计划维护；本函数只负责 id 事实
  };
}
