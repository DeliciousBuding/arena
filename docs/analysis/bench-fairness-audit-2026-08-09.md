# 评测公正性审计（arena-bench-v2，2026-08-09）

数据：`data/runs/sim/arena-bench-v2-d874a86e1931/results.json`（schema `arena.bench.report.v2`，
10 玩家 × 5 场景 × 3 seeds × 1000 tick，`--pipeline` 并行版，与串行逐字节一致）。
代码：arena-ts main `e4bac2e`。全部结论引用 results.json 数字或源码行号；无证据的判断标注"假设，未验证"。

## 0. 六问结论摘要

| # | 问题 | 结论（证据） |
|---|---|---|
| 1 | 判定公平性 | 基本能排序但两个指标失效：survivalMedian 全条目恒 1.0（退化常量，实测 unique={1}）；avgRank 60% 会把"零击杀发育混子"抬到 rankScore 第一（farmer-eco rankScore=1.0），登顶靠 killScore 20% 扳回——榜单实际在测"击杀数 + 经济发育"混合，且击杀被双重计算（判定链第 2 键 + killRate 20%）。另有内部矛盾：每场"胜者"判定（资源优先）与排名判定（击杀优先）不一致，15 场胜者全是 farmer/waaiging 系、ts-aggressive 从未赢过一场。 |
| 2 | 特化诊断 | 登顶 = **场景红利 + 主场优势**；"vanguardRatio 参数红利"被 1000 tick 消融**反驳**（0.8→0.4 击杀完全相同，见 §5b）：17/42 击杀中 10 杀在 dense（3 场）、4 杀 std、3 杀 scarce，open/random 0 杀（avgRank 6.33/7.67）；内置条目为本模拟器编写 + 不经 Python 桥（零决策成本、无超时风险）。 |
| 3 | 场景覆盖 | 只测"密度 + 资源量 + 出生随机"三个旋钮；测不出扩张节奏、侦察/视野、防御时机、资源争夺（scarce 只是减半）、结盟/混战动态、持久局运营。 |
| 4 | 条目同质化 | 3 个变体确认无参数注入通道 = 与基座行为同一（configNote 证据）；同质条目并列时排名噪声巨大（变体 vs 基座 per-match Spearman 仅 -0.18/0.35/0.38），实际有效条目 7 个。 |
| 5 | 验证实验 | 已跑（3 场 dense 500 tick 6 玩家，vanguardRatio 0.8 vs 0.4 同场）：500 tick 窗口内全场 0 战斗接触（所有玩家 damageDealt=0），击杀对比未验证；发育期 A/B 显示 0.4 不劣于 0.8（排位 2/1/5 vs 4/4/2）。 |
| 6 | v3 方向 | 见 §6（判定/场景/条目/运行 4 面各 2-4 条）。 |

## 1. 判定公平性（Q1）

**综合分公式**（`run-arena-report.mts:1174-1193`）：rankScore/killScore/survivalScore 各自
min-max 归一化后 `composite = 0.6·rankScore + 0.2·killScore + 0.2·survivalScore`。
复算 4 条目与 results.json leaderboard 完全一致（ts-aggressive 0.9745 / farmer-eco 0.8000 / tactic 0.2000 / core 0.7547）。

### 1.1 avgRank 60%：会奖励"稳定混子"，本榜靠 kill 项扳回

- **证据 A**：farmer-eco 击杀 0（perEntryKills：farmer/farmer-eco/tactic 均 0），但 avgRank=4.60
  为全榜最优 → rankScore=1.000 满分（results.json leaderboard）。纯发育条目在 avgRank 轴压过
  17 杀登顶者（ts-aggressive avgRank 4.73、rankScore 0.957）。若权重只有 avgRank，farmer-eco 登顶。
- **证据 B**：tactic avgRank=7.73（每场景均垫底或近底，如 dense 7.67/open 7.67/random 8.00）
  → rankScore=0，是唯一被 avgRank 正确惩罚的条目；它的波动也最小（15 场 sd=1.06，全榜最低），
  说明"稳定"本身不保证高分——高分必须发生在 10 人 FFA 的中位。
- **证据 C（波动性）**：登顶者 ts-aggressive 15 场排名 [1,1,1,1,1,3,3,5,6,6,7,8,8,10,10]
  （sd=3.28 全榜最高），5 次第 1、2 次第 10。avgRank 均值化会稀释高波动强者的表现——它靠
  击杀轴（killScore=1.0）补回。结论：60% avgRank 确实偏袒"每场中位偏上"的发育流，但本榜
  恰好是 20% kill 项挽回了军事价值；权重结构脆弱，换一批条目即可翻转（假设，未验证——需
  更多条目集复跑才能证明翻转）。

