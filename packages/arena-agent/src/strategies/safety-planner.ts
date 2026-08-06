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
  move,
  nearest,
  stepToward,
} from "../domain/nav.ts";
import { UNIT_MAX_HP } from "../domain/plan-validator.ts";
import { countEnemiesNearCore } from "../domain/plan-validator.ts";
import { PhaseMachine, type PhaseConfig } from "../domain/phase-machine.ts";
import { World } from "../domain/world.ts";
import { assessThreat, coreDamagedThisTick, type ThreatAssessment } from "../domain/threat.ts";
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
  /**
   * focusRegion 最大有效距离（Chebyshev，以 Core 为圆心）：聚焦区语义是"可探索/
   * 可攻坚的近程区域"，超上限视为无效并回退巡逻。生产实测：policy 层曾输出
   * [1500,1500]/[-1500,1500] 等地图角落坐标，全部 worker 被直线支去不可达远点 →
   * 无限 go_focus、0 采集、经济冻结（focus 是"直线远征"而非"巡逻偏好"）。
   */
  readonly maxFocusDistance: number;
  /**
   * clear-path 清障（TS-009 候选）：defensive 下 Vanguard 不再纯留守——满载
   * Worker 回仓路径上（距满载 Worker ≤2 格且比 Worker 更靠近 Core）的敌人视为
   * 挡路者，优先主动清除。生产 A/B 实测：被敌群挡回仓的一方经济 2-4× 差于清场方。
   */
  readonly clearPath?: boolean;
  readonly phase?: PhaseConfig;
  /**
   * 战斗激进级别（默认 defensive，与历史行为一致）：
   * - defensive：Vanguard 仅在邻近威胁时应对，靠近 Core 留守；
   * - aggressive：Vanguard 前压攻坚（优先敌人 Core），Ranger 优先断敌经济
   *   （射 WORKER）并保持射程站定。
   */
  readonly aggression?: AggressionLevel;
  /**
   * 军事配比（实验，默认 undefined = 交替产兵）：VANGUARD 目标占比 [0,1]。
   * 1 = 全近战攻坚、0 = 全远程断经济、0.5 = 交替（历史行为等价）。
   * 模拟器配比实验（military-composition-experiment）决定生产默认是否调整。
   */
  readonly vanguardRatio?: number;
  /**
   * 爆兵阈值（2026-08-06 用户导向"积累到一定程度开始爆兵"）：resources 达到
   * 该值前只产 Worker 积累经济；达到后全力爆兵（交替产 VANGUARD/RANGER，
   * 不受 militaryRatio 比例限制，人口上限内持续）。默认 0 = 关闭（历史行为
   * 按 militaryRatio 随产随造）。与 attackForce 配套：爆兵成型后前压打水晶。
   */
  readonly accumulateThreshold?: number;
  /**
   * 前压兵力门槛（2026-08-06 用户导向"以爆兵为目的打对面水晶"）：军事单位数
   * 达到该值前 aggressive Vanguard 守家蓄势（不送死）；达标后前压/打野。
   * 默认 0 = 关闭（历史行为：有可见敌人即前压）。
   */
  readonly attackForce?: number;
  /**
   * frontier 探索（v0.2，实验）：worker 回家换巡逻方位时，按"该方位探测点所在
   * chunk 观察老化"选方向——观察最老的分区先巡（chunk 16×16），多 worker 按
   * 序号轮转分散到不同老分区。默认 false = 固定步进 +3（历史行为零回归）。
   * 场景价值：资源枯竭后 40 格外矿在不同方位时，worker 不再沿固定方位序列
   * 顺序覆盖（可能数圈后才到矿所在方位），而是优先补老分区。
   */
  readonly frontierPriority?: boolean;
  /**
   * Core 迁移（v0.3，PRE_EVADE-lite，实验）：12 格内可见敌或确认追击时
   * START_MOVE 远离敌人+远离 beacon（竞品 threat-response 对照，P06 结算
   * 已支持）。默认 false = 历史行为（Core 不迁移）。迁移中不生产/heal。
   */
  readonly coreEvade?: boolean;
  /**
   * Core 迁移 TTR 预撤离（v0.3，实验，需 coreEvade=true）：用 EnemyMemory
   * 位置差分估算逼近速度，TTR（距离/速度）≤16 tick 即触发迁移——比 12 格
   * 固定阈值更早（高速逼近的敌人在 20 格外 TTR 已 ≤16）。竞品
   * threat-response time-to-range 对照。默认 false = 仅 12 格触发（历史实验行为）。
   */
  readonly coreEvadeTtr?: boolean;
  /**
   * Core 迁移多目标方向评分（v0.3，实验，需 coreEvade=true）：retreatDirection
   * 用竞品字典序（投影伤害 → 全敌距离升序向量 → beacon）替代旧"只取最近敌
   * 距离"——防退向"离最近敌最远"但冲进另一敌射程（Ranger 3 格直线）。
   * 默认 false = 旧 distance 评分（历史实验行为零回归）。
   */
  readonly coreEvadeScoring?: boolean;
  /**
   * MOVE_FAILED 反馈规避（v0.3，实验）：单位连续 N 次移动被结算拒绝
   * （MOVE_CONTESTED/CELL_UNIT_LIMIT 等）时，不再盲目重试同格——改走垂直
   * 绕行格（探路）。模拟器实证（2026-08-06 第三十一轮）：2 Vanguard vs 敌
   * CORE 场景，敌守军与进攻方 3 只 Vanguard 每 tick 争唯一推进格（容量 2）
   * → MOVE_CONTESTED 全失败 → 无反馈重试 400 tick 0 拆。默认 false =
   * 历史行为（无反馈重试，零回归）。
   */
  readonly moveFailedAvoidance?: boolean;
  /**
   * BREAKOUT 全面收缩（v0.3，实验）：威胁等级 BREAKOUT（多轴包围、无逃逸
   * 方向——竞品 multi-axis breakout 对齐）时 worker 全面缩守家圈（比 ALERT
   * 召回更保守——被包围时外出采集/巡逻即送死，等包围解除再恢复）。默认
   * false = 历史行为（仅 ALERT 召回生效时收缩）。
   */
  readonly threatBreakout?: boolean;
  /**
   * 威胁召回（v0.3，实验）：ALERT 级威胁（12 格内可见敌确认）时 worker
   * 巡逻半径缩到守家圈（4 格），不放远探/远采——防止 worker 在外被敌人
   * 击杀（生产 t2 无近敌是地理因素；有敌接触对局中保护经济）。默认
   * false = 历史行为（威胁不改变 worker 巡逻范围）。
   */
  readonly threatRecall?: boolean;
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
  maxFocusDistance: 32,
});

