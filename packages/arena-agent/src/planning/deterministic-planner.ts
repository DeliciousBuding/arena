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
  stepToward as pathStepToward,
  type PathSearchOptions,
} from "../domain/nav.ts";
import type { PlanProvider } from "../runtime/decision-types.ts";
import type { MacroPolicy } from "../runtime/macro-policy.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner, type SafetyPlannerConfig } from "../strategies/safety-planner.ts";
import { type CoreHuntTarget } from "../domain/world.ts";
import type { ThreatProfile } from "../strategies/safety-planner-config.ts";
import { unitSpawnCosts } from "../domain/pricing.ts";
import { extractPlanningSnapshot, type PlanningSnapshot } from "./planning-snapshot.ts";
import { WorkerTaskPlanner, type Assignment } from "./worker-task-planner.ts";

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
    if (isPatrolIntent(candidate.intent)) {
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

function compareBestMoveFirst(a: MoveCandidate, b: MoveCandidate): number {
  return a.priority - b.priority || a.unitId.localeCompare(b.unitId);
}

function compareWorstMoveFirst(a: MoveCandidate, b: MoveCandidate): number {
  return b.priority - a.priority || b.unitId.localeCompare(a.unitId);
}

const WORKER_RECOVERY_FLOOR = 2;
/** 冷启动 worker 扩编目标（2026-08-07，t3/t4 生产实证）：worker 数未达该值
 *  时产 worker 豁免 spawnReserve——资源刚够成本就扩编（t4 实证：2W res 5 <
 *  WORKER 5 + reserve 2 = 7 → 永不产第 3 个 worker → 经济停滞）。v3.0
 *  MIN_BOOTSTRAP_WORKERS=3 放大到 6：workerTarget=12 的一半，尽早建立
 *  采集网后再进入正常 reserve 保护。 */
const BOOTSTRAP_WORKER_TARGET = 6;
const WORKER_SPAWN_COST = 5;
/** 补员保留资源（不因扩编掏空国库；emergency 时也可用满额 5）。 */
const WORKER_SPAWN_RESERVE = 2;
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
): { readonly action: CoreAction | null; readonly intent: string | null; readonly surgeActive: boolean } {
  if (fallbackAction?.type === "HEAL") {
    return { action: fallbackAction, intent: "core_heal", surgeActive };
  }
  if (fallbackAction?.type === "REPAIR_SHIELD") {
    return { action: fallbackAction, intent: "repair_shield", surgeActive };
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
    if (state.population >= populationCeiling) {
      return { action: null, intent: null, surgeActive: active };
    }
    // Core 格被空载/非 Worker 单位占位时阻塞生成（SPAWN 会叠加容量）；
    // 满载 Worker 是"卸货等待"不阻塞（资源满时 DEPOSIT 暂不合法，但 SPAWN
    // 消耗资源后立即可卸——资源满 + 占格 + 无法卸货会形成永久经济死锁）。
    const permanentOccupantsOnCore = state.units.filter(
      (unit) =>
        unit.position[0] === core.position[0] &&
        unit.position[1] === core.position[1] &&
        !(unit.unitType === "WORKER" && unit.cargo > 0),
    ).length;
    // 威胁感知（官方 _control_core 对照）：可见战斗单位（VANGUARD/RANGER）
    // 距 Core <=3 格 = 射程内威胁——防御产兵触发条件。
    const coreThreatened = state.visibleEnemies.some(
      (enemy) =>
        enemy.kind === "UNIT" &&
        enemy.unitType !== "WORKER" &&
        manhattan(enemy.position, core.position) <= THREAT_SPAWN_DISTANCE,
    );
    if (permanentOccupantsOnCore === 0) {
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
    }
  }
  return { action: null, intent: null, surgeActive: active };
}

export interface DeterministicPlannerInput {
  readonly state: TickState;
  readonly policy?: MacroPolicy;
}

export class DeterministicPlanner implements PlanProvider {
  private readonly planner: WorkerTaskPlanner;
  private readonly fallbackPlanner: SafetyPlanner;
  /** 只用于“资源格已被其他 Worker 占用”时继续探索；永远看不到 resourceCells，
   *  因此不会把额外 Worker 再次派往同一可见资源格。 */
  private readonly patrolPlanner: SafetyPlanner;
  /** 军事配比（实验）：VANGUARD 目标占比 [0,1]；undefined = 交替产兵（历史行为）。
   *  热加载（2026-08-08）：updateConfig 原子替换，不重建 planner、不丢记忆。 */
  private vanguardRatio: number | undefined;
  /** 爆兵阈值（2026-08-06）：resources 达标前只产 Worker 积累、达标后持续爆兵。 */
  private accumulateThreshold: number;
  /** 爆兵状态（跨 tick 保持：达标后持续爆兵直到资源耗尽回积累期）。 */
  private surgeActive = false;
  /** 补员 reserve（第十轮实验配置；默认 2 = 生产行为零回归）。 */
  private spawnReserve: number;
  /** 官方排行榜威胁画像（2026-08-07，威胁自适应）：透传内部 SafetyPlanner。 */
  private readonly threatProfiles: ReadonlyMap<string, ThreatProfile>;
  private previousAssignments: readonly Assignment[] = [];

  constructor(
    planner: WorkerTaskPlanner = new WorkerTaskPlanner(),
    fallbackPlanner: SafetyPlanner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG),
    patrolPlanner: SafetyPlanner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG),
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
  ) {
    this.planner = planner;
    this.fallbackPlanner = fallbackPlanner;
    this.patrolPlanner = patrolPlanner;
    this.vanguardRatio = vanguardRatio;
    this.accumulateThreshold = accumulateThreshold;
    this.spawnReserve = spawnReserve;
    this.threatProfiles = threatProfiles;
    if (initialCoreHuntTargets.length > 0) {
      fallbackPlanner.seedCoreHuntTargets(initialCoreHuntTargets);
      patrolPlanner.seedCoreHuntTargets(initialCoreHuntTargets);
    }
    if (initialResourceCells.length > 0) {
      fallbackPlanner.world.seedResourceMemory(initialResourceCells, 0);
      patrolPlanner.world.seedResourceMemory(initialResourceCells, 0);
    }
    fallbackPlanner.seedThreatProfiles(threatProfiles);
    patrolPlanner.seedThreatProfiles(threatProfiles);
  }

  /** 热加载配置（2026-08-08）：tick 间原子替换 safety/deterministic 参数，
   *  保留 World/巡逻/攻坚记忆（不重建 planner）。调用方先校验变体合法性。 */
  updateConfig(
    safetyConfig: SafetyPlannerConfig,
    deterministicConfig: {
      readonly vanguardRatio?: number;
      readonly accumulateThreshold?: number;
      readonly spawnReserve?: number;
    },
  ): void {
    this.fallbackPlanner.updateConfig(safetyConfig);
    this.patrolPlanner.updateConfig(safetyConfig);
    this.vanguardRatio = deterministicConfig.vanguardRatio;
    this.accumulateThreshold = deterministicConfig.accumulateThreshold ?? 0;
    this.spawnReserve = deterministicConfig.spawnReserve ?? WORKER_SPAWN_RESERVE;
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
    );
    this.surgeActive = coreDecision.surgeActive;
    if (coreDecision.intent !== null) finalIntents.core = coreDecision.intent;

    return {
      tick: input.state.tick,
      unitActions: resolved.unitActions,
      coreAction: coreDecision.action,
      intents: finalIntents,
    };
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
          return snapshot.resourceCells.has(targetKey) ? { type: "HARVEST" } : { type: "WAIT" };
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

