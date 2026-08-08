/** WorkerTaskPlanner：全局任务分配（确定性贪心）。
 *
 * 背景（长期主线第一个确定性收益升级）：同一 Tick 多个空 Worker 在同一资源格
 * HARVEST 时，只有 UUID 最低者成功，其余全部失败——因此必须由本模块做全局
 * 分配，保证**同一资源格最多一个 Worker**（唯一性硬约束，见 plan()）。
 *
 * 代价模型（总裁决 RP2）：
 *   cost = expected_resource_value - travel_time - return_time
 *          - threat_risk - congestion + exploration_gain + beacon_bonus
 * 按净收益（上式即净收益）确定性贪心：每轮取净收益最大的 (Worker, 资源格) 对，
 * 已指派资源格从候选移除。初期单位数 <20，贪心足够；匈牙利算法留作后续替换
 * （替换时 netValue() 的代价矩阵可直接复用）。
 */

import { manhattan } from "../domain/nav.ts";
import { type Position } from "../domain/model.ts";
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

// 代价模型常数（数值化：travel/return = 曼哈顿距离 ×1.0，见总裁决 RP2）
const RESOURCE_VALUE = 1.0; // 单次 HARVEST 期望资源产出
const TRAVEL_WEIGHT = 1.0; // travel_time = 距离 ×1.0
const RETURN_WEIGHT = 1.0; // return_time = 回 Core 距离 ×1.0
const BEACON_BONUS = 2.0; // 目标格恰为 GROUND 信标时的加成
const EXPLORATION_GAIN = 0.0; // 预留：GO_RESOURCE 目标是已知资源格，探索增益暂为 0

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
    const availableCells = [...snapshot.resourceCells.keys()]
      .filter((key) => !claimedCells.has(key))
      .sort(); // 字典序：确定性迭代顺序

    const pool = [...unassigned].sort((a, b) => a.id.localeCompare(b.id));
    // 使命层角色仲裁（G2）：迁移后测绘期（surveyBurstActive）保证 ≥ surveyWorkerFloor
    // 个勘探者——在贪心采集之前预留（否则好矿多时 floor 保证失效：worker 全去采集、
    // 无人测绘新家园）。
    const surveyors = surveyorIds(pool, this.mission, options.surveyBurstActive === true);
    if (options.surveyBurstActive === true && surveyors.size > 0) {
      for (const worker of [...pool]) {
        if (!surveyors.has(worker.id)) continue;
        assignments.push({ unitId: worker.id, task: { type: "EXPLORE" } });
        pool.splice(pool.indexOf(worker), 1);
      }
    }

    // 确定性贪心：每轮取净收益最大的 (Worker, 资源格) 对；并列时取先出现的
    // （Worker 按 id 升序、资源格按键字典序，均确定）。已选 Worker 与资源格
    // 从候选移除。匈牙利算法替换点：把 netValue 矩阵交给匹配器即可。
    // 使命层（worker-mission-v1）：候选格按 score ≥ 门槛 && 距离 ≤ 上限过滤
    // （陈旧种子/超距目标不入池 → worker 转勘探而非长途空跑，t1 实证）。
    while (pool.length > 0 && availableCells.length > 0) {
      let best: { worker: PlanningUnit; cellKey: string; net: number } | null = null;
      for (const worker of pool) {
        for (const key of availableCells) {
          const net = this.netValue(worker, key, snapshot, previousAssignments, claimedCells);
          const cell = snapshot.resourceCells.get(key);
          // 使命层（worker-mission-v1）：门槛/距离/死矿过滤——该 worker 对此格不值得
          // （陈旧种子/超距/预测采空）则跳过；无任何可采格时 worker 自然留在 pool → 转勘探。
          if (cell !== undefined && !isCollectable(net, worker, cell.position, this.mission, snapshot.refillPredictions)) {
            continue;
          }
          if (best === null || net > best.net) {
            best = { worker, cellKey: key, net };
          }
        }
      }
      if (best === null) {
        break; // 无可采 (worker, 格) 对：剩余 pool 转勘探/守家
      }
      const cell = snapshot.resourceCells.get(best.cellKey);
      assignments.push({
        unitId: best.worker.id,
        task: {
          type: "GO_RESOURCE",
          target: cell?.position,
          targetCellKey: best.cellKey,
        },
      });
      pool.splice(pool.indexOf(best.worker), 1);
      availableCells.splice(availableCells.indexOf(best.cellKey), 1);
    }

    // 使命层角色仲裁（G2，非测绘期）：剩余 worker 前 surveyWorkerCap 个 → EXPLORE
    // （SURVEYOR，由 deterministic-planner 落 patrolFallback 勘探基线）；超出部分
    // 守家 WAIT 不空跑。测绘期已在采集前预留（上面的 pre-reserve 分支），此处
    // 剩余 worker 均为非勘探者 → WAIT。
    // 全量外出（2026-08-08，用户导向"矿工不许原地守家"）：alwaysSurvey=true 时
    // 剩余空闲 worker 全部 EXPLORE（外出测绘/打探，永不守家 WAIT）——矿工不守家，
    // 守家是军事单位职责；特殊卡位（blockade）与核心迁移持货由 SafetyPlanner 显式例外。
    const leftoverSurveyors = options.surveyBurstActive === true
      ? new Set<string>()
      : surveyorIds(pool, this.mission, false);
    const alwaysOutbound = this.mission.alwaysSurvey === true;
    for (const worker of pool) {
      assignments.push({
        unitId: worker.id,
        task: alwaysOutbound || leftoverSurveyors.has(worker.id) ? { type: "EXPLORE" } : { type: "WAIT" },
      });
    }

    return { assignments };
  }

  /** 净收益（总裁决 RP2 代价模型 + 使命层置信项）：越大越优先。 */
  private netValue(
    worker: PlanningUnit,
    key: string,
    snapshot: PlanningSnapshot,
    previousAssignments: readonly Assignment[],
    claimedCells: ReadonlySet<string>,
  ): number {
    const cell = snapshot.resourceCells.get(key);
    if (cell === undefined) {
      return Number.NEGATIVE_INFINITY; // 防御分支：候选均来自 resourceCells
    }
    const travelTime = TRAVEL_WEIGHT * manhattan(worker.position, cell.position);
    const returnTime =
      snapshot.corePosition === null
        ? 0 // Core 不在位无回程（骨架：Leader 集成时再定）
        : RETURN_WEIGHT * manhattan(cell.position, snapshot.corePosition);
    const threatRisk = snapshot.threatMap.get(key) ?? 0; // 敌人距离倒数衰减
    const congestion = claimedCells.has(key) ? this.congestionPenalty : 0; // 唯一性硬约束下恒为 0
    const explorationGain = EXPLORATION_GAIN;
    const beaconBonus =
      snapshot.beacon.status === "GROUND" && sameCell(snapshot.beacon.position, cell.position)
        ? BEACON_BONUS
        : 0;
    const sticky = applyStickyBonus(worker.id, key, previousAssignments, this.stickyBonus);
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
      congestion +
      explorationGain +
      beaconBonus +
      sticky
    );
  }
}