/** 威胁召回触发距离（12 = ALERT 级威胁的确认接触半径，与 threat.ts 一致）。 */
const THREAT_RECALL_DISTANCE = 12;
/** 召回时 worker 的守家巡逻半径。 */
const RECALL_PATROL_RADIUS = 4;
/** Core 迁移 TTR 预撤离阈值（竞品 time-to-range ≤16 tick）。 */
const TTR_PRE_EVADE_TICKS = 16;

/** moveFailedAvoidance 绕行（v0.3 实验）：单位连续 MOVE_FAILED 后不再盲目重试
 *  同格——沿主方向垂直的候选方向探路（先 UP/DOWN 再 LEFT/RIGHT，排除障碍格）；
 *  垂直全堵再退一格反向（远离目标后 BFS 自然换路）。模拟器实证根因：进攻方与
 *  敌守军每 tick 争唯一推进格（容量 2）→ MOVE_CONTESTED 全失败 → 无反馈重试
 *  死循环；垂直绕行打破争格僵局。 */
function detourDirection(
  position: Position,
  target: Position,
  obstacles: ReadonlySet<string>,
): Direction | null {
  const dx = target[0] - position[0];
  const dy = target[1] - position[1];
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const perpendicular: Direction[] = horizontal ? ["UP", "DOWN"] : ["LEFT", "RIGHT"];
  for (const direction of perpendicular) {
    if (!obstacles.has(cellKey(move(position, direction)))) return direction;
  }
  const primary: Direction = horizontal ? (dx > 0 ? "RIGHT" : "LEFT") : (dy > 0 ? "DOWN" : "UP");
  const reverse: Direction =
    primary === "UP" ? "DOWN" : primary === "DOWN" ? "UP" : primary === "LEFT" ? "RIGHT" : "LEFT";
  if (!obstacles.has(cellKey(move(position, reverse)))) return reverse;
  return null;
}

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
  readonly config: SafetyPlannerConfig;
  /** 本 decide 生效的 aggression（policy 优先，其次 config.aggression）。 */
  private effectiveAggression: AggressionLevel = "defensive";
  /** 本 decide 生效的 workerTarget（policy 优先，其次 config.workerTarget）。 */
  private effectiveWorkerTarget = 8;
  /** 本 decide 生效的 policy（focusRegion/attackPriority 消费）。 */
  private effectivePolicy: MacroPolicy | null = null;
  /** 爆兵状态（2026-08-06）：accumulateThreshold 达标后置 true 并保持——
   *  持续爆兵直到资源不足以产兵才回积累期（防止"产 1 兵掉回阈值下"振荡）。 */
  private surgeActive = false;
  /** Core 迁移方向（coreEvade）：START_MOVE 发起时记录；次 tick 仍 MOVING
   *  同向 = 已提交（本地等效 move_progress≥2，竞品 CANCEL 语义用）。 */
  private coreMoveDirection: Direction | null = null;
  /** PRE_EVADE 持续截止 tick（竞品 preemptive_evade_until_tick = tick + 2）：
   *  触发迁移后即使敌人消失，2 tick 内仍保持迁移意图（防止"敌人闪失 →
   *  立刻取消"抖动）。 */
  private preemptiveEvadeUntilTick = 0;
  /** MOVE_FAILED 连续失败计数（moveFailedAvoidance）：单位连续 N tick 移动被
   *  结算拒绝时改走垂直绕行格，避免无反馈重试同格死循环。 */
  private moveFailedStreak = new Map<string, number>();
  /** 本 tick 威胁评估（threatBreakout 用）：decide 入口计算一次供 worker 消费。 */
  private currentThreat: ThreatAssessment | null = null;

  constructor(
    config: SafetyPlannerConfig = DEFAULT_SAFETY_CONFIG,
    world = new World(),
  ) {
    this.config = config;
    this.world = world;
    this.phase = new PhaseMachine(config.phase);
  }

  decide(input: SafetyPlannerInput): Plan {
    const { state } = input;
    this.effectivePolicy = input.policy ?? null;
    // focusRegion 防呆（生产实测 2026-08-05）：policy 层曾输出 [1500,1500]/
    // [-1500,1500]/[0,0] 等不可达远点，全部 worker 被 go_focus 直线支走 → 0 采集、
    // 经济冻结、无法补员/产兵。聚焦区必须是 Core 附近的可探索近程区域：以 Core
    // 为圆心超 maxFocusDistance 的焦点视为无效，统一回退巡逻（覆盖 worker/vanguard/
    // ranger 的全部 focus 消费点）。
    const focus = this.effectivePolicy?.focusRegion ?? null;
    const home = state.core?.position ?? null;
    if (focus !== null && home !== null && this.effectivePolicy !== null && chebyshev(home, focus) > this.config.maxFocusDistance) {
      this.effectivePolicy = { ...this.effectivePolicy, focusRegion: null };
    }
    this.effectiveAggression =
      input.policy !== undefined ? aggressionOf(input.policy) : (this.config.aggression ?? "defensive");
    this.effectiveWorkerTarget = input.policy?.workerTarget ?? this.config.workerTarget;
    this.world.observe(state);
    this.phase.update({
      population: state.population,
      resources: state.resources,
      enemyNearCore: countEnemiesNearCore(state, this.config.threatEnemyDistance),
    });
    // 威胁评估（threatBreakout 用）：decide 入口算一次（有 Core 且有可见敌时）。
    this.currentThreat = null;
    if (state.core !== null && state.visibleEnemies.length > 0) {
      this.currentThreat = assessThreat({
        core: state.core.position,
        visibleEnemies: state.visibleEnemies,
        enemyHints: this.world.enemyHints(),
        coreDamagedThisTick: coreDamagedThisTick(state.events),
      });
    }
    // MOVE_FAILED 反馈（moveFailedAvoidance）：上 tick 结算拒绝的单位计连续失败，
    // 其余清零——连续失败 ≥2 时单位改走垂直绕行格探路（见 detourDirection）。
    if (this.config.moveFailedAvoidance === true) {
      const failed = new Set<string>();
      for (const event of state.events) {
        if (event.eventType === "UNIT_MOVE_FAILED" && event.actorId !== null) failed.add(event.actorId);
      }
      for (const unit of state.units) {
        if (failed.has(unit.id)) {
          this.moveFailedStreak.set(unit.id, (this.moveFailedStreak.get(unit.id) ?? 0) + 1);
        } else {
          this.moveFailedStreak.delete(unit.id);
        }
      }
    }

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
    const vanguardIndex = new Map(
      [...state.units]
        .filter((unit) => unit.unitType === "VANGUARD")
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((unit, index) => [unit.id, index]),
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
        this.decideVanguard(state, unit, vanguardIndex.get(unit.id) ?? 0, obstacles, enemies, set);
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
    const memory = this.world.unitMemory(unit.id, (index * 3 + 7) % EXPLORE_DIRECTION_COUNT);
    const home = state.core?.position ?? null;
    const movementObstacles = this.world.movementObstacles(unit.id, obstacles);
    // 威胁召回（threatRecall，v0.3 实验）：12 格内可见敌（确认接触）时 worker
    // 巡逻/探索半径缩到守家圈（RECALL_PATROL_RADIUS），不放远探/远采。
    // BREAKOUT 全面收缩（threatBreakout，v0.3 实验）：多轴包围（无逃逸方向）
    // 时同样缩家——被包围时外出即送死，等包围解除再恢复。
    const recallActive =
      this.config.threatRecall === true &&
      state.visibleEnemies.some(
        (enemy) => home !== null && manhattan(enemy.position, home) <= THREAT_RECALL_DISTANCE,
      );
    const breakoutActive =
      this.config.threatBreakout === true && this.currentThreat?.level === "BREAKOUT";
    const maxPatrolRadius =
      recallActive || breakoutActive ? RECALL_PATROL_RADIUS : Number.POSITIVE_INFINITY;

    if (unit.cargo > 0) {
      if (home !== null && samePosition(unit.position, home)) {
        if (state.resourceSpace > 0) set(unit, { type: "DEPOSIT" }, "deposit");
      } else if (home !== null) {
        const stuckTicks = this.moveFailedStreak.get(unit.id) ?? 0;
        const direction =
          this.config.moveFailedAvoidance === true && stuckTicks >= 2
            ? detourDirection(unit.position, home, movementObstacles)
            : stepToward(unit.position, home, movementObstacles);
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
      // 召回期间只采守家圈内的矿（远矿等威胁解除再采）
      if (recallActive && target !== null && home !== null && manhattan(target, home) > maxPatrolRadius) {
        memory.workerMode = "patrol";
        memory.harvestTarget = null;
      } else {
        memory.workerMode = "go_harvest";
        memory.harvestTarget = target;
        if (target !== null && !samePosition(target, unit.position)) {
          const stuckTicks = this.moveFailedStreak.get(unit.id) ?? 0;
          const direction =
            this.config.moveFailedAvoidance === true && stuckTicks >= 2
              ? detourDirection(unit.position, target, movementObstacles)
              : stepToward(unit.position, target, movementObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "go_harvest");
        }
      }
      return;
    }

    const hints = this.world.resourceHints();
    if (
      memory.workerMode === "go_harvest" &&
      memory.harvestTarget !== null &&
      hints.some((hint) => samePosition(hint, memory.harvestTarget!))
    ) {
      const inRecallRange = home === null || manhattan(memory.harvestTarget, home) <= maxPatrolRadius;
      if (inRecallRange) {
        const direction = stepToward(unit.position, memory.harvestTarget, movementObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "go_harvest_mem");
      }
      return;
    }

    memory.workerMode = "patrol";
    memory.harvestTarget = null;

    // focusRegion：战略聚焦区优先于无差别巡逻（探索方向由策略层决定）
    const focus = this.effectivePolicy?.focusRegion ?? null;
    if (focus !== null && !samePosition(unit.position, focus)) {
      const direction = stepToward(unit.position, focus, movementObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, "go_focus");
      return;
    }

    let target: Position | null = null;
    if (home !== null) {
      const beacon = state.beacon.position ?? home;
      let patrolRadius = exploreRadiusForRing(this.config.exploreRadius, memory.patrolRing);
      if (maxPatrolRadius < patrolRadius) patrolRadius = maxPatrolRadius;
      let patrolPoint = exploreTarget(home, beacon, memory.patrolDirection, patrolRadius);
      const patrolPointBlocked = obstacles.has(cellKey(patrolPoint));
      if (chebyshev(unit.position, home) > patrolRadius) {
        memory.patrolReturning = true;
        target = home;
      } else if (samePosition(unit.position, home)) {
        if (memory.patrolStarted) {
          // 方位步进 1→3（2026-08-06 生产实证）：t1 资源枯竭时 40 格矿在正东，
          // 旧连续步进（+1）按 beacon 方位基（东南）逐格推进，第 8 圈才轮到正东
          // （数百 tick 不可达）——4 worker 首圈聚集东南-西 4 方位造成测绘盲区；
          // +3（与 8 互质）前 3 圈即扫过全部 8 方位，分散覆盖。
          // frontier-v1（实验）：观察最老的分区先巡——8 方位按当前环探测点所在
          // chunk 老化排序，worker 按序号轮转分散（默认 false 保持 +3 固定步进）。
          memory.patrolDirection =
            this.config.frontierPriority === true
              ? this.world.staleDirection(
                  home,
                  beacon,
                  memory.patrolRing,
                  this.config.exploreRadius,
                  EXPLORE_DIRECTION_COUNT,
                  // 分散偏移与初始方向同构（(index*3+7)%8 生产验证的分散方案）：
                  // 纯 index 位次会让全部 worker 涌向"最老"位次（实验实证：
                  // 双对角远矿场景 east 0/3 west 3/3——东侧被集体放弃）；
                  // 固定偏移保证不同 worker 取不同老化位次，老方位优先 + 覆盖分散。
                  (index * 3 + 7) % EXPLORE_DIRECTION_COUNT,
                )
              : (memory.patrolDirection + 3) % EXPLORE_DIRECTION_COUNT;
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
        // 连续外扩巡逻（2026-08-06 用户导向）：到达当前环点后不回 home——
        // 同方位直接延伸下一环（8→16→24→32→40 连续外扩，"一直往外探索"；
        // 旧行为每环往返 home 换环，视觉上来回、推进慢、测绘覆盖滞后）。
        // 到最远环后回家换方位重头。
        if (memory.patrolRing < EXPLORE_RING_COUNT - 1) {
          memory.patrolRing += 1;
          patrolRadius = exploreRadiusForRing(this.config.exploreRadius, memory.patrolRing);
          patrolPoint = exploreTarget(home, beacon, memory.patrolDirection, patrolRadius);
          target = patrolPoint;
        } else {
          memory.patrolReturning = true;
          target = home;
        }
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
    index: number,
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
      // 爆兵蓄势 gate（2026-08-06 用户导向"以爆兵为目的打对面水晶"）：军事
      // 规模未达 attackForce 时守家蓄势（兵力成型再前压，避免零星送死）；
      // 达标后前压攻坚。默认 attackForce=0 = 关闭（历史行为）。
      const military = state.vanguards.length + state.rangers.length;
      const forceGate = (this.config.attackForce ?? 0) > 0 && military < (this.config.attackForce ?? 0);
      if (forceGate) {
        const home = state.core === null ? null : homeCell(state.core.position, movementObstacles, index);
        if (home !== null && !samePosition(unit.position, home)) {
          const direction = stepToward(unit.position, home, movementObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_hold");
        }
        return;
      }
      // 敌方 Core 记忆推进（2026-08-07 竞品 offensive memory 对齐）：aggressive
      // 且当前无可见敌人时，若曾见过敌方 Core（记忆未过期），向记忆位置推进——
      // 避免"敌人离开视野后 Vanguard 只在自家 Core 附近巡逻"的盲区（模拟器
      // v0.14 实证：无敌人时 scavenge 巡逻方向随机，可能完全背离敌方）。
      // Core 是慢速目标，记忆有效期放宽到 60 ticks（单位记忆默认 6）。
      // 优先级高于守家巡逻：有攻坚目标时不空转。
      if (enemies.length === 0 && state.core !== null) {
        const enemyCoreMemory = this.world.enemyHints(60).find((hint) => hint.kind === "CORE");
        if (enemyCoreMemory !== undefined) {
          const direction = stepToward(unit.position, enemyCoreMemory.position, movementObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_pressure_memory");
          return;
        }
      }
      // 军事打野（2026-08-06 用户导向）：aggressive + 无可见敌人 + 资源枯竭
      // （视野 0 资源格）——军事单位不再守家发呆，巡逻外扩探索（测绘 + 打野）；
      // 有资源仍守家（防止军事单位长期远征离家被端）、有敌人走前压。
      // 修复（2026-08-06 模拟器实证）：旧条件 samePosition(unit, target) 要求
      // Vanguard 先走到 target（无敌人时 = Core 格）才打野——守家锚点在途/
      // Core 格被 Worker 回仓占用时永远到不了 → 打野永不触发、Vanguard 枯竭后
      // 空转守家。无敌人时 target 恒为 Core 位置，该到位限制无意义。
      if (enemies.length === 0 && state.resourceCells.size === 0 && state.core !== null) {
        const memory = this.world.unitMemory(unit.id, (index * 3 + 7) % EXPLORE_DIRECTION_COUNT);
        const home = state.core.position;
        const beacon = state.beacon.position ?? home;
        let patrolRadius = exploreRadiusForRing(this.config.exploreRadius, memory.patrolRing);
        let patrolPoint = exploreTarget(home, beacon, memory.patrolDirection, patrolRadius);
        if (samePosition(unit.position, patrolPoint)) {
          if (memory.patrolRing < EXPLORE_RING_COUNT - 1) {
            memory.patrolRing += 1;
            patrolRadius = exploreRadiusForRing(this.config.exploreRadius, memory.patrolRing);
            patrolPoint = exploreTarget(home, beacon, memory.patrolDirection, patrolRadius);
          } else {
            memory.patrolRing = 0;
            memory.patrolDirection = (memory.patrolDirection + 3) % EXPLORE_DIRECTION_COUNT;
            patrolPoint = exploreTarget(home, beacon, memory.patrolDirection, patrolRadius);
          }
        }
        const direction = stepToward(unit.position, patrolPoint, movementObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_scavenge");
        return;
      }
      // 激进：主动前压。attackPriority 决定攻坚目标（v0.9 拆 Core 掠夺资源 vs
      // 断敌经济）；无特攻目标时追击最近可见敌人。不再因靠近自家 Core 而留守。
      const attackPriority = this.effectivePolicy?.attackPriority ?? null;
      let target: Position | null = null;
      if (attackPriority === "workers") {
        const enemyWorker = enemies.find((enemy) => enemy.kind === "UNIT" && enemy.unitType === "WORKER");
        target = enemyWorker?.position ?? nearestEnemy(enemies, unit.position)?.position ?? state.core?.position ?? null;
      } else if (attackPriority === "core") {
        const enemyCore = enemies.find((enemy) => enemy.kind === "CORE");
        target = enemyCore?.position ?? nearestEnemy(enemies, unit.position)?.position ?? state.core?.position ?? null;
      } else {
        target = nearestEnemy(enemies, unit.position)?.position ?? state.core?.position ?? null;
      }
      if (target !== null && !samePosition(unit.position, target)) {
        const stuckTicks = this.moveFailedStreak.get(unit.id) ?? 0;
        const direction =
          this.config.moveFailedAvoidance === true && stuckTicks >= 2
            ? detourDirection(unit.position, target, movementObstacles)
            : stepToward(unit.position, target, movementObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_pressure");
      }
      return;
    }

    const nearby = enemies.filter((enemy) => manhattan(unit.position, enemy.position) <= 4);
    // clear-path 清障（TS-009 候选）：满载 Worker 回仓路径上的敌人，或站在
    // 我方可见资源格上的敌人（封锁采集），视为挡路者，Vanguard 优先主动清除
    // （覆盖留守）。判据 1：敌人距任一满载 Worker ≤2 格且比 Worker 更靠近 Core
    // （回仓方向）；判据 2：敌人站在可见资源格上（采集封锁——生产实测：被压方
    // 经济 2-4× 差于清场方）。
    if (this.config.clearPath === true && state.core !== null) {
      const corePosition = state.core.position;
      const blockingOnRoute = enemies.find((enemy) =>
        state.workers.some((worker) => {
          if (worker.cargo <= 0) return false;
          if (manhattan(worker.position, enemy.position) > 2) return false;
          const workerDistance = manhattan(worker.position, corePosition);
          const enemyDistance = manhattan(enemy.position, corePosition);
          return enemyDistance < workerDistance;
        }),
      );
      const blockingResource = enemies.find((enemy) => state.resourceCells.has(cellKey(enemy.position)));
      const blockingEnemy = blockingOnRoute ?? blockingResource;
      if (blockingEnemy !== undefined) {
        const direction = stepToward(unit.position, blockingEnemy.position, movementObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_clear_path");
        return;
      }
    }
    if (
      nearby.length > 0 &&
      state.core !== null &&
      manhattan(unit.position, state.core.position) <= 4
    ) {
      return;
    }
    // 守家/回防锚点 = Core 相邻格（绝不站 Core 格本身——Core 格是 Worker 回仓
    // 通道，被军事单位长期占用会造成 capacity_wait:DEPOSIT 经济死锁，生产实测）。
    const home = state.core === null ? null : homeCell(state.core.position, movementObstacles, index);
    // 已在 Core 格且满血：移出到守家锚点（治疗是短时占格，治疗完必须让出回仓通道）
    if (
      state.core !== null &&
      unit.hp >= UNIT_MAX_HP[unit.unitType] &&
      samePosition(unit.position, state.core.position) &&
      home !== null &&
      !samePosition(unit.position, home)
    ) {
      const direction = stepToward(unit.position, home, movementObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_home");
      return;
    }
    // focusRegion：无敌人时朝策略聚焦区推进（侦察/占位），否则回守家锚点或追击邻近敌人
    const focus = this.effectivePolicy?.focusRegion ?? null;
    const target = nearby.length > 0
      ? nearestEnemy(nearby, unit.position)?.position ?? null
      : focus ?? home;
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
    // Defensive mode prioritizes the nearest threat first (a Vanguard one cell
    // from sweeping us outranks a Worker three cells away), then same value
    // ranks by type (workers first = economy damage), then raw id (determinism).
    const inRange = enemies.filter((enemy) => canShoot(unit.position, enemy.position, obstacles));
    const target = this.effectiveAggression === "aggressive"
      ? inRange.sort(aggressiveShotPriority)[0]
      : inRange.sort((a, b) => defensiveShotPriority(unit.position, a, b))[0];
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
      : this.effectivePolicy?.focusRegion ?? state.core?.position ?? null;
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
    // Core 迁移（v0.3 PRE_EVADE-lite，coreEvade 配置默认关闭）：迁移中不
    // 生产/heal（竞品语义：MOVING 直接 return）；迁移方向由 START_MOVE 发起
    // 时记录，次 tick 仍 MOVING = 已提交（本地等效 move_progress≥2）。
    if (core.state === "MOVING") {
      return null;
    }
    if (this.config.coreEvade === true) {
      // 触发源（2026-08-07 B1/B3 对齐竞品 threat-response PRE_EVADE）：
      // 1) closing：12 格内可见敌（回退半径）；
      // 2) confirmedPursuit：远距确认追击（积分 ≥3 持续逼近，>12 格也触发）；
      // 3) ttrTrigger：TTR 预撤离（扣 attack-range、observation-gap 缩放）；
      // 4) preemptiveEvadeUntilTick：敌人消失后 2 tick 持续（竞品 2-tick
      //    preemptive_evade_until 对照——防止"敌人闪失 → 立刻取消"抖动）。
      const enemyHints = this.world.enemyHints();
      const threat = assessThreat({
        core: core.position,
        visibleEnemies: state.visibleEnemies,
        enemyHints,
        coreDamagedThisTick: coreDamagedThisTick(state.events),
      });
      const closing = threat.closingEnemies > 0;
      const confirmedPursuit = threat.confirmedPursuit;
      let ttrTrigger = false;
      if (this.config.coreEvadeTtr === true) {
        const hintsById = new Map(enemyHints.map((hint) => [hint.id, hint]));
        for (const enemy of state.visibleEnemies) {
          const hint = hintsById.get(enemy.id);
          if (hint?.prevPosition === undefined || hint?.prevSeenTick === undefined) continue;
          const prevDistance = manhattan(hint.prevPosition, core.position);
          const distance = manhattan(enemy.position, core.position);
          const closed = prevDistance - distance; // 观测间隔内总逼近量
          if (closed <= 0) continue;
          const observationGap = hint.lastSeenTick - hint.prevSeenTick; // 间隔 tick
          // 竞品公式：remaining = max(0, d − attack_range)，attack_range =
          // RANGER 3 / VANGUARD 1；ticks_to_attack_range = remaining × gap / closed
          const attackRange = enemy.unitType === "RANGER" ? 3 : 1;
          const remaining = Math.max(0, distance - attackRange);
          if ((remaining * observationGap) / closed <= TTR_PRE_EVADE_TICKS) {
            ttrTrigger = true;
            break;
          }
        }
      }
      const preemptivePersist = this.preemptiveEvadeUntilTick >= state.tick;
      if (closing || confirmedPursuit || ttrTrigger || preemptivePersist) {
        const direction = retreatDirection(
          core.position,
          state.visibleEnemies,
          this.world.obstacles(state.obstacleCells),
          state.beacon.position,
          this.config.coreEvadeScoring === true ? "multi" : "distance",
        );
        if (direction !== null) {
          this.coreMoveDirection = direction;
          // 竞品 preemptive_evade_until_tick = tick + 2：敌人消失后仍持续 2 tick
          this.preemptiveEvadeUntilTick = state.tick + 2;
          intents.core = ttrTrigger ? "core_evade_ttr" : "core_evade";
          return { type: "START_MOVE", direction };
        }
      }
    }
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
    // 三阶段爆兵状态机（2026-08-06 用户导向"积累到一定程度开始爆兵"）：
    // 1. 积累期（surgeActive=false 且 res < 阈值）：只产 Worker 积累经济；
    // 2. 爆兵期（surgeActive=true）：持续全力产兵（交替 VANGUARD/RANGER，
    //    不受 militaryRatio 限制，人口上限内）——达标即激活并保持，直到
    //    资源连一个兵都产不起才回积累期（防止"产 1 兵掉回阈值下"振荡）；
    // 3. 前压期：军事规模达 attackForce 后由 decideVanguard 前压打水晶。
    // accumulateThreshold 缺省 0 = 关闭（历史行为：按 militaryRatio 随产随造）。
    const threshold = this.config.accumulateThreshold ?? 0;
    if (threshold > 0 && !this.surgeActive && state.resources >= threshold) {
      this.surgeActive = true;
    }
    const unitType = threshold > 0
      ? this.surgeActive
        ? nextMilitary(state, this.config)
        : "WORKER"
      : this.config.accumulateTarget > 0 &&
          state.resources >= this.config.guardResources &&
          military < this.config.guardForce
        ? nextMilitary(state, this.config)
        : nextSpawn(state, this.effectiveWorkerTarget, this.config);
    const cost = unitType === "WORKER" ? 5 : unitType === "VANGUARD" ? 10 : 12;
    const reserve = state.resources >= this.config.wealthyThreshold
      ? this.config.reserveWealthy
      : this.config.reserveEarly;
    if (state.resources < cost + reserve) {
      if (threshold > 0 && this.surgeActive) this.surgeActive = false;
      return null;
    }
    intents.core = `spawn_${unitType.toLowerCase()}`;
    return { type: "SPAWN", unitType };
  }
}

function nextSpawn(state: TickState, workerTarget: number, config: SafetyPlannerConfig): UnitType {
  if (state.workers.length < workerTarget) return "WORKER";
  return nextMilitary(state, config);
}

function nextMilitary(state: TickState, config: SafetyPlannerConfig): UnitType {
  const ratio = config.vanguardRatio;
  if (ratio === undefined) {
    return state.vanguards.length <= state.rangers.length ? "VANGUARD" : "RANGER";
  }
  const military = state.vanguards.length + state.rangers.length;
  // ceil((military+1)*ratio)：新兵计入后 VANGUARD 占比不超过 ratio 才产 VANGUARD。
  // （floor(military*ratio) 在 military=0 时恒 0——ratio=1 也错误产 RANGER。）
  const targetVanguards = Math.ceil((military + 1) * ratio);
  return state.vanguards.length < targetVanguards ? "VANGUARD" : "RANGER";
}

/** Core 的守家锚点：四邻中第一个非障碍格（确定性 UP→RIGHT→DOWN→LEFT）。
 *  军事单位守家站此格而非 Core 格本身——Core 格是 Worker 回仓通道，
 *  被长期占用会造成 capacity_wait:DEPOSIT 经济死锁。 */
function homeCell(core: Position, obstacles: ReadonlySet<string>, index = 0): Position | null {
  const order: readonly Direction[] = ["UP", "RIGHT", "DOWN", "LEFT"];
  for (let offset = 0; offset < order.length; offset += 1) {
    const dir = order[(index + offset) % order.length];
    const cell: Position = dir === "UP"
      ? [core[0], core[1] - 1]
      : dir === "RIGHT"
        ? [core[0] + 1, core[1]]
        : dir === "DOWN"
          ? [core[0], core[1] + 1]
          : [core[0] - 1, core[1]];
    if (!obstacles.has(cellKey(cell))) return cell;
  }
  return null;
}

function nearestEnemy(enemies: readonly VisibleEntity[], position: Position): VisibleEntity | null {
  return [...enemies].sort(
    (a, b) => manhattan(position, a.position) - manhattan(position, b.position) || a.id.localeCompare(b.id),
  )[0] ?? null;
}

/** Core 迁移方向（coreEvade，PRE_EVADE-lite）：4 方向候选中，硬块（障碍/资源/
 *  敌占格）排除；评分 = 最近敌距离（越大越好，无敌人 = 无穷）×1000 + beacon 距离
 *  （远离敌人优先、次远离 beacon——竞品 retreat 语义的确定性简化版）。
 *  coreEvadeScoring=true 时用多目标字典序（竞品 threat-response 对照）：
 *  投影伤害（候选格受敌射程内伤害总值，Vanguard sweep 1 格 / Ranger 直线 3 格）
 *  → 全敌距离升序向量字典序（远离所有敌，不只最近）→ beacon 距离（小优）。
 *  修复：旧评分只取 minEnemyDistance，退向"离最近敌最远"的方向可能冲进
 *  另一敌的射程（Ranger 3 格直线）。 */
const RANGER_SHOOT_RANGE = 3;
const VANGUARD_SWEEP_RANGE = 1;

/** 竞品投影伤害（rule-correct）：敌当前格可对候选格发动的合法攻击——
 *  Vanguard 仅邻格（Chebyshev 1，SWEEP）；Ranger 八方向直线 ≤3 且中间格
 *  无障碍（SHOOT，lineBlocked）。旧实现用 Manhattan ≤ range 代理：把
 *  (2,1) 非法线算 1 伤、无视障碍遮挡（2026-08-07 C6 对齐）。 */
function projectedDamageAt(
  target: Position,
  enemy: VisibleEntity,
  obstacles: ReadonlySet<string>,
): number {
  if (enemy.kind === "CORE") return 0;
  const distance = chebyshev(target, enemy.position);
  if (enemy.unitType === "RANGER") {
    if (distance === 0 || distance > RANGER_SHOOT_RANGE) return 0;
    return lineBlocked(target, enemy.position, obstacles) ? 0 : 1;
  }
  // VANGUARD / WORKER 近战：仅邻格可伤害
  return distance === VANGUARD_SWEEP_RANGE ? 1 : 0;
}

function retreatDirection(
  core: Position,
  enemies: readonly VisibleEntity[],
  obstacles: ReadonlySet<string>,
  beacon: Position,
  scoring: "distance" | "multi" = "distance",
): Direction | null {
  const candidates: readonly Direction[] = ["UP", "RIGHT", "DOWN", "LEFT"];
  let best: Direction | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestVector: readonly number[] = [];
  let bestBeacon = 0;
  for (const direction of candidates) {
    const destination: Position =
      direction === "UP"
        ? [core[0], core[1] - 1]
        : direction === "RIGHT"
          ? [core[0] + 1, core[1]]
          : direction === "DOWN"
            ? [core[0], core[1] + 1]
            : [core[0] - 1, core[1]];
    if (obstacles.has(cellKey(destination))) continue;
    if (enemies.some((enemy) => samePosition(enemy.position, destination))) continue;
    if (scoring === "distance") {
      const minEnemyDistance =
        enemies.length === 0
          ? Number.POSITIVE_INFINITY
          : Math.min(...enemies.map((enemy) => manhattan(destination, enemy.position)));
      const score = minEnemyDistance * 1000 + manhattan(destination, beacon);
      if (score > bestScore) {
        bestScore = score;
        best = direction;
      }
      continue;
    }
    // 多目标评分（coreEvadeScoring）：投影伤害 → 全敌距离升序向量 → beacon。
    const projectedDamage = enemies.reduce((sum, enemy) => {
      return sum + projectedDamageAt(destination, enemy, obstacles);
    }, 0);
    const distanceVector = enemies
      .map((enemy) => manhattan(destination, enemy.position))
      .sort((a, b) => a - b);
    const beaconDistance = manhattan(destination, beacon);
    // 字典序：投影伤害小优 → 敌距向量大优 → beacon 小优。
    if (
      best === null ||
      compareRetreat(projectedDamage, distanceVector, beaconDistance, bestScore, bestVector, bestBeacon) > 0
    ) {
      bestScore = projectedDamage;
      bestVector = distanceVector;
      bestBeacon = beaconDistance;
      best = direction;
    }
  }
  return best;
}

/** 多目标字典序比较（竞品 retreat 语义）：投影伤害（小优）→ 全敌距离升序向量
 *  （大优）→ beacon 距离（小优）。返回 >0 表示 candidate 优于 incumbent。 */
function compareRetreat(
  candidateDamage: number,
  candidateVector: readonly number[],
  candidateBeacon: number,
  incumbentDamage: number,
  incumbentVector: readonly number[],
  incumbentBeacon: number,
): number {
  if (candidateDamage !== incumbentDamage) return incumbentDamage - candidateDamage;
  const length = Math.max(candidateVector.length, incumbentVector.length);
  for (let index = 0; index < length; index += 1) {
    const a = candidateVector[index] ?? 0;
    const b = incumbentVector[index] ?? 0;
    if (a !== b) return a - b;
  }
  return incumbentBeacon - candidateBeacon;
}

/** 激进射击目标优先级：断敌经济（WORKER）优先，其次远程单位，最后 Core。
 *  排序稳定：同优先级按 raw id 字典序（nearestEnemy 的调用方约束）。 */
/** 激进射击目标优先级（纯类型价值）：断敌经济（WORKER 优先），同价值 raw id 序。 */
function aggressiveShotPriority(a: VisibleEntity, b: VisibleEntity): number {
  return shotTargetRank(a) - shotTargetRank(b) || a.id.localeCompare(b.id);
}

/** 防守射击目标优先级：最近威胁优先（1 格外的 Vanguard 即将 sweep 我们），
 *  同距离再按威胁价值（RANGER 优先——远程火力 3 格持续威胁；再 VANGUARD 近战；
 *  WORKER 最后——不构成即时威胁，断经济是进攻姿态的事，2026-08-06 竞品
 *  hierarchical threat assessment 对照），最后 raw id 序（确定性）。 */
function defensiveShotPriority(from: Position, a: VisibleEntity, b: VisibleEntity): number {
  return (
    manhattan(from, a.position) - manhattan(from, b.position) ||
    defensiveShotTargetRank(a) - defensiveShotTargetRank(b) ||
    a.id.localeCompare(b.id)
  );
}

/** 防守威胁价值（低 = 优先）：RANGER 远程持续威胁 > VANGUARD 近战 > WORKER 无即时威胁。 */
function defensiveShotTargetRank(enemy: VisibleEntity): number {
  if (enemy.kind === "CORE") return 3;
  return enemy.unitType === "RANGER" ? 0 : enemy.unitType === "VANGUARD" ? 1 : 2;
}

/** 进攻目标价值（低 = 优先）：断敌经济（WORKER 优先），同价值 raw id 序。 */
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
