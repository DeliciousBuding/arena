/**
 * DeterministicPlanner（leader 集成，2026-08-03）：WorkerTaskPlanner → SafetyPlanner
 * 接口适配。decisionMode=deterministic 时 tenant-runtime 注入此 planner（P0-1 契约：
 * coordinator 不感知 deterministic——planner 注入即得）。
 *
 * 转换规则（Task → UnitAction，确定性）：
 * - GO_RESOURCE：不在资源格 → 朝目标格移动一步（先 x 后 y，确定性方向）
 * - HARVEST_CURRENT：已在资源格 → HARVEST
 * - DEPOSIT：cargo>0 → 已回 Core 格则 DEPOSIT，否则朝 Core 移动一步
 * - RETURN_FOR_HEAL：朝 Core 移动一步（到位后 HEAL 由 Safety 兜底/下 Tick 处理）
 * - WAIT/EXPLORE/PICKUP_BEACON（骨架未产出）→ WAIT
 *
 * 非 Worker 单位（Vanguard/Ranger）无 assignment → WAIT（确定性骨架只分配 Worker；
 * 战斗单位策略是后续里程碑）。
 *
 * sticky：applyStickyBonus 在 WorkerTaskPlanner.plan() 内部按 previousAssignments
 * 计算——本类缓存上一 Tick 分配结果传入。
 */

import { cellKey, type Direction, type Plan, type Position, type TickState, type UnitAction } from "../domain/model.ts";
import { stepToward as pathStepToward } from "../domain/nav.ts";
import type { PlanProvider } from "../runtime/decision-types.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../strategies/safety-planner.ts";
import { extractPlanningSnapshot, type PlanningSnapshot } from "./planning-snapshot.ts";
import { WorkerTaskPlanner, type Assignment } from "./worker-task-planner.ts";

/** 朝向目标的确定性一步（先 x 后 y；已在目标列/行则走另一轴）。 */
export function stepToward(from: Position, target: Position): Direction {
  const dx = target[0] - from[0];
  const dy = target[1] - from[1];
  if (dx !== 0) {
    return dx > 0 ? "RIGHT" : "LEFT";
  }
  return dy > 0 ? "DOWN" : "UP";
}

/** position + direction → 下一步格（边界不校验——调用方用 obstacles 判定）。 */
function stepCell(position: Position, direction: Direction): Position {
  switch (direction) {
    case "UP":
      return [position[0], position[1] - 1];
    case "DOWN":
      return [position[0], position[1] + 1];
    case "LEFT":
      return [position[0] - 1, position[1]];
    case "RIGHT":
      return [position[0] + 1, position[1]];
  }
}

/** 障碍感知一步：首选方向被挡 → 依次尝试纯 x / 纯 y 轴；全挡返回 null（调用方 WAIT）。
 *  修正依据：t2 真机观察 repair 率 48.5%（blocked_move 系统性）——骨架不避障导致。 */
export function stepTowardAvoiding(from: Position, target: Position, obstacles: ReadonlySet<string>): Direction | null {
  return pathStepToward(from, target, obstacles);
}

export class DeterministicPlanner implements PlanProvider {
  private readonly planner: WorkerTaskPlanner;
  private readonly fallbackPlanner: SafetyPlanner;
  private previousAssignments: readonly Assignment[] = [];

  constructor(
    planner: WorkerTaskPlanner = new WorkerTaskPlanner(),
    fallbackPlanner: SafetyPlanner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG),
  ) {
    this.planner = planner;
    this.fallbackPlanner = fallbackPlanner;
  }

  decide(input: { readonly state: TickState }): Plan {
    // SafetyPlanner 已包含跨 Tick World（障碍/资源线索/Worker 巡逻状态）。先生成完整
    // 基线计划，再用 WorkerTaskPlanner 覆盖可见资源的全局唯一分配。这样 deterministic
    // 不再是“看不到资源就 WAIT”的骨架，也不会复制第二套脆弱状态机。
    const fallback = this.fallbackPlanner.decide(input);
    const rawSnapshot = extractPlanningSnapshot(input.state);
    const snapshot: PlanningSnapshot = {
      ...rawSnapshot,
      obstacleCells: this.fallbackPlanner.world.obstacles(rawSnapshot.obstacleCells),
    };
    const { assignments } = this.planner.plan(snapshot, this.previousAssignments);
    this.previousAssignments = assignments;

    const unitActions: Record<string, UnitAction> = { ...fallback.unitActions };
    const intents: Record<string, string> = { ...(fallback.intents ?? {}) };
    for (const assignment of assignments) {
      if (assignment.task.type === "WAIT") {
        // 无可见资源时保留 Safety 的资源记忆/分散巡逻动作；有可见资源但数量少于
        // Worker 时，额外 Worker 必须 WAIT，不能重新扎堆到已被全局分配的资源格。
        if (snapshot.resourceCells.size > 0) {
          unitActions[assignment.unitId] = { type: "WAIT" };
          intents[assignment.unitId] = "WAIT_UNCLAIMED";
        }
        continue;
      }
      unitActions[assignment.unitId] = this.taskAction(assignment, snapshot);
      intents[assignment.unitId] = assignment.task.type;
    }

    // 防御分支：任何缺失动作的单位都必须有合法 WAIT；正常情况下 fallback 已覆盖。
    for (const unit of snapshot.units) {
      if (unitActions[unit.id] === undefined) {
        unitActions[unit.id] = { type: "WAIT" };
        intents[unit.id] = "WAIT";
      }
    }

    // 当前生产目标是积累 Core 资源，deterministic 热路径暂不主动消费资源；
    // MacroPolicy 后续只需决定是否放开 fallback.coreAction，无需重写单位策略。
    return { tick: input.state.tick, unitActions, coreAction: null, intents };
  }

  /** Task → UnitAction（确定性映射；核心语义见文件头注释）。 */
  private taskAction(assignment: Assignment, snapshot: PlanningSnapshot): UnitAction {
    const unit = snapshot.units.find((u) => u.id === assignment.unitId);
    if (unit === undefined) {
      return { type: "WAIT" };
    }
    const task = assignment.task;
    switch (task.type) {
      case "HARVEST_CURRENT":
        return { type: "HARVEST" };
      case "DEPOSIT":
      case "RETURN_FOR_HEAL": {
        const core = snapshot.corePosition;
        if (core === null) {
          return { type: "WAIT" };
        }
        if (unit.position[0] === core[0] && unit.position[1] === core[1]) {
          return task.type === "DEPOSIT" ? { type: "DEPOSIT" } : { type: "WAIT" };
        }
        const direction = stepTowardAvoiding(unit.position, core, snapshot.obstacleCells);
        return direction === null ? { type: "WAIT" } : { type: "MOVE", direction };
      }
      case "GO_RESOURCE": {
        const target = task.target;
        if (target === undefined) {
          return { type: "WAIT" };
        }
        if (unit.position[0] === target[0] && unit.position[1] === target[1]) {
          const targetKey = task.targetCellKey ?? cellKey(target);
          return snapshot.resourceCells.has(targetKey) ? { type: "HARVEST" } : { type: "WAIT" };
        }
        const direction = stepTowardAvoiding(unit.position, target, snapshot.obstacleCells);
        return direction === null ? { type: "WAIT" } : { type: "MOVE", direction };
      }
      default:
        return { type: "WAIT" };
    }
  }
}
