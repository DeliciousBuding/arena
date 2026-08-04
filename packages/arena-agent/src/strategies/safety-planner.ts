import {
  cellKey,
  type CoreAction,
  type Direction,
  type Plan,
  type Position,
  type TickState,
  type UnitAction,
  type UnitSnapshot,
  type UnitType,
  type VisibleEntity,
} from "../domain/model.ts";
import {
  chebyshev,
  directionToAdjacent,
  EXPLORE_DIRECTION_COUNT,
  EXPLORE_RING_COUNT,
  exploreRadiusForRing,
  exploreTarget,
  lineBlocked,
  manhattan,
  nearest,
  stepToward,
} from "../domain/nav.ts";
import { UNIT_MAX_HP } from "../domain/plan-validator.ts";
import { countEnemiesNearCore } from "../domain/plan-validator.ts";
import { PhaseMachine, type PhaseConfig } from "../domain/phase-machine.ts";
import { World } from "../domain/world.ts";
import { aggressionOf, type MacroPolicy } from "../runtime/macro-policy.ts";

export type AggressionLevel = "defensive" | "aggressive";

export interface SafetyPlannerConfig {
  readonly reserveWealthy: number;
  readonly reserveEarly: number;
  readonly wealthyThreshold: number;
  readonly workerTarget: number;
  readonly populationCeiling: number;
  readonly exploreRadius: number;
  readonly threatEnemyDistance: number;
  readonly accumulateTarget: number;
  readonly guardResources: number;
  readonly guardForce: number;
  readonly phase?: PhaseConfig;
  /**
   * 战斗激进级别（默认 defensive，与历史行为一致）：
   * - defensive：Vanguard 仅在邻近威胁时应对，靠近 Core 留守；
   * - aggressive：Vanguard 前压攻坚（优先敌人 Core），Ranger 优先断敌经济
   *   （射 WORKER）并保持射程站定。
   */
  readonly aggression?: AggressionLevel;
}

export const DEFAULT_SAFETY_CONFIG: SafetyPlannerConfig = Object.freeze({
  reserveWealthy: 3,
  reserveEarly: 1,
  wealthyThreshold: 10,
  workerTarget: 8,
  populationCeiling: 20,
  exploreRadius: 8,
  threatEnemyDistance: 5,
  accumulateTarget: 0,
  guardResources: 30,
  guardForce: 4,
});

/** 激进战斗配置：完整默认值 + aggressive 战斗行为（供 tenant-runtime 注入）。 */
export const AGGRESSIVE_SAFETY_CONFIG: SafetyPlannerConfig = Object.freeze({
  ...DEFAULT_SAFETY_CONFIG,
  aggression: "aggressive",
});

export interface SafetyPlannerInput {
  readonly state: TickState;
  readonly sharedObstacles?: ReadonlySet<string>;
  readonly allyUsernames?: ReadonlySet<string>;
  /** 低频 MacroPolicy（orchestrator 每 K ticks 产出）；提供时覆盖静态 config。 */
  readonly policy?: MacroPolicy;
}

/** Deterministic, side-effect-free with respect to the game. World memory is local to this planner. */
export class SafetyPlanner {
  readonly world: World;
  readonly phase: PhaseMachine;
  /** 本 decide 生效的 aggression（policy 优先，其次 config.aggression）。 */
  private effectiveAggression: AggressionLevel = "defensive";
  /** 本 decide 生效的 workerTarget（policy 优先，其次 config.workerTarget）。 */
  private effectiveWorkerTarget = 8;

  constructor(
    readonly config: SafetyPlannerConfig = DEFAULT_SAFETY_CONFIG,
    world = new World(),
  ) {
    this.world = world;
    this.phase = new PhaseMachine(config.phase);
  }

