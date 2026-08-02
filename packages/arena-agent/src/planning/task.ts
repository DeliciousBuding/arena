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

/** canDeposit：cargo > 0 且 Core 在位（可接收）。 */
export function canDeposit(unit: PlanningUnit, snapshot: PlanningSnapshot): boolean {
  return unit.cargo > 0 && snapshot.corePosition !== null;
}

/** 强制任务判定：命中 RP2 规则返回对应 Task，否则 null（走代价矩阵）。 */
export function forcedTaskFor(unit: PlanningUnit, snapshot: PlanningSnapshot): Task | null {
  const core = snapshot.corePosition;
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
