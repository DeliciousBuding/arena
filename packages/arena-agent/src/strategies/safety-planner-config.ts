import type { PhaseConfig } from "../domain/phase-machine.ts";

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
   * 远端军事回援（2026-08-07，竞品 "敌方战斗单位已经进入 Core 防区时，
   * 所有非守家单位跳过集结等待并立即回援" 对照）：可见敌方**战斗单位**
   * （VANGUARD/RANGER，非 WORKER/CORE）进入 Core 防区（12 =
   * THREAT_FALLBACK_RADIUS，与 threat 评估/worker 召回同口径）→ 所有
   * 非守家军事（Vanguard/Ranger）立即回 Core 守位——优先于攻坚/打野/
   * 环搜（家被拆一切白搭）。触发后保持回援 8 tick（防敌人闪失→立刻折返
   * 抖动）；返回期间邻接敌仍 SWEEP/射程反击优先。默认 false = 历史行为
   * （远端军事继续原任务，零回归）。
   */
  readonly remoteReinforce?: boolean;
  /**
   * 信标夺取（2026-08-07，Champion Beacon 机制对齐）：官方规则信标
   * 坐标全员公开、持有者核心盾上限 5→10、worker 采集 1→2（双倍经济）。
   * 开启后：信标 GROUND 且距我方 Core ≤ beaconGrabMaxDist 时，指定最近
   * Vanguard（无则 Ranger）前往拾取并带回守家（信标跟随移动）；拾取后
   * 载者回 Core 守位持标（盾+采集双 buff 属于本租户）。近距离才抢——
   * 默认 80 格上限防远征送死（信标坐标公开，远距可被敌方埋伏）。默认
   * false = 历史行为（只有恰好路过才自动拾取，零回归）。
   */
  readonly beaconGrab?: boolean;
  /** 信标夺取最大距离（Chebyshev，以我方 Core 为圆心）：超出视为远征，不抢。 */
  readonly beaconGrabMaxDist?: number;
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
  /**
   * 敌 Core 记忆窗口（2026-08-07，攻坚候选）：aggressive 敌 Core 记忆推进
   * /Ranger 记忆射击的 maxAge。默认 60（历史行为）；Core 是慢速目标，长局
   * （t1 已 6 万+ tick）中 60 tick 记忆导致"看一眼就忘、部队圈巡找不到家"。
   * strike-core-v1 设 1200——一旦发现敌 Core，部队在 1200 tick 内持续前压。
   */
  readonly enemyCoreMemoryTicks?: number;
  /**
   * 密集军事搜索（2026-08-07，攻坚候选）：aggressive 军事打野改用 16 方位
   * （含半八分位）目标选择。根因：8 方位对角巡逻线距 off-diagonal 敌 Core
   * 的 Manhattan 最近距离 ≥7（视野 4），几何上永远发现不了（t1 敌 Core 在
   * NE 对角 17° 偏角，[-611,-169] vs home [-619,-154]，8 方位 NE 线最近
   * Manhattan 7）。16 方位含 [1,-2]（NNE，-63.4°）→ 距 Core Manhattan ~1，
   * 进入视野 → 记忆 → 前压。默认 false = 历史 8 方位（零回归）。
   */
  readonly militarySearchDense?: boolean;
  /**
   * 军事打野环停留预算（2026-08-07，攻坚候选）：军事打野在**同一 patrolRing
   * 上停留超过该 tick 数**即强制推进下一环（不再要求精确到达巡逻点）——防
   * 止单位被争格/振荡卡死在同一环，让搜索持续外扩覆盖新半径。默认 0 = 关闭
   * （历史行为：到达精确点才升环）。strike-core-v1 设 20。
   */
  readonly militaryRingHoldTicks?: number;
  /**
   * 敌情狩猎（2026-08-07，持久敌情测绘）：aggressive 军事在无可见敌人/资源时，
   * 优先回访"最后已知敌基地"（World.coreHuntTargets：CORE 目击 sticky + Worker
   * 轨迹推断锚点）并清扫，而不是从自家 Core 盲目环搜——t1 生产实证：敌 Core
   * 迁移后军队在旧位置空转，16 方位环搜射线距迁移后 Core 仍 ~6 格 > 视野 4，
   * 几何近失永不接敌。默认 false = 历史行为（home 环搜，零回归）。
   */
  readonly militaryHunt?: boolean;
  /**
   * worker 空闲回血（2026-08-07，B13 候选，竞品 heal priority 对照）：
   * 空 worker（无 cargo、无资源任务、未撤离）HP 未满且 Core 资源足够
   * 补满时回 Core 补血——在 Core 上由主循环 HEAL 分支结算（1 HP=1 资源，
   * 引擎 P10-unit-heal）。优先级低于撤离/回仓（竞品 worker 行为序：逃 →
   * 撤 → 回仓 → 治疗 → 扫描 → 采集 → 巡逻）。默认 false = 历史行为
   * （带伤 worker 继续采集/巡逻，零回归）。
   */
  readonly idleHealReturn?: boolean;
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

/** 激进战斗配置：完整默认值 + aggressive 战斗行为（供 tenant-runtime 注入）。 */
export const AGGRESSIVE_SAFETY_CONFIG: SafetyPlannerConfig = Object.freeze({
  ...DEFAULT_SAFETY_CONFIG,
  aggression: "aggressive",
});