### 1.2 survivalMedian 20%：退化常量，零区分度

- 10 条目 × 5 场景的 survivalMedian 全部 = 1.0（results.json leaderboard 与全部
  perScenario.perEntry；唯一值集合 {1}）。
- 根因：`aliveTicks` 只计 `player.core !== null` 的 tick（`episode.ts:598`），而核心被拆后
  **同 tick 内立即重生**（`respawn.ts`：无重生冷却，P09 置 RESPAWNING 后 P13 同结算 tick
  放回新 Core，20-30 格、满盾满血 5 资源 1 worker）——15 场全部玩家 aliveTicks=1000。
- 影响：survivalScore 恒 1.0 → 20% 权重是常量项，实际有效权重为 rank 75% / kill 25%。
  "都奖励不死"的共线性在本数据中不成立——因为无人会被永久淘汰，杀人与被杀都不影响存活。

### 1.3 判定链（存活→击杀→资源→人口）：发育型在下行键上获利

- 每场排名 = 存活 → 击杀 → 资源 → 人口（`run-arena-report.mts:290-330`，竞争式排名并列同分）。
- **证据**：dense seed1 全场 10 人存活（aliveTicks 全 1000），ts-aggressive 5 杀 → rank 1
  （res 13），farmer-eco 0 杀 res 27 → rank 2：击杀键优先于资源键生效。但一旦全场无击杀
  （open 3 场只产生 2 杀），排名退化为纯资源/人口——open 场景 farmer-eco avgRank=2.00。
- 所以 avgRank 在"击杀场"≈ 击杀序，在"发育场"≈ 经济序，两种语义混合进一个数。
- **击杀双重计算**：击杀既是排名第 2 键（决定大部分 avgRank 差异），又是 killScore 20% 的
  直接输入；而"资源"只通过排名第 3 键间接影响 60% 权重。军事向实际上被加权两次。

### 1.4 胜者判定与排名判定不一致（设计缺陷）

- 每场 `winner` 走 `decideWinner`（`tournament.ts:239-266`）：存活 → **资源 → 人口**（无击杀键）；
  榜单排名却击杀优先（`run-arena-report.mts:309-313`）。同场可出现 rank=1 与 winner 不同人
  （dense seed1：rank 1 = ts-aggressive 5 杀，winner = farmer-eco 27 资源）。
- **证据**：15 场 winner 分布 = farmer-eco×4、waaiging×4、waaiging-agg×4、farmer×3，
  ts-aggressive **0 场获胜**，与榜单第一形成系统性矛盾——报告首页"胜者"与"综合分"讲两个故事。

## 2. 特化诊断（Q2）：ts-aggressive 登顶是能力还是红利？

**总账**：17/42 击杀（40.5%），但场景分布极不均：dense 10、std 4、scarce 3、open 0、random 0。
open/random 的 avgRank 6.33/7.67（垫底区）。"军事压制 vs 生态发育"的故事只在密集图成立。

### a) dense 出生距离（radius 18）利于 0.8 兵潮：成立

- 10 玩家圆周出生（`tournament.ts:477-537`，无 randomDrop 时按 roster 序固定落位），
  相邻核心弦距 = 2·18·sin(π/10) ≈ **11.1 格**（std 14.8 / open 22.2）；移动 1 格/tick
  （rules-v0.14.json `maxCellsPerTick=1`）。视野：vanguard 4、ranger 5、core 5——开局互相
  不可见，但兵潮成型后 11 格只够跑 11 tick 就到邻家。
- accumulateThreshold=30 前只产 Worker、达标后按 vanguardRatio=0.8 爆 Vanguard 前压
  （`contestants.ts:66-67,128-142`）。实测首杀 tick：dense 526 / std 609 / scarce 776
  （results.json perEntry.firstKillTick）。这是**中局一波流**，不是早期兵潮。
- 证据支持"dense 是这套参数的温床"：dense 总击杀 14（3 场）、ts-aggressive 独占 10；
  open 总击杀 2、ts-aggressive 0。半径差 2 倍（11.1 vs 22.2 弦距）直接把一波流打没。

### b) 1000 tick 对军事策略：偏利

