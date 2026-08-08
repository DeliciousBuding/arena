/** WorkerTaskPlanner：全局任务分配（确定性 Hungarian + route-aware 代价）。
 *
 * 生产回流（99b4ba2/d2fe2f6，production-runtime-v3）：同一 Tick 多个空 Worker
 * 在同一资源格 HARVEST 时，只有 UUID 最低者成功，其余全部失败——因此必须由本
 * 模块做全局分配，保证**同一资源格最多一个 Worker**（唯一性硬约束，见 plan()）。
 *
 * 分配求解：确定性矩形 Hungarian（algorithms/min-cost-assignment.ts）——行 = 未
 * 分配 Worker，列 = 候选资源格 + 每 Worker 一个 dummy WAIT 列。矩阵代价 =
 * −netValue（净收益越大代价越小），waitCost 恒高于全部真实任务（真实任务优先），
 * forbiddenCost 恒高于 WAIT（宁 WAIT 不做非法任务）。与旧贪心相比，Hungarian
 * 求全局最优（贪心在 2+ worker 抢近矿、远端矿无人去时落局部次优）。
 *
 * 代价模型（总裁决 RP2 + route-aware）：
 *   cost = expected_resource_value - travel_time - return_time
 *          - threat_risk - congestion - stale_penalty
 *          + exploration_gain + beacon_bonus + sticky + refill_bonus
 * 其中 travel/return 用障碍感知 BFS 距离场（shortestPathDistances），绕墙/绕敌
 * 走真实步数；BFS 未覆盖（超出预算/半径）时回退曼哈顿 + UNKNOWN_ROUTE_PENALTY
 * 降级，绝不误判"永久不可达"。
 */

