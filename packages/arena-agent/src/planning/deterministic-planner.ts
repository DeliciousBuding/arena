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
 * - PICKUP_BEACON：与 GROUND Beacon 同格 → PICKUP_BEACON（2x 采集加成；不派专人去抢）
 * - WAIT/EXPLORE → WAIT
 *
 * 非 Worker 单位（Vanguard/Ranger）无 assignment：保留 SafetyPlanner fallback 的
 * 战斗动作（SWEEP 近战 / SHOOT 直线射击 / 追击 / 无目标回防 Core）。
 * WorkerTaskPlanner 只覆盖 Worker 单位的资源分配。
 *
 * sticky：applyStickyBonus 在 WorkerTaskPlanner.plan() 内部按 previousAssignments
 * 计算——本类缓存上一 Tick 分配结果传入。
 */

import {
  cellKey,
  type CoreAction,
  type Direction,
  type Plan,
  type Position,
  type TickState,
  type UnitAction,
} from "../domain/model.ts";
import {
  adaptivePathOptions,
  manhattan,
  move,
  stepToward as pathStepToward,
  type PathSearchOptions,
} from "../domain/nav.ts";
import type { PlanProvider } from "../runtime/decision-types.ts";
import type { MacroPolicy } from "../runtime/macro-policy.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner, type SafetyPlannerConfig } from "../strategies/safety-planner.ts";
import { World, type CoreHuntTarget } from "../domain/world.ts";
import type { ThreatProfile } from "../strategies/safety-planner-config.ts";
import { unitSpawnCosts } from "../domain/pricing.ts";
import {
  applyReplacementQueueDelta,
  consumeReplacementQueue,
  EMPTY_REPLACEMENT_QUEUE,
  type ReplacementQueue,
} from "../domain/state-reducer.ts";
import { extractPlanningSnapshot, type PlanningSnapshot } from "./planning-snapshot.ts";
import { WorkerTaskPlanner, type Assignment, type CellBlocker } from "./worker-task-planner.ts";
import { DEFAULT_MISSION_CONFIG, type MissionConfig } from "./mission-planner.ts";
import type { WorkerProgressExpectation, WorkerProgressExpectations } from "./progress-contract.ts";
import { directionToNextPathCell } from "../migration/overlay.ts";
import type { MigrationPlanV1 } from "../migration/plan.ts";

const CELL_ENTITY_CAPACITY = 2;
const REROUTE_ORDER: Readonly<Record<Direction, readonly Direction[]>> = {
  UP: ["RIGHT", "LEFT", "DOWN"],
  RIGHT: ["DOWN", "UP", "LEFT"],
  DOWN: ["LEFT", "RIGHT", "UP"],
  LEFT: ["UP", "DOWN", "RIGHT"],
};

interface MoveCandidate {
  readonly unitId: string;
  readonly source: Position;
  readonly destination: Position;
  readonly direction: Direction;
  readonly intent: string;
  readonly priority: number;
}

export interface CapacityResolution {
  readonly unitActions: Readonly<Record<string, UnitAction>>;
  readonly intents: Readonly<Record<string, string>>;
  readonly rerouteCount: number;
  readonly waitCount: number;
}

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
export function stepTowardAvoiding(
  from: Position,
  target: Position,
  obstacles: ReadonlySet<string>,
  options?: PathSearchOptions,
): Direction | null {
  return pathStepToward(from, target, obstacles, options);
}

/** 迁移方向勘探（2026-08-08，migration-scout）：核心 MOVING 时，EXPLORE worker
 *  朝核心迁移方向前方 scoutRange 格探路（为落点测绘），而非随机老分区。
 *  返回该方向的下一步 Direction；无迁移/无方向/已在目标附近返回 null（fallback 巡逻）。
 *  纯函数可测；核心 NORMAL 时 previousCorePosition 不匹配 → null 零影响。 */
export function migrationScoutDirection(
  workerPosition: Position,
  corePosition: Position,
  previousCorePosition: Position | null,
  obstacles: ReadonlySet<string>,
  scoutRange = 24,
): Direction | null {
  if (previousCorePosition === null) return null;
  const dx = corePosition[0] - previousCorePosition[0];
  const dy = corePosition[1] - previousCorePosition[1];
  if (dx === 0 && dy === 0) return null;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const target: Position = [corePosition[0] + sx * scoutRange, corePosition[1] + sy * scoutRange];
  if (workerPosition[0] === target[0] && workerPosition[1] === target[1]) return null;
  return stepTowardAvoiding(workerPosition, target, obstacles);
}

/** 迁移方向勘探·计划前向约束版（migration-system-v1 §3.3，评审 P1 定稿）：
 *  不再靠核心前后坐标差分推断方向（旧 migration-scout 只在核心完成格子的那
 *  tick 触发，且推断的是"已经走过的方向"），改读计划路径的下一格方向——
 *  核心 NORMAL 的 LEG_MOVE 窗口内也持续前向探路。plan.state≠LEG_MOVE 或
 *  路径无相邻前进格 → null（fallback 巡逻，零影响）。 */
export function migrationScoutDirectionForPlan(
  workerPosition: Position,
  corePosition: Position,
  plan: MigrationPlanV1,
  obstacles: ReadonlySet<string>,
  scoutRange = 24,
): Direction | null {
  if (plan.state !== "LEG_MOVE") return null;
  const next = directionToNextPathCell(plan.path.cells, corePosition, Math.max(0, plan.legProgress.legIndex));
  if (next === null) return null;
  const oneStep = move(corePosition, next.direction);
  const dx = oneStep[0] - corePosition[0];
  const dy = oneStep[1] - corePosition[1];
  const target: Position = [corePosition[0] + dx * scoutRange, corePosition[1] + dy * scoutRange];
  if (workerPosition[0] === target[0] && workerPosition[1] === target[1]) return null;
  return stepTowardAvoiding(workerPosition, target, obstacles);
}

/** 满载 Worker 资源满时让出 Core 格的移动方向：Core 四邻中第一个非障碍格
 *  （确定性 UP→RIGHT→DOWN→LEFT，与守家锚点 homeCell 同序）。
 *  资源满时 DEPOSIT 不合法，原地等待会永久占住 Core 格（SPAWN 被拒 → 资源
 *  永不消耗 → 永远满）；让位后 SPAWN 消耗资源、卸货通道恢复，Worker 再回来。 */
function yieldDirection(position: Position, obstacles: ReadonlySet<string>): Direction | null {
  const order: readonly Direction[] = ["UP", "RIGHT", "DOWN", "LEFT"];
  for (const direction of order) {
    if (!obstacles.has(cellKey(stepCell(position, direction)))) {
      return direction;
    }
  }
  return null;
}

/**
 * 按服务端全局移动规则做客户端侧容量预裁决：单格最多 2 个占用实体；所有已选 MOVE
 * 先组成最终占用图，超容量格逐步淘汰最低优先级的到达动作，直到固定点。这样保留
 * 合法依赖链/循环，不会把“当前已满但占用者本 Tick 会离开”的格误判成永久墙。
 */
export function resolveMoveCapacity(
  state: TickState,
  actions: Readonly<Record<string, UnitAction>>,
  intents: Readonly<Record<string, string>>,
  obstacles: ReadonlySet<string>,
): CapacityResolution {
  const nextActions: Record<string, UnitAction> = { ...actions };
  const nextIntents: Record<string, string> = { ...intents };
  const units = new Map(state.units.map((unit) => [unit.id, unit]));
  const currentOccupancy = new Map<string, number>();
  const hostileCells = new Set<string>();
  const increment = (key: string, amount = 1): void => {
    currentOccupancy.set(key, (currentOccupancy.get(key) ?? 0) + amount);
  };

  for (const unit of state.units) increment(cellKey(unit.position));
  if (state.core !== null) increment(cellKey(state.core.position));
  for (const enemy of state.visibleEnemies) {
    const key = cellKey(enemy.position);
    increment(key);
    hostileCells.add(key);
  }

  const candidates = new Map<string, MoveCandidate>();
  for (const [unitId, action] of Object.entries(actions)) {
    if (action.type !== "MOVE") continue;
    const unit = units.get(unitId);
    if (unit === undefined) continue;
    const intent = intents[unitId] ?? "MOVE";
    candidates.set(unitId, {
      unitId,
      source: unit.position,
      destination: stepCell(unit.position, action.direction),
      direction: action.direction,
      intent,
      priority: movePriority(unit.cargo, intent),
    });
  }

  const selected = new Set(candidates.keys());
  // 可见敌方占用格按“敌方不会可靠离开”保守处理，避免 MOVE_DESTINATION_OCCUPIED。
  for (const candidate of candidates.values()) {
    if (hostileCells.has(cellKey(candidate.destination))) selected.delete(candidate.unitId);
  }

  let finalOccupancy = projectedOccupancy(currentOccupancy, candidates, selected);
  while (true) {
    const violatingCell = firstCapacityViolation(currentOccupancy, finalOccupancy, candidates, selected);
    if (violatingCell === null) break;
    const arrivals = [...candidates.values()]
      .filter((candidate) => selected.has(candidate.unitId) && cellKey(candidate.destination) === violatingCell)
      .sort(compareWorstMoveFirst);
    if (arrivals.length === 0) break;
    selected.delete(arrivals[0].unitId);
    finalOccupancy = projectedOccupancy(currentOccupancy, candidates, selected);
  }

  let rerouteCount = 0;
  let waitCount = 0;
  const rejected = [...candidates.values()]
    .filter((candidate) => !selected.has(candidate.unitId))
    .sort(compareBestMoveFirst);
  for (const candidate of rejected) {
    const sourceKey = cellKey(candidate.source);
    let rerouted = false;
    if (canReroute(candidate.intent)) {
      for (const direction of REROUTE_ORDER[candidate.direction]) {
        const destination = stepCell(candidate.source, direction);
        const destinationKey = cellKey(destination);
        const currentDestinationOccupancy = currentOccupancy.get(destinationKey) ?? 0;
        if (
          obstacles.has(destinationKey) ||
          hostileCells.has(destinationKey) ||
          currentDestinationOccupancy > CELL_ENTITY_CAPACITY ||
          (finalOccupancy.get(destinationKey) ?? 0) >= CELL_ENTITY_CAPACITY
        ) {
          continue;
        }
        finalOccupancy.set(sourceKey, Math.max(0, (finalOccupancy.get(sourceKey) ?? 0) - 1));
        finalOccupancy.set(destinationKey, (finalOccupancy.get(destinationKey) ?? 0) + 1);
        nextActions[candidate.unitId] = { type: "MOVE", direction };
        nextIntents[candidate.unitId] = `capacity_reroute:${candidate.intent}`;
        rerouteCount += 1;
        rerouted = true;
        break;
      }
    }
    if (!rerouted) {
      nextActions[candidate.unitId] = { type: "WAIT" };
      nextIntents[candidate.unitId] = `capacity_wait:${candidate.intent}`;
      waitCount += 1;
    }
  }

  return { unitActions: nextActions, intents: nextIntents, rerouteCount, waitCount };
}