  decide(input: SafetyPlannerInput): Plan {
    const { state } = input;
    this.effectiveAggression =
      input.policy !== undefined ? aggressionOf(input.policy) : (this.config.aggression ?? "defensive");
    this.effectiveWorkerTarget = input.policy?.workerTarget ?? this.config.workerTarget;
    this.world.observe(state);
    this.phase.update({
      population: state.population,
      resources: state.resources,
      enemyNearCore: countEnemiesNearCore(state, this.config.threatEnemyDistance),
    });

    const actions: Record<string, UnitAction> = {};
    const intents: Record<string, string> = {};
    const obstacles = this.world.obstacles(new Set([
      ...state.obstacleCells,
      ...(input.sharedObstacles ?? []),
    ]));
    const allies = input.allyUsernames ?? new Set<string>();
    const enemies = state.visibleEnemies
      .filter((enemy) => !(enemy.kind === "CORE" && enemy.ownerUsername !== undefined && allies.has(enemy.ownerUsername)))
      .sort((a, b) => a.id.localeCompare(b.id));
    const workerIndex = new Map(
      [...state.workers]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((worker, index) => [worker.id, index]),
    );

    const set = (unit: UnitSnapshot, action: UnitAction, intent: string): void => {
      actions[unit.id] = action;
      intents[unit.id] = intent;
    };

    for (const unit of [...state.units].sort((a, b) => a.id.localeCompare(b.id))) {
      if (
        state.beacon.status === "GROUND" &&
        state.beacon.carrierId === null &&
        samePosition(unit.position, state.beacon.position)
      ) {
        set(unit, { type: "PICKUP_BEACON" }, "beacon");
        continue;
      }
      if (
        state.core !== null &&
        state.core.state === "NORMAL" &&
        samePosition(unit.position, state.core.position) &&
        unit.hp < UNIT_MAX_HP[unit.unitType]
      ) {
        set(unit, { type: "HEAL" }, "heal");
        continue;
      }

      if (unit.unitType === "WORKER") {
        this.decideWorker(state, unit, workerIndex.get(unit.id) ?? 0, obstacles, set);
      } else if (unit.unitType === "VANGUARD") {
        this.decideVanguard(state, unit, obstacles, enemies, set);
      } else {
        this.decideRanger(state, unit, obstacles, enemies, set);
      }
    }

    const coreAction = this.decideCore(state, intents);
    return { tick: state.tick, unitActions: actions, coreAction, intents };
  }

  private decideWorker(
    state: TickState,
    unit: UnitSnapshot,
    index: number,
    obstacles: ReadonlySet<string>,
    set: (unit: UnitSnapshot, action: UnitAction, intent: string) => void,
  ): void {
    const memory = this.world.unitMemory(unit.id, index);
    const home = state.core?.position ?? null;
    const movementObstacles = this.world.movementObstacles(unit.id, obstacles);

    if (unit.cargo > 0) {
      if (home !== null && samePosition(unit.position, home)) {
        if (state.resourceSpace > 0) set(unit, { type: "DEPOSIT" }, "deposit");
      } else if (home !== null) {
        const direction = stepToward(unit.position, home, movementObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "return_home");
      }
      return;
    }

    if (state.resourceCells.has(cellKey(unit.position))) {
      memory.workerMode = "patrol";
      memory.harvestTarget = null;
      set(unit, { type: "HARVEST" }, "harvest");
      return;
    }

    const visibleResources = [...state.resourceCells].map((cell) => parseCell(cell));
    if (visibleResources.length > 0) {
      const target = nearest(visibleResources, unit.position);
      memory.workerMode = "go_harvest";
      memory.harvestTarget = target;
      if (target !== null && !samePosition(target, unit.position)) {
        const direction = stepToward(unit.position, target, movementObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "go_harvest");
      }
      return;
    }

    const hints = this.world.resourceHints();
    if (
      memory.workerMode === "go_harvest" &&
      memory.harvestTarget !== null &&
      hints.some((hint) => samePosition(hint, memory.harvestTarget!))
    ) {
      const direction = stepToward(unit.position, memory.harvestTarget, movementObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, "go_harvest_mem");
      return;
    }

    memory.workerMode = "patrol";
    memory.harvestTarget = null;
    let target: Position | null = null;
    if (home !== null) {
      const beacon = state.beacon.position ?? home;
      let patrolRadius = exploreRadiusForRing(this.config.exploreRadius, memory.patrolRing);
      let patrolPoint = exploreTarget(home, beacon, memory.patrolDirection, patrolRadius);
      const patrolPointBlocked = obstacles.has(cellKey(patrolPoint));
      if (chebyshev(unit.position, home) > patrolRadius) {
        memory.patrolReturning = true;
        target = home;
      } else if (samePosition(unit.position, home)) {
        if (memory.patrolStarted) {
          memory.patrolDirection = (memory.patrolDirection + 1) % EXPLORE_DIRECTION_COUNT;
          memory.patrolRing = (memory.patrolRing + 1) % EXPLORE_RING_COUNT;
        }
        else memory.patrolStarted = true;
        memory.patrolReturning = false;
        patrolRadius = exploreRadiusForRing(this.config.exploreRadius, memory.patrolRing);
        patrolPoint = exploreTarget(home, beacon, memory.patrolDirection, patrolRadius);
        target = patrolPoint;
      } else if (memory.patrolReturning) {
        target = home;
      } else if (
        samePosition(unit.position, patrolPoint) ||
        (patrolPointBlocked && chebyshev(unit.position, patrolPoint) <= 1)
      ) {
        // 探索目标可能恰好落在已知障碍格。此时精确到达不可能，若仍持续
        // stepToward(target)，导航会在障碍旁的两个合法格之间反复摆动。
        // 巡逻的目标是覆盖该方向的视野，不是占据精确坐标；到达障碍邻格
        // 已完成这条射线的有效探索，立即返航并在下一圈换方向。
        memory.patrolReturning = true;
        target = home;
      } else {
        target = patrolPoint;
      }
    } else {
      target = state.beacon.position;
    }

    if (target !== null && !samePosition(target, unit.position)) {
      const direction = stepToward(unit.position, target, movementObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, "patrol");
    }
  }

