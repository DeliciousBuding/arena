/**
 * 迁移运行时 overlay（migration-system-v1 §1/§6.2，评审 P0-3 定稿）。
 *
 * 提交链位置：coordinator 决策 → migrationOverlay → humanOverride → 单次 submit。
 *
 * 生效契约（fail-closed）：计划存在时，`leaseFresh && conductorEpoch 匹配 &&
 * currentCoreId == originCoreId` 任一不满足 → 阻断迁移订单（不发下一个
 * START_MOVE），核心就地 NORMAL 为安全态。
 *
 * 节奏窗口：plan.state=LEG_MOVE 且 burst 未达 → 可选生成 START_MOVE
 * （enableCoreOrders 默认关，canary 后开——关闭时只报告，零影响）。
 */

import type { Plan } from "../domain/model.ts";
import { cellKey } from "../domain/model.ts";
import { isMigrationLeaseFresh } from "./lease.ts";
import type { MigrationPlanV1 } from "./plan.ts";
import type { MigrationRuntimeConfig } from "./config.ts";
import { decidePacing, type PaceDecision } from "./pacing.ts";

/** runtime 侧每 tick 可提供的计划上下文（调用方组装）。 */
export interface MigrationOverlayContext {
  readonly state: {
    readonly tick: number;
    readonly core?: {
      readonly position?: readonly [number, number] | null;
      readonly id?: string | null;
      readonly state?: "NORMAL" | "MOVING" | null;
    } | null;
  };
  readonly plan: Plan;
  readonly migrationPlan: MigrationPlanV1 | null;
  readonly nowMs: number;
  /** 提交前重读的计划文件 epoch（fencing）；null = 文件已被清/改写。 */
  readonly fileEpoch: number | null;
  readonly config: MigrationRuntimeConfig;
  /**
   * runtime 已知的不可迁入地形格（障碍 + 资源格，2026-08-10 修复）：发射
   * START_MOVE 前校验下一路径格；undefined/null = 不校验（零回归）。
   */
  readonly terrainBlockedCells?: ReadonlySet<string> | null;
}

export interface MigrationOverlayResult {
  readonly plan: Plan;
  /** 计划存在且 lease 生效（迁移执行中）。 */
  readonly active: boolean;
  /** 计划存在但契约不满足 → 已阻断迁移订单。 */
  readonly failClosed: boolean;
  readonly reasons: readonly string[];
  /** overlay 发出的核心迁移订单（若有）。 */
  readonly coreOrder: { readonly type: "START_MOVE"; readonly direction: "UP" | "DOWN" | "LEFT" | "RIGHT" } | null;
  /** 节奏决策摘要（遥测用）。 */
  readonly pacing: PaceDecision | null;
  /** worker 集结带（min 叠加既有上限；null = 不限制）。 */
  readonly workerBand: number | null;
}

/** 计划契约检查：lease + epoch + 核心代际（P0-3/P0-4）。 */
export function migrationContractValid(
  migrationPlan: MigrationPlanV1,
  state: MigrationOverlayContext["state"],
  nowMs: number,
  fileEpoch: number | null,
): { readonly ok: boolean; readonly reasons: string[] } {
  const reasons: string[] = [];
  if (!isMigrationLeaseFresh(migrationPlan.lease, state.tick, nowMs)) {
    reasons.push("lease 不新鲜（tick 过期或心跳停止）");
  }
  if (fileEpoch === null || fileEpoch !== migrationPlan.conductorEpoch) {
    reasons.push(`conductorEpoch 不匹配（计划 ${migrationPlan.conductorEpoch}，文件 ${fileEpoch}）`);
  }
  const currentCoreId = state.core?.id ?? null;
  if (migrationPlan.core.originCoreId !== null && currentCoreId !== null &&
      migrationPlan.core.originCoreId !== currentCoreId) {
    reasons.push("currentCoreId ≠ originCoreId（核心代际变化）");
  }
  return { ok: reasons.length === 0, reasons };
}

const DIRECTION_DELTAS: Record<string, [number, number]> = {
  UP: [0, -1],
  DOWN: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
};

/** 从计划路径推导下一格方向（4 向）：跳过核心已走过的格（位置在路径中的
 *  最后出现之后才开始找），无下一格/不相邻 → null。
 *
 *  对角步分解：路径生成（route.ts）允许 8 邻域对角格（Chebyshev ≤1），而
 *  引擎 START_MOVE 仅 4 向。遇到对角下一格时按"先水平后垂直"分解为两个
 *  4 向子步——核心每 tick 走一格，中间格自然成为下一 tick 的起点，无需
 *  在 overlay 侧维护中间态（中间格在路径外，directionToNextPathCell 的
 *  "最后出现"定位逻辑对中间格天然放行下一格）。 */