function projectedOccupancy(
  current: ReadonlyMap<string, number>,
  candidates: ReadonlyMap<string, MoveCandidate>,
  selected: ReadonlySet<string>,
): Map<string, number> {
  const result = new Map(current);
  for (const unitId of selected) {
    const candidate = candidates.get(unitId);
    if (candidate === undefined) continue;
    const sourceKey = cellKey(candidate.source);
    const destinationKey = cellKey(candidate.destination);
    result.set(sourceKey, Math.max(0, (result.get(sourceKey) ?? 0) - 1));
    result.set(destinationKey, (result.get(destinationKey) ?? 0) + 1);
  }
  return result;
}

function firstCapacityViolation(
  current: ReadonlyMap<string, number>,
  projected: ReadonlyMap<string, number>,
  candidates: ReadonlyMap<string, MoveCandidate>,
  selected: ReadonlySet<string>,
): string | null {
  const keys = new Set([...current.keys(), ...projected.keys()]);
  for (const key of [...keys].sort()) {
    const currentCount = current.get(key) ?? 0;
    const projectedCount = projected.get(key) ?? 0;
    // 历史超容量格不得接收入场；正常格最终容量不得超过 2。
    const hasIncoming = [...candidates.values()].some(
      (candidate) => selected.has(candidate.unitId) && cellKey(candidate.destination) === key,
    );
    if ((currentCount > CELL_ENTITY_CAPACITY && hasIncoming) || projectedCount > CELL_ENTITY_CAPACITY) {
      return key;
    }
  }
  return null;
}

function movePriority(cargo: number, intent: string): number {
  // 守位让位（ranger_home/vanguard_home）最高优先：让位者是回仓通道的
  // 解锁者——Core 格被军事单位占满时，让位动作被容量预裁决淘汰会导致
  // 永久死锁（生产 t2 实证：Ranger 让位目标格被 2 个 cargo worker 争抢
  // → Ranger 被淘汰 → Core 格永不释放 → 全部 worker WAIT、经济停摆）。
  if (intent === "ranger_home" || intent === "vanguard_home") return -1;
  if (cargo > 0 || intent === "DEPOSIT" || intent === "return_home") return 0;
  if (intent === "GO_RESOURCE" || intent === "go_harvest" || intent === "go_harvest_mem") return 1;
  if (intent === "RETURN_FOR_HEAL" || intent.includes("heal")) return 2;
  if (isPatrolIntent(intent)) return 4;
  return 3;
}

function isPatrolIntent(intent: string): boolean {
  return intent === "patrol" || intent === "WAIT_UNCLAIMED" || intent.startsWith("capacity_reroute:patrol");
}

/** 可容量绕行意图：被容量拒绝时绕行到相邻格继续接近目标（而非死 WAIT）。
 *  go_harvest/go_harvest_mem/GO_RESOURCE 加入（2026-08-08，t2 生产实证：
 *  5 worker 持续 capacity_wait:go_harvest_mem——记忆矿/可见矿被容量拒只能
 *  死等，位置不动触发 stuck 回退后重新选同一矿再卡，恶性循环；绕行让
 *  worker 持续朝目标推进，下 tick sticky 目标继续）。 */
function canReroute(intent: string): boolean {
  return (
    isPatrolIntent(intent) ||
    intent === "GO_RESOURCE" ||
    intent === "go_harvest" ||
    intent === "go_harvest_mem" ||
    intent.startsWith("capacity_reroute:")
  );
}

function compareBestMoveFirst(a: MoveCandidate, b: MoveCandidate): number {
  return a.priority - b.priority || a.unitId.localeCompare(b.unitId);
}

function compareWorstMoveFirst(a: MoveCandidate, b: MoveCandidate): number {
  return b.priority - a.priority || b.unitId.localeCompare(a.unitId);
}

/** Safety 决策拥有对经济 overlay 的否决权：这些 intent 是生存/撤离/通道清障
 * 动作，WorkerTaskPlanner 不得用采矿任务覆盖。core 通道清障（worker_clear_core*）
 * 2026-08-08 补入：t2 现场实证——Safety 已对核心格空 worker 发 worker_clear_core_empty
 * 疏散，但经济层用 GO_RESOURCE 覆盖（该空 worker 无 cargo 被 WorkerTaskPlanner 派矿），
 * 疏散永远不落地 → 空 worker 占核心格 130+ tick、7 满载围死 ring、deposit=0 冻结。 */
function isSafetyVetoIntent(intent: string | undefined): boolean {
  return (
    intent === "heal" ||
    intent === "worker_heal_return" ||
    intent === "worker_clear_core" ||
    intent === "worker_clear_core_empty" ||
    intent?.startsWith("worker_evade_") === true
  );
}

const WORKER_RECOVERY_FLOOR = 2;
// RECOVERY 早期防御（ref lifecycle overlay，2026-08-08）：重生/弱小期 worker 起步
// （>= EARLY_MILITARY_WORKER_FLOOR）且军事=0 时，先产 1 个 Vanguard 自卫（防野怪/入侵），
// 不等 workerTarget=12——裸奔期被拆的教训（t3 重生后无军事）。
const EARLY_MILITARY_WORKER_FLOOR = 4;
const EARLY_MILITARY_COUNT = 1;
/** 家防底线编成（W3b，官方 AGGRESS_DEFENDER_VANGUARDS=3 / AGGRESS_DEFENDER_RANGERS=3
 *  渐进补编，2026-08-09）：早期先 1V 自卫（EARLY_MILITARY_COUNT），再补 1V+2R，
 *  最后向 3V+3R 满编渐进——每档只产缺口兵种，不一次爆编。 */
const HOME_DEFENSE_VANGUARD_TARGET = 3;
const HOME_DEFENSE_RANGER_TARGET = 3;
/** 冷启动 worker 扩编目标（2026-08-07，t3/t4 生产实证）：worker 数未达该值
 *  时产 worker 豁免 spawnReserve——资源刚够成本就扩编（t4 实证：2W res 5 <
 *  WORKER 5 + reserve 2 = 7 → 永不产第 3 个 worker → 经济停滞）。v3.0
 *  MIN_BOOTSTRAP_WORKERS=3 放大到 6：workerTarget=12 的一半，尽早建立
 *  采集网后再进入正常 reserve 保护。 */
const BOOTSTRAP_WORKER_TARGET = 6;
const WORKER_SPAWN_COST = 5;
/** 补员保留资源（不因扩编掏空国库；emergency 时也可用满额 5）。 */
const WORKER_SPAWN_RESERVE = 2;
/** 资源高水位消费线（2026-08-10 用户理念）：150 = 顶级兑换码门槛，够用即可；
 *  超出部分花掉造单位。资源 >= 该值时强制 SPAWN（防 Core 容量顶格死锁）。 */
const RESOURCE_HIGH_WATER = 150;
/** 军事危机底线（2026-08-10 用户裁决升级"守卫起码 8 个"）：4V+4R = 8。
 *  军事单位（Vanguard+Ranger）少于该值 = 危机 → 紧急爆兵（无视 reserve/
 *  水位/ceiling，按 4V+4R 编成补缺口）。 */
const EMERGENCY_MILITARY_FLOOR = 8;
/** 危机爆兵的 Vanguard 目标（4V+4R 编成）：V < 4 先补 Vanguard（抗线肉盾），
 *  V≥4 后产 Ranger（火力）——四角各配 1 前锋 1 游侠（用户裁决）。 */
const EMERGENCY_VANGUARD_TARGET = 4;
/** 危机爆兵的 worker 起步门（2026-08-10）：workers < 该值 = 冷启动期——
 *  先按正常算法产 worker（工人军事均衡，用户裁决"按之前算法"），工人起步
 *  后军事不足才紧急爆兵（防冷启动只产兵不产工人）。 */
const EMERGENCY_WORKER_GATE = 4;
/** 容量硬顶余量（2026-08-10 数学防死锁）：res ≥ max(10, pop×5) − 15 时强制
 *  消费最便宜的（Worker→Vanguard→Ranger）——pop<30 时容量 <150 高水位线
 *  管不到，硬顶保证任何人口段都不顶满 Core 容量（DEPOSIT_FAILED 死锁）。 */
const CORE_CAPACITY_MARGIN = 15;
/**
 * 无 policy 时的默认补员目标（2026-08-06 扩编主动性优化）：原恢复地板 2 使
 * solo 3 worker 起步即永不补员（res 闲置）；workerTarget 梯度实验（3 seeds）：
 * 2→res 15/pop 3/deposits 5 vs 4→res 20/pop 4/deposits 15（3 倍，res 更高）——
 * 多 1 worker 边际收益 > 5 成本，纯正收益；8/12→deposits 17.3 但 res 5.7
 * （upkeep 负担重）。取 4 = 温和扩编（经济存量最优、无副作用），emergency
 * floor=2 保留。生产有 policy 时仍以 policy.workerTarget 为准（零变化）。
 */
const DEFAULT_WORKER_TARGET = 4;
/** 威胁防御产兵（竞品 arena_farmer 对照）：可见战斗敌距 Core 的触发半径。
 *  5 格 > 射程 3 = 预警带：敌人进入视野即产兵，比挨打再产（fallback
 *  HEAL 会抢占资源）提前 2 tick 部署。 */
const THREAT_SPAWN_DISTANCE = 5;
/** 威胁时的 VANGUARD 防御目标（官方 DEFENSE_VANGUARD_TARGET=3）。 */
const DEFENSE_VANGUARD_TARGET = 3;