- 首杀 526+，剩余 ~470 tick 足够再组织 1-2 波；且被拆者同 tick 重生在 20-30 格外
  （`respawn.ts`）——新家远离战区、资源清零，**击杀是"得分"，不是淘汰**：杀人者拿永久
  +1 击杀分，被杀者回到原点继续发育。tick 越长，击杀分累计越多的条目越赚。
- 若 tick 更短（≤400），一波流根本没时间成型（见 §5 实验：500 tick 全场 0 接触）。

### c) 内置条目 vs Python 条目的决策不对称：成立，但只差墙钟与风险，不差游戏内 tick

- Python 条目：`PersistentSyncBridge` 每 tick 决策一次往返，200ms Atomics.wait 轮询、
  **10s 硬超时 fail-fast**（`sync-bridge.ts:38,110-131`）。评测未启用决策预算
  （`episode.ts` decisionBudgetMs 缺省 undefined；仅 sim-server 服务模式传 200ms）——
  Python 决策慢不扣游戏内 tick，但主线程 98.3% idle 等桥（LOG 2026-08-09 剖析），
  桥错误/超时会让**整场**报废（15 场 errors=[]，未发生）。
- 内置条目：DeterministicPlanner/SafetyPlanner 进程内同步，零桥成本、零超时风险
  （`contestants.ts:124-146`），且**为本模拟器量身编写 + 参数按 2026-08-07 用户导向特调**。
- 判定：游戏内公平（同一观察/同一 validatePlan/同一 pipeline 语义），但"评测现场就是
  内置条目的主场"——它是为这套 FFA 格式写的纸面策略，社区 agent 是通用生产 agent 适配
  过来，无任何 FFA 特调。这不是代码特权，是"主场 + 特调参数"红利。

### d) 击杀归属（destroyed_by）：明显偏向"最后一 tick 在打的人"

- 归属 = `contributorsByTarget`（`combat.ts:271` 每次命中登记；`combat.ts:352-354` 取列表），
  即**击毁当 tick** 所有对该核心造成过伤害的玩家，全员各记 1 杀（`tournament.ts:550-570`）：
  - 最后一下偏置：前 90% 伤害（早 100 tick 打的）不在击杀 tick 出手 = 0 击杀；
  - 多记：一波集火同 tick 命中 = 多个玩家各 +1，perPlayerKills 之和 > CORE_DESTROYED 数；
  - 附带发现：Vanguard 的 SWEEP 命中计入击杀归属但不计入 damageDealt 账本
    （`episode.ts:59` 只记 SHOT_HIT；`combat.ts` sweep 分支只发 SWEEP_RESOLVED）——
    §5 实验中即出现"kills=1 但 damageDealt=0"的条目，指标口径不一致。
- 结论：击杀数偏袒"能组织同 tick 集火 + 最后一击在场"的伤害流条目，不能代表"输出贡献"。

## 3. 场景覆盖（Q3）

5 模板只变 3 个旋钮（radius / 资源减半 / randomDrop 洗牌，`bench-scenarios.json`）。

| 维度 | 能否测 | 现状/证据 |
|---|---|---|
| 高密度混战 | ✅ | dense 14 杀 / 3 场（唯一充分测试的维度） |
| 资源稀缺下的争夺 | ⚠️ 弱 | scarce 只是每玩家 4 盘→2 盘减半（`run-arena-report.mts:118-139`），总击杀 10，条目间分布尚可但无"抢同一矿"冲突设计 |
| 出生随机性 | ⚠️ 弱 | random 只洗牌+旋转（几何等价），总击杀仅 5，且 ts-aggressive 1.33→0 杀（std vs random 同半径）提示 3 seed 方差过大，结论不可靠 |
| 开阔发育 | ✅ | open 2 杀，测出"发育排序"但测不出远征战（22.2 格弦距 + 1000 tick = 军队到不了） |
| 扩张节奏/侦查 | ❌ | 无视野差异化、无侦查单位价值、固定 1 worker 起点，扩张只体现为资源分 |
| 防御时机 | ❌ | 无波次进攻场景；防御是纯反应式（守家），无"该防时没防"的判定结构 |
| 资源争夺（中央单矿） | ❌ | 无地图中央矿/信标资源化设计 |
| 结盟/混战动态 | ❌ | 纯 all-vs-all；官方世界是 4 租户持久局，无 2v2/停战/背刺语义 |
| 持久局运营 | ❌ | 1000 tick 单场 + 同 tick 重生 = "击杀得分赛"，非官方"无终局持久"形态 |
| 决策时效 | ❌ | 未启用 decisionBudgetMs，决策速度完全不参与评分 |

## 4. 条目同质化（Q4）

