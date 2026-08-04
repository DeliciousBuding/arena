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
import { stepToward as pathStepToward } from "../domain/nav.ts";
import type { PlanProvider } from "../runtime/decision-types.ts";
import type { MacroPolicy } from "../runtime/macro-policy.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../strategies/safety-planner.ts";
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
export function stepTowardAvoiding(from: Position, target: Position, obstacles: ReadonlySet<string>): Direction | null {
  return pathStepToward(from, target, obstacles);
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
const WORKER_SPAWN_COST = 5;
/** 补员保留资源（不因扩编掏空国库；emergency 时也可用满额 5）。 */
const WORKER_SPAWN_RESERVE = 2;

/**
 * deterministic 的长期目标仍是积累资源，但不能因此失去自恢复能力：
 * - Core HEAL / REPAIR_SHIELD 属于生存动作，直接沿用 Safety 的合法裁决；
 * - 补员按 policy.workerTarget 驱动（MacroPolicy 低频战略的消费点之一）：
 *   workerTarget 缺省/过低时用 emergency floor=2 兜底；
 * - 补员带 reserve 保护（至少保留 2 资源），不因扩编掏空国库。
 */
export function selectDeterministicCoreAction(
  state: TickState,
  fallbackAction: CoreAction | null,
  policy?: MacroPolicy,
): { readonly action: CoreAction | null; readonly intent: string | null } {
  if (fallbackAction?.type === "HEAL") {
    return { action: fallbackAction, intent: "core_heal" };
  }
  if (fallbackAction?.type === "REPAIR_SHIELD") {
    return { action: fallbackAction, intent: "repair_shield" };
  }

  const workerTarget = Math.max(policy?.workerTarget ?? WORKER_RECOVERY_FLOOR, WORKER_RECOVERY_FLOOR);
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

  if (core !== null && core.state === "NORMAL") {
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
      if (state.workers.length < workerTarget && !needMilitary) {
        if (state.resources >= WORKER_SPAWN_COST + (emergency ? 0 : WORKER_SPAWN_RESERVE)) {
          return {
            action: { type: "SPAWN", unitType: "WORKER" },
            intent: emergency ? "emergency_spawn_worker" : "spawn_worker_target",
          };
        }
      } else if (needMilitary) {
        // 军事单位交替产出（VANGUARD ↔ RANGER），资源门禁：VANGUARD 10 / RANGER 12 + reserve
        const unitType: "VANGUARD" | "RANGER" =
          state.vanguards.length <= state.rangers.length ? "VANGUARD" : "RANGER";
        const cost = unitType === "VANGUARD" ? 10 : 12;
        if (state.resources >= cost + WORKER_SPAWN_RESERVE) {
          return {
            action: { type: "SPAWN", unitType },
            intent: `spawn_${unitType.toLowerCase()}_military_ratio`,
          };
        }
      }
    }
  }
  return { action: null, intent: null };
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
  private previousAssignments: readonly Assignment[] = [];

  constructor(
    planner: WorkerTaskPlanner = new WorkerTaskPlanner(),
    fallbackPlanner: SafetyPlanner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG),
    patrolPlanner: SafetyPlanner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG),
  ) {
    this.planner = planner;
    this.fallbackPlanner = fallbackPlanner;
    this.patrolPlanner = patrolPlanner;
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
    const coreDecision = selectDeterministicCoreAction(input.state, fallback.coreAction, input.policy);
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
        const direction = stepTowardAvoiding(unit.position, core, movementObstacles);
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
        const direction = stepTowardAvoiding(unit.position, target, movementObstacles);
        return direction === null ? { type: "WAIT" } : { type: "MOVE", direction };
      }
      default:
        return { type: "WAIT" };
    }
  }
}