export function directionToNextPathCell(
  pathCells: readonly (readonly [number, number])[],
  position: readonly [number, number],
  fromIndex: number,
): { readonly direction: "UP" | "DOWN" | "LEFT" | "RIGHT"; readonly nextIndex: number } | null {
  let searchFrom = fromIndex;
  for (let i = fromIndex; i < pathCells.length; i += 1) {
    if (pathCells[i]![0] === position[0] && pathCells[i]![1] === position[1]) {
      searchFrom = i + 1; // 位置在路径中最后出现的下一格才是前进方向
    }
  }
  for (let i = searchFrom; i < pathCells.length; i += 1) {
    const [x, y] = pathCells[i]!;
    const dx = x - position[0];
    const dy = y - position[1];
    for (const [name, [adx, ady]] of Object.entries(DIRECTION_DELTAS)) {
      if (adx === dx && ady === dy) {
        return { direction: name as "UP" | "DOWN" | "LEFT" | "RIGHT", nextIndex: i };
      }
    }
    // 对角下一格（|dx|=|dy|=1）→ 先走水平轴子步，下一 tick 再走垂直轴
    if (Math.abs(dx) === 1 && Math.abs(dy) === 1) {
      return { direction: dx > 0 ? "RIGHT" : "LEFT", nextIndex: i };
    }
    if (Math.abs(dx) + Math.abs(dy) > 1) return null; // 路径与当前位置不再相邻
  }
  return null;
}

export function migrationOverlay(context: MigrationOverlayContext): MigrationOverlayResult {
  const { migrationPlan, config, state } = context;
  if (!config.enabled || migrationPlan === null) {
    return {
      plan: context.plan,
      active: false,
      failClosed: false,
      reasons: [],
      coreOrder: null,
      pacing: null,
      workerBand: null,
    };
  }

  const contract = migrationContractValid(migrationPlan, state, context.nowMs, context.fileEpoch);
  const reasons = [...contract.reasons];
  let plan = context.plan;
  let coreOrder: MigrationOverlayResult["coreOrder"] = null;
  let pacing: PaceDecision | null = null;

  if (!contract.ok) {
    // fail-closed：阻断迁移订单（当前 runtime 不产 START_MOVE，此处防御性
    // 移除任何迁移来源的 START_MOVE，避免旧订单在 lease 失效后继续执行）。
    if (plan.coreAction !== null && plan.coreAction.type === "START_MOVE") {
      plan = { ...plan, coreAction: null };
      reasons.push("已移除失效迁移订单（fail-closed）");
    }
    return {
      plan,
      active: false,
      failClosed: true,
      reasons,
      coreOrder: null,
      pacing: null,
      workerBand: config.workerBand,
    };
  }

  const coreState = state.core?.state ?? null;
  const corePosition = state.core?.position ?? null;
  const burst = config.pace.burstCells;
  const pacingResult = decidePacing({
    phase: migrationPlan.state,
    coreState,
    cellsThisLeg: migrationPlan.legProgress.cellsThisLeg,
    burstCells: burst,
    cargoWorkerCount: 0, // 满载清空检测由 conductor/遥测侧维护，overlay 不重复计
    stragglersReady: true,
    nearMinesRemaining: 0,
    settleElapsed: 0,
    minSettle: config.pace.minSettle,
    maxSettle: config.pace.maxSettle,
    settleTarget: config.pace.settleTarget,
    threatLevel: 0,
  });
  pacing = pacingResult.decision;

  if (config.overlay.enableCoreOrders &&
      migrationPlan.state === "LEG_MOVE" &&
      coreState === "NORMAL" &&
      corePosition !== null) {
    const next = directionToNextPathCell(
      migrationPlan.path.cells,
      corePosition,
      Math.max(0, migrationPlan.legProgress.legIndex),
    );
    if (next !== null) {
      // 发射防御（2026-08-10 修复）：下一路径格若在 runtime 已知的障碍/资源
      // 集合里 → 不发射 START_MOVE（fail-closed 等 conductor REPLAN/清路）。
      // 规则表 RESOURCE/OBSTACLE | Core may migrate: no——路径规划用完整
      // survey 障碍集（conductor 侧修复），此处是防"观测与计划时差/未知
      // 地形"的最后一层兜底；terrainBlockedCells 未提供 = 不校验（零回归）。
      const nextCell = migrationPlan.path.cells[next.nextIndex]!;
      const terrainBlocked = context.terrainBlockedCells !== undefined &&
        context.terrainBlockedCells !== null &&
        context.terrainBlockedCells.has(cellKey(nextCell));
      if (terrainBlocked) {
        reasons.push(`下一路径格 [${nextCell[0]},${nextCell[1]}] 为已知障碍/资源格，不发射 START_MOVE（等待 conductor 换路）`);
      } else {
        coreOrder = { type: "START_MOVE", direction: next.direction };
        plan = { ...plan, coreAction: coreOrder };
        reasons.push(`burst 推进 → ${next.direction}（路径格 ${next.nextIndex}）`);
      }
    } else {
      reasons.push("路径已耗尽或核心偏离路径，等待 conductor 更新");
    }
  } else if (migrationPlan.state === "LEG_MOVE" && coreState === "NORMAL") {
    reasons.push(`节奏窗口 LEG_MOVE 推进就绪（${pacingResult.reason}）；core orders 未启用`);
  }

  return {
    plan,
    active: true,
    failClosed: false,
    reasons,
    coreOrder,
    pacing,
    workerBand: config.workerBand,
  };
}
