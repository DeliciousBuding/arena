/** Mission Planner（worker-mission-v1，2026-08-08，架构设计见
 *  docs/design/worker-mission-layer-v1.md）：值层 + 使命层的纯函数核心。
 *
 * 现状空洞（t1 实证：14 worker 全扑陈旧测绘种子、30+ tick 零采集零巡逻）：
 * - G1 目标置信缺失：visible/stale/seeded 元数据不进评分，陈旧种子与新鲜矿同值；
 * - G2 角色缺失：勘探只是 WAIT 兜底，种子矿填满池子后 WAIT 永不发生。
 *
 * 本模块提供：
 * - 值层 scoreCollectionTarget：在既有 netValue（距离/威胁）上叠加置信项
 *   （visible 加成、seeded 随龄衰减）——陈旧种子自然低于采集门槛；
 * - 使命层 collectableCells / surveyorCount：门槛 + 距离过滤后仍无目标的
 *   worker 转 SURVEYOR（勘探角色，动作由 deterministic-planner 落
 *   patrolFallback 的既有巡逻基线），超 cap 守家 WAIT 不空跑。
 *
 * 全部纯函数、确定性（id/字典序排序）；配置缺省 = 现行为零回归。
 */

import type { PlanningSnapshot, PlanningUnit } from "./planning-snapshot.ts";

/** 格子键："x,y"（与 worker-task-planner cellKey 同格式，本地实现避免循环依赖）。 */
function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Mission 层配置（DeterministicVariantConfig.mission；缺省 = 现行为）。 */
export interface MissionConfig {
  /** 采集价值门槛：score < 门槛的格不进采集池（低于门槛 = 与勘探价值相当，转 SURVEYOR）。 */
  readonly collectionValueFloor: number;
  /** 采集最大距离（Manhattan）：超出不入池（长途奔陈旧种子 = 空跑，t1 实证）。 */
  readonly maxCollectionDistance: number;
  /** SURVEYOR（勘探）worker 上限：超出部分守家 WAIT，不空跑。 */
  readonly surveyWorkerCap: number;
  /** 迁移后测绘期（tick）：核心迁移完成后该时长内保证 ≥ surveyWorkerFloor 个勘探者。 */
  readonly surveyBurstTicks: number;
  /** 测绘期最少勘探者数（surveyBurstTicks > 0 且测绘期内生效）。 */
  readonly surveyWorkerFloor: number;
  /** 可见格置信加成（目标质量分项）。 */
  readonly visibleBonus: number;
  /** seeded 种子随龄衰减系数：score −= seedAgeDecay × age。 */
  readonly seedAgeDecay: number;
  /** 矿刷新预测加成（Phase 2）：dueInTicks ≤ refillLookahead 的格 +refillBonus
   *  （提前占位即将刷新矿）。 */
  readonly refillLookahead: number;
  readonly refillBonus: number;
  /** 死矿剔除阈值（Phase 2）：dueInTicks < −deadMineOverdueTicks 视为永久采空，
   *  不入采集池（t1 实证：14 worker 循环近核死种子、cargo=0 冻结）。 */
  readonly deadMineOverdueTicks: number;
  /** 迁移方向勘探（2026-08-08，migration-scout）：核心 MOVING 时 EXPLORE worker 朝
   *  核心迁移方向探路（为落点测绘），而非随机老分区。核心 NORMAL 时零影响。 */
  readonly migrationScout: boolean;
  /** 分配滞回阈值（2026-08-08，t2 生产实证 planChurn=1.0 根治）：上一 tick 目标格
   *  仍可采时，新目标净收益必须高于原目标该阈值才切换——低于阈值保持原目标
   *  （worker 路程不浪费、分配稳定）。缺省 0 = 关闭（现行为零回归）。 */
  readonly switchThreshold: number;
  /** 供给缺口勘探（2026-08-08，t2 生产实证 12 空 worker 抢 1-8 可见矿）：候选可采格
   *  数量 < 未分配 worker 数时，缺口部分全部转 SURVEYOR（勘探新矿源）——矿工供给
   *  过剩时边际矿工应去测绘，而不是守家 WAIT 或追死种子。缺省 false = 关闭（零回归）。 */
  readonly surveyOnSupplyGap: boolean;
}