/** 军事单位类型选择：默认交替（VANGUARD ↔ RANGER）；vanguardRatio 配置时按目标占比。 */
function nextMilitaryType(state: TickState, vanguardRatio?: number): "VANGUARD" | "RANGER" {
  if (vanguardRatio === undefined) {
    return state.vanguards.length <= state.rangers.length ? "VANGUARD" : "RANGER";
  }
  const military = state.vanguards.length + state.rangers.length;
  // ceil((military+1)*ratio)：新兵计入后 VANGUARD 占比不超过 ratio 才产 VANGUARD。
  // （floor(military*ratio) 在 military=0 时恒 0——ratio=1 也错误产 RANGER。）
  const targetVanguards = Math.ceil((military + 1) * vanguardRatio);
  return state.vanguards.length < targetVanguards ? "VANGUARD" : "RANGER";
}

/**
 * deterministic 的长期目标仍是积累资源，但不能因此失去自恢复能力：
 * - Core HEAL / REPAIR_SHIELD 属于生存动作，直接沿用 Safety 的合法裁决；
 * - START_MOVE（coreEvade 核心迁移逃生）/ CANCEL_MOVE（迁移取消止损）同为
 *   生存动作（2026-08-09）：deterministic 的 SPAWN 覆盖会让核心遇险不迁移，
 *   coreEvade 变体在 deterministic 主路径（生产 t1-t4）静默失效——直接透传；
 * - 补员按 policy.workerTarget 驱动（MacroPolicy 低频战略的消费点之一）：
 *   无 policy 时用 DEFAULT_WORKER_TARGET=4（扩编主动性，2026-08-06 实验取证），
 *   emergency floor=2 兜底；
 * - 补员带 reserve 保护（至少保留 2 资源），不因扩编掏空国库。
 */
