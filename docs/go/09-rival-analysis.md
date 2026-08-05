# 竞品参考：arena-hero-agent（第二名仓库）机制分析

> 来源：`D:\Code\Projects\arena-hero-agent`（Arena Hero 榜单第二名，Python 实现，
> 约 6900 行，MIT）。分析日期：2026-08-06。定位：**融合线（Rust 决策内核）策略层
> 参考清单**——Go 侧不实施，落点在 rust-rewrite/sim-rs `strategy` crate。

## 1. 仓库结构

| 文件 | 行数 | 职责 |
| --- | ---: | --- |
| `arena_farmer.py` | 4672 | 核心决策器（CoreFarmer 类 + 战术函数库） |
| `arena_supervisor.py` | 1066 | 确定性看护（异常→告警→保守模式） |
| `arena_optimizer.py` | 834 | 离线参数优化（日志/回放驱动） |
| `arena_health.py` | 322 | 健康检查 + 版本兼容门禁 |
| `docs/strategy.md` | — | 策略画像（人口计划/Core 安全/经济侦察/战斗） |
| `docs/threat-response.md` | — | 威胁状态机（安全不变量/多轴突破/攻防矩阵） |

## 2. 值得参考的核心机制（按价值排序）

### 2.1 全局最小成本匹配（`_minimum_cost_assignment` L342）
- 空 Worker × 记忆资源格全局最优指派（距离 + 回程 + 任务状态综合成本）；
- 小意图奖励防抖（防止 churn），但明显更近的 Worker 可接管目标；
- 每个资源格至多分配给一个 Worker。
- 对照：Go 侧 `assignWorkers` 为简单"每格至多一个"，无全局最优。
- **融合线落点**：Rust `strategy` 的 worker 分配升级为最小成本指派。

### 2.2 Core 威胁状态机（`_control_core` L3791 + threat-response.md）
- 预判性规避：敌人预计 16 tick 到攻击范围即开始撤离；
- 多轴突破（multi-axis breakout）：比较完整排序的敌方距离向量，
  跨火线（crossfire）也能撤出，即使没有任何单步远离所有敌人；
- 分布式防御：守卫沿不同威胁轴分布，不叠 Core 格、不挡 Worker 路线；
- 观察到的敌方 Vanguard/Ranger 移动触发短时警报：召回任务、暂停扩张
  生产、重定向防御（横向活动本身不移动 Core）；
- 紧急迁移若目的地不恶化预计伤害/聚合风险则允许完成（不因立即治疗或
  交资源而取消）；硬阻塞或更危险目的地可取消；
- 兼容性标记 → 保守行为（规则/SDK 不匹配时）。
- 对照：Go 侧 Core 迁移仅"朝 Beacon 反方向"，无威胁评估。
- **融合线落点**：Core 决策加威胁向量评分 + 预判规避 + 守卫分布。

### 2.3 Raid 谨慎性（`_select_isolated_core_target` L2010）
- 静止 Core 需**重复观察 + 隔离检查**才可 raid；暴露它的 Worker 可作为
  指定观察者留守；
- 突击队最远 48 路径无关曼哈顿格、拉出 56 释放目标；
- 一 Vanguard + 一 Ranger 永远留守 Core 防守；
- 主动敌方舰队 → 释放 raid/静止清除目标、暂停非紧急生产、防御沿
  不同威胁轴分布；
- 击杀经济性判断：loot 事件、仓储容量、同 tick Core 生存、回程成本；
- 静止单位可由小突击队清除（仅在战斗压力外）；
- Ranger 优先攻击敌方 Ranger → Vanguard（威胁优先），连续每 tick 合法
  开火（不按 tick 奇偶交替）。
- 对照：Go 侧 raid 为无条件冲向可见敌人（激进，缺安全网会送死）。
- **融合线落点**：raid 加隔离确认 + 距离上限 + 留守防御 + 击杀经济性。

### 2.4 威胁记忆（`_update_enemy_awareness` L1719）
- 敌人消失不立即删除：保存 last_position + velocity + threat_score；
- 静止敌人多次 tick 位置不变 → stationary threat（不立即删）；
- 移动预测：追击/逃跑/绕路结合最近移动、目标方向、障碍；
- 攻击事件位置在失去可见性后保持可行动 6 个规划 tick；
- Core 与舰队威胁记忆分离（远处 Worker 受伤召回防御姿态但不移动 Core）。
- 对照：Go 侧仅即时 `VisibleEnemies`，无跨 tick 敌人记忆。
- **融合线落点**：Rust 侧加 EnemyMemory（last_pos/velocity/threat_score）。

### 2.5 侦察协同（`_refresh_scout_assignments` L2436）
- 资源格视为**动态观测**而非永久地形；
- 侦察路线 3 tick 无改进换方向；优先最久未观测 chunk；
- 避免所有 Worker 走同一走廊；
- 路线 6 tick 无改进释放（防占位）。
- 对照：Go 侧螺旋确定性覆盖（覆盖质量更优），缺"协同避让"。
- **融合线落点**：螺旋扫描 + chunk 观测年龄加权。

### 2.6 资源账本对账（`_reconcile_resource_turn` L4125）
- 每 tick 资源增减对账（事件驱动），自动发现"莫名资源丢失"；
- `unexplained_loss` 指标进诊断日志。
- 对照：Go 侧 telemetry 有 decision.jsonl，无资源对账。
- **融合线落点**：Rust 侧结算后资源守恒断言（与 Go golden 呼应）。

## 3. 人口计划对照

| 方案 | Worker | Vanguard | Ranger | 总计 |
| --- | ---: | ---: | ---: | ---: |
| 第二名（默认） | 12 | 3 | 4 | 19（压 20 惩罚线） |
| 第二名（A/B 候选） | 15 | 2 | 2 | 19 |
| Go 侧当前（激进） | 8 | ~40% 人口 | ~40% 人口 | ≤16 |

差异定位：第二名更稳（生存/积累优先），Go 侧更激进（早期军事压制）。
**A/B 候选**：融合线落地后可做 12/3/4 与 8/激进军事 的离线对打。

## 4. 工程层对照（已等价，无需参考）

| 能力 | 第二名 | Go 侧 |
| --- | --- | --- |
| 容器/部署 | Docker/systemd | 计划任务 + 看护脚本 |
| 兼容门禁 | version monitor（6h） | schema:check / replay |
| 离线优化 | arena_optimizer.py | optsearch（GA/SA） |
| 健康/回滚 | health + rollback | watchdog + runwatch |
| AI 不进 tick 循环 | 是（事后分析） | 是（deterministic） |

## 5. 融合线落点清单（优先级）

1. **Core 威胁状态机**（2.2）：预判规避 + 多轴突破 + 守卫分布——差距最大；
2. **Raid 隔离检查**（2.3）：重复观察 + 48/56 距离上限 + 留守防御 + 击杀
   经济性——补激进打野的安全网；
3. **全局最小成本匹配**（2.1）：worker×资源最优指派；
4. **威胁记忆**（2.4）：last_pos/velocity/threat_score + 跨 tick 保留；
5. **侦察协同**（2.5）：chunk 观测年龄 + 走廊避让；
6. **资源对账**（2.6）：结算后资源守恒断言。

> 实施位置：rust-rewrite/sim-rs `crates/strategy`（融合线 F3 双跑验证前
> 的 Rust 侧策略迭代）；Go 侧不实施（保持运行，避免冲突）。