- **3 个变体全部降级 = 与基座同一 agent、同一默认配置**（`contestants.ts` 各 configNote）：
  waaiging-agg（SmartTactic 无进攻参数可注入）、core-mil（mode 仅 control/harvest）、
  farmer-eco（worker_target 默认即上限 12）。**有效条目 = 7**（5 社区 + 2 内置）。
- **同质条目的排名噪声反而极大**：变体 vs 基座 15 场 per-match rank Spearman 只有
  farmer-eco vs farmer 0.38、core-mil vs core 0.35、waaiging-agg vs waaiging -0.18——
  行为相同的 agent 因出生位固定（非 random 场景按 roster 序落位，`tournament.ts:493-503`）
  与并列 tie-break（playerId 字典序）拿到差异巨大的排名。例：同 agent 的 farmer vs
  farmer-eco，dense avgRank 5.00 vs 6.33、open 4.33 vs 2.00（results.json perEntry）。
- **隐含结论**：a) 榜单第 3-8 名之间的 0.748-0.800 差距可能小于"出生位 + 并列"噪声
  （~0.7 名 avgRank 量级）；b) 3 个"变体"占用了榜单 3 席，稀释了社区条目对比的纯度；
  c) 全榜两两 per-match 相关性大多 |ρ|<0.6，无清晰技能聚类——排名主要由场次噪声主导。

## 5. 验证实验（Q5）

命令（arena-ts 主树，仅写 gitignored 的 `data/`，不改任何源码）：

```
cd arena-ts && npx tsx data/lb-exp/exp-vanguard.mts   # 脚本：runFreeForAll 直调，
# 阵容 = ts-agg-08(vanguardRatio=0.8, 登顶参数) + ts-agg-04(0.4 对照) + ts-safety + core/farmer/waaiging(python 桥)
# 3 场 ffa-dense（radius 18 默认布局），seed 1-3，ticks=500，players=6，规则 rules-v0.14
```

输出摘要（`data/lb-exp/exp-out.txt`，每场 ~20-24s 墙钟）：

| 条目 | seed1 rank/杀 | seed2 rank/杀 | seed3 rank/杀 |
|---|---|---|---|
| ts-agg-08 (0.8) | 4 / 0 | 4 / 0 | 2 / 0 |
| ts-agg-04 (0.4) | 2 / 0 | 1 / 1 | 5 / 0 |
| ts-safety | 5 / 0 | 5 / 0 | 6 / 0 |
| farmer / core / waaiging | 1,6,3 / 0 | 2,3,6 / 0 | 3,4,1 / 0 |

- **击杀对比：未验证**——500 tick 窗口内全场 0 战斗接触（所有玩家 damageDealt=0、unitsLost≈0），
  一波流要 526+ tick 才首杀（dense 10 玩家实测），6 玩家弦距更长（18 格）更慢；
  唯一击杀是 seed2 中 0.4 变体的 sweep 集火（且 damageDealt=0，暴露 §2d 指标口径问题）。
- **发育期 A/B 有结果**：降为 0.4 后不崩——人口峰值 8/10/10 vs 0.8 的 9/9/8，最终排位
  2/1/5 vs 4/4/2（0.4 平均更优）。即"vanguardRatio=0.8 是登顶唯一配方"**不成立**；
  "0.8 在 1000 tick 长局击杀更多"未能在窗口内验证（假设，未验证）。

### 5b. 1000 tick 消融（总负责人补跑，dense seed=1，正式 10 条目阵容）

```
cd arena-ts/packages/arena-agent && npx tsx scripts/tmp-probe-vanguard.mts
# 阵容 = defaultContestants() 正式 10 条目（仅替换 ts-aggressive 的参数），radius 18 / 1000 tick / seed 1
[vanguard-0.8（现状）] ticks=1000 → agg kills=5 total=5 alive=true :: ts-aggressive=5
[vanguard-0.4（消融）] ticks=1000 → agg kills=5 total=5 alive=true :: ts-aggressive=5
```

- **vanguardRatio 0.8 → 0.4 击杀完全不变（均 5 杀、独占全部击杀）**——5 杀与正式评测
  dense seed=1 场次一致（验证探针等价）。**参数红利结论被反驳**：ts-aggressive 的击杀
  能力来自策略本体（RUSH 时序/积累期控制），vanguardRatio 在 0.4-0.8 区间不敏感（饱和）。