export function selectDeterministicCoreAction(
  state: TickState,
  fallbackAction: CoreAction | null,
  policy?: MacroPolicy,
  vanguardRatio?: number,
  /** 爆兵模式（2026-08-06）：>0 时 resources 达标前只产 Worker 积累、达标后
   *  surgeActive=true 持续爆兵（不受 militaryRatio 限制）；内部按资源是否
   *  够产兵回写 surgeActive（资源耗尽回积累期）。默认 0 = 关闭。 */
  accumulateThreshold = 0,
  surgeActive = false,
  /** 补员 reserve（2026-08-06 第十轮实验配置）：solo 刷新供给≈upkeep 平衡场景
   *  （生产 t2：res 恒 5 < cost 5 + reserve 2 = 7 → 永不 SPAWN → pop 3 冻结），
   *  reserve=0 可突破平衡扩编；默认 WORKER_SPAWN_RESERVE=2 保持生产行为零回归。 */
  spawnReserve = WORKER_SPAWN_RESERVE,
  /** 人口上限（2026-08-07 动态定价配套）：SURGE/产兵分支越过该值不再 SPAWN——
   *  v0.14 第 21 单位起动态涨价（Worker 7/Vanguard 13/Ranger 16），超 20 的
   *  单位 ROI 骤降；与 SafetyPlanner.populationCeiling 对齐（默认 20）。
   *  缺省 Infinity = 历史行为（deterministic 不设上限，零回归）。 */
  populationCeiling = Number.POSITIVE_INFINITY,
  /** 威胁防御产兵（2026-08-07 竞品 _control_core 对照）：可见战斗敌距
   *  Core <=5 格（预警带）且 VANGUARD < 3 → 优先产 VANGUARD。实验 A/B
   *  （threat-defense-experiment，120 ticks × 3 seeds）：资源紧张场景
   *  （容量 10、res 10）产兵挤占治疗资源——被拆 17 tick vs 对照组（不
   *  产兵、res 留存治疗）25 tick——**更差**；官方有 heal/repair/迁移
   *  多重防御垫底，我们只有治疗。未证明净收益 → 默认关闭（候选）。 */
  threatDefenseSpawn = false,
  /** RECOVERY 早期防御产兵（2026-08-08，ref lifecycle overlay 对照）：军事=0 且
   *  worker >= EARLY_MILITARY_WORKER_FLOOR 时先产 1 Vanguard 自卫——重生/弱小期裸奔
   *  被野怪/入侵拆核的兜底（t3 重生后无军事实证）。默认开启（纯防御，不挤占采集）。 */
  recoveryEarlyMilitary = false,
  /** 家防底线渐进补编（W3b，home-defense-bottom-v1，2026-08-09）：官方
   *  AGGRESS_DEFENDER_VANGUARDS=3 / AGGRESS_DEFENDER_RANGERS=3 家防底线在
   *  RECOVERY/弱小期的渐进落地——1V 自卫 → 1V+2R → 3V+3R 满编，每档只产缺口
   *  兵种；豁免 spawnReserve（生存行为只看纯成本，与 recoveryEarlyMilitary 同
   *  语义）；不受 workerTarget=12 前置门限制（EARLY_MILITARY_WORKER_FLOOR=4
   *  起步）。默认关（零回归），变体显式开启。 */
  homeDefenseBottom = false,
  /** W12 按类型替补队列（replacement-queue-v1，2026-08-09）：阵亡军事单位
   *  按类型计数（VANGUARD/RANGER 各一计数器），产兵优先补缺口——缺口兵种
   *  买不起时价格窗口等待（不产低档替代品），队列空 / 变体关 = 历史产兵顺序
   *  不变（零回归）。队列由 DeterministicPlanner 实例持有，从 state-reducer
   *  纯函数（applyReplacementQueueDelta / consumeReplacementQueue）转移而来。 */
  replacementQueue: ReplacementQueue = EMPTY_REPLACEMENT_QUEUE,
  replacementQueueEnabled = false,
  /** 资源高水位消费线（2026-08-10 用户理念，防死锁兜底）：资源 >= 该值时
   *  无视 populationCeiling/军事配比强制产兵（价格按动态价）——t1 实证
   *  pop≥ceiling 后所有 SPAWN 分支关闭，资源囤积到 Core 容量上限
   *  （max(10, pop×5)）→ DEPOSIT_FAILED 满载 worker 卡 Core 格 → 经济死锁。
   *  默认 150 = 顶级兑换码门槛（够用即可，超出花掉造单位）。0 = 关闭。 */
  resourceHighWater = RESOURCE_HIGH_WATER,
): { readonly action: CoreAction | null; readonly intent: string | null; readonly surgeActive: boolean } {
  if (fallbackAction?.type === "HEAL") {
    return { action: fallbackAction, intent: "core_heal", surgeActive };
  }
  if (fallbackAction?.type === "REPAIR_SHIELD") {
    return { action: fallbackAction, intent: "repair_shield", surgeActive };
  }
  // coreEvade 迁移/取消（生存动作，2026-08-09）：Safety 裁决的 START_MOVE
  // （核心迁移逃生）与 CANCEL_MOVE（迁移取消止损）直接沿用，不落入下方 SPAWN
  // 分支——否则 deterministic 主路径（生产 t1-t4）覆盖后核心遇险不迁移，
  // coreEvade 变体形同虚设。intent 沿用 Safety 侧通用命名（core_evade /
  // migration_cancel；Safety 的细分原因 core_evade_ttr / migration_cancel_* 在
  // 透传层不可见，只保留动作级语义）。
  if (fallbackAction?.type === "START_MOVE") {
    return { action: fallbackAction, intent: "core_evade", surgeActive };
  }
  if (fallbackAction?.type === "CANCEL_MOVE") {
    return { action: fallbackAction, intent: "migration_cancel", surgeActive };
  }

  const workerTarget = Math.max(
    policy?.workerTarget ?? DEFAULT_WORKER_TARGET,
    WORKER_RECOVERY_FLOOR,
  );
  const core = state.core;
  const emergency = state.workers.length < WORKER_RECOVERY_FLOOR;
  // militaryRatio 消费点（v0.2.11）：workers 达 target 后按策略产兵——
  // 生产 A/B 实测清场方经济 2-4× 优于被压方（敌群挡回仓/采集）。经济优先：
  // workers 未达 target 或 militaryRatio=0 时仍只产 Worker。
  const militaryRatio = policy?.militaryRatio ?? 0;
  const military = state.vanguards.length + state.rangers.length;
  const populationTotal = state.workers.length + military;
  const needMilitary =
    state.workers.length >= workerTarget &&
    militaryRatio > 0 &&
    populationTotal > 0 &&
    military / populationTotal < militaryRatio;
  // 爆兵模式：达标即激活并保持（防止"产 1 兵掉回阈值下"振荡）
  let active = surgeActive;
  if (accumulateThreshold > 0 && !active && state.resources >= accumulateThreshold) {
    active = true;
  }

  if (core !== null && core.state === "NORMAL") {
    // v0.14 动态定价（2026-08-07 生产实证：pop 24 RANGER 实收 16、pop 25
    // VANGUARD 实收 13）：所有产兵分支用 unitSpawnCosts（按 spawn 前人口），
    // 不再用 base 价预算——旧固定价导致 pop≥21 后连串 INSUFFICIENT_RESOURCES
    // 失败（t1 67452-67478 实证）。人口超上限（默认 20 = 动态价线）不再产兵。
    const spawnCosts = unitSpawnCosts(state.population);
    // 威胁感知（官方 _control_core 对照）：可见战斗单位（VANGUARD/RANGER）
    // 距 Core <=3 格 = 射程内威胁——防御产兵触发条件。
    const coreThreatened = state.visibleEnemies.some(
      (enemy) =>
        enemy.kind === "UNIT" &&
        enemy.unitType !== "WORKER" &&
        manhattan(enemy.position, core.position) <= THREAT_SPAWN_DISTANCE,
    );
    // Core 格被空载/非 Worker 单位占位时阻塞生成（SPAWN 会叠加容量）；
    // 满载 Worker 是"卸货等待"不阻塞（资源满时 DEPOSIT 暂不合法，但 SPAWN
    // 消耗资源后立即可卸——资源满 + 占格 + 无法卸货会形成永久经济死锁）。
    const permanentOccupantsOnCore = state.units.filter(
      (unit) =>
        unit.position[0] === core.position[0] &&
        unit.position[1] === core.position[1] &&
        !(unit.unitType === "WORKER" && unit.cargo > 0),
    ).length;
    if (permanentOccupantsOnCore === 0) {
      const militaryCount = state.vanguards.length + state.rangers.length;
      // P1 军事危机爆兵（2026-08-10 用户裁决"军事单位减少太多才紧急爆兵，
      // 守卫起码 8 个 = 4V+4R"）：军事 < 8（且 worker 已起步 >=4，冷启动先
      // 按正常算法产 worker——工人军事均衡）或 可见威胁缺 Vanguard → 无视
      // reserve/水位/ceiling 全力产兵——按 4V+4R 编成补缺口（V<4 产
      // Vanguard 抗线肉盾，V≥4 产 Ranger 火力）。军事归零=裸奔（t2 77003
      // 被拆教训）；资源不足则让位（下 tick 重试）。放 popCeiling 检查前
      // （危机是生存行为，与占位检查同级——满载 worker 卡 Core 时同样解锁）。
      if (
        (militaryCount < EMERGENCY_MILITARY_FLOOR && state.workers.length >= EMERGENCY_WORKER_GATE) ||
        (coreThreatened && state.vanguards.length < DEFENSE_VANGUARD_TARGET)
      ) {
        const unitType: "VANGUARD" | "RANGER" =
          state.vanguards.length < EMERGENCY_VANGUARD_TARGET ? "VANGUARD" : "RANGER";
        if (state.resources >= spawnCosts[unitType]) {
          return {
            action: { type: "SPAWN", unitType },
            intent: "spawn_emergency_military",
            surgeActive: active,
          };
        }
      }
      // P2 资源高水位消费（2026-08-10 生产实证 t1 死锁根因 + 用户理念"150
      // （顶级兑换码门槛）够用即可，超出部分花掉造单位"）：pop≥ceiling 后
      // 正常 SPAWN 分支关闭 → 资源囤积到 Core 容量上限（max(10, pop×5)）→
      // DEPOSIT_FAILED 满载 worker 卡 Core 格 → 经济死锁。优先级高于
      // populationCeiling / 军事配比（死锁兜底）；价格按动态价；首选军事
      // （交替），买不起回退 Worker。
      if (resourceHighWater > 0 && state.resources >= resourceHighWater) {
        const unitType: "VANGUARD" | "RANGER" = nextMilitaryType(state, vanguardRatio);
        if (state.resources >= spawnCosts[unitType]) {
          return {
            action: { type: "SPAWN", unitType },
            intent: "spawn_high_water_spend",
            surgeActive: active,
          };
        }
        if (state.resources >= spawnCosts.WORKER) {
          return {
            action: { type: "SPAWN", unitType: "WORKER" },
            intent: "spawn_high_water_worker",
            surgeActive: active,
          };
        }
      }
      // P3 容量硬顶（2026-08-10 数学防死锁）：res 接近 Core 容量上限
      // （max(10, pop×5)）时强制消费最便宜的（Worker→Vanguard→Ranger）——
      // pop<30 时容量 <150 高水位线管不到，硬顶保证任何人口段都不顶满容量
      // （DEPOSIT_FAILED 死锁的绝对防线）。作为**兜底**放在正常分支之后
      // （含 popCeiling 停产分支）：正常策略能产时保持原有优先级/intent
      // （零回归），只有正常停产且容量将满时才介入。
      const coreCapacity = Math.max(10, state.population * 5);
      const capacitySpend = (): ReturnType<typeof selectDeterministicCoreAction> => {
        if (state.resources < coreCapacity - CORE_CAPACITY_MARGIN) {
          return { action: null, intent: null, surgeActive: active };
        }
        for (const unitType of ["WORKER", "VANGUARD", "RANGER"] as const) {
          if (state.resources >= spawnCosts[unitType]) {
            return {
              action: { type: "SPAWN", unitType },
              intent: "spawn_capacity_spend",
              surgeActive: active,
            };
          }
        }
        return { action: null, intent: null, surgeActive: active };
      };
      if (state.population >= populationCeiling) {
        return capacitySpend();
      }
      const surgeOn = accumulateThreshold > 0 && active;
      if (surgeOn) {
        // 爆兵期：全力产兵（交替 VANGUARD/RANGER，不受 militaryRatio 限制）
        const unitType: "VANGUARD" | "RANGER" = nextMilitaryType(state, vanguardRatio);
        const cost = spawnCosts[unitType];
        if (state.resources >= cost + spawnReserve) {
          return {
            action: { type: "SPAWN", unitType },
            intent: `spawn_${unitType.toLowerCase()}_surge`,
            surgeActive: active,
          };
        }
        // 资源不足以产兵：回积累期
        active = false;
      } else if (threatDefenseSpawn && coreThreatened && state.vanguards.length < DEFENSE_VANGUARD_TARGET) {
        // 威胁防御产兵（2026-08-07 竞品 _control_core 对照）：可见战斗敌
        // 距 Core <=5 格（预警带：射程 3 外提前 2 tick 部署）且 VANGUARD
        // 未达防御目标 → 优先产 VANGUARD——敌人打到门口时继续产 worker
        // 补员是送死（官方 DEFENSE_VANGUARD_TARGET=3，威胁响应先于经济
        // 扩张）。紧急防御豁免 spawnReserve（官方语义：威胁产兵只看纯
        // 成本 resources >= VANGUARD_COST——防御是生存行为不囤 reserve）。
        if (state.resources >= spawnCosts.VANGUARD) {
          return {
            action: { type: "SPAWN", unitType: "VANGUARD" },
            intent: "spawn_vanguard_defense",
            surgeActive: active,
          };
        }
      } else if (recoveryEarlyMilitary && military === 0 &&
                 state.workers.length >= EARLY_MILITARY_WORKER_FLOOR && militaryRatio > 0) {
        // RECOVERY 早期防御（ref 4W→1V 语义）：worker 已起步但无军事 → 产 1 Vanguard 自卫，
        // 不等 workerTarget=12（裸奔期被拆教训）。产 1 个后回到正常扩编。
        if (state.vanguards.length + state.rangers.length < EARLY_MILITARY_COUNT &&
            // 防御产兵豁免 spawnReserve（2026-08-08，与 threatDefenseSpawn 同语义：
            // 生存行为只看纯成本——t4 生产实证 res 0-2 裸奔 7W/0 军事，res<cost+reserve
            // 永远产不起 Vanguard；豁免后 res>=10 即可自卫，防裸奔期被拆）。
            state.resources >= spawnCosts.VANGUARD) {
          return {
            action: { type: "SPAWN", unitType: "VANGUARD" },
            intent: "spawn_vanguard_recovery",
            surgeActive: active,
          };
        }
      } else if (homeDefenseBottom && militaryRatio > 0 &&
                 state.workers.length >= EARLY_MILITARY_WORKER_FLOOR &&
                 (state.vanguards.length < HOME_DEFENSE_VANGUARD_TARGET ||
                  state.rangers.length < HOME_DEFENSE_RANGER_TARGET)) {
        // W3b 家防底线渐进补编（官方 AGGRESS_DEFENDER_* = 3V+3R）：早期防御线
        // 的完整版——1V 自卫 → 1V+2R → 3V+2R → 3V+3R 满编，每档只产缺口兵种
        // （先肉盾后火力），不受 workerTarget=12 前置门限制。满编后回正常扩编。
        // 豁免 spawnReserve（生存行为只看纯成本，与 recoveryEarlyMilitary 同语义）。
        const vanguards = state.vanguards.length;
        const rangers = state.rangers.length;
        const needVanguard = vanguards < HOME_DEFENSE_VANGUARD_TARGET &&
          (vanguards < 1 || rangers >= HOME_DEFENSE_RANGER_TARGET - 1);
        const needRanger = !needVanguard && vanguards >= 1 && rangers < HOME_DEFENSE_RANGER_TARGET;
        const unitType: "VANGUARD" | "RANGER" = needVanguard ? "VANGUARD" : "RANGER";
        if (state.resources >= spawnCosts[unitType]) {
          return {
            action: { type: "SPAWN", unitType },
            intent: unitType === "VANGUARD" ? "spawn_home_defense_vanguard" : "spawn_home_defense_ranger",
            surgeActive: active,
          };
        }
      } else if (replacementQueueEnabled &&
                 (replacementQueue.VANGUARD > 0 || replacementQueue.RANGER > 0) &&
                 militaryRatio > 0 &&
                 state.workers.length >= WORKER_RECOVERY_FLOOR) {
        // W12 按类型替补队列（replacement-queue-v1）：阵亡军事单位按类型计数，
        // 产兵优先补缺口（reference _select_spawn :9605-9665 MODE_AGGRESS）。
        // 队列有缺口 → 优先补该类型，覆盖 militaryRatio 配比与 worker 扩编
        // （经济地板 WORKER_RECOVERY_FLOOR=2 满足后即触发——base workers first
        //  reference 语义）。豁免 spawnReserve（生存行为只看纯成本，与
        //  recoveryEarlyMilitary / homeDefenseBottom 同语义）。
        const gapType: "VANGUARD" | "RANGER" =
          replacementQueue.VANGUARD > 0 ? "VANGUARD" : "RANGER";
        const gapCost = spawnCosts[gapType];
        if (state.resources >= gapCost) {
          return {
            action: { type: "SPAWN", unitType: gapType },
            intent: `spawn_${gapType.toLowerCase()}_replacement`,
            surgeActive: active,
          };
        }
        // 价格窗口等待（reference "Do not spend 10 resources on a Vanguard at
        // population 19; waiting for the 12-resource Ranger avoids the 20+ price
        // tier"）：资源不足缺口兵种 → 等待，不产低档替代品（Worker / 次选
        // 军事）——产 Worker 会推迟缺口兵种到更贵的人口档，产次选军事会偏
        // 离"按类型补员"语义。返回 null action + price_window intent（遥测
        // 可见，core 本 tick 不行动等资源）。出队仍是产后确认式（下 tick
        // 新单位出现才扣减），SPAWN 失败时队列保留、下 tick 自动重试。
        return {
          action: null,
          intent: `replacement_price_window_${gapType.toLowerCase()}`,
          surgeActive: active,
        };
      } else if (state.workers.length < workerTarget && !needMilitary) {
        // 冷启动扩编（2026-08-07）：worker < BOOTSTRAP_WORKER_TARGET 时豁免
        // spawnReserve——资源刚够成本就产 worker，打破"res < cost+reserve
        // 永远产不起"的冷启动冻结（t4 生产实证 2W res 5 卡住）。达标后恢复
        // reserve 保护（防掏空国库）。
        const reserve = (emergency || state.workers.length < BOOTSTRAP_WORKER_TARGET) ? 0 : spawnReserve;
        if (state.resources >= spawnCosts.WORKER + reserve) {
          return {
            action: { type: "SPAWN", unitType: "WORKER" },
            intent: emergency ? "emergency_spawn_worker" : "spawn_worker_target",
            surgeActive: active,
          };
        }
      } else if (needMilitary) {
        // 军事单位产出：默认交替（VANGUARD ↔ RANGER）；vanguardRatio 实验配置
        // 覆盖为按目标占比产出。资源门禁：VANGUARD 10 / RANGER 12 + reserve。
        // 修复（2026-08-07 t2 生产实证：3V+0R、ratio 0.5 → nextMilitaryType
        // 要求补 RANGER 12+2=14 > res 13 → 永远产不起 → 军事冻结在 3V，恰逢
        // 上方 jerkman 猛攻蛆威胁）：首选兵种买不起时回退到次选兵种（有兵比
        // 按配比空等强——配比偏移是临时妥协，兵力成型后可自然回归）。
        const preferred: "VANGUARD" | "RANGER" = nextMilitaryType(state, vanguardRatio);
        const candidates: readonly ("VANGUARD" | "RANGER")[] =
          preferred === "VANGUARD" ? ["VANGUARD", "RANGER"] : ["RANGER", "VANGUARD"];
        for (const unitType of candidates) {
          if (state.resources >= spawnCosts[unitType] + spawnReserve) {
            return {
              action: { type: "SPAWN", unitType },
              intent: `spawn_${unitType.toLowerCase()}_military_ratio`,
              surgeActive: active,
            };
          }
        }
      }
      // P3 容量硬顶兜底（正常分支全不产时）：workers 达标/无军事需求且
      // res 接近 Core 容量 → 强制消费最便宜的（防 DEPOSIT_FAILED 死锁）。
      return capacitySpend();
    }
  }
  return { action: null, intent: null, surgeActive: active };
}

