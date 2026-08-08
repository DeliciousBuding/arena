/**
 * 迁移助手（migration-assist-v1，M6，2026-08-09 落线）。
 *
 * runtime 侧共享助手：手动/自动迁移同一套机制——
 * ① 手动迁移检测（核心 MOVING 且无活跃计划）；
 * ② 手动窗口抑制（手动迁移期间不产出 START_MOVE，planner 不抢用户方向）；
 * ③ 迁移失败签名（MOVING→NORMAL 位置未变 + 进度归零）；
 * ④ 清路订单（plan.clearRequests 格上的我方单位 → 让位 MOVE）。
 *
 * 纯函数、无副作用；调用方（tenant-runtime overlay 闭包）负责接线。
 * 与 conductor 侧（stall/clearRequests 生成）配套：conductor 写清路请求，
 * runtime 执行让位订单，conductor 用单位坐标观测验证清空。
 */

import type { MigrationPlanV1 } from "./plan.ts";

export interface AssistCoreSnapshot {
  readonly position: readonly [number, number] | null;
  readonly state: "NORMAL" | "MOVING" | null;
  readonly destination: readonly [number, number] | null;
  readonly moveProgress: number | null;
  readonly moveRequiredTicks: number | null;
}

export interface AssistUnitSnapshot {
  readonly id: string;
  readonly unitType: string;
  readonly position: readonly [number, number] | null;
  /** M8（migration-survival-v1 §5）：货物量（>0 = 满载 worker，卸货排队判定）。 */
  readonly cargo: number;
}

export interface AssistContext {
  readonly tick: number;
  readonly core: AssistCoreSnapshot | null;
  readonly units: readonly AssistUnitSnapshot[];
  /** 迁移计划（null = 无计划：手动迁移窗口）。 */
  readonly plan: MigrationPlanV1 | null;
  /** 计划是否生效（lease 新鲜 + epoch 匹配 + coreId 匹配；由调用方判定）。 */
  readonly planActive: boolean;
}

export interface AssistResult {
  /** 手动迁移进行中（核心 MOVING 且无活跃计划）。 */
  readonly manualMigration: boolean;
  /** 手动窗口抑制：应过滤 planner 的 START_MOVE（手动迁移期不抢方向）。 */
  readonly suppressCoreOrder: boolean;
  /** 迁移失败签名（MOVING→NORMAL 位置未变；调用方需传 prev 状态对比）。 */
  readonly migrationFailed: boolean;
  /** 清路订单：unitId → 让位 MOVE action（核心 next 格占用单位）。 */
  readonly clearOrders: readonly {
    readonly unitId: string;
    readonly direction: "UP" | "DOWN" | "LEFT" | "RIGHT";
    readonly from: readonly [number, number];
    readonly reason: string;
  }[];
  /** M8（migration-survival-v1 §5）：卸货等待订单（核心格容量已满时满载 worker 停在邻格）。 */
  readonly waitOrders: readonly {
    readonly unitId: string;
    readonly from: readonly [number, number];
    readonly reason: string;
  }[];
}

/** 迁移失败签名判定（migration-assist-v1 §4-D）：MOVING→NORMAL 位置未变。 */
export function detectMigrationFailure(
  prev: AssistCoreSnapshot | null,
  curr: AssistCoreSnapshot | null,
): boolean {
  if (prev === null || curr === null) return false;
  if (prev.state !== "MOVING") return false;
  if (curr.state !== "NORMAL") return false;
  if (prev.position === null || curr.position === null) return false;
  return prev.position[0] === curr.position[0] && prev.position[1] === curr.position[1];
}

/**
 * 核心路径清空订单（migration-assist-v1 §4-A/§4-C）：
 * plan.clearRequests 格上的我方单位 → 让位 MOVE（远离 destination 的方向，
 * 4 向中取与"目标格→单位"相反或垂直方向；无单位 → 空数组）。
 */