import { manhattan, shortestPathDistances, type PathSearchOptions } from "../domain/nav.ts";
import { type Position } from "../domain/model.ts";
import { minimumCostAssignment } from "../algorithms/min-cost-assignment.ts";
import { forcedTaskFor, type Task } from "./task.ts";
import type { PlanningSnapshot, PlanningUnit } from "./planning-snapshot.ts";
import {
  DEFAULT_MISSION_CONFIG,
  isCollectable,
  refillBonusOf,
  surveyorIds,
  targetConfidence,
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

// 代价模型常数（数值化：travel/return = 距离 ×1.0，见总裁决 RP2）
const RESOURCE_VALUE = 1.0; // 单次 HARVEST 期望资源产出
const TRAVEL_WEIGHT = 1.0; // travel_time = 距离 ×1.0
const RETURN_WEIGHT = 1.0; // return_time = 回 Core 距离 ×1.0
const BEACON_BONUS = 2.0; // 目标格恰为 GROUND 信标时的加成
const EXPLORATION_GAIN = 0.0; // 预留：GO_RESOURCE 目标是已知资源格，探索增益暂为 0
/** BFS 未覆盖该格（超出搜索预算/半径）时对直线距离的降级惩罚——"路径未知"按
 *  8 步额外代价计，仍可比 WAIT 更优（路线是局部绕行，鲜有真不可达）。 */
const UNKNOWN_ROUTE_PENALTY = 8.0;
/** 记忆矿直接距离上限（Manhattan，探索最外环）：超出 = 长途奔陈旧种子 = 空跑
 *  （t1 实证 14 worker 全扑 100+ 格外陈旧测绘种子、30+ tick 零采集）——
 *  不进入候选矩阵，交给巡逻发现。 */
const MEMORY_MAX_DIRECT_DISTANCE = 40;
/** 不可见格随龄惩罚：age × 0.20/tick，封顶 8.0（陈旧种子自然低于新鲜矿）。 */
const STALE_AGE_WEIGHT = 0.2;
const STALE_MAX_PENALTY = 8.0;
/** seeded（跨 run 测绘种子）额外惩罚：无真实观察，置信低于新鲜记忆。 */
const SEEDED_PENALTY = 2.0;
/** 任务分配路由预算：半径 24（与 stepToward 默认一致，走廊级绕行）+ 1024 节点
 *  （每 worker 一次 BFS 覆盖全部候选格，热路径可控）。 */
const ASSIGNMENT_ROUTE_RADIUS = 24;
const ASSIGNMENT_ROUTE_NODE_BUDGET = 1024;

/** sticky 机制（progress-aware，planner-algos-v3 吸收）：上一 Tick 该 Worker 的
 *  任务目标格与本次候选一致时返回 amount × progressDecay(distance)——Worker 离
 *  目标越近 sticky 越强（防中途改派浪费路程），越远越弱。distance 缺省时回退
 *  二值 sticky（amount / 0，零回归）。
 *
 *  与 Hungarian 不冲突的证明：sticky 只是 netValue 的加法项，作为矩阵代价的
 *  一部分参与求解；Hungarian 对任意有限代价矩阵求全局最小，任何代价项都不影响
 *  求解器正确性（仅改变"最优"的定义）。progressDecay 纯函数、确定性、单调，
 *  同状态同输出。 */
export function applyStickyBonus(
  unitId: string,
  targetCellKey: string,
  previousAssignments: readonly Assignment[],
  amount: number,
  distance?: number,
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
  if (previousTarget !== targetCellKey) return 0;
  if (distance === undefined) return amount;
  return amount * progressDecay(distance);
}

/** 距离比例衰减（progress-aware sticky 核）：dist=0 → 1.0、dist=normDist → 0.5、
 *  dist→∞ → 0。normDist=20（约 patrol 中环半径）。纯函数。 */
export function progressDecay(distance: number, normDistance = 20): number {
  return normDistance / (normDistance + distance);
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

  /** 全局任务分配（确定性 Hungarian）。previousAssignments：上一 Tick 分配结果
   *  （progress-aware sticky 用）。options.surveyBurstActive：迁移后测绘期。
   *
   *  分配步骤：
   *  1. 强制任务（RP2）：DEPOSIT / HARVEST_CURRENT / RETURN_FOR_HEAL / 同格
   *     PICKUP_BEACON 直接指派，目标格计入 claimedCells（唯一性硬约束）；
   *  2. 测绘期勘探预留（G2）：surveyWorkerFloor 个 worker 先提为 EXPLORE；
   *  3. 候选 = 资源格 − claimed −（invisible 且被 worker 站住的格，freeze fix）；
   *  4. 每 worker 一次 BFS 距离场 + core 一次回程距离场（routingObstacles =
   *     obstacleCells ∪ enemyCells），netValue 用真实绕行步数；
   *  5. Hungarian 求解（含 dummy WAIT 列），真实任务恒优于 WAIT；
   *  6. dummy 选中的 worker 按使命层角色仲裁（surveyorIds）转 EXPLORE 或守家 WAIT。 */
  plan(
    snapshot: PlanningSnapshot,
    previousAssignments: readonly Assignment[] = [],
    options: PlanOptions = {},
  ): WorkerTaskPlan {
    const workers = snapshot.units.filter((unit) => unit.unitType === "WORKER");
    const assignments: Assignment[] = [];

    // 唯一性硬约束：同一资源格最多一个 Worker。
    // 实现：claimedCells 记录本 Tick 已占用的资源格——强制任务直接占用，
    // 代价矩阵候选 = 资源格 − 已占用格，Hungarian 每列只指派给一个 Worker。
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
    // freeze fix（生产回流 99b4ba2，2026-08-08 t4）：worker 站在 invisible 记忆/
    // seed 矿上时不得把该格重派给自己（矿实际不在格上，到达后 WAIT 死锁）。
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

    const pool = [...unassigned].sort((a, b) => a.id.localeCompare(b.id));
    // 使命层角色仲裁（G2）：迁移后测绘期（surveyBurstActive）保证 ≥ surveyWorkerFloor
    // 个勘探者——在求解之前预留（否则好矿多时 floor 保证失效：worker 全去采集、
    // 无人测绘新家园）。
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
      // route-aware（生产回流 d2fe2f6）：绕行障碍 = 静态障碍 ∪ 敌方占用格
      // （敌格是临时障碍；core 回程同理，一次 BFS 距离场服务全部候选格）。
      const routingObstacles = new Set([...snapshot.obstacleCells, ...snapshot.enemyCells]);
      const routingOptions: PathSearchOptions = {
        searchRadius: ASSIGNMENT_ROUTE_RADIUS,
        nodeBudget: ASSIGNMENT_ROUTE_NODE_BUDGET,
        abandonFactor: 3,
      };
      const travelFields = new Map<string, ReadonlyMap<string, number>>();
      if (routingObstacles.size > 0) {
        for (const worker of pool) {
          travelFields.set(
            worker.id,
            shortestPathDistances(worker.position, targetPositions, routingObstacles, routingOptions),
          );
        }
      }
      const returnField = snapshot.corePosition === null || routingObstacles.size === 0
        ? new Map<string, number>()
        : shortestPathDistances(snapshot.corePosition, targetPositions, routingObstacles, routingOptions);

      const realNetValues = pool.map((worker) =>
        availableCells.map((key) =>
          this.netValue(
            worker,
            key,
            snapshot,
            previousAssignments,
            claimedCells,
            travelFields.get(worker.id)?.get(key),
            returnField.get(key),
            routingObstacles.size > 0,
          ),
        ),
      );
      const finiteCosts = realNetValues.flat()
        .filter(Number.isFinite)
        .map((net) => -net);
      const maxReal = finiteCosts.length > 0 ? Math.max(...finiteCosts) : 0;
      // 真实任务恒优于 WAIT；WAIT 优于明确非法（forbidden）任务——三个层次
      // 由哨兵代价大小关系保证，Hungarian 最小化总代价时自然遵守。
      const waitCost = maxReal + 1_000_000;
      const forbiddenCost = waitCost + 1_000_000;
      // 矩阵：行 = Worker；列 = 候选资源格 + 每 Worker 一个 dummy WAIT 列
      // （rows <= columns 的 rectangular 前提由此满足）。
      const matrix = realNetValues.map((row, rowIndex) => [
        ...row.map((net, colIndex) => {
          if (!Number.isFinite(net)) return forbiddenCost;
          const worker = pool[rowIndex]!;
          const key = availableCells[colIndex]!;
          const cell = snapshot.resourceCells.get(key);
          // 使命层（worker-mission-v1）：门槛/距离/死矿过滤——不值得的格对该
          // worker 视为 forbidden（宁 WAIT 也不长途空跑陈旧种子，t1 实证）。
          if (
            cell !== undefined &&
            !isCollectable(net, worker, cell.position, this.mission, snapshot.refillPredictions)
          ) {
            return forbiddenCost;
          }
          return -net;
        }),
        ...Array.from({ length: pool.length }, () => waitCost),
      ]);
      const columns = minimumCostAssignment(matrix);
      // 先解出真实任务（列 < availableCells.length），剩余（dummy 列）worker
      // 再走使命层角色仲裁（G2，非测绘期）：前 surveyWorkerCap 个 → EXPLORE
      // （SURVEYOR，由 deterministic-planner 落 patrolFallback 勘探基线）；
      // 超出部分守家 WAIT 不空跑。注意 surveyorIds 必须只看"未分配到真实任务"
      // 的 worker——否则被真实任务占用的 surveyor 名额浪费，cap 内勘探者数量
      // 少于预期（worker-mission-v1 回归测试实证）。测绘期已在求解前预留
      // （pre-reserve 分支），此处剩余 worker 均为非勘探者 → WAIT。
      // 全量外出（2026-08-08，用户导向"矿工不许原地守家"，v3 生产行为）：
      // alwaysSurvey=true 时无矿可采（dummy WAIT 列）的剩余 worker 全部 EXPLORE
      // （外出测绘/打探，永不守家 WAIT）——守家是军事单位职责；特殊卡位
      // （blockade）与核心迁移持货由 SafetyPlanner 显式例外。
      // 供给缺口勘探（surveyOnSupplyGap，2026-08-08，t2 生产实证）：候选可采格
      // 数量 < 未分配 worker 数（dummyWorkers 非空）时缺口全部转 SURVEYOR——
      // 矿工供给过剩时边际矿工应去测绘新矿源，而不是守家 WAIT 空耗（t2 实证
      // 12 空 worker 抢 1-8 可见矿、近核全死种子、守家 WAIT 零产出）。
      const realTargets = new Map<string, string>(); // workerId → cellKey
      const dummyWorkers: PlanningUnit[] = [];
      for (let rowIndex = 0; rowIndex < pool.length; rowIndex += 1) {
        const worker = pool[rowIndex]!;
        const column = columns[rowIndex]!;
        if (column < availableCells.length) {
          realTargets.set(worker.id, availableCells[column]!);
        } else {
          dummyWorkers.push(worker);
        }
      }
      const alwaysOutbound = this.mission.alwaysSurvey === true;
      const supplyGapSurvey = this.mission.surveyOnSupplyGap === true && dummyWorkers.length > 0;
      // 测绘期也适用供给缺口（2026-08-08 审查修复）：burst 分支原恒返回空集 →
      // 测绘期（恰是迁移后最缺矿期）缺口 worker 仍守家 WAIT。缺口判断只看
      // dummy 是否非空，测绘期同样生效。
      const leftoverSurveyors = supplyGapSurvey
        ? new Set(dummyWorkers.map((worker) => worker.id))
        : options.surveyBurstActive === true
          ? new Set<string>()
          : surveyorIds(dummyWorkers, this.mission, false);
      for (const worker of pool) {
        const key = realTargets.get(worker.id);
        if (key !== undefined) {
          const cell = snapshot.resourceCells.get(key);
          assignments.push({
            unitId: worker.id,
            task: {
              type: "GO_RESOURCE",
              target: cell?.position,
              targetCellKey: key,
            },
          });
        } else {
          assignments.push({
            unitId: worker.id,
            task: alwaysOutbound || leftoverSurveyors.has(worker.id) ? { type: "EXPLORE" } : { type: "WAIT" },
          });
        }
      }
    } else if (pool.length > 0) {
      // 无候选格（资源全被强制任务占用/全 invisible 被站/无资源）：走角色仲裁。
      // 供给缺口勘探（surveyOnSupplyGap）：候选格为 0 = 供给完全不足——全部
      // 转 SURVEYOR 外出测绘，不守家 WAIT（t2 生产实证：近核全死种子时守家
      // WAIT 零产出，勘探才能找到新矿源）。
      const supplyGapSurvey = this.mission.surveyOnSupplyGap === true;
      const leftoverSurveyors = options.surveyBurstActive === true
        ? new Set<string>()
        : supplyGapSurvey
          ? new Set(pool.map((worker) => worker.id))
          : surveyorIds(pool, this.mission, false);
      for (const worker of pool) {
        assignments.push({
          unitId: worker.id,
          task: (this.mission.alwaysSurvey === true) || leftoverSurveyors.has(worker.id) ? { type: "EXPLORE" } : { type: "WAIT" },
        });
      }
    }

    return { assignments };
  }

  /** 净收益（总裁决 RP2 代价模型 + 使命层置信项 + route-aware 距离）：越大越优先。
   *
   *  routedTravelDistance/routedReturnDistance：BFS 距离场结果（未覆盖时 undefined）；
   *  hasRoutingObstacles：本轮存在绕行障碍（有障碍但 BFS 未覆盖 = 未知路径，
   *  直线距离 + UNKNOWN_ROUTE_PENALTY 降级；无任何障碍时直接用直线距离，
   *  与旧贪心逐位一致）。 */
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
    // 记忆矿 40 格边界：不可见格超距不进入矩阵（长途奔陈旧种子 = 空跑，t1 实证）。
    if (cell.visible === false && directTravel > MEMORY_MAX_DIRECT_DISTANCE) {
      return Number.NEGATIVE_INFINITY;
    }
    // 敌方占用格不可采（生产回流 d2fe2f6）：目标在敌人脚下，采集必然失败/送死。
    if (snapshot.enemyCells.has(key)) return Number.NEGATIVE_INFINITY;
    const travelDistance =
      routedTravelDistance ?? directTravel + (hasRoutingObstacles ? UNKNOWN_ROUTE_PENALTY : 0);
    const directReturn = snapshot.corePosition === null ? 0 : manhattan(cell.position, snapshot.corePosition);
    const returnDistance = snapshot.corePosition === null
      ? 0
      : routedReturnDistance ?? directReturn + (hasRoutingObstacles ? UNKNOWN_ROUTE_PENALTY : 0);
    const travelTime = TRAVEL_WEIGHT * travelDistance;
    const returnTime = RETURN_WEIGHT * returnDistance;
    const threatRisk = snapshot.threatMap.get(key) ?? 0; // 敌人距离倒数衰减
    const congestion = claimedCells.has(key) ? this.congestionPenalty : 0; // 唯一性硬约束下恒为 0
    const explorationGain = EXPLORATION_GAIN;
    // 不可见格随龄惩罚 + seed 惩罚（生产回流 99b4ba2）：陈旧种子自然低于新鲜矿
    // ——与使命层 targetConfidence（配置驱动，叠加）互补，默认配置即生效。
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
    const sticky = applyStickyBonus(worker.id, key, previousAssignments, this.stickyBonus, travelDistance);
    // 分配滞回（2026-08-08，t2 生产实证 planChurn=1.0 根治）：上一 tick 目标格
    // 仍可采时额外加 switchThreshold——只有新目标净收益显著更高才切换，worker
    // 路程不浪费、分配跨 tick 稳定。缺省 0 = 零回归（sticky 0.5 基础保留）。
    const hysteresis = applyStickyBonus(worker.id, key, previousAssignments, this.mission.switchThreshold, travelDistance);
    // 使命层值层（G1）：目标置信项（可见加成 / seeded 随龄衰减）。
    const confidence = targetConfidence(cell, snapshot.tick, this.mission);
    // 使命层值层（Phase 2，G3）：矿刷新预测加成（即将刷新格提前占位）。
    const refillBonus = refillBonusOf(key, snapshot.refillPredictions, this.mission);
    return (
      RESOURCE_VALUE +
      confidence +
      refillBonus -
      travelTime -
      returnTime -
      threatRisk -
      congestion -
      stalePenalty +
      explorationGain +
      beaconBonus +
      sticky +
      hysteresis
    );
  }
}