- 结合 §5a：击杀维度上"0.8 是登顶配方"不成立；**登顶的真实红利 = 场景（dense 温床，
  11.1 格弦距）× 主场（内置 planner 为本模拟器编写）+ 唯一军事策略**（社区条目无军事
  参数通道）。"vanguardRatio 特调"从登顶解释中移除。

## 6. v3 改进方向（Q6，建议层）

**判定面**
1. 修 winner 与排名判定不一致（统一击杀优先或资源优先，二选一并文档化）。
2. survivalMedian 失效 → 换"被拆次数/重生惩罚"或直接删除该 20%；权重改 rank 50 + kill 25 + economy 15 + decision 10 之类可辨别的组合。
3. 击杀归属改"累计核心伤害占比 ≥20% 才记 0.5 杀/1 杀"，消除最后一 tick 偏置与多记；damageDealt 计入 sweep。
4. 并列块处理：增加 deposited/unitsLost 等 tie-break 键或改平均秩法（dense seed1 曾出现 4 家并列 rank 7）。

**场景面**
5. 新场景"资源争夺"：地图中央单矿/信标资源化，逼正面冲突。
6. "防御压力"场景：定时红队 AI 进攻波次，测防御时机与兵力分配。
7. "侦察/扩张"场景：大图 + 视野不对称（侦察单位价值显性化）。
8. 4 人官方制式持久局（3000+ tick、无终局、按官方规则）作为独立分榜；1000 tick 单场维持。

**条目面**
9. 内置条目去特权：ts-aggressive/ts-safety 走同一决策桥/同一决策预算（依赖 L-C 的 SDK
   通道把内置策略也做成桥条目），并发布 vanguardRatio/accumulateThreshold 敏感性扫描
   （本次实验提示 0.4-0.8 区间内不单调）。
10. 条目真参数化（依赖 L-C SDK 通道）：waaiging-agg/core-mil/farmer-eco 注入真参数，
    变体才可测；否则从阵容中删除，省 3 席。
11. 非 random 场景按 seed 旋转 roster 落位，消除出生位红利（farmer vs farmer-eco 差 0.7 名量级）。

**运行面**
12. seeds 1-3 → 1-5/1-10（ts-aggressive sd=3.28，3 seed 太噪；random vs std 同几何结果反转）。
13. 统一启用 P4e 决策预算（如 200ms），把"决策速度"变为可测维度，杜绝 Python 侧无上限
    墙钟（评测耗时被桥决策主导，LOG 98.3% idle）。
14. 输出事件级明细（每场 CORE_DESTROYED/destroyed_by/重生记录），否则击杀归属与多记
    无法从 results.json 审计（本报告已撞此墙）。

## 7. 总判定

榜单**能**区分"会杀人的军事流 / 会发育的经济流 / 全程垫底"三档，但**不能**证明
ts-aggressive 是"更强策略"——它的登顶 = **密集场景红利**（11.1 格弦距 + 1000 tick 的
击杀得分赛）**× 主场优势**（为本模拟器编写的内置 planner + 唯一具备军事策略的条目；
vanguardRatio 特调参数已被 1000 tick 消融反驳，§5b）。avgRank 60% 会让纯发育条目拿到
满分 rankScore，survivalMedian 是完全失效的常量，胜者判定与排名判定自相矛盾，击杀
归属偏袒同 tick 集火。
**结论：评测测的是"场景红利 × 主场优势"而非"通用能力"；v3 需按 §6 重构**
（判定去失效指标、场景补真实对抗结构、条目去特权 + 真参数化、seeds 扩容）。

## 附：证据索引

- results.json：leaderboard（composite/rankScore/killScore/survivalMedian）、
  perScenario.perEntry（killRate/avgRank/firstKillTick/survivalMedian）、matches（rank/perPlayer）
- `run-arena-report.mts:290-330`（排名判定链）、`:1174-1193`（综合分）、`:470-545`（聚合）、`:118-139`（scarce 减半）
- `contestants.ts:66-67,128-142`（0.8/30 参数与内置构造）、configNote（三变体降级）
- `tournament.ts:239-266`（decideWinner 资源优先）、`:477-537`（圆周出生/固定序）、`:550-570`（击杀归属）
- `combat.ts:271,352-354`（contributorsByTarget）、`episode.ts:59,507,598`（damageDealt 口径/aliveTicks）
- `respawn.ts`（同 tick 无冷却重生 20-30 格）、`sync-bridge.ts:38,110-131`（200ms/10s）
- `bench-scenarios.json`（5 模板）、rules-v0.14.json（maxCellsPerTick=1、core 5/5、vision 3-5）