/** Safety owns survival/evacuation/core-clearance decisions; economic/mission overlays must not
 * replace these intents. This is the explicit veto boundary between Safety and Worker missions. */
export interface DeterministicPlannerInput {
  readonly state: TickState;
  readonly policy?: MacroPolicy;
}

/** 打转封锁（W5）消费端 sink：DeterministicPlanner 注入后，在 plan() 候选排序
 *  与 GO_RESOURCE 分配登记处消费 WorkerLivenessTracker 的封锁视图。接口隔离
 *  避免 planner 反向依赖 runtime 层——WorkerLivenessTracker 结构化满足此接口。
 *  recordPlannedMove 让 W5 检测器知道"上次计划的目的地"，MOVE_FAILED 后据此
 *  blockCell；isCellBlocked 供 Hungarian 候选排序把死目标格排后。 */
export interface BlockadeSink extends CellBlocker {
  recordPlannedMove(unitId: string, target: Position, currentTick?: number): void;
}

export class DeterministicPlanner implements PlanProvider {
  private readonly planner: WorkerTaskPlanner;
  private readonly fallbackPlanner: SafetyPlanner;
  /** P4g 流水线预取缓存（决策流水线，2026-08-09）：prefetch 同步计算缓存，
   *  decideCached 取——决策输入与串行 decide 相同，结果逐字节一致。 */
  private prefetchedPlanValue: Plan | null = null;
  /** 只用于“资源格已被其他 Worker 占用”时继续探索；永远看不到 resourceCells，
   *  因此不会把额外 Worker 再次派往同一可见资源格。 */
  private readonly patrolPlanner: SafetyPlanner;
  /** 军事配比（实验）：VANGUARD 目标占比 [0,1]；undefined = 交替产兵（历史行为）。
   *  热加载（2026-08-08）：updateConfig 原子替换，不重建 planner、不丢记忆。 */
  private vanguardRatio: number | undefined;
  /** RECOVERY 早期防御产兵（recovery-early-military-v1）：军事=0 且 worker 起步
   *  （>=4）时先产 1 Vanguard 自卫（防野怪/入侵），不等 workerTarget——裸奔期
   *  被拆的兜底（t3 重生后无军事实证）。默认关（零回归），变体显式开启。 */
  private recoveryEarlyMilitary = false;
  /** 家防底线渐进补编（home-defense-bottom-v1，W3b）：早期按官方 3V+3R 底线
   *  渐进补编（1V → 1V+2R → 3V+3R），豁免 reserve、不受 workerTarget 前置门。
   *  默认关（零回归），变体显式开启。 */
  private homeDefenseBottom = false;
  /** W12 按类型替补队列开关（replacement-queue-v1）：阵亡军事单位按类型计数，
   *  产兵优先补缺口。默认关（零回归），变体显式开启。 */
  private replacementQueueEnabled = false;
  /** W12 替补队列状态（跨 tick 持有，与 surgeActive / previousCorePosition 同
   *  语义）：UNIT_DESTROYED 入队 + 新单位出现出队（产后确认式）。不可变对象，
   *  每次转移返回新冻结实例。 */
  private replacementQueue: ReplacementQueue = EMPTY_REPLACEMENT_QUEUE;
  /** W12 上一 tick 单位 id→类型映射（阵亡单位已从 turn.units 消失，事件
   *  actor_id 是其 id；UNIT_DESTROYED values 实测恒 null 无 unit_type——
   *  只能靠上一 tick 标签解析类型）。 */
  private readonly previousUnitTypes = new Map<string, import("../domain/model.ts").UnitType>();
  /** 爆兵阈值（2026-08-06）：resources 达标前只产 Worker 积累、达标后持续爆兵。 */
  private accumulateThreshold: number;
  /** 爆兵状态（跨 tick 保持：达标后持续爆兵直到资源耗尽回积累期）。 */
  private surgeActive = false;
  /** 资源高水位消费线（2026-08-10 用户理念，防 Core 容量顶格死锁）。 */
  private resourceHighWater = RESOURCE_HIGH_WATER;
  /** 补员 reserve（第十轮实验配置；默认 2 = 生产行为零回归）。 */
  private spawnReserve: number;
  /** 使命层配置（worker-mission-v1）：值层置信 + SURVEYOR 角色仲裁。 */
  private missionConfig: MissionConfig;
  /** 迁移计划（migration-system-v1 §3.3 勘探前向约束，评审 P1）：tenant-runtime
   *  每 tick 决策前注入；EXPLORE worker 朝计划路径前向探路（替代 core 坐标
   *  差分触发）。null = 无迁移，历史行为零回归。 */
  private migrationPlan: MigrationPlanV1 | null = null;
  /** 矿刷新预测（Phase 2，G3）：cellKey → dueInTicks；tenant-runtime 周期刷新注入。 */
  private refillPredictions: ReadonlyMap<string, number> = new Map();
  /** 迁移后测绘期截止 tick（核心位置变化时刷新为 tick + surveyBurstTicks）。 */
  private surveyBurstUntilTick = 0;
  private previousCorePosition: Position | null = null;
  /** 官方排行榜威胁画像（2026-08-07，威胁自适应）：透传内部 SafetyPlanner。 */
  private readonly threatProfiles: ReadonlyMap<string, ThreatProfile>;
  private previousAssignments: readonly Assignment[] = [];
  /** Last task-progress contract emitted with the most recent plan. Runtime liveness consumes this
   * read-only snapshot on the following observation; generic Safety patrol has no contract. */
  private lastWorkerProgressExpectations: WorkerProgressExpectations = new Map();
  /** Worker 局部活性恢复冷却：冷却内从 economicSnapshot 排除，强制沿 Safety patrol
   *  探索一段时间，防 reset 后下一 Tick 又被 Hungarian 分回同一 stale mine。 */
  private readonly workerRecoveryUntilTick = new Map<string, number>();
  /** 打转封锁（W5）消费端：tenant-runtime 注入 WorkerLivenessTracker（结构化满足
   *  BlockadeSink）。spinBlockadeEnabled=false 时不消费任何封锁状态（零回归）。 */
  private blockadeSink: BlockadeSink | null = null;
  private spinBlockadeEnabled = false;

