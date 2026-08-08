/** WorkerTaskPlanner：全局任务分配（确定性最小费用匹配）。
 *
 * 背景（长期主线第一个确定性收益升级）：同一 Tick 多个空 Worker 在同一资源格
 * HARVEST 时，只有 UUID 最低者成功，其余全部失败——因此必须由本模块做全局
 * 分配，保证**同一资源格最多一个 Worker**（唯一性硬约束，见 plan()）。
 *
 * 代价模型（总裁决 RP2）：
 *   cost = expected_resource_value - travel_time - return_time
 *          - threat_risk - congestion + exploration_gain + beacon_bonus
 * 把净收益取负转成 cost matrix，使用 Hungarian 全局最小费用匹配。资源列只
 * 出现一次，因此“一矿一 Worker”是结构性约束；额外 dummy 列代表 WAIT。与逐对
 * greedy 相比，这能避免“先抢了局部最近矿，迫使另一 Worker 跨图”的典型局部最优。
 */

import { manhattan, shortestPathDistances } from "../domain/nav.ts";
import { type Position } from "../domain/model.ts";
import { forcedTaskFor, type Task } from "./task.ts";
import type { PlanningSnapshot, PlanningUnit } from "./planning-snapshot.ts";
import { minimumCostAssignment } from "../algorithms/min-cost-assignment.ts";
import {
  DEFAULT_MISSION_CONFIG,
  isCollectable,
  refillBonusOf,
  surveyorIds,
  type MissionConfig,
} from "./mission-planner.ts";

/** 格子键："x,y"（与 domain model.ts 的 cellKey 同格式）。 */
export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

export interface Assignment {
  readonly unitId: string;
  readonly task: Task;
}

export interface WorkerTaskPlan {
  readonly assignments: ReadonlyArray<Assignment>;
}

export interface WorkerTaskPlannerConfig {
  /** 上一 Tick 同目标格任务的净收益加成（防抖动的 sticky bonus），默认 0.5。 */
  readonly stickyBonus?: number;
  /** 目标格已被分配数的拥挤惩罚，默认 1.0（唯一性硬约束下恒为 0；若后续匹配算法允许多分配则启用）。 */
  readonly congestionPenalty?: number;
  /** 使命层配置（worker-mission-v1）：缺省 = 关闭（现行为零回归）。 */
  readonly mission?: MissionConfig;
}

/** plan() 每次调用级选项（核心迁移状态由调用方追踪）。 */
export interface PlanOptions {
  /** 迁移后测绘期激活（DeterministicPlanner 依据核心位置变化判定）。 */
  readonly surveyBurstActive?: boolean;
}

export const DEFAULT_STICKY_BONUS = 0.5;
export const DEFAULT_CONGESTION_PENALTY = 1.0;

// 代价模型常数：路径代价来自已知障碍上的最短路距离；搜索预算未覆盖时退回
// Manhattan + UNKNOWN_ROUTE_PENALTY（“未知”≠“永久不可达”）。
const RESOURCE_VALUE = 1.0;
const TRAVEL_WEIGHT = 1.0;
const RETURN_WEIGHT = 1.0;
const BEACON_BONUS = 2.0;
const EXPLORATION_GAIN = 0.0;
const UNKNOWN_ROUTE_PENALTY = 8.0;
/** 记忆矿仍保持历史 40 格主动开采边界，避免 seeded 老矿诱发跨图远征。 */
const MEMORY_MAX_DIRECT_DISTANCE = 40;
/** stale 资源置信惩罚：每老 1 tick +0.20，最多 8；seed 再加 2。 */
const STALE_AGE_WEIGHT = 0.20;
const STALE_MAX_PENALTY = 8.0;
const SEEDED_PENALTY = 2.0;
/** 热路径路由预算：只精算局部 24 格，最多展开 1024 节点；远处用近似代价。 */
const ASSIGNMENT_ROUTE_RADIUS = 24;
const ASSIGNMENT_ROUTE_NODE_BUDGET = 1024;