export function buildClearOrders(
  plan: MigrationPlanV1,
  units: readonly AssistUnitSnapshot[],
  core: AssistCoreSnapshot | null,
): AssistResult["clearOrders"] {
  const clearRequests = plan.clearRequests ?? [];
  if (clearRequests.length === 0) return [];
  const orders: {
    readonly unitId: string;
    readonly direction: "UP" | "DOWN" | "LEFT" | "RIGHT";
    readonly from: readonly [number, number];
    readonly reason: string;
  }[] = [];
  const occupied = new Set<string>();
  for (const unit of units) {
    if (unit.position === null) continue;
    const request = clearRequests.find(
      (entry) => entry.x === unit.position![0] && entry.y === unit.position![1],
    );
    if (request === undefined) continue;
    const key = `${unit.position[0]},${unit.position[1]}`;
    if (occupied.has(key)) continue; // 每格只发一个让位订单（链式由后续 tick 处理）
    occupied.add(key);
    // 让位方向：垂直/远离 destination。以核心位置为参考，取远离方向的 4 向。
    const dx = unit.position[0] - (core?.position?.[0] ?? unit.position[0]);
    const dy = unit.position[1] - (core?.position?.[1] ?? unit.position[1]);
    let direction: "UP" | "DOWN" | "LEFT" | "RIGHT" = "DOWN";
    if (Math.abs(dx) >= Math.abs(dy)) {
      direction = dx > 0 ? "RIGHT" : dx < 0 ? "LEFT" : "DOWN";
    } else {
      direction = dy > 0 ? "DOWN" : dy < 0 ? "UP" : "LEFT";
    }
    orders.push({
      unitId: unit.id,
      direction,
      from: [unit.position[0], unit.position[1]],
      reason: `clear:${request.reason ?? "destination"}`,
    });
  }
  return orders;
}

/**
 * M8 卸货等待订单（migration-survival-v1 §5，M6 §4-B 落地）：
 * 核心格容量纪律 ≤1 我方单位（=核心 + 至多 1 卸货位）。满载 worker 靠近核心
 * （≤2 格）且核心格已有其他我方单位驻留 → 停在核心 1 格邻域等待（wait-ring），
 * 不挤入核心格（防 R1 溢出导致核心迁移被自己人挡死——L1 实测：核心格被
 * VANGUARD 集群占满，满载 worker 挤不进卸货，SETTLE 拖满 maxSettle 强制退出）。
 *
 * - 核心 MOVING：持货 WAIT（既有 coreMovingHold），本函数不介入；
 * - 空载 worker：不受影响（照常采矿/勘探）；
 * - 调用方把 waitOrders 对应单位的动作覆盖为"原地等待"（不发起向核心格的移动）。
 */
export function buildWaitRingOrders(
  units: readonly AssistUnitSnapshot[],
  core: AssistCoreSnapshot | null,
): AssistResult["waitOrders"] {
  const corePosition = core?.position ?? null;
  if (corePosition === null) return [];
  const orders: {
    readonly unitId: string;
    readonly from: readonly [number, number];
    readonly reason: string;
  }[] = [];
  // 核心格驻留单位数（核心本体不计入 units；≥1 即容量满——核心 + 1 单位 = 2 占用）。
  const coreCellOccupants = units.filter(
    (unit) => unit.position !== null && unit.position[0] === corePosition[0] && unit.position[1] === corePosition[1],
  ).length;
  if (coreCellOccupants < 1) return [];
  for (const unit of units) {
    if (unit.cargo <= 0) continue; // 空载不受影响
    if (unit.position === null) continue;
    const distance = Math.max(
      Math.abs(unit.position[0] - corePosition[0]),
      Math.abs(unit.position[1] - corePosition[1]),
    );
    if (distance > 2) continue; // 只在核心邻域拦截（远距满载 worker 照常行进）
    if (unit.position[0] === corePosition[0] && unit.position[1] === corePosition[1]) continue; // 已在核心格 = 正在卸货，放行
    orders.push({
      unitId: unit.id,
      from: [unit.position[0], unit.position[1]],
      reason: `wait-ring:核心格容量满（${coreCellOccupants} 驻留单位），等待卸货位`,
    });
  }
  return orders;
}

/**
 * 迁移助手主入口（纯函数）。调用方在 overlay pre-submit 阶段调用：
 * - suppressCoreOrder → 过滤 plan.coreAction 的 START_MOVE；
 * - clearOrders → 覆盖 unitActions 中对应单位的动作为让位 MOVE；
 * - waitOrders → 覆盖 unitActions 中对应单位的动作为原地等待（卸货排队）；
 * - manualMigration/migrationFailed → 遥测事件。
 */
export function migrationAssist(context: AssistContext): AssistResult {
  const manualMigration =
    context.plan === null && context.core?.state === "MOVING";
  // 手动窗口：核心 MOVING 且无活跃计划 → planner 不抢方向（M6 §4-E）。
  // 自动迁移（计划生效）时 overlay 自己发 START_MOVE，不需要抑制。
  const suppressCoreOrder = manualMigration && !context.planActive;
  return {
    manualMigration,
    suppressCoreOrder,
    migrationFailed: false, // 需 prev 对比，由调用方经 detectMigrationFailure 判定
    clearOrders: context.planActive ? buildClearOrders(context.plan!, context.units, context.core) : [],
    waitOrders: buildWaitRingOrders(context.units, context.core),
  };
}
