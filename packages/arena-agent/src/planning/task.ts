/** Task：Worker 任务类型与结构 + 强制任务优先规则（总裁决 RP2）。
 *
 * 强制任务（不走代价矩阵，直接指派），优先级：
 *   1. cargo > 0 且 Core 可接收 → DEPOSIT
 *   2. 已站资源格且 cargo = 0 → HARVEST_CURRENT
 *   3. 低 HP（≤1）且可安全回家 → RETURN_FOR_HEAL
 * 不满足任一 → 返回 null，走代价矩阵（GO_RESOURCE / WAIT）。
 */

import { cellKey, type Position } from "../domain/model.ts";
import { manhattan } from "../domain/nav.ts";
import type { PlanningSnapshot, PlanningUnit } from "./planning-snapshot.ts";

export type TaskType =
  | "HARVEST_CURRENT"
  | "GO_RESOURCE"
  | "DEPOSIT"
  | "EXPLORE"
  | "PICKUP_BEACON"
  | "RETURN_FOR_HEAL"
  | "WAIT";

export interface Task {
  readonly type: TaskType;
  /** 目标格（HARVEST_CURRENT/DEPOSIT 等在格上直接行动；WAIT/EXPLORE 可缺省）。 */
  readonly target?: Position;
  /** 目标格键 "x,y"（唯一性硬约束与 sticky 匹配都用它）。 */
  readonly targetCellKey?: string;
}

/** canDeposit：cargo > 0 且 Core 在位且资源未满（resourceSpace=0 时 DEPOSIT 不合法，
 *  强派会把满载 Worker 拉回 Core 格后让位，形成"回仓→让位→再回仓"振荡（v0.2.14）。 */
export function canDeposit(unit: PlanningUnit, snapshot: PlanningSnapshot): boolean {
  return unit.cargo > 0 && snapshot.corePosition !== null && snapshot.resourceSpace > 0;
}

/** 强制任务判定：命中 RP2 规则返回对应 Task，否则 null（走代价矩阵）。
 *  规则 0：与 GROUND Beacon 同格（且无人持有）→ PICKUP_BEACON。
 *  只拾取"路径上恰好经过"的 Beacon，不派 Worker 专门去抢——采集优先级不被干扰，
 *  行为保持确定性（同 Tick 同状态 → 同动作）。 */
export function forcedTaskFor(unit: PlanningUnit, snapshot: PlanningSnapshot): Task | null {
  const beacon = snapshot.beacon;
  if (
    unit.cargo === 0 &&
    beacon.status === "GROUND" &&
    beacon.carrierId === null &&
    cellKey(unit.position) === cellKey(beacon.position)
  ) {
    return { type: "PICKUP_BEACON", target: beacon.position, targetCellKey: cellKey(beacon.position) };
  }
  const core = snapshot.corePosition;
  // cargo>0 即强制回仓（服务器语义：HARVEST 要求 cargo=0，cargo=1 再采必
  // CARGO_FULL——"满载运 2 次"不可行，2026-08-06 实验实证后回滚）。
  if (unit.cargo > 0 && core !== null) {
    return { type: "DEPOSIT", target: core };
  }
  if (unit.cargo === 0 && snapshot.resourceCells.has(cellKey(unit.position))) {
    return {
      type: "HARVEST_CURRENT",
      target: unit.position,
      targetCellKey: cellKey(unit.position),
    };
  }
  if (unit.hp <= 1 && canReturnForHeal(unit, core)) {
    return { type: "RETURN_FOR_HEAL", target: core };
  }
  return null;
}

/** 可安全回家：Core 在位且不在 Core 上（骨架判定；路径安全/拦截风险留给 Leader 集成时补全）。 */
function canReturnForHeal(unit: PlanningUnit, core: Position | null): core is Position {
  return core !== null && manhattan(unit.position, core) > 0;
}