/** sticky 机制：上一 Tick 该 Worker 的任务目标格与本次候选一致时返回 amount，否则 0。
 *  Leader 集成时把上一 Tick 的分配结果作为 previousAssignments 传入 plan() 即可。 */
export function applyStickyBonus(
  unitId: string,
  targetCellKey: string,
  previousAssignments: readonly Assignment[],
  amount: number,
): number {
  const previous = previousAssignments.find((assignment) => assignment.unitId === unitId);
  if (previous === undefined) {
    return 0;
  }
  const previousTarget =
    previous.task.targetCellKey ??
    (previous.task.target !== undefined
      ? cellKey(previous.task.target[0], previous.task.target[1])
      : undefined);
  return previousTarget === targetCellKey ? amount : 0;
}

function sameCell(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export class WorkerTaskPlanner {
  readonly stickyBonus: number;
  readonly congestionPenalty: number;
  private mission: MissionConfig;

  constructor(config: WorkerTaskPlannerConfig = {}) {
    this.stickyBonus = config.stickyBonus ?? DEFAULT_STICKY_BONUS;
    this.congestionPenalty = config.congestionPenalty ?? DEFAULT_CONGESTION_PENALTY;
    this.mission = { ...DEFAULT_MISSION_CONFIG, ...(config.mission ?? {}) };
  }

  /** 热加载使命层配置（DeterministicPlanner.updateConfig 转发）。 */
  updateConfig(config: WorkerTaskPlannerConfig = {}): void {
    this.mission = { ...DEFAULT_MISSION_CONFIG, ...(config.mission ?? {}) };
  }

  /** 全局任务分配。previousAssignments：上一 Tick 分配结果（sticky 用）。
   *  options.surveyBurstActive：迁移后测绘期（调用方按核心位置变化判定）。 */
  plan(
    snapshot: PlanningSnapshot,
    previousAssignments: readonly Assignment[] = [],
    options: PlanOptions = {},
  ): WorkerTaskPlan {
    const workers = snapshot.units.filter((unit) => unit.unitType === "WORKER");
    const assignments: Assignment[] = [];

    // 唯一性硬约束：同一资源格最多一个 Worker。
    // 实现：claimedCells 记录本 Tick 已占用的资源格——
    //   1. 强制 HARVEST_CURRENT 的目标格直接占用；
    //   2. 代价矩阵候选 = 资源格 − 已占用格；
    //   3. 每轮贪心取走的格从候选移除（不再参与后续匹配）。
    // 输出由此保证唯一性，不依赖测试凑数。
    const claimedCells = new Set<string>();
    for (const worker of workers) {
      // 强制任务优先（RP2）：DEPOSIT / HARVEST_CURRENT / RETURN_FOR_HEAL 不走代价矩阵
      const forced = forcedTaskFor(worker, snapshot);
      if (forced !== null) {
        assignments.push({ unitId: worker.id, task: forced });
        if (forced.targetCellKey !== undefined) {
          claimedCells.add(forced.targetCellKey);
        }
      }
    }

    const unassigned = workers.filter((worker) => !assignments.some((a) => a.unitId === worker.id));
    const occupiedByWorker = new Set(
      workers.map((worker) => cellKey(worker.position[0], worker.position[1])),
    );
    const availableCells = [...snapshot.resourceCells.keys()]
      .filter((key) => !claimedCells.has(key))
      // 追空矿冻结修复（2026-08-08，t4 生产实证）：worker 已在某格但该矿
      // 当前不可见（memory/seed 矿，visible=false——矿 2-6 tick 相位消失）时，
      // 不得继续分配该格——否则 worker 到达后 GO_RESOURCE 恒 WAIT（无矿可采）
      // 永久冻结（t4 3 worker 全部 WAIT+GO_RESOURCE、res=0 连续 100+ tick）。
      // 释放后 worker 回 Safety 巡逻，去探新鲜矿/等 refill。
      .filter((key) => {
        const cell = snapshot.resourceCells.get(key);
        if (cell?.visible === false && occupiedByWorker.has(key)) return false;
        return true;
      })
      .sort(); // 字典序：确定性迭代顺序

    // Hungarian 全局最优：rows=worker；columns=resource + 每 worker 一个 dummy WAIT。
    // dummy cost 取高于任一真实候选的确定性上界，因此资源数不足时才 WAIT；
    // 若未来加入不可达判定，可把不可达候选提升到 forbiddenCost，仍复用同一求解器。
    const pool = [...unassigned].sort((a, b) => a.id.localeCompare(b.id));
    // 使命层（worker-mission-v1）：迁移后测绘期保证 ≥ surveyWorkerFloor 个勘探者——
    // 在求解前预留（否则好矿多时 floor 保证失效：worker 全去采集、无人测绘新家园）。
    const surveyors = surveyorIds(pool, this.mission, options.surveyBurstActive === true);
    if (options.surveyBurstActive === true && surveyors.size > 0) {
      for (const worker of [...pool]) {
        if (!surveyors.has(worker.id)) continue;
        assignments.push({ unitId: worker.id, task: { type: "EXPLORE" } });
        pool.splice(pool.indexOf(worker), 1);
      }
    }
    if (pool.length > 0) {
      const targetPositions = availableCells
        .map((key) => snapshot.resourceCells.get(key)?.position)
        .filter((position): position is Position => position !== undefined);
      const routingObstacles = new Set([...snapshot.obstacleCells, ...snapshot.enemyCells]);
      const routingOptions = { searchRadius: ASSIGNMENT_ROUTE_RADIUS, nodeBudget: ASSIGNMENT_ROUTE_NODE_BUDGET, abandonFactor: 3 };
      const travelFields = new Map<string, ReadonlyMap<string, number>>();
      if (routingObstacles.size > 0) {
        for (const worker of pool) {
          travelFields.set(worker.id, shortestPathDistances(
            worker.position, targetPositions, routingObstacles, routingOptions,
          ));
        }
      }
      const returnField = snapshot.corePosition === null || routingObstacles.size === 0
        ? new Map<string, number>()
        : shortestPathDistances(snapshot.corePosition, targetPositions, routingObstacles, routingOptions);

      const realNetValues = pool.map((worker) => availableCells.map((key) =>
        this.netValue(
          worker, key, snapshot, previousAssignments, claimedCells,
          travelFields.get(worker.id)?.get(key), returnField.get(key), routingObstacles.size > 0,
        )));
      const finiteCosts = realNetValues.flat()
        .filter(Number.isFinite)
        .map((net) => -net);
      const maxReal = finiteCosts.length > 0 ? Math.max(...finiteCosts) : 0;
      // eligible real task is always preferred over WAIT (historical semantics); WAIT beats
      // explicit ineligible task. This preserves “use all known mines” without forcing a
      // worker to violate the memory-distance safety boundary.
      const waitCost = maxReal + 1_000_000;
      const forbiddenCost = waitCost + 1_000_000;
      // 使命层（worker-mission-v1）：低于采集价值门槛/超距的格 = forbidden——
      // worker 宁可选 WAIT（→ patrol 勘探）也不长途奔陈旧种子（t1 实证空跑）。
      const matrix = realNetValues.map((row, rowIndex) => [
        ...row.map((net, colIndex) => {
          if (!Number.isFinite(net)) return forbiddenCost;
          const worker = pool[rowIndex]!;
          const key = availableCells[colIndex]!;
          const cell = snapshot.resourceCells.get(key);
          if (cell !== undefined && !isCollectable(net, worker, cell.position, this.mission, snapshot.refillPredictions)) {
            return forbiddenCost;
          }
          return -net;
        }),
        ...Array.from({ length: pool.length }, () => waitCost),
      ]);
      const columns = minimumCostAssignment(matrix);
      // 全量外出（2026-08-08，用户导向“矿工不许原地守家”）：alwaysSurvey=true 时
      // 无矿可采（dummy WAIT 列）的剩余 worker 全部 EXPLORE（外出测绘/打探，永不守家
      // WAIT）——矿工不守家，守家是军事单位职责；特殊卡位（blockade）与核心迁移持货
      // 由 SafetyPlanner 显式例外。
      const alwaysOutbound = this.mission.alwaysSurvey === true;
      for (let rowIndex = 0; rowIndex < pool.length; rowIndex += 1) {
        const worker = pool[rowIndex]!;
        const column = columns[rowIndex]!;
        if (column >= availableCells.length) {
          assignments.push({
            unitId: worker.id,
            task: alwaysOutbound ? { type: "EXPLORE" } : { type: "WAIT" },
          });
          continue;
        }
        const key = availableCells[column]!;
        const cell = snapshot.resourceCells.get(key);
        assignments.push({
          unitId: worker.id,
          task: { type: "GO_RESOURCE", target: cell?.position, targetCellKey: key },
        });
      }
    }

    return { assignments };
  }

  /** 净收益（总裁决 RP2 代价模型）：越大越优先。 */
  private netValue(
    worker: PlanningUnit,
    key: string,
    snapshot: PlanningSnapshot,
    previousAssignments: readonly Assignment[],
    claimedCells: ReadonlySet<string>,
    routedTravelDistance?: number,
    routedReturnDistance?: number,
    hasRoutingObstacles = false,
  ): number {
    const cell = snapshot.resourceCells.get(key);
    if (cell === undefined) {
      return Number.NEGATIVE_INFINITY; // 防御分支：候选均来自 resourceCells
    }
    const directTravel = manhattan(worker.position, cell.position);
    if (cell.visible === false && directTravel > MEMORY_MAX_DIRECT_DISTANCE) {
      return Number.NEGATIVE_INFINITY;
    }
    // 目标格当前被敌方实体占据时，不把 Worker 分配过去；下一 Tick 敌人离开后
    // candidate 会自然恢复，无需把动态占位写成永久障碍。
    if (snapshot.enemyCells.has(key)) return Number.NEGATIVE_INFINITY;
    const travelDistance = routedTravelDistance ?? directTravel + (hasRoutingObstacles ? UNKNOWN_ROUTE_PENALTY : 0);
    const directReturn = snapshot.corePosition === null ? 0 : manhattan(cell.position, snapshot.corePosition);
    const returnDistance = snapshot.corePosition === null
      ? 0
      : routedReturnDistance ?? directReturn + (hasRoutingObstacles ? UNKNOWN_ROUTE_PENALTY : 0);
    const travelTime = TRAVEL_WEIGHT * travelDistance;
    const returnTime = RETURN_WEIGHT * returnDistance;
    const threatRisk = snapshot.threatMap.get(key) ?? 0;
    const congestion = claimedCells.has(key) ? this.congestionPenalty : 0;
    const explorationGain = EXPLORATION_GAIN;
    const age = cell.visible === false
      ? Math.max(0, snapshot.tick - (cell.lastSeenTick ?? snapshot.tick))
      : 0;
    const stalePenalty = cell.visible === false
      ? Math.min(STALE_MAX_PENALTY, age * STALE_AGE_WEIGHT) + (cell.seeded === true ? SEEDED_PENALTY : 0)
      : 0;
    const beaconBonus =
      snapshot.beacon.status === "GROUND" && sameCell(snapshot.beacon.position, cell.position)
        ? BEACON_BONUS
        : 0;
    const sticky = applyStickyBonus(worker.id, key, previousAssignments, this.stickyBonus);
    // 分配滞回（2026-08-08，t2 生产实证 planChurn=1.0 根治）：上一 tick 目标格
    // 仍可采时额外加 switchThreshold——只有新目标净收益显著更高才切换，worker
    // 路程不浪费、分配跨 tick 稳定。缺省 0 = 零回归（sticky 基础保留）。
    const hysteresis = applyStickyBonus(worker.id, key, previousAssignments, this.mission.switchThreshold);
    // 使命层值层（Phase 2，G3 数据管道）：矿刷新预测加成（即将刷新格提前占位）。
    const refillBonus = refillBonusOf(key, snapshot.refillPredictions, this.mission);
    return (
      RESOURCE_VALUE - travelTime - returnTime - threatRisk - congestion - stalePenalty
      + explorationGain + beaconBonus + sticky + hysteresis + refillBonus
    );
  }
}