/** 缺省 = 关闭（全部保守值，逐字节复现现行为）。 */
export const DEFAULT_MISSION_CONFIG: MissionConfig = Object.freeze({
  collectionValueFloor: Number.NEGATIVE_INFINITY,
  maxCollectionDistance: Number.POSITIVE_INFINITY,
  surveyWorkerCap: 0,
  surveyBurstTicks: 0,
  surveyWorkerFloor: 0,
  visibleBonus: 0,
  seedAgeDecay: 0,
  refillLookahead: 0,
  refillBonus: 0,
  deadMineOverdueTicks: 0,
  migrationScout: false,
  switchThreshold: 0,
  surveyOnSupplyGap: false,
});

/** 目标置信项（G1）：可见加成 + seeded 随龄衰减。独立于距离/威胁，便于单测。 */
export function targetConfidence(
  cell: { readonly visible?: boolean; readonly lastSeenTick?: number; readonly seeded?: boolean },
  tick: number,
  config: MissionConfig,
): number {
  let confidence = cell.visible === true ? config.visibleBonus : 0;
  if (cell.seeded === true && cell.lastSeenTick !== undefined) {
    const age = Math.max(0, tick - cell.lastSeenTick);
    confidence -= config.seedAgeDecay * age;
  }
  return confidence;
}

/** 采集池过滤（G1+G2 门槛 + Phase 2 死矿剔除）：不满足门槛/距离的格不可采集。
 *  返回 false = 该格不可达/不值得，worker 应转勘探。
 *  refillPredictions（cellKey → dueInTicks）：dueInTicks < −deadMineOverdueTicks
 *  的格疑似永久采空 → 不可采（t1 实证死种子循环）。 */
export function isCollectable(
  score: number,
  worker: PlanningUnit,
  cellPosition: readonly [number, number],
  config: MissionConfig,
  refillPredictions?: ReadonlyMap<string, number>,
): boolean {
  if (score < config.collectionValueFloor) return false;
  const key = cellKey(cellPosition[0], cellPosition[1]);
  const dueInTicks = refillPredictions?.get(key);
  if (dueInTicks !== undefined && dueInTicks < -config.deadMineOverdueTicks) return false;
  const distance = Math.abs(worker.position[0] - cellPosition[0]) + Math.abs(worker.position[1] - cellPosition[1]);
  return distance <= config.maxCollectionDistance;
}

/** 矿刷新预测加成（Phase 2）：dueInTicks ≤ refillLookahead（即将刷新）→ +refillBonus，
 *  提前占位即将刷新矿。无预测/缺省 = 0（零回归）。 */
export function refillBonusOf(
  key: string,
  refillPredictions: ReadonlyMap<string, number> | undefined,
  config: MissionConfig,
): number {
  const dueInTicks = refillPredictions?.get(key);
  if (dueInTicks === undefined) return 0;
  if (dueInTicks > config.refillLookahead) return 0;
  if (dueInTicks < -config.deadMineOverdueTicks) return 0; // 死矿不加成
  return config.refillBonus;
}

/** SURVEYOR 名额（G2）：未分配 worker 中取前 cap 个（按 id 升序，确定性）；
 *  测绘期（surveyBurstActive）保证至少 floor 个。返回 (workerId → EXPLORE) 映射
 *  之外的剩余未分配 worker（守家 WAIT）。 */
export function surveyorIds(
  unassigned: readonly PlanningUnit[],
  config: MissionConfig,
  surveyBurstActive: boolean,
): ReadonlySet<string> {
  const ordered = [...unassigned].sort((a, b) => a.id.localeCompare(b.id));
  const required = surveyBurstActive
    ? Math.max(config.surveyWorkerFloor, config.surveyWorkerCap)
    : config.surveyWorkerCap;
  if (required <= 0) return new Set();
  return new Set(ordered.slice(0, required).map((worker) => worker.id));
}

export type { PlanningSnapshot };
