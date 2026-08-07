/**
 * FleetRef / TaskForce 纯函数助手（Phase 0 contract freeze）。
 *
 * 核心语义（spec §10）：
 * - FleetRef 严格 tenant-local——单 tenant FleetController 消费 FleetRef 前
 *   必须验证 owner tenant，只能驱动自己 tenant 的 Fleet；
 * - TaskForce 才允许跨 tenant 绑定多个 FleetRef——跨 tenant 协同由
 *   commanderTenant 拆解成 per-tenant directive，不产生跨 tenant Plan。
 *
 * 所有函数严格 deterministic、无 I/O、无副作用。
 * 最后更新：2026-08-08
 */

import type { FleetRef, TaskForce } from "./control-types.ts";

/**
 * 验证 FleetRef 是否属于指定 tenant（tenant-local enforcement）。
 * FleetController 消费 FleetRef 前必须调用：不匹配 → 忽略该 ref
 * （fail-open，回到本地 planner，绝不驱动其他 tenant 的 Fleet）。
 */
export function validateFleetRefForTenant(ref: FleetRef, tenantId: string): boolean {
  return ref.tenantId === tenantId;
}

/**
 * 过滤出属于指定 tenant 的 FleetRef（TaskForce → per-tenant directive 拆解：
 * commanderTenant 按 tenant 分发后，各 FleetController 只取自己的 ref）。
 */
export function fleetRefsForTenant(tf: TaskForce, tenantId: string): readonly FleetRef[] {
  return tf.fleetRefs.filter((ref) => ref.tenantId === tenantId);
}