  private decideVanguard(
    state: TickState,
    unit: UnitSnapshot,
    obstacles: ReadonlySet<string>,
    enemies: readonly VisibleEntity[],
    set: (unit: UnitSnapshot, action: UnitAction, intent: string) => void,
  ): void {
    const movementObstacles = this.world.movementObstacles(unit.id, obstacles);
    const adjacent = enemies.find((enemy) => manhattan(unit.position, enemy.position) === 1);
    if (adjacent !== undefined) {
      const direction = directionToAdjacent(unit.position, adjacent.position);
      if (direction !== null) set(unit, { type: "SWEEP", direction }, "sweep");
      return;
    }

    if (this.effectiveAggression === "aggressive") {
      // 激进：主动前压。敌人 Core 是最高价值目标（拆 Core 掠夺资源，v0.9
      // capture）；否则追击最近可见敌人。不再因靠近自家 Core 而留守。
      const enemyCore = enemies.find((enemy) => enemy.kind === "CORE");
      const target = enemyCore?.position ?? nearestEnemy(enemies, unit.position)?.position ?? state.core?.position ?? null;
      if (target !== null && !samePosition(unit.position, target)) {
        const direction = stepToward(unit.position, target, movementObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_pressure");
      }
      return;
    }

    const nearby = enemies.filter((enemy) => manhattan(unit.position, enemy.position) <= 4);
    if (
      nearby.length > 0 &&
      state.core !== null &&
      manhattan(unit.position, state.core.position) <= 4
    ) {
      return;
    }
    const target = nearby.length > 0
      ? nearestEnemy(nearby, unit.position)?.position ?? null
      : state.core?.position ?? null;
    if (target !== null && !samePosition(unit.position, target)) {
      const direction = stepToward(unit.position, target, movementObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_move");
    }
  }

  private decideRanger(
    state: TickState,
    unit: UnitSnapshot,
    obstacles: ReadonlySet<string>,
    enemies: readonly VisibleEntity[],
    set: (unit: UnitSnapshot, action: UnitAction, intent: string) => void,
  ): void {
    const movementObstacles = this.world.movementObstacles(unit.id, obstacles);

    // Precision shot at a visible enemy in range. Aggressive mode prioritizes
    // enemy Workers to cut their economy (cargo never reaches their Core).
    const inRange = enemies.filter((enemy) => canShoot(unit.position, enemy.position, obstacles));
    const target = this.effectiveAggression === "aggressive"
      ? inRange.sort(aggressiveShotPriority)[0]
      : inRange[0];
    if (target !== undefined) {
      set(unit, { type: "SHOOT", targetId: target.id, expectedCell: target.position }, "shoot");
      return;
    }

    // Upstream v0.12 cell fire: fire at the predicted next cell of the nearest
    // visible enemy that is out of range. A unit in range 4-5 can be hit next
    // tick if it keeps advancing toward us along the same line.
    const nearest = nearestEnemy(enemies, unit.position);
    if (nearest !== null) {
      const predicted = predictedEnemyCell(unit.position, nearest.position);
      if (
        predicted !== null &&
        canShoot(unit.position, predicted, obstacles) &&
        !samePosition(predicted, nearest.position)
      ) {
        set(unit, { type: "SHOOT", targetId: null, expectedCell: predicted }, "shoot_cell");
        return;
      }
    }

    const moveTarget = enemies.length > 0
      ? nearestEnemy(enemies, unit.position)?.position ?? null
      : state.core?.position ?? null;
    if (moveTarget !== null && !samePosition(unit.position, moveTarget)) {
      // 激进：保持 1-3 射程站定，不冲脸（近身会让 Ranger 失去射程优势且易被
      // SWEEP）。已在射程内但没有合法射击目标（被障碍挡住）时原地待机。
      const distance = manhattan(unit.position, moveTarget);
      const keepRange = this.effectiveAggression === "aggressive" && distance <= 3;
      if (!keepRange) {
        const direction = stepToward(unit.position, moveTarget, movementObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "ranger_move");
      }
    }
  }

  private decideCore(state: TickState, intents: Record<string, string>): CoreAction | null {
    const core = state.core;
    if (core === null) return null;
    if (core.hp < 5) {
      intents.core = "core_heal";
      return { type: "HEAL" };
    }
    if (core.shield < 5 && state.resources >= 1 && core.state === "NORMAL") {
      intents.core = "repair_shield";
      return { type: "REPAIR_SHIELD" };
    }
    if (core.state !== "NORMAL" || state.population >= this.config.populationCeiling) return null;
    if (this.config.accumulateTarget > 0 && state.resources >= this.config.accumulateTarget) {
      intents.core = "accumulated_target";
      return null;
    }

    const military = state.vanguards.length + state.rangers.length;
    const unitType =
      this.config.accumulateTarget > 0 &&
      state.resources >= this.config.guardResources &&
      military < this.config.guardForce
        ? nextMilitary(state)
        : nextSpawn(state, this.effectiveWorkerTarget);
    const cost = unitType === "WORKER" ? 5 : unitType === "VANGUARD" ? 10 : 12;
    const reserve = state.resources >= this.config.wealthyThreshold
      ? this.config.reserveWealthy
      : this.config.reserveEarly;
    if (state.resources < cost + reserve) return null;
    intents.core = `spawn_${unitType.toLowerCase()}`;
    return { type: "SPAWN", unitType };
  }
}

function nextSpawn(state: TickState, workerTarget: number): UnitType {
  if (state.workers.length < workerTarget) return "WORKER";
  return nextMilitary(state);
}

function nextMilitary(state: TickState): UnitType {
  return state.vanguards.length <= state.rangers.length ? "VANGUARD" : "RANGER";
}

function nearestEnemy(enemies: readonly VisibleEntity[], position: Position): VisibleEntity | null {
  return [...enemies].sort(
    (a, b) => manhattan(position, a.position) - manhattan(position, b.position) || a.id.localeCompare(b.id),
  )[0] ?? null;
}

/** 激进射击目标优先级：断敌经济（WORKER）优先，其次远程单位，最后 Core。
 *  排序稳定：同优先级按 raw id 字典序（nearestEnemy 的调用方约束）。 */
function aggressiveShotPriority(a: VisibleEntity, b: VisibleEntity): number {
  return shotTargetRank(a) - shotTargetRank(b) || a.id.localeCompare(b.id);
}

function shotTargetRank(enemy: VisibleEntity): number {
  if (enemy.kind === "CORE") return 3;
  return enemy.unitType === "WORKER" ? 0 : enemy.unitType === "RANGER" ? 1 : 2;
}

function canShoot(from: Position, target: Position, obstacles: ReadonlySet<string>): boolean {
  const dx = target[0] - from[0];
  const dy = target[1] - from[1];
  const distance = Math.max(Math.abs(dx), Math.abs(dy));
  return distance >= 1 &&
    distance <= 3 &&
    (dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)) &&
    !lineBlocked(from, target, obstacles);
}

/** 预测敌人下一 Tick 位置：朝攻击者逼近一格（八方向切比雪夫步进）。
 *  仅当敌人当前不在射程内（4-5 格）时用于 cell fire 预判；已在射程内
 *  由 precision shoot 覆盖。返回 null 表示无法预测（已在身边）。 */
function predictedEnemyCell(actor: Position, enemy: Position): Position | null {
  const dx = enemy[0] - actor[0];
  const dy = enemy[1] - actor[1];
  const stepX = dx === 0 ? 0 : Math.sign(dx);
  const stepY = dy === 0 ? 0 : Math.sign(dy);
  const next = [enemy[0] - stepX, enemy[1] - stepY] as Position;
  return samePosition(next, enemy) ? null : next;
}

function parseCell(value: string): Position {
  const [x, y] = value.split(",").map(Number);
  return [x, y];
}

function samePosition(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export function directionName(direction: Direction): Direction {
  return direction;
}
