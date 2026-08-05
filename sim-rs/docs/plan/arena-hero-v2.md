# Arena Hero 策略追赶方案（v2：从 SafetyPlanner 到 RTS Engine）

> 来源：第一名算法说明复盘 + 第二名仓库分析（用户提供，2026-08-05）+ 模拟器线差距盘点。
> 落点：**Rust 决策内核（arena-sim-strategy）**——融合线终态下 Rust 是生产唯一决策实现，
> 策略改进做在 Rust 一次、模拟=生产（fusion-line.md 核心原则）。
> 验证工具：simsearch（死锁狩猎）/ optsearch（参数搜索）/ paramscan（网格）/ simgolden（回归）——
> 这本身就是第二名"offline optimizer"的对应物。

## 1. 核心判断

- 不复制第一名代码；吸收**策略思想**（目标评分/全局匹配/资源记忆/确定性探索/威胁记忆）
- 不复制第二名代码；吸收**工程定位**（AI 不进 tick 循环、确定性、offline 调参）——我们已天然满足
- 终态 = 第二名工程框架 + 第一名策略深度 + 自建模拟器验证体系

## 2. 差距盘点（对照第一名方案）

| # | 能力 | 现状（Rust strategy） | 差距 |
|---|---|---|---|
| 1 | 全局资源匹配（非最近优先） | ✅ `assign_workers` 全局分配（claimed/harvesters + 排序） | 无 |
| 2 | Worker 生命周期（空载→采→回→提交→重分配） | ✅ harvest/deposit/return_core/yield_full_core | 无 |
| 3 | 移动容量仲裁/同步占位 | 部分（事后降级仲裁 arbitrate_move_capacity + 占位 WAIT 排队） | 事前预约可增强 |
| 4 | 资源记忆（采空/空资源格/失败路线） | ❌ 无（模拟器由 refill 管理；planner 无跨 tick 资源记忆） | **缺（v0.1）** |
| 5 | 分区探索（chunk/frontier/blacklist） | 部分（螺旋扫描带=确定性无缝覆盖，已超越简单分区；无 blacklist） | 部分（v0.2） |
| 6 | 威胁记忆（last_position/velocity/threat_score） | ❌ 无（仅即时 nearest_enemy + engage 超时） | **缺（v0.3）** |
| 7 | 静止敌人判断 | ❌ 无 | 缺（v0.3） |
| 8 | 攻击点预测/追击平衡 | 部分（engage 超时放弃 ✓） | 部分（v0.4） |
| 9 | Core 防御布防（Ranger 外围/Vanguard 屏障/回收） | ❌ 无 | 缺（v0.4） |
| 10 | 循环消除（A-B-A/停滞跳出） | ✅ stuck 指纹 + 换目标 | 无 |
| 11 | 单位配置（12/3/4） | ✅ 可参数化（workerTarget/militaryRatio） | simsearch 验证即可 |
| 12 | 持久状态/重启恢复 | ❌ 无（planner 内存态） | 延后（生产需求出现再做） |

## 3. 验证基线（v0，当前 Rust 策略，500 tick golden，2026-08-05 实测）

| 场景 | deposits | spawns | workers(终) | resources(终) |
|---|---|---|---|---|
| base（真实拓扑 6 格） | 68 | 13 | 13 | 1 |
| dense（Core 周围 8 格） | 154 | 16 | 13 | 0 |
| sparse（远处 3 格+障碍） | 30 | 7 | 9 | 0 |

经济雪球指标（对比目标）：deposits/资源增长率/人口终值——后续每个 v0.x 改动用
`cargo test --release -- --ignored bench_` + simgolden --check 回归 + 上述三场景对比。

## 3.1 真实数据画像（t3/t4 decision.jsonl 学习，2026-08-06）

样本：t3 26 runs/990 行 + t4 38 runs/2740 行（deterministic shadow 记录模式，
submitEnabled=false；t1/t2 本地 live 未落盘）。关键事实：

- **资源极度稀缺**：t4 resources 0-10 波动、38 runs 全样本仅 **1 次 DEPOSIT**
  （tick 55866：workers=3、res=5、cargo=1，同 tick 还 spawn+2 explore）；
  t3 全程 0 deposit、cargo 全 0。真实地图资源比模拟器 sparse 更稀。
- **explore 绝对主导**：t3 92%（1312/1428）、t4 99.7%（8448/8470）意图为 explore；
  kinds MOVE 绝对主导（t4 7138/8462）——worker 绝大多数时间空跑巡逻。
- **人口规模小**：t3 workers 1-2、t4 2-4；spawn 极少（t3 20、t4 8）——资源瓶颈
  压制经济扩张，符合"经济雪球 > 击杀"前提下的资源受限形态。
- **capacity_wait 存在**：t3 96、t4 8——容量仲裁在真实形态下可见。
- **质量**：valid 990/990 + 2740/2740，repaired 0——确定性决策无非法动作。
- **会话短**：每 run 38-72 tick——服务器会话频繁重置，记忆须会话内尽快生效。

**对 v0.x 的设计输入**：资源记忆（v0.1）与探索 blacklist（v0.2）在真实地图
价值最高（explore 空跑是最大损失）；sparse 场景是主要对标（30 deposits 基线）；
v0.5 校准目标 = 模拟器场景意图分布/资源密度向真实画像逼近（explore>90%、
deposit 每 500 tick 个位数）。

## 4. 版本路线（模拟器驱动）

### v0.1 Worker Economy 强化
- 资源记忆：跨 tick 记录已采空格/确认空资源格（refill 揭示前不重复派工）
- 满载 Worker 在 Core 满仓时"就近安全等待"替代"堵门"（现有 yield 已部分覆盖，验证边界）
- 验收：sparse 场景 deposits 提升（当前 30 为基线）；simsearch 死锁数下降

### v0.2 Map Memory / 探索
- blacklist：已确认无价值区域（封闭/采空）降低巡逻优先级
- 螺旋扫描与 blacklist 结合（当前螺旋是纯几何覆盖，无记忆）
- 验收：稀疏场景资源发现速度（harvests 首次时间）提升

### v0.3 Threat Model
- 威胁记忆：enemy last_position + 静止判定（连续 N tick 不动 → stationary）
- threat_score：距离 Core + 单位类型威胁值 → 影响 worker 路线风险
- 验收：敌方入侵场景存活率（构造带敌人的 simsearch 场景）

### v0.4 Combat Optimizer
- 攻击窗口预测（移动方向外推）
- Core 防御布防（Ranger 外围/威胁时回收 Worker）
- 验收：对打场景（top4 对打已有 strategy-search.mts 方法论）

### v0.5 Offline Optimizer 深化
- 用真实 t1-4 decision.jsonl 校准模拟器场景参数（单位 ID 形态/意图分布对比）
- optsearch 目标函数扩展（deposits 权重 vs 存活权重）

## 5. 工程纪律

- 每个 v0.x 单独提交，附模拟器基线对比数字
- 不引入 LLM 进 tick 循环（第二名教训，我们天然遵守）
- 策略改进只做 Rust 侧（融合线终态）；Go 生产经 F3 shadow 验证后由 Rust 决策
- 优先级：经济雪球 > 击杀（第一名结论）——战斗最后做