  constructor(
    planner: WorkerTaskPlanner = new WorkerTaskPlanner(),
    fallbackPlanner: SafetyPlanner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG),
    patrolPlanner: SafetyPlanner = new SafetyPlanner(
      // patrolPlanner 永远看不到资源格（decide 传空 resourceCells）——默认 World
      // 关闭 visionInvalidation（2026-08-08 审查修复）：A2 视野证伪对"本轮资源恒空"
      // 的 patrol world 会把全部 seed 记忆标 harvested 且永远无法恢复，系统性破坏
      // patrol 侧记忆（当前潜伏，任何未来消费会读到假数据）。生产侧 tenant-runtime
      // 构造时同样注入关闭的 World（本默认值覆盖测试/未显式注入路径）。
      DEFAULT_SAFETY_CONFIG,
      new World({ visionInvalidation: false }),
    ),
    vanguardRatio: number | undefined = undefined,
    accumulateThreshold = 0,
    spawnReserve = WORKER_SPAWN_RESERVE,
    /** 启动播种的敌情狩猎目标（2026-08-07 持久敌情测绘）：注入两个内部
     *  SafetyPlanner 的 World——重启后军事仍记得历史 calibration 里的最后
     *  已知敌基地（解决"重启→记忆清零→军队空转"）。缺省空 = 零回归。 */
    initialCoreHuntTargets: readonly CoreHuntTarget[] = [],
    /** 官方排行榜威胁画像（2026-08-07，威胁自适应）：透传给内部两个
     *  SafetyPlanner——攻坚目标所有者是高伤害玩家时"留强"（提高成型门槛 +
     *  增加守家预留）。缺省空 Map = 无威胁情报（零回归）。 */
    threatProfiles: ReadonlyMap<string, ThreatProfile> = new Map(),
    /** 跨 run 测绘种子（2026-08-08，survey-db 联动）：已知矿注入内部两个
     *  SafetyPlanner 的 World——重启后 worker 不再从零探索（"矿发现了没
     *  分配去挖"的持久化端）。缺省空 = 零回归。 */
    initialResourceCells: readonly Position[] = [],
    /** 跨 run 测绘种子（2026-08-08，survey-db 联动）：静态障碍注入内部两个
     *  SafetyPlanner 的 World——重启后导航/寻路直接准确，无需重新探索。
     *  缺省空 = 零回归。 */
    initialObstacleCells: readonly Position[] = [],
    /** 使命层配置（worker-mission-v1，2026-08-08）：值层置信 + SURVEYOR 角色仲裁。
     *  缺省 DEFAULT_MISSION_CONFIG = 关闭（现行为零回归）。 */
    missionConfig: MissionConfig = DEFAULT_MISSION_CONFIG,
    /** RECOVERY 早期防御产兵开关（recovery-early-military-v1，默认关零回归）。 */
    recoveryEarlyMilitary = false,
    /** 家防底线渐进补编开关（home-defense-bottom-v1，W3b，默认关零回归）。 */
    homeDefenseBottom = false,
    /** W12 按类型替补队列开关（replacement-queue-v1，默认关零回归）。 */
    replacementQueue = false,
  ) {
    this.planner = planner;
    this.fallbackPlanner = fallbackPlanner;
    this.patrolPlanner = patrolPlanner;
    // deterministic 模式只有 WorkerTaskPlanner 拥有资源任务分配权。patrol fallback
    // 只负责探索/安全机动，禁止自己从 World memory 再抢矿绕过全局唯一匹配。
    this.patrolPlanner.updateConfig({ ...this.patrolPlanner.config, harvestMemoryMine: false });
    this.vanguardRatio = vanguardRatio;
    this.accumulateThreshold = accumulateThreshold;
    this.spawnReserve = spawnReserve;
    this.missionConfig = missionConfig;
    this.recoveryEarlyMilitary = recoveryEarlyMilitary;
    this.homeDefenseBottom = homeDefenseBottom;
    this.replacementQueueEnabled = replacementQueue;
    this.threatProfiles = threatProfiles;
    if (initialCoreHuntTargets.length > 0) {
      fallbackPlanner.seedCoreHuntTargets(initialCoreHuntTargets);
      patrolPlanner.seedCoreHuntTargets(initialCoreHuntTargets);
    }
    if (initialResourceCells.length > 0) {
      fallbackPlanner.world.seedResourceMemory(initialResourceCells, 0);
      patrolPlanner.world.seedResourceMemory(initialResourceCells, 0);
    }
    if (initialObstacleCells.length > 0) {
      fallbackPlanner.world.seedObstacleMemory(initialObstacleCells);
      patrolPlanner.world.seedObstacleMemory(initialObstacleCells);
    }
    fallbackPlanner.seedThreatProfiles(threatProfiles);
    patrolPlanner.seedThreatProfiles(threatProfiles);
    // patrol planner 只用于“资源格已被其他 Worker 占用时继续探索”——永远看不到
    // resourceCells，因此不得拥有第二套 memory-mine 分配权（生产回流 99b4ba2：
    // 否则未分配 worker 会经 patrol 基线的 go_harvest_mem 绕过 Hungarian 唯一性）。
    patrolPlanner.updateConfig({ ...patrolPlanner.config, harvestMemoryMine: false });
    this.planner.updateConfig({ mission: missionConfig });
  }

  /** 热刷新官方排行榜威胁画像（2026-08-08）：替换式透传内部两个 SafetyPlanner——
   *  掉榜用户立即移除，威胁自适应始终消费最新快照（tenant-runtime 定时重读）。 */
  replaceThreatProfiles(profiles: ReadonlyMap<string, ThreatProfile>): void {
    this.fallbackPlanner.replaceThreatProfiles(profiles);
    this.patrolPlanner.replaceThreatProfiles(profiles);
  }

  /** 热刷新矿刷新预测（Phase 2，G3 数据管道）：替换式更新（tenant-runtime 周期
   *  重读 survey-db），decide() 并入快照——死矿剔除 + 即将刷新格加成即时生效。 */
  replaceRefillPredictions(predictions: ReadonlyMap<string, number>): void {
    this.refillPredictions = predictions;
  }

  /** 打转封锁（W5）消费端注入：tenant-runtime 构造时注入 WorkerLivenessTracker
   *  （结构化满足 BlockadeSink）。sink=null 清除引用（零回归）。实际是否消费
   *  封锁状态由 spinBlockadeEnabled（updateConfig 从 safetyConfig.spinBlockade
   *  读）控制——sink 总是注入但变体关时不消费，保证热加载开关即生效。 */
  setBlockadeSink(sink: BlockadeSink | null): void {
    this.blockadeSink = sink;
  }

  /** 分级冷却播种（2026-08-08，缺席实证）：透传内部 fallback/patrol 两个 World
   *  ——缺席统计高频格升级失败冷却，worker 不每 32 tick 白试长期死格。 */
  seedFailedCooldownTiers(entries: readonly { position: Position; cooldownTicks: number }[]): void {
    this.fallbackPlanner.world.seedFailedCooldownTiers(entries);
    this.patrolPlanner.world.seedFailedCooldownTiers(entries);
  }

  workerProgressExpectations(): WorkerProgressExpectations {
    return this.lastWorkerProgressExpectations;
  }

  /** 迁移计划注入（migration-system-v1 §3.3，评审 P1）：tenant-runtime 每 tick
   *  决策前调用；EXPLORE worker 朝计划路径前向探路。null = 无迁移。
   *
   *  **转发 fallback SafetyPlanner（2026-08-09 生产实证）**：deterministic 模式
   *  下军事单位（Vanguard/Ranger/满载 worker）的决策在 fallback SafetyPlanner
   *  ——tenant-runtime 只对主 planner 调 setMigrationPlan，fallback 永远看不到
   *  迁移计划 → migrationMoving=false → 迁移期守卫/worker 不疏散、核心被自己
   *  编队围死（t1 生产实证：4 邻 13 个单位、核心 19+ tick 0 格、清路/REPLAN
   *  循环）。主 planner 注入时同步转发。 */
  setMigrationPlan(plan: MigrationPlanV1 | null): void {
    this.migrationPlan = plan;
    this.fallbackPlanner.setMigrationPlan(plan);
  }

  /** 热加载配置（2026-08-08）：tick 间原子替换 safety/deterministic 参数，
   *  保留 World/巡逻/攻坚记忆（不重建 planner）。调用方先校验变体合法性。
   *
   *  deterministicConfig 是"完整的新 deterministic 表面"（非局部 patch）：
   *  `mission` 缺省 = 明确清空（回 DEFAULT_MISSION_CONFIG），不存在
   *  "undefined=保持旧值" 的歧义——移除 worker-mission-v1 + mission 块热载后，
   *  旧代 missionConfig 不得残留（2026-08-09 审计 R1）。合法新 mission 原子替换。 */
  updateConfig(
    safetyConfig: SafetyPlannerConfig,
    deterministicConfig: {
      readonly vanguardRatio?: number;
      readonly accumulateThreshold?: number;
      readonly spawnReserve?: number;
      readonly recoveryEarlyMilitary?: boolean;
      readonly homeDefenseBottom?: boolean;
      readonly replacementQueue?: boolean;
      readonly mission?: MissionConfig;
    },
  ): void {
    this.fallbackPlanner.updateConfig(safetyConfig);
    // patrol 永远不消费 World 记忆矿（单一分配权威在 Hungarian，生产回流 99b4ba2）。
    this.patrolPlanner.updateConfig({ ...safetyConfig, harvestMemoryMine: false });
    this.vanguardRatio = deterministicConfig.vanguardRatio;
    this.accumulateThreshold = deterministicConfig.accumulateThreshold ?? 0;
    this.spawnReserve = deterministicConfig.spawnReserve ?? WORKER_SPAWN_RESERVE;
    this.recoveryEarlyMilitary = deterministicConfig.recoveryEarlyMilitary ?? false;
    this.homeDefenseBottom = deterministicConfig.homeDefenseBottom ?? false;
    this.replacementQueueEnabled = deterministicConfig.replacementQueue ?? false;
    // 打转封锁（W5）：变体开关经 SafetyPlannerConfig.spinBlockade 传递（变体注册表
    // 把 spin-blockade-v1 映射为 { spinBlockade: true }）。热加载时原子替换——
    // 变体关后下一 tick plan() 不再传 cellBlocker、不 recordPlannedMove（零回归）。
    this.spinBlockadeEnabled = safetyConfig.spinBlockade === true;
    // worker-mission-v1 属热面（variants+mission）：mission 缺省 = 明确清空回
    // DEFAULT_MISSION_CONFIG，并同步转发 WorkerTaskPlanner（旧实现仅在 mission
    // 定义时转发——去掉该 variant 后旧代 mission 仍生效，2026-08-09 审计 R1）。
    this.missionConfig = deterministicConfig.mission === undefined
      ? { ...DEFAULT_MISSION_CONFIG }
      : { ...DEFAULT_MISSION_CONFIG, ...deterministicConfig.mission };
    this.planner.updateConfig({ mission: this.missionConfig });
  }

  /** Worker 局部活性恢复：清 sticky economic assignment，并同步恢复两套 Safety World。 */
  recoverWorker(
    unitId: string,
    currentTick?: number,
  ): { readonly previousDirection: number; readonly nextDirection: number; readonly clearedMoveFailures: number; readonly cooldownUntilTick: number | null } {
    this.previousAssignments = this.previousAssignments.filter((assignment) => assignment.unitId !== unitId);
    // GO_RESOURCE 领取租约释放（2026-08-09）：worker 局部活性恢复时不得继续锁
    // 住已领取矿格（否则恢复冷却结束后其他 worker 无法接替）。
    this.planner.recoverWorker(unitId);
    const fallback = this.fallbackPlanner.recoverWorker(unitId, currentTick);
    // patrol planner 独立持有 World；也必须清，否则下一 Tick fallback 仍可能从旧状态回灌。
    this.patrolPlanner.recoverWorker(unitId, currentTick);
    if (fallback.cooldownUntilTick !== null) this.workerRecoveryUntilTick.set(unitId, fallback.cooldownUntilTick);
    return fallback;
  }

  decide(input: DeterministicPlannerInput): Plan {
    // SafetyPlanner 已包含跨 Tick World（障碍/资源线索/Worker 巡逻状态）。先生成完整
    // 基线计划，再用 WorkerTaskPlanner 覆盖可见资源的全局唯一分配。这样 deterministic
    // 不再是“看不到资源就 WAIT”的骨架，也不会复制第二套脆弱状态机。
    // policy（低频 MacroPolicy）透传给内部 SafetyPlanner——deterministic 执行 + LLM 战略。
    const fallback = this.fallbackPlanner.decide(input);
    const patrolFallback = this.patrolPlanner.decide({
      state: { ...input.state, resourceCells: new Set<string>() },
      policy: input.policy,
    });
    for (const [unitId, untilTick] of this.workerRecoveryUntilTick) {
      if (untilTick <= input.state.tick || !input.state.workers.some((worker) => worker.id === unitId)) {
        this.workerRecoveryUntilTick.delete(unitId);
      }
    }
    const rawSnapshot = extractPlanningSnapshot(input.state);
    const resourceCells = new Map(rawSnapshot.resourceCells);
    // 记忆矿合并（生产回流 99b4ba2，harvest-memory-mine-v1 联动）：deterministic
    // 模式下该配置只负责"允许消费 World 记忆"；实际 worker→资源分配统一交给
    // WorkerTaskPlanner/Hungarian，不再由 Safety 自己做第二套最近矿分配。
    // 本 Tick 可见事实优先于 memory 元数据（visible 键不覆盖）；stale/seeded
    // 元数据（visible=false + lastSeenTick + seeded）由 planner 的随龄惩罚、
    // seed 惩罚与 40 格边界消费。World 侧 timestamp/data-quality 修复
    // （tick 回滚清空、TTL 64、vision 失效、失败冷却）保持原样不动。
    if (this.fallbackPlanner.config.harvestMemoryMine === true) {
      for (const candidate of this.fallbackPlanner.world.resourceCandidates()) {
        const key = cellKey(candidate.cell);
        if (resourceCells.has(key)) continue;
        resourceCells.set(key, {
          position: candidate.cell,
          visible: false,
          lastSeenTick: candidate.lastSeenTick,
          seeded: candidate.seeded,
        });
      }
    }
    // threat recall / raid defense / breakout 激活时资源分配收缩到守家圈
    // （生产回流 99b4ba2）：召回期不派 worker 长途奔矿，超距候选从矩阵剔除。
    const maxResourceDistanceFromCore = this.fallbackPlanner.resourceAssignmentMaxDistanceFromCore(input.state);
    if (Number.isFinite(maxResourceDistanceFromCore) && rawSnapshot.corePosition !== null) {
      for (const [key, resource] of resourceCells) {
        if (manhattan(resource.position, rawSnapshot.corePosition) > maxResourceDistanceFromCore) {
          resourceCells.delete(key);
        }
      }
    }
    const snapshot: PlanningSnapshot = {
      ...rawSnapshot,
      resourceCells,
      obstacleCells: this.fallbackPlanner.world.obstacles(rawSnapshot.obstacleCells),
      // Phase 2（G3 数据管道）：矿刷新预测并入快照——按当前 tick 折算 dueInTicks
      // （存 predictedNextTick，随 tick 老化自动衰减）。
      refillPredictions: new Map(
        [...this.refillPredictions].map(([key, predictedNextTick]) => [key, predictedNextTick - rawSnapshot.tick]),
      ),
    };
    // 迁移后测绘期（worker-mission-v1）：核心位置变化 → 未来 surveyBurstTicks 内
    // 保证 ≥ surveyWorkerFloor 个勘探者（新家园先测绘再采集，防搬进 0 资源区空转）。
    // migration-scout（2026-08-08 修复）：记录上一帧核心位置——必须在下方
    // previousCorePosition 覆盖前捕获，否则 EXPLORE 分支的 dx/dy 恒为 0，迁移
    // 方向永远算不出（56a0172/33c7517 原实现双因失效：previousCorePosition 在
    // planner.plan 前被更新为当前值 + coreState 为 MOVING 的判断在决策时刻几乎恒 false）。
    const prevCorePosition = this.previousCorePosition;
    const corePosition = input.state.core?.position ?? null;
    if (
      corePosition !== null &&
      this.previousCorePosition !== null &&
      (corePosition[0] !== this.previousCorePosition[0] || corePosition[1] !== this.previousCorePosition[1])
    ) {
      this.surveyBurstUntilTick = input.state.tick + this.missionConfig.surveyBurstTicks;
    }
    this.previousCorePosition = corePosition;

    // 局部 Worker 自愈与使命分配共用一个排除面：Safety veto（回仓/撤离/清核心等）
    // 和 liveness recovery cooldown 中的 Worker 均不参与经济目标匹配；但仍由
    // patrol/safety 基线继续产生合法行动。这样不会让 mission 层重新吸回旧矿，
    // 也不会覆盖更高优先级的生存/通道动作。
    const safetyVetoIds = new Set(
      snapshot.units
        .filter((unit) => unit.unitType === "WORKER" && isSafetyVetoIntent(fallback.intents?.[unit.id]))
        .map((unit) => unit.id),
    );
    const economicExcludedIds = new Set([
      ...safetyVetoIds,
      ...[...this.workerRecoveryUntilTick.entries()]
        .filter(([, untilTick]) => untilTick > input.state.tick)
        .map(([unitId]) => unitId),
    ]);
    const economicSnapshot: PlanningSnapshot = economicExcludedIds.size === 0
      ? snapshot
      : { ...snapshot, units: snapshot.units.filter((unit) => !economicExcludedIds.has(unit.id)) };
    // 到达死矿证伪（2026-08-08，t2 生产实证 osc=11/11 乒乓根治）：worker 站立格
    // 是 invisible 记忆/seed 矿（格上无实体资源）→ 实地勘察证伪该格——写 failedCells
    // 冷却，resourceCandidates 32 tick 内跳过（"追一次即证伪"）。乒乓断链原理：
    // worker 到达死种子后被 freeze fix 剔除站立格 → 重排到相邻死种子 → 往返。证伪
    // 让已到达格不再入池，worker 线性推进逐格证伪，直到候选池只剩可见矿 → 正常
    // 采集；无可见矿 → 转勘探（alwaysSurvey/surveyOnSupplyGap）。refill 后重新可见
    // 自然恢复（visible 优先于失败冷却，不拦真矿）。
    for (const unit of snapshot.units) {
      if (unit.unitType !== "WORKER") continue;
      const standingCell = snapshot.resourceCells.get(cellKey(unit.position));
      if (standingCell !== undefined && standingCell.visible === false) {
        this.fallbackPlanner.world.markResourceFailed(standingCell.position);
      }
    }
    const { assignments } = this.planner.plan(economicSnapshot, this.previousAssignments, {
      surveyBurstActive: input.state.tick <= this.surveyBurstUntilTick,
      // 打转封锁（W5）：变体启用时把 WorkerLivenessTracker 的封锁视图传给
      // Hungarian——isCellBlocked 的死目标格在候选代价上加 BLOCKADE_PENALTY
      // 排后（不剔除，防饥饿）。变体关时 cellBlocker=undefined = 零回归。
      cellBlocker: this.spinBlockadeEnabled ? this.blockadeSink ?? undefined : undefined,
    });
    this.previousAssignments = assignments;
    // 打转封锁（W5）登记：GO_RESOURCE 分配确定后把目标格写入 plannedMoves，
    // 让 WorkerLivenessTracker 在 MOVE_FAILED 时知道封哪个格（computeBlockedTarget
    // 读 plannedMoves）。变体关时不登记（plannedMoves 永空 → blockedTarget
    // 永为 undefined → blockCell 不触发，零回归）。tick 用 economicSnapshot 的
    // 视图 tick（与 onObservation 的 outcome.tick 一致）。
    if (this.spinBlockadeEnabled && this.blockadeSink !== null) {
      for (const assignment of assignments) {
        if (assignment.task.type === "GO_RESOURCE" && assignment.task.target !== undefined) {
          this.blockadeSink.recordPlannedMove(assignment.unitId, assignment.task.target, snapshot.tick);
        }
      }
    }

    const unitActions: Record<string, UnitAction> = { ...fallback.unitActions };
    const intents: Record<string, string> = { ...(fallback.intents ?? {}) };
    for (const assignment of assignments) {
      // WorkerTaskPlanner 是 deterministic 模式下资源任务的最终 SSOT；必须把实际
      // 分配同步回 Safety fallback 的跨 tick UnitMemory。否则 Safety 先写入的“最近矿”
      // 会在下一 tick 资源离开视野后复活，覆盖本 tick 已执行的全局唯一分配，导致
      // 多 worker 再次扎堆同一记忆矿（生产 capacity_wait:go_harvest_mem 主因）。
      const fallbackMemory = this.fallbackPlanner.world.unitMemory(assignment.unitId);
      if (assignment.task.type === "GO_RESOURCE" && assignment.task.target !== undefined) {
        fallbackMemory.workerMode = "go_harvest";
        fallbackMemory.harvestTarget = assignment.task.target;
      } else if (assignment.task.type === "WAIT" && snapshot.resourceCells.size > 0) {
        // 有可见矿但该 worker 未被全局匹配器分配：清除 Safety 的虚假最近矿记忆，
        // 让它按 patrolFallback 继续探索，而不是下一 tick 偷跑去已被别人占用的矿。
        fallbackMemory.workerMode = "patrol";
        fallbackMemory.harvestTarget = null;
      }
      if (assignment.task.type === "EXPLORE") {
        // migration-scout（2026-08-08，worker-mission-v1 延伸）：核心 MOVING 时
        // 勘探 worker 朝核心迁移方向探路（为落点测绘），不随机巡老分区——
        // t3 迁移期"worker 探索测绘"直接服务新家园；核心 NORMAL 时零影响。
        // 计划前向约束版（migration-system-v1 §3.3，评审 P1）：有迁移计划时
        // 读计划路径下一格方向持续前向探路（不依赖 core 坐标差分触发）。
        if (
          this.missionConfig.migrationScout === true &&
          snapshot.corePosition !== null &&
          this.migrationPlan !== null
        ) {
          const worker = snapshot.units.find((u: any) => u.id === assignment.unitId);
          const dir = worker
            ? migrationScoutDirectionForPlan(worker.position, snapshot.corePosition, this.migrationPlan, snapshot.obstacleCells)
            : null;
          if (dir !== null) {
            unitActions[assignment.unitId] = { type: "MOVE", direction: dir };
            intents[assignment.unitId] = "worker_migration_scout";
            continue;
          }
        }
        if (
          this.missionConfig.migrationScout === true &&
          snapshot.corePosition !== null &&
          prevCorePosition !== null &&
          (snapshot.corePosition[0] !== prevCorePosition[0] || snapshot.corePosition[1] !== prevCorePosition[1])
        ) {
          const worker = snapshot.units.find((u: any) => u.id === assignment.unitId);
          const dir = worker
            ? migrationScoutDirection(worker.position, snapshot.corePosition, prevCorePosition, snapshot.obstacleCells)
            : null;
          if (dir !== null) {
            unitActions[assignment.unitId] = { type: "MOVE", direction: dir };
            intents[assignment.unitId] = "worker_migration_scout";
            continue;
          }
        }
        // SURVEYOR 角色（worker-mission-v1）：勘探动作落 patrolFallback 基线
        // （覆盖感知方向由 patrolPlanner 的 frontier-priority 逻辑提供）。
        const fallbackMemoryExplore = this.fallbackPlanner.world.unitMemory(assignment.unitId);
        fallbackMemoryExplore.workerMode = "patrol";
        fallbackMemoryExplore.harvestTarget = null;
        unitActions[assignment.unitId] = patrolFallback.unitActions[assignment.unitId] ?? { type: "WAIT" };
        intents[assignment.unitId] = "worker_survey";
        continue;
      }
      if (assignment.task.type === "WAIT") {
        // 无可见资源时保留完整 Safety 的资源记忆；有可见资源但数量少于 Worker 时，
        // 使用看不到资源格的 patrol baseline，保证继续探索且不会重新扎堆。
        if (snapshot.resourceCells.size > 0) {
          unitActions[assignment.unitId] = patrolFallback.unitActions[assignment.unitId] ?? { type: "WAIT" };
          intents[assignment.unitId] = patrolFallback.intents?.[assignment.unitId] ?? "WAIT_UNCLAIMED";
        }
        continue;
      }
      // 核心迁移中持货待命（core-moving-hold-v1，2026-08-07）：deterministic worker
      // 的 DEPOSIT 任务直接覆盖 Safety 的 WAIT——迁移期照常追交空跑（生产 t3 实证
      // CORE_MOVING/CORE_NOT_PRESENT）。这里对齐 SafetyPlanner：coreMovingHold 且
      // 核心 MOVING 时，cargo worker 原地 WAIT，等核心回 NORMAL 再交仓。
      if (
        assignment.task.type === "DEPOSIT" &&
        snapshot.coreState === "MOVING" &&
        this.fallbackPlanner.config.coreMovingHold === true
      ) {
        unitActions[assignment.unitId] = { type: "WAIT" };
        intents[assignment.unitId] = "worker_hold_cargo_moving";
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

    const resolved = resolveMoveCapacity(input.state, unitActions, intents, snapshot.obstacleCells);
    const finalIntents: Record<string, string> = { ...resolved.intents };
    // fallback 可能提出被 deterministic 故意压制的普通 spawn；不要留下“有 intent
    // 但 coreAction=null”的误导遥测。只有实际执行的恢复/生存动作才记录 core intent。
    delete finalIntents.core;
    // W12 按类型替补队列（replacement-queue-v1）：每 tick 决策前更新队列——
    // UNIT_DESTROYED 入队（类型靠上一 tick 的 previousUnitTypes 解析），新单位
    // 出队（产后确认式：SPAWN 被服务端拒时下 tick 自动重试，队列保留）。
    // 变体关 → 队列恒空、previousUnitTypes 不更新（零回归）。
    if (this.replacementQueueEnabled) {
      const previousTypesSnapshot = new Map(this.previousUnitTypes);
      this.replacementQueue = applyReplacementQueueDelta(
        this.replacementQueue,
        input.state.events,
        previousTypesSnapshot,
        true,
      );
      this.replacementQueue = consumeReplacementQueue(
        this.replacementQueue,
        input.state.units,
        new Set(previousTypesSnapshot.keys()),
        true,
      );
    }
    // previousUnitTypes 始终刷新（即使变体关也保持——热加载启用时即有上一 tick
    // 标签可用，无需预热；O(units) 可忽略）。
    this.previousUnitTypes.clear();
    for (const unit of input.state.units) {
      this.previousUnitTypes.set(unit.id, unit.unitType);
    }
    const coreDecision = selectDeterministicCoreAction(
      input.state,
      fallback.coreAction,
      input.policy,
      this.vanguardRatio,
      this.accumulateThreshold,
      this.surgeActive,
      this.spawnReserve,
      // 动态定价配套：deterministic 产兵尊重 Safety 配置的人口上限（默认 20
      // = v0.14 动态价线）；strike-core-v1 的 SafetyPlanner 用默认 20。
      this.fallbackPlanner.config.populationCeiling,
      this.recoveryEarlyMilitary,
      this.homeDefenseBottom,
      // NOTE: threatDefenseSpawn（pos 9）与 recoveryEarlyMilitary/homeDefenseBottom
      // 的位置映射沿用历史调用约定（不改既有行为——零回归）。pos 11 显式传
      // false 保持 homeDefenseBottom 形参的历史默认值。replacement-queue-v1 的
      // 两个新形参落在 pos 12-13，resourceHighWater 在 pos 14。
      false,
      this.replacementQueue,
      this.replacementQueueEnabled,
      this.resourceHighWater,
    );
    this.surgeActive = coreDecision.surgeActive;
    if (coreDecision.intent !== null) finalIntents.core = coreDecision.intent;

    const progressExpectations = new Map<string, WorkerProgressExpectation>();
    for (const assignment of assignments) {
      switch (assignment.task.type) {
        case "GO_RESOURCE":
          if (assignment.task.target !== undefined) {
            progressExpectations.set(assignment.unitId, {
              kind: "target",
              taskType: "GO_RESOURCE",
              target: assignment.task.target,
            });
          }
          break;
        case "DEPOSIT":
          if (snapshot.corePosition !== null) {
            progressExpectations.set(assignment.unitId, {
              kind: "target",
              taskType: "DEPOSIT",
              target: snapshot.corePosition,
            });
          }
          break;
        case "HARVEST_CURRENT":
          progressExpectations.set(assignment.unitId, { kind: "cargo_change", taskType: "HARVEST_CURRENT" });
          break;
        case "EXPLORE":
          progressExpectations.set(assignment.unitId, { kind: "novel_coverage", taskType: "EXPLORE" });
          break;
        default:
          break;
      }
    }
    this.lastWorkerProgressExpectations = progressExpectations;

    return {
      tick: input.state.tick,
      unitActions: resolved.unitActions,
      coreAction: coreDecision.action,
      intents: finalIntents,
    };
  }

  /** 流水线预取（P4g，决策流水线）：同步计算并缓存——决策输入与串行 decide
   *  相同，结果逐字节一致；仅时间点前移（结算后即算，不阻塞调用方）。 */
  prefetch(input: DeterministicPlannerInput): void {
    this.prefetchedPlanValue = this.decide(input);
  }

  /** 取流水线预取结果（P4g）：必须在 prefetch 之后成对调用。 */
  decideCached(): Plan {
    const plan = this.prefetchedPlanValue;
    this.prefetchedPlanValue = null;
    if (plan === null) {
      throw new Error("deterministic planner: decideCached without prefetch");
    }
    return plan;
  }

  /** Task → UnitAction（确定性映射；核心语义见文件头注释）。 */
  private taskAction(assignment: Assignment, snapshot: PlanningSnapshot): UnitAction {
    const unit = snapshot.units.find((u) => u.id === assignment.unitId);
    if (unit === undefined) {
      return { type: "WAIT" };
    }
    // 可见敌人全部占用格并入绕行障碍（含敌方 CORE——生产实测：Worker 回仓
    // 路线被敌方 CORE 挡时，BFS 不知道它是障碍 → 反复 capacity_wait:DEPOSIT）。
    // Worker 不主动进敌方格，路线绕行而非等待。
    const avoidCells = new Set(snapshot.obstacleCells);
    for (const enemyCell of snapshot.enemyCells) {
      avoidCells.add(enemyCell);
    }
    // 容量预检：本 tick 已占满（≥2 实体，Core 占 1）的格也视为障碍——MOVE
    // 目标格若已满必被 resolveMoveCapacity 拒绝转 WAIT（capacity_wait 循环
    // 的另一个来源），BFS 直接绕开这类格。
    const occupancy = new Map<string, number>();
    if (snapshot.corePosition !== null) {
      occupancy.set(cellKey(snapshot.corePosition), 1);
    }
    for (const ally of snapshot.units) {
      const key = cellKey(ally.position);
      occupancy.set(key, (occupancy.get(key) ?? 0) + 1);
    }
    for (const [key, count] of occupancy) {
      if (count >= 2) avoidCells.add(key);
    }
    const movementObstacles = this.fallbackPlanner.world.movementObstacles(
      assignment.unitId,
      avoidCells,
    );
    const task = assignment.task;
    switch (task.type) {
      case "PICKUP_BEACON":
        // 只有与 GROUND Beacon 同格才可能拿到该任务；直接发出拾取动作。
        return { type: "PICKUP_BEACON" };
      case "HARVEST_CURRENT":
        return { type: "HARVEST" };
      case "DEPOSIT":
      case "RETURN_FOR_HEAL": {
        const core = snapshot.corePosition;
        if (core === null) {
          return { type: "WAIT" };
        }
        if (unit.position[0] === core[0] && unit.position[1] === core[1]) {
          if (task.type === "RETURN_FOR_HEAL") {
            return { type: "WAIT" };
          }
          if (snapshot.resourceSpace > 0) {
            return { type: "DEPOSIT" };
          }
          // 资源满（resourceSpace=0）时 DEPOSIT 不合法（validator 会移除），
          // 满载 Worker 若原地等待会永久占住 Core 格：SPAWN 被服务端容量拒、
          // 资源永不消耗、永远满。让位到 Core 相邻格——SPAWN 成功后资源消耗、
          // 卸货通道恢复，Worker 下一轮回来卸货（生产实测死锁闭环的根治）。
          const leave = yieldDirection(unit.position, movementObstacles);
          return leave === null ? { type: "WAIT" } : { type: "MOVE", direction: leave };
        }
        const direction = stepTowardAvoiding(
          unit.position,
          core,
          movementObstacles,
          adaptivePathOptions(manhattan(unit.position, core)),
        );
        return direction === null ? { type: "WAIT" } : { type: "MOVE", direction };
      }
      case "GO_RESOURCE": {
        const target = task.target;
        if (target === undefined) {
          return { type: "WAIT" };
        }
        if (unit.position[0] === target[0] && unit.position[1] === target[1]) {
          const targetKey = task.targetCellKey ?? cellKey(target);
          const resource = snapshot.resourceCells.get(targetKey);
          return resource !== undefined && resource.visible !== false ? { type: "HARVEST" } : { type: "WAIT" };
        }
        const direction = stepTowardAvoiding(
          unit.position,
          target,
          movementObstacles,
          adaptivePathOptions(manhattan(unit.position, target)),
        );
        return direction === null ? { type: "WAIT" } : { type: "MOVE", direction };
      }
      default:
        return { type: "WAIT" };
    }
  }
}

