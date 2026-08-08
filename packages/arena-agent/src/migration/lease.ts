/**
 * 迁移计划 lease 生效契约（migration-system-v1 §6.2，评审 P0-3）。
 *
 * runtime 每 tick 执行迁移订单的前置条件：`leaseFresh && epoch 匹配 &&
 * coreId 匹配`——任一不满足 → fail-closed（只允许 NORMAL/WAIT）。
 * 本模块只判定 lease 新鲜度（tick 与墙钟双条件），纯函数。
 */

import type { MigrationLease } from "./plan.ts";

export interface LeaseCheckOptions {
  /** 墙钟心跳 TTL（ms）。conductor 每次轮询更新 heartbeatAt。 */
  readonly heartbeatTtlMs?: number;
}

export const DEFAULT_HEARTBEAT_TTL_MS = 60_000;

/**
 * lease 新鲜判定：
 * - tick 维度：untilTick >= currentTick（游戏 tick 未过期）；
 * - 墙钟维度：nowMs - heartbeatAt <= heartbeatTtlMs（心跳未停）。
 * 双条件必须同时满足；任何异常（时间戳缺失/非法）一律视为不新鲜（fail-closed）。
 */
export function isMigrationLeaseFresh(
  lease: MigrationLease,
  currentTick: number,
  nowMs: number,
  options: LeaseCheckOptions = {},
): boolean {
  const heartbeatTtlMs = options.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
  if (!Number.isFinite(currentTick) || !Number.isFinite(nowMs)) return false;
  if (!Number.isFinite(lease.untilTick)) return false;

  const heartbeatAtMs = Date.parse(lease.heartbeatAt);
  if (Number.isNaN(heartbeatAtMs)) return false;

  const tickFresh = lease.untilTick >= currentTick;
  const heartbeatFresh = nowMs - heartbeatAtMs <= heartbeatTtlMs;
  return tickFresh && heartbeatFresh;
}

/** runtime 判定迁移订单是否可执行（lease 维度；epoch/coreId 在 plan 消费侧判定）。 */
export function migrationOrderAllowed(
  lease: MigrationLease,
  currentTick: number,
  nowMs: number,
  options: LeaseCheckOptions = {},
): boolean {
  return isMigrationLeaseFresh(lease, currentTick, nowMs, options);
}
