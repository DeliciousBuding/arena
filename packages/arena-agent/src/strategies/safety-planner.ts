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
import {
  assessThreat,
  coreDamagedThisTick,
  projectedDamageOnCore,
  type ThreatAssessment,
} from "../domain/threat.ts";
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
   * Core 迁移 approach 记忆持续（v0.3，实验，B9 竞品 "approach memory
   * expires" 对照，需 coreEvade=true）：closing/TTR 触发迁移后敌人消失时，
   * 迁移意图从固定 2 tick 扩展为"approach 记忆未过期"（6 tick 内曾见
   * 12 格内敌——closing 记忆，仅"曾逼近"才算 approach，远距路过不算）
   * ——防"敌人被击退出 12 格 → 2 tick 恢复 → 敌人折返 → 再触发"的迁移
   * 抖动（竞品 "Preserve migration through short visibility loss" /
   * "Returns to ALERT after the approach memory expires"）。代价：敌人
   * 死亡等"不再回来"场景会白迁移至记忆过期（迁移中不生产/heal）。
   * 默认 false = 历史 2 tick 行为（零回归）。
   */
  readonly coreEvadePersist?: boolean;
  /**
   * 迁移取消（B9 候选，竞品 _moving_core_should_cancel 对照）：MOVING 中
   * 目的地为硬块（障碍/资源/敌占）或投影伤害劣于当前格时发 CANCEL_MOVE
   * （Core 回 NORMAL）——避免走完 4 tick 失败或继续走进敌阵。默认 false =
   * 历史行为（MOVING 直接 return，零回归）。
   */
  readonly coreMigrationCancel?: boolean;
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
  /**
   * 防御轴分桶守卫轮转（v0.3，实验，B4 竞品 defense distribution 对照）：
   * 可见战斗敌按相对 Core 的主接近方向分 4 轴桶（N/E/S/W），威胁轴按
   * 最近敌距离升序排序；第 i 个防守者取排序后第 (i % 轴数) 轴的外层守位
   * （Vanguard 3 格外层 / Ranger 2 格内层）——守卫按轴分散而非全部挤向
   * 最近敌方向，多轴夹击时各轴都有拦截。守位避开障碍/敌占格，保持 Core
   * 邻格为空（cargo 通道）。默认 false = 历史行为（Core 四邻轮转）。
   */
  readonly guardAxes?: boolean;
  /**
   * 守卫轮换治疗（v0.3，实验，B8 竞品 healing rotation 对照）：defensive
   * 守卫受伤（Vanguard ≤2/4、Ranger ≤1/2——掉血过半）且无反击压力（敌不在
   * 守卫反击射程内）时，主动回 Core 格补血——治疗完满血由守位锚点逻辑移出
   * 回守位（闭环）。战斗中的守卫不回修（邻格 SWEEP/射程射击优先——C7 反击
   * 优先已覆盖）。默认 false = 历史行为（带伤值守到死/永不回修，零回归）。
   */
  readonly guardHealRotation?: boolean;
  /**
   * 远端突击组局部响应（v0.3，实验，B5 竞品 detached squad response 对照）：
   * aggressive 突击单位前压时，敌**非目标**战斗单位进入 5 格局部响应半径
   * = 突击组被拦截——释放旧任务、回 Core 守位至少 8 tick（防抖动记忆），
   * Core 不迁移（局部冲突不拖 Core 过图）。返回期间邻接敌仍 SWEEP 反击
   * （反击优先）。8 tick 后任务目标仍在则恢复前压。默认 false = 历史行为
   * （被拦截时无视拦截继续压任务送死，零回归）。
   */
  readonly detachedSquadResponse?: boolean;
  /**
   * 有界攻坚（v0.3，实验，B6 竞品 "exceeds the bounded mission distance"
   * 对照）：aggressive 敌 Core 记忆推进时，记忆位置距我方 Core 超上限
   * （40 格 Chebyshev）= 远征送死（补给线长、守军集火、被端概率高）——
   * 取消攻坚回 Core 守位（竞品 Withdraw 条件之一）。可见敌人/近距记忆
   * 不受影响。默认 false = 历史行为（记忆多远推多远，零回归）。
   */
  readonly boundedRaid?: boolean;
  /**
   * 守卫预留（B7，实验，竞品 _strike_group_ids 对照）：aggressive 攻坚
   * （敌 Core 记忆推进）时按 id 排序保留 1 个 Vanguard 守家（官方拆家
   * 留守卫 VANGUARD_CORE_GUARDS=1 防换家/反打——家不空防），其余全压
   * 拆家。默认 false = 历史行为（全压，零回归）。
   */
  readonly strikeGroupReserve?: boolean;
  /**
   * worker 遭遇撤离（v0.3，实验，B10 竞品 "Scout And Observer Response"
   * 对照）：空 worker 视野内（3 格）出现战斗单位（VANGUARD/RANGER）时，
   * 撤离回 Core（EVADE+RETURN 合一——向 Core 步进即远离敌人，敌占格
   * 视为硬块绕开）——接触丢失后仍继续回 Core（不恢复旧巡逻线），到
   * Core 3 格内冷却 3 tick 再恢复巡逻（防敌人尾随立即再逃）。满载
   * worker 走既有 return_home（已回 Core）。默认 false = 历史行为
   * （worker 见敌仍 harvest/巡逻，零回归）。
   */
  readonly scoutEvade?: boolean;
  /**
   * Ranger 记忆射击（v0.3，实验，B12 竞品 strategy.md "A strike Ranger
   * may also fire at the remembered cell of a confirmed stationary Core
   * during a short visibility gap" 对照）：aggressive Ranger 无可见目标
   * 时，对"确认静止"的敌 Core 记忆格射击（射程内 cell-fire，targetId
   * null）——短暂视野丢失不浪费射程压制（Vanguard memory 推进的
   * Ranger 版：Vanguard 走向记忆，Ranger 打记忆）。默认 false = 历史
   * 行为（无可见目标时移动/守位，零回归）。
   */
  readonly rangerMemoryShot?: boolean;
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
/** B9 迁移取消冷却（coreMigrationCancel）：取消后 N tick 内不重触发 START_MOVE。 */
const CORE_MIGRATION_CANCEL_COOLDOWN = 10;
/** 守卫轮换治疗（B8 候选）：HP ≤ 该值即回 Core 补血（掉血过半）。 */
const HEAL_ROTATION_HP: Record<UnitType, number> = { WORKER: 1, VANGUARD: 2, RANGER: 1 };
/** 守卫"战斗中不回修"的反击范围（敌进入守卫反击射程 = 战斗压力，带伤值守）。 */
const HEAL_ROTATION_ENGAGE_RANGE: Record<UnitType, number> = { WORKER: 1, VANGUARD: 1, RANGER: 3 };
/** B8 守卫轮换 one-at-a-time（竞品 "one wounded defender at a time"）：
 *  触发回修后该守卫占用回修名额的 tick 窗口（路上 + 补血）。 */
