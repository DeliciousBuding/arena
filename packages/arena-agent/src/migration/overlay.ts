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
 *  最后出现之后才开始找），无下一格/不相邻 → null。 */
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
      coreOrder = { type: "START_MOVE", direction: next.direction };
      plan = { ...plan, coreAction: coreOrder };
      reasons.push(`burst 推进 → ${next.direction}（路径格 ${next.nextIndex}）`);
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