const HEAL_ROTATION_HOLD_TICKS = 12;
/** B5 远端突击组局部响应（竞品 detached squad）：敌非目标单位进入 5 格 = 被拦截。 */
const DETACHED_RESPONSE_RADIUS = 5;
/** 被拦截后回 Core 守位的最少 tick（竞品 "at least eight Ticks"）。 */
const DETACHED_RETURN_TICKS = 8;
/** B6 有界攻坚（竞品 bounded mission distance）：记忆敌 Core 距我方 Core 上限。 */
const BOUNDED_RAID_DISTANCE = 40;
/** B10 worker 遭遇撤离（竞品 Scout And Observer Response）：撤离触发半径。 */
const SCOUT_EVADE_RADIUS = 3;
/** 到 Core 3 格内后的冷却 tick（竞品 three-Tick cooldown）。 */
const SCOUT_COOLDOWN_TICKS = 3;
/** 到达即进入冷却的 Core 距离（竞品 within three cells）。 */
const SCOUT_HOME_RADIUS = 3;

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
  /** B9 迁移取消冷却（coreMigrationCancel）：取消后 N tick 内不重触发
   *  START_MOVE——防"退路危险 → 取消 → 立即重触发 → 再取消"的每 tick
   *  振荡（实验实证：core-evade-danger 场景 START/CANCEL 各 200 次）。 */
  private coreMigrationCancelUntilTick = 0;
  /** PRE_EVADE 持续截止 tick（竞品 preemptive_evade_until_tick = tick + 2）：
   *  触发迁移后即使敌人消失，2 tick 内仍保持迁移意图（防止"敌人闪失 →
   *  立刻取消"抖动）。 */
  private preemptiveEvadeUntilTick = 0;
  /** MOVE_FAILED 连续失败计数（moveFailedAvoidance）：单位连续 N tick 移动被
   *  结算拒绝时改走垂直绕行格，避免无反馈重试同格死循环。 */
  private moveFailedStreak = new Map<string, number>();
  /** 本 tick 威胁评估（threatBreakout 用）：decide 入口计算一次供 worker 消费。 */
  private currentThreat: ThreatAssessment | null = null;
  /** B5 突击组被拦截后的返回截止 tick（unitId → tick；8-tick 防抖动记忆）。 */
  private detachedReturnUntil = new Map<string, number>();
  /** B10 worker 遭遇撤离状态（unitId → 返回截止/冷却截止 tick）。 */
  private scoutEvadeState = new Map<string, { returnUntil: number; cooldownUntil: number }>();
  /** B8 守卫轮换 one-at-a-time：回修流程中的守卫（unitId → 名额占用截止 tick）。 */
  private healRotationActive = new Map<string, number>();
  /** C2 RECOVERY：上次见到的我方 Core id（全新 UUID = 重生/替换 → 清战场记忆）。 */
  private lastCoreId: string | null = null;
  /** C2 RECOVERY 触发次数（telemetry/测试可读）。 */
  coreRecoveryCount = 0;
  /** C2 RECOVERY 事件日志（telemetry/测试可读；正常对局为空）。 */
  readonly recoveryLog: string[] = [];

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
    // C2 RECOVERY（竞品 lifecycle overlay 对照，2026-08-07）：Core 重生 =
    // 全新 UUID 替换（引擎 P12 respawn：CORE_DESTROYED + CORE_RESPAWNED，
    // 新 Core 20-30 格重生 + 全新 Worker）。旧追击积分/巡逻扇区基于旧 Core
    // 坐标系，重生后失真 → 先清战场记忆再 observe（observe 用新 Core 位置
    // 写入正确记忆）。绝对坐标地图事实（障碍/资源/chunk）保留。正常对局
    // Core id 不变 → 零变化（生产 t1/t2 无对手不重生，零回归）。
    if (state.core !== null && this.lastCoreId !== null && state.core.id !== this.lastCoreId) {
      const cleared = this.world.clearBattlefieldMemory();
      this.coreRecoveryCount += 1;
      this.recoveryLog.push(`tick ${state.tick}: core ${this.lastCoreId.slice(0, 8)} → ${state.core.id.slice(0, 8)}，清战场记忆 ${cleared} 条`);
    }
    if (state.core !== null) this.lastCoreId = state.core.id;
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
        obstacles: this.world.obstacles(state.obstacleCells),
        resourceCells: state.resourceCells,
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
    const rangerIndex = new Map(
      [...state.units]
        .filter((unit) => unit.unitType === "RANGER")
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
        this.decideRanger(state, unit, rangerIndex.get(unit.id) ?? 0, obstacles, enemies, set);
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

    // B10 worker 遭遇撤离（scoutEvade 候选，竞品 Scout And Observer
    // Response 对照）：空 worker 视野内（3 格）出现战斗单位 → 撤离回
    // Core（EVADE+RETURN 合一——向 Core 步进即远离敌人，敌占格视为
    // 硬块绕开）——接触丢失后仍持续回 Core（persistent return flow，
    // 不恢复旧巡逻线），到 Core 3 格内冷却 3 tick 再恢复（防敌人尾随
    // 立即再逃）；冷却到期清除状态。
    if (this.config.scoutEvade === true && home !== null) {
      const threatened = state.visibleEnemies.some(
        (enemy) =>
          enemy.kind === "UNIT" &&
          enemy.unitType !== "WORKER" &&
          manhattan(unit.position, enemy.position) <= SCOUT_EVADE_RADIUS,
      );
      if (threatened) {
        this.scoutEvadeState.set(unit.id, {
          returnUntil: Number.POSITIVE_INFINITY,
          cooldownUntil: 0,
        });
      }
      const evade = this.scoutEvadeState.get(unit.id);
      if (evade !== undefined) {
        // 冷却到期 → 清除状态，恢复正常巡逻/采集
        if (evade.cooldownUntil > 0 && evade.cooldownUntil <= state.tick) {
          this.scoutEvadeState.delete(unit.id);
        } else if (evade.cooldownUntil > state.tick) {
          set(unit, { type: "WAIT" }, "worker_evade_cooldown");
          return;
        } else if (manhattan(unit.position, home) <= SCOUT_HOME_RADIUS) {
          // 撤离流中到达 Core 3 格内 → 进入冷却（防尾随立即再逃）
          this.scoutEvadeState.set(unit.id, {
            returnUntil: Number.POSITIVE_INFINITY,
            cooldownUntil: state.tick + SCOUT_COOLDOWN_TICKS,
          });
          set(unit, { type: "WAIT" }, "worker_evade_cooldown");
          return;
        } else {
          // 敌占格视为硬块（竞品 enemy-occupied cells remain hard blocks）
          const evadeObstacles = new Set(movementObstacles);
          for (const enemy of state.visibleEnemies) {
            if (enemy.kind === "UNIT" && enemy.unitType !== "WORKER") {
              evadeObstacles.add(cellKey(enemy.position));
            }
          }
          const direction = stepToward(unit.position, home, evadeObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "worker_evade_return");
          return;
        }
      }
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
    // 军事单位绕开自家 Core 格（2026-08-07 生产 t2 实证）：Core 格是
    // Worker 回仓/SPAWN 出生通道——军事单位穿越（如让位回归路径穿过
    // Core 格）会与同 tick SPAWN 冲突 CELL_UNIT_LIMIT → 每 2 tick 一次
    // spawn 失败循环（单 run 26 次）。回 Core 的接近目标 = Core 邻格
    // （homeCell——Core 格本身是军事禁区）；四邻全堵回退 Core 格。
    const militaryObstacles = state.core === null
      ? movementObstacles
      : new Set([...movementObstacles, cellKey(state.core.position)]);
    const approachTarget = state.core === null
      ? null
      : homeCell(state.core.position, militaryObstacles, index) ?? state.core.position;
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
        const home = state.core === null ? null : homeCell(state.core.position, militaryObstacles, index);
        if (home !== null && !samePosition(unit.position, home)) {
          const direction = stepToward(unit.position, home, militaryObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_hold");
        }
        return;
      }
      // B7 守卫预留（strikeGroupReserve 候选，竞品 _strike_group_ids 对照）：
      // 攻坚时按 id 排序保留 1 个 Vanguard 守家（官方拆家留守卫
      // VANGUARD_CORE_GUARDS=1 防换家/反打），其余全压拆家——家不空防。
      const reserveGuard =
        this.config.strikeGroupReserve === true &&
        state.vanguards.length >= 2 &&
        [...state.vanguards].map((v) => v.id).sort().at(-1) === unit.id;
      if (reserveGuard) {
        const home = state.core === null ? null : homeCell(state.core.position, militaryObstacles, index);
        if (home !== null && !samePosition(unit.position, home)) {
          const direction = stepToward(unit.position, home, militaryObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_home_guard");
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
          // B6 有界攻坚（boundedRaid 候选，竞品 "exceeds the bounded mission
          // distance" → withdraw）：记忆中的敌 Core 距我方 Core 超上限（40 格）
          // = 远征送死（补给线长、守军集火）——取消攻坚回 Core 守位。
          if (
            this.config.boundedRaid === true &&
            chebyshev(state.core.position, enemyCoreMemory.position) > BOUNDED_RAID_DISTANCE
          ) {
            const direction = stepToward(unit.position, approachTarget ?? state.core.position, militaryObstacles);
            if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_bounded_return");
            return;
          }
          const direction = stepToward(unit.position, enemyCoreMemory.position, militaryObstacles);
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
        const direction = stepToward(unit.position, patrolPoint, militaryObstacles);
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
      // B5 远端突击组局部响应（detachedSquadResponse 候选，竞品对照）：
      // 敌**非目标**战斗单位进入 5 格响应半径 = 突击组被拦截——释放旧任务、
      // 回 Core 守位至少 8 tick（防抖动记忆：8 tick 内敌消失也继续返回）。
      // Core 不迁移（局部冲突不拖 Core 过图）；返回期间邻接敌由函数开头
      // SWEEP 分支反击（反击优先）。8 tick 后任务目标仍在则恢复前压。
      if (this.config.detachedSquadResponse === true) {
        const returnUntil = this.detachedReturnUntil.get(unit.id) ?? 0;
        if (state.tick < returnUntil) {
          const direction = stepToward(unit.position, approachTarget ?? state.core!.position, militaryObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_detached_return");
          return;
        }
        const intercepted = enemies.some(
          (enemy) =>
            enemy.kind !== "CORE" &&
            (target === null || !samePosition(enemy.position, target)) &&
            manhattan(unit.position, enemy.position) <= DETACHED_RESPONSE_RADIUS,
        );
        if (intercepted && state.core !== null) {
          this.detachedReturnUntil.set(unit.id, state.tick + DETACHED_RETURN_TICKS);
          const direction = stepToward(unit.position, approachTarget ?? state.core.position, militaryObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_detached_return");
          return;
        }
      }
      if (target !== null && !samePosition(unit.position, target)) {
        const stuckTicks = this.moveFailedStreak.get(unit.id) ?? 0;
        const direction =
          this.config.moveFailedAvoidance === true && stuckTicks >= 2
            ? detourDirection(unit.position, target, militaryObstacles)
            : stepToward(unit.position, target, militaryObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_pressure");
      }
      return;
    }

    // B8 守卫轮换治疗（guardHealRotation 候选）：defensive 守卫受伤（HP 过半
    // 以下）且无反击压力（敌不在守卫反击射程内）时回 Core 补血——到达后主循环
    // HEAL 分支接管，满血后守位锚点逻辑移出回守位（闭环）。战斗中的守卫不回修：
    // 邻格 SWEEP 反击优先（C7 已覆盖——SWEEP 分支在本函数更早处）。已在 Core
    // 格时不重复 MOVE（HEAL 分支直接治疗）。
    // B8 one-at-a-time（竞品 "one wounded defender at a time"）：同类型守卫
    // 已有回修流程中的（名额占用未过期）→ 本守卫不触发——防多守卫同时离位
    // /同占 Core 格（防线真空）；满血即释放名额。
    if (unit.hp > HEAL_ROTATION_HP[unit.unitType]) {
      this.healRotationActive.delete(unit.id);
    }
    if (
      this.config.guardHealRotation === true &&
      this.effectiveAggression === "defensive" &&
      state.core !== null &&
      unit.hp <= HEAL_ROTATION_HP[unit.unitType] &&
      !state.vanguards.some(
        (other) =>
          other.id !== unit.id && (this.healRotationActive.get(other.id) ?? 0) > state.tick,
      ) &&
      !enemies.some(
        (enemy) =>
          enemy.kind !== "CORE" &&
          chebyshev(unit.position, enemy.position) <= HEAL_ROTATION_ENGAGE_RANGE[unit.unitType],
      ) &&
      !samePosition(unit.position, state.core.position)
    ) {
      this.healRotationActive.set(unit.id, state.tick + HEAL_ROTATION_HOLD_TICKS);
      const direction = stepToward(unit.position, approachTarget ?? state.core.position, militaryObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, "guard_heal_return");
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
        const direction = stepToward(unit.position, blockingEnemy.position, militaryObstacles);
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
    // 守家/回防锚点（绝不站 Core 格本身——Core 格是 Worker 回仓通道，被军事
    // 单位长期占用会造成 capacity_wait:DEPOSIT 经济死锁，生产实测）。
    // guardAxes（B4 候选）：有可见敌人时按威胁轴分桶守位（Vanguard 3 格外层
    // 屏、Ranger 2 格内层屏），守卫分散到各威胁轴；无敌人回退历史四邻轮转。
    let home: Position | null = null;
    if (state.core !== null) {
      home =
        this.config.guardAxes === true && enemies.length > 0
          ? defensePost(state.core.position, enemies, movementObstacles, "VANGUARD", index)
          : homeCell(state.core.position, movementObstacles, index);
    }
    // 已在 Core 格且满血：移出到让位锚点（yieldAnchor——与 Ranger 同，
    // 避开被占格；t2 实证：Core 四邻全堵时 homeCell 选到满格 → 预裁决
    // 淘汰让位 → 死锁。治疗是短时占格，治疗完必须让出回仓通道）
    if (
      state.core !== null &&
      unit.hp >= UNIT_MAX_HP[unit.unitType] &&
      samePosition(unit.position, state.core.position)
    ) {
      const yieldTarget = yieldAnchor(state.core.position, movementObstacles, occupancyCounts(state), state.visibleEnemies);
      if (yieldTarget !== null && !samePosition(unit.position, yieldTarget)) {
        const direction = stepToward(unit.position, yieldTarget, militaryObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_home");
        return;
      }
      // 同 Ranger：无合法让位目标原地等，不 fall through 到守位
      return;
    }
    // focusRegion：无敌人时朝策略聚焦区推进（侦察/占位），否则回守家锚点或追击邻近敌人
    const focus = this.effectivePolicy?.focusRegion ?? null;
    const target = nearby.length > 0
      ? nearestEnemy(nearby, unit.position)?.position ?? null
      : focus ?? home;
    if (target !== null && !samePosition(unit.position, target)) {
      const direction = stepToward(unit.position, target, militaryObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_move");
    }
  }

  private decideRanger(
    state: TickState,
    unit: UnitSnapshot,
    index: number,
    obstacles: ReadonlySet<string>,
    enemies: readonly VisibleEntity[],
    set: (unit: UnitSnapshot, action: UnitAction, intent: string) => void,
  ): void {
    const movementObstacles = this.world.movementObstacles(unit.id, obstacles);
    // 与 Vanguard 同：军事单位绕开自家 Core 格（生产/SPAWN 通道，见
    // decideVanguard 注释）——让位回归路径不穿越 Core 格。
    const militaryObstacles = state.core === null
      ? movementObstacles
      : new Set([...movementObstacles, cellKey(state.core.position)]);
    const approachTarget = state.core === null
      ? null
      : homeCell(state.core.position, militaryObstacles, index) ?? state.core.position;

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

    // B12 Ranger 记忆射击（rangerMemoryShot 候选，竞品 strategy.md
    // "A strike Ranger may also fire at the remembered cell of a confirmed
    // stationary Core during a short visibility gap"）：aggressive Ranger
    // 无可见目标时，对"确认静止"（两次观察同位置）的敌 Core 记忆格
    // cell-fire（射程内）——短暂视野丢失不浪费射程压制（Vanguard memory
    // 推进的 Ranger 版：Vanguard 走向记忆，Ranger 打记忆）。
    if (this.config.rangerMemoryShot === true && this.effectiveAggression === "aggressive") {
      const coreMemory = this.world.enemyHints(60).find(
        (hint) =>
          hint.kind === "CORE" &&
          hint.prevPosition !== undefined &&
          samePosition(hint.prevPosition, hint.position),
      );
      if (coreMemory !== undefined && canShoot(unit.position, coreMemory.position, obstacles)) {
        set(
          unit,
          { type: "SHOOT", targetId: null, expectedCell: coreMemory.position },
          "ranger_memory_shot",
        );
        return;
      }
    }

    // B8 守卫轮换治疗（guardHealRotation 候选）：defensive Ranger 受伤且无射程
    // 内敌（射击分支已优先处理——有敌就打，C7 反击优先）时回 Core 补血。
    // 治疗完满血由守位锚点逻辑移出回守位（闭环）。one-at-a-time（竞品
    // "one wounded defender at a time"）：同类型守卫已有回修流程中的 →
    // 本守卫不触发（防多守卫同时离位/同占 Core 格 → 防线真空）。
    if (unit.hp > HEAL_ROTATION_HP[unit.unitType]) {
      this.healRotationActive.delete(unit.id);
    }
    if (
      this.config.guardHealRotation === true &&
      this.effectiveAggression === "defensive" &&
      state.core !== null &&
      unit.hp <= HEAL_ROTATION_HP[unit.unitType] &&
      !state.rangers.some(
        (other) =>
          other.id !== unit.id && (this.healRotationActive.get(other.id) ?? 0) > state.tick,
      ) &&
      !enemies.some(
        (enemy) =>
          enemy.kind !== "CORE" &&
          chebyshev(unit.position, enemy.position) <= HEAL_ROTATION_ENGAGE_RANGE[unit.unitType],
      ) &&
      !samePosition(unit.position, state.core.position)
    ) {
      this.healRotationActive.set(unit.id, state.tick + HEAL_ROTATION_HOLD_TICKS);
      const direction = stepToward(unit.position, approachTarget ?? state.core.position, militaryObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, "guard_heal_return");
      return;
    }

    // guardAxes（B4 候选）：defensive + 有可见敌人时 Ranger 守内层屏
    // （2 格）而非追击最近敌（竞品"defenders do not chase beyond the
    // protective posture"——Ranger 冲脸失去射程优势且易被 SWEEP）。
    const guardAxesPost =
      this.config.guardAxes === true &&
      this.effectiveAggression === "defensive" &&
      state.core !== null
        ? defensePost(state.core.position, enemies, movementObstacles, "RANGER", index)
        : null;
    // 守家锚点（绝不站 Core 格本身——Core 格是 Worker 回仓通道，被军事
    // 单位长期占用会造成 capacity_wait:DEPOSIT 经济死锁，生产实测 t2）。
    // guardAxes（B4 候选）有可见敌人时按威胁轴守内层屏（2 格，天然保持
    // Core 邻格为空）；无敌人回退历史四邻轮转。
    const home = state.core === null
      ? null
      : guardAxesPost ?? homeCell(state.core.position, movementObstacles, index);
    // 已在 Core 格且满血：移出到让位锚点（yieldAnchor——优先空邻格、其次
    // 单占用邻格（可挤入，容量 2）；Core 四邻全堵（障碍+单位）时 homeCell
    // 会选到满格 → 预裁决淘汰让位 → Ranger 永不离开 → worker 永不
    // deposit → 经济死锁（t2 实证）。治疗是短时占格，治疗完必须让出）
    if (
      state.core !== null &&
      unit.hp >= UNIT_MAX_HP[unit.unitType] &&
      samePosition(unit.position, state.core.position)
    ) {
      const yieldTarget = yieldAnchor(state.core.position, movementObstacles, occupancyCounts(state), state.visibleEnemies);
      if (yieldTarget !== null && !samePosition(unit.position, yieldTarget)) {
        const direction = stepToward(unit.position, yieldTarget, militaryObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "ranger_home");
        return;
      }
      // 无合法让位目标（Core 四邻全堵且全满）：原地等下一 tick 重试——
      // 不 fall through 到守位（守位目标可能在 Core 邻格满格 → 预裁决
      // 淘汰 → MOVE_FAILED 循环）。
      return;
    }
    const moveTarget = enemies.length > 0
      ? guardAxesPost ?? nearestEnemy(enemies, unit.position)?.position ?? null
      : this.effectivePolicy?.focusRegion ?? home;
    if (moveTarget !== null && !samePosition(unit.position, moveTarget)) {
      // 激进：保持 1-3 射程站定，不冲脸（近身会让 Ranger 失去射程优势且易被
      // SWEEP）。已在射程内但没有合法射击目标（被障碍挡住）时原地待机。
      const distance = manhattan(unit.position, moveTarget);
      const keepRange = this.effectiveAggression === "aggressive" && distance <= 3;
      if (!keepRange) {
        const direction = stepToward(unit.position, moveTarget, militaryObstacles);
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
      // B9 迁移取消候选（coreMigrationCancel，竞品 _moving_core_should_cancel
      // 对照）：目的地为硬块（障碍/资源/敌占）或投影伤害劣于当前格时发
      // CANCEL_MOVE（Core 回 NORMAL）——避免走完 4 tick 后失败或继续走进
      // 敌阵。TickState 的 CoreSnapshot 不带 destination——用迁移方向推断
      // 下一格（近似竞品"目的地"判定；迁移路径上任何一步危险即止损）。
      // 例行 cargo/heal/repair 不取消（竞品同语义）。
      if (this.config.coreMigrationCancel === true && this.coreMoveDirection !== null) {
        const nextCell = move(core.position, this.coreMoveDirection);
        const nextKey = cellKey(nextCell);
        const hardBlocked =
          state.obstacleCells.has(nextKey) ||
          state.resourceCells.has(nextKey) ||
          state.visibleEnemies.some((enemy) => samePosition(enemy.position, nextCell));
        const currentDamage = projectedDamageOnCore(core.position, state.visibleEnemies, state.obstacleCells);
        const nextDamage = projectedDamageOnCore(nextCell, state.visibleEnemies, state.obstacleCells);
        if (hardBlocked || nextDamage > currentDamage) {
          this.coreMigrationCancelUntilTick = state.tick + CORE_MIGRATION_CANCEL_COOLDOWN;
          intents.core = hardBlocked ? "migration_cancel_blocked" : "migration_cancel_danger";
          return { type: "CANCEL_MOVE" };
        }
      }
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
        obstacles: this.world.obstacles(state.obstacleCells),
        resourceCells: state.resourceCells,
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
      // B9（coreEvadePersist 候选，竞品 "approach memory expires" 对照）：
      // closing/TTR 触发后敌人消失时，迁移意图从固定 2 tick 扩展为
      // "approach 记忆未过期"（6 tick 内曾见 12 格内敌——closing 记忆，
      // 仅"曾逼近"才算 approach，远距路过不算）——防"敌人被击退出
      // 12 格 → 2 tick 恢复 → 敌人折返 → 再触发"的迁移抖动（竞品
      // "Preserve migration through short visibility loss"）。
      const approachMemoryActive =
        this.config.coreEvadePersist === true &&
        this.world
          .enemyHints(6)
          .some((hint) => hint.coreDistance !== undefined && hint.coreDistance <= THREAT_RECALL_DISTANCE);
      const preemptivePersist = approachMemoryActive || this.preemptiveEvadeUntilTick >= state.tick;
      const cancelCooldownActive = this.coreMigrationCancelUntilTick >= state.tick;
      if ((closing || confirmedPursuit || ttrTrigger || preemptivePersist) && !cancelCooldownActive) {
        const direction = retreatDirection(
          core.position,
          state.visibleEnemies,
          this.world.obstacles(state.obstacleCells),
          state.beacon.position,
          this.config.coreEvadeScoring === true ? "multi" : "distance",
        );
        if (direction !== null) {
          this.coreMoveDirection = direction;
          // 竞品 preemptive_evade_until_tick = tick + 2：敌人消失后仍持续
          // 2 tick。仅在真实触发时刷新窗口——persist 分支（preemptivePersist
          // 单独为真）不刷新：否则每次 persist 都顺延窗口 = 触发一次
          // closing 后永久迁移、永不恢复生产（2026-08-07 修复，滚动窗口 bug）。
          if (closing || confirmedPursuit || ttrTrigger) {
            this.preemptiveEvadeUntilTick = state.tick + 2;
          }
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
/** 防御轴分桶守卫轮转（B4 竞品 defense distribution 对照，2026-08-07）：
 *  可见战斗敌按相对 Core 的主接近方向分 4 轴桶（N/E/S/W）；威胁轴按"轴内
 *  最近敌距离升序"排序（威胁大的轴先被覆盖），第 i 个防守者取排序后第
 *  (i % 轴数) 轴的外层守位——守卫按轴分散而非全部挤向最近敌方向。
 *  守位半径：Vanguard 3（外层屏）/ Ranger 2（内层屏，竞品
 *  VANGUARD_GUARD_RADIUS=3 / RANGER_GUARD_RADIUS=2）。保持 Core 邻格为空
 *  （cargo 通道）——半径 ≥2 天然满足；守位被障碍/敌占占用时沿轴向内收缩
 *  （radius-1 直到 1），全堵返回 null（调用方回退 homeCell 历史四邻轮转）。 */
const VANGUARD_GUARD_RADIUS = 3;
const RANGER_GUARD_RADIUS = 2;

/** 敌相对 Core 的主接近方向轴（4 桶，确定性：|dx| 与 |dy| 比较）。 */
type ThreatAxis = "N" | "E" | "S" | "W";

function axisOfDelta(dx: number, dy: number): ThreatAxis {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "E" : "W";
  return dy >= 0 ? "S" : "N";
}

const AXIS_DIRECTIONS: Readonly<Record<ThreatAxis, Position>> = Object.freeze({
  N: [0, -1],
  E: [1, 0],
  S: [0, 1],
  W: [-1, 0],
});
const AXIS_ORDER: readonly ThreatAxis[] = ["N", "E", "S", "W"];

function defensePost(
  core: Position,
  enemies: readonly VisibleEntity[],
  obstacles: ReadonlySet<string>,
  unitType: "VANGUARD" | "RANGER",
  index: number,
): Position | null {
  // 每轴最近敌距离（无可见敌在该轴 = Infinity → 该轴不参与）
  const axisMinDistance: Record<ThreatAxis, number> = {
    N: Number.POSITIVE_INFINITY,
    E: Number.POSITIVE_INFINITY,
    S: Number.POSITIVE_INFINITY,
    W: Number.POSITIVE_INFINITY,
  };
  for (const enemy of enemies) {
    if (enemy.kind === "CORE") continue;
    const axis = axisOfDelta(enemy.position[0] - core[0], enemy.position[1] - core[1]);
    axisMinDistance[axis] = Math.min(
      axisMinDistance[axis],
      manhattan(core, enemy.position),
    );
  }
  const axesWithEnemies = AXIS_ORDER
    .filter((axis) => Number.isFinite(axisMinDistance[axis]))
    .sort(
      (a, b) =>
        axisMinDistance[a] - axisMinDistance[b] ||
        AXIS_ORDER.indexOf(a) - AXIS_ORDER.indexOf(b),
    );
  if (axesWithEnemies.length === 0) return null;
  const axis = axesWithEnemies[index % axesWithEnemies.length];
  const radius = unitType === "VANGUARD" ? VANGUARD_GUARD_RADIUS : RANGER_GUARD_RADIUS;
  // 沿轴由外向内收缩：守位被障碍/敌占占用时向内一格（半径 ≥2 保持 Core 邻格空）
  for (let r = radius; r >= 1; r -= 1) {
    const candidate: Position = [
      core[0] + AXIS_DIRECTIONS[axis][0] * r,
      core[1] + AXIS_DIRECTIONS[axis][1] * r,
    ];
    if (obstacles.has(cellKey(candidate))) continue;
    if (enemies.some((enemy) => samePosition(enemy.position, candidate))) continue;
    return candidate;
  }
  return null;
}

/**
 * 让位锚点（2026-08-07，生产 t2 实证修复）：已在 Core 格的军事单位
 * （Ranger/Vanguard）移出回仓通道的目标格。与 homeCell 不同，让位必须
 * 避开被单位占用的格——Core 四邻全堵（障碍 + 单位）时 homeCell 会选到
 * 满格（如 t2：[-53,49] 被 Vanguard+worker 占 2）→ 预裁决按容量淘汰
 * 让位动作 → Ranger 永不离开 → worker 永不 deposit → 经济死锁。
 * 选择顺序：① 空邻格（占用 0，最优先）；② 单占用邻格（占用 1——
 * 可挤入，容量 2，预裁决按优先级裁决）；③ 全堵返回 null（原地等，
 * 下一 tick 重试）。
 */
function yieldAnchor(
  core: Position,
  obstacles: ReadonlySet<string>,
  occupancy: ReadonlyMap<string, number>,
  enemies: readonly VisibleEntity[] = [],
): Position | null {
  const order: readonly Direction[] = ["UP", "RIGHT", "DOWN", "LEFT"];
  const cellOf = (target: Direction): Position => target === "UP"
    ? [core[0], core[1] - 1]
    : target === "RIGHT"
      ? [core[0] + 1, core[1]]
      : target === "DOWN"
        ? [core[0], core[1] + 1]
        : [core[0] - 1, core[1]];
  // 候选：先空位（占用 0），无空位再单占用（可挤入容量 2）。
  const candidates: Position[] = [];
  for (const pass of [0, 1]) {
    for (const target of order) {
      const cell = cellOf(target);
      if (obstacles.has(cellKey(cell))) continue;
      if ((occupancy.get(cellKey(cell)) ?? 0) === pass) candidates.push(cell);
    }
    if (candidates.length > 0) break;
  }
  if (candidates.length === 0) return null;
  if (enemies.length === 0) return candidates[0];
  // 可见敌人时：让位目标优先远离敌人（官方 arena_farmer egress 同语义——
  // 守卫让位不走进敌人怀里；防御性增强）。敌人距离相同保持确定性原序。
  candidates.sort((left, right) => {
    const leftDistance = nearestEnemyDistance(left, enemies);
    const rightDistance = nearestEnemyDistance(right, enemies);
    if (leftDistance !== rightDistance) return rightDistance - leftDistance;
    const leftDirection = directionOf(core, left, order);
    const rightDirection = directionOf(core, right, order);
    return leftDirection - rightDirection;
  });
  return candidates[0];
}

/** 到最近可见敌人的 Manhattan 距离（让位目标排序用）。 */
function nearestEnemyDistance(cell: Position, enemies: readonly VisibleEntity[]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const enemy of enemies) {
    nearest = Math.min(nearest, manhattan(cell, enemy.position));
  }
  return nearest;
}

/** cell 相对 core 的方向序（UP=0 RIGHT=1 DOWN=2 LEFT=3，确定性平局序）。 */
function directionOf(core: Position, cell: Position, order: readonly Direction[]): number {
  for (let index = 0; index < order.length; index += 1) {
    const target = order[index];
    const delta: Position = target === "UP"
      ? [0, -1]
      : target === "RIGHT"
        ? [1, 0]
        : target === "DOWN"
          ? [0, 1]
          : [-1, 0];
    if (cell[0] === core[0] + delta[0] && cell[1] === core[1] + delta[1]) return index;
  }
  return Number.MAX_SAFE_INTEGER;
}

/** 当前占用计数（Core + 全部单位），让位锚点判断"空位/单占用"用。 */
function occupancyCounts(state: TickState): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (position: Position): void => {
    const key = cellKey(position);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  if (state.core !== null) bump(state.core.position);
  for (const unit of state.units) bump(unit.position);
  return counts;
}

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
