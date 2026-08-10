# arena-bench v3 评测设计（2026-08-09）

取代 v2（`arena-bench-v2.md`）。v3 = 评测公平性审计 14 条建议的首轮落地。
R1（2026-08-09）：变体三接线 + 对照组主榜外置 + 探针证据 + v2-vs-v3 重算。

## 1. 与 v2 的差异（判定/场景/条目/运行）

| 面 | v2 | v3 | 审计依据 |
|---|---|---|---|
| 胜者判定 | 存活→资源→人口（无击杀键） | 存活→击杀→资源→人口（与排名统一，decideWinner 加 kills 键） | §1.4 |
| 排名 tie-break | 存活→击杀→资源→人口 | 存活→击杀→**deposited（累计存款）**→资源→人口 | §6.4 |
| 综合分权重 | rank 60% + kill 20% + survival 20% | rank 60% + kill 30% + **economy（resourcesPerTick）10%** | §1.2/§6.2 |
| survivalScore | 20% 权重（恒 1.0 退化） | 字段保留（兼容旧消费者）但退出权重 | §1.2 |
| 变体条目 | 3 个全部降级默认（无效条目） | 3 个全部接线 ARENA_CFG_*（属性路径已查实；桥端通道待 R2，见 §6） | §4/§6.10 |
| 内置条目 | 参与主榜排名 | **对照组：不参与主榜 composite，单独展示**（leaderboardControl） | §6.9 |
| 场景 | 5 个（dense/std/open/scarce/random） | +2：**ffa-resource-race**（中央矿争夺）、**ffa-defense-pressure**（资源枯竭压力，定时红队降级版） | §6.5/§6.6 |
| seeds | 缺省 3 | 缺省 **5** | §6.12 |
| schema | `arena.bench.report.v2` | `arena.bench.report.v3`（v2 字段向后兼容；新增 economyScore/leaderboardControl/notes） | — |

## 2. 判定语义（v3）

- 每场排名：存活 → 击杀 → deposited → 资源 → 人口（竞争式排名 1,2,2,4）。
- 每场胜者：与排名同链（存活 → 击杀 → 资源 → 人口）——**消除"榜首从没赢过"的矛盾**。
- 综合分 = 0.6·rankScore + 0.3·killScore + 0.1·economyScore（rank/kill 各自跨主榜
  条目 min-max；economyScore 归一化在**全部场景×条目**的 resourcesPerTick 池上做）。
- **对照组**：内置条目（kind=builtin：ts-aggressive/ts-safety）不参与主榜 composite
  排名，用主榜同一归一化基准计分、单独展示（results.json `leaderboardControl`、
  report.html 第 1 节对照组条形）——内置去特权。
- 击杀归属保持 v2 口径（destroyed_by），聚合层注释已知局限（§2d：最后 tick 偏置/
  同 tick 集火多记/SWEEP 不入 damageDealt 账本）；≥20% 伤害占比归属触结算语义，
  v3 不实施（逐字节一致性优先，审计 §6.3）。
- survivalMedian/survivalScore 保留在结果 JSON（旧消费者兼容），权重不再使用。

## 3. 条目（v3）

- 社区默认 5：farmer/core/waaiging/tactic/arena-evolve（不变）。
- 变体 3（全部经 `opponentEntry(spec, seed, {env})` 传 ARENA_CFG_*）：
  - **farmer-eco**：`ARENA_CFG_WORKER_TARGET=8`（默认 12→8，纯经济对照；SDK 层探针验证有效）。
  - **core-mil**：`ARENA_CFG_TARGET=20 + ARENA_CFG_MODE=harvest`（默认 target=30
    提前收经济——mode 无 military 值，用 target 缩短发育期；decide_kwargs 覆盖
    通道 SDK 层验证有效）。
  - **waaiging-agg**：`ARENA_CFG_MEMORY_MODE=aggress`（R1 查实：TacticMemory.mode
    点分路径 memory.mode，默认 develop→aggress 即进攻模式开关；SDK 层验证有效）。
- 内置对照 2：ts-aggressive/ts-safety（对照组，见 §2）。
- **桥端通道状态（R1 探针实测）**：`opponent-bridge.py` 的 `apply_config_overrides`
  在真实对局路径**未生效**——bridge import 的是官方 SDK
  （reference/official/arena-hero-python，registry.ts SDK_REPO），其无
  `config_overrides` 模块，ImportError 被 try/except 吞掉 → env 注入 no-op
  （2 玩家 300 tick × seed1/2 固定 id/slot 对局：变体带 env vs 不带 env 逐字段
  Δ=0）。修复 = 桥改用 SDK fork（arena-hero-sdk-py）或补官方 SDK
  模块——**R2 桥接线遗留**（"桥接 decide_kwargs 合并前置"）。

## 4. 场景（v3）

| 场景 | radius | 资源后处理 | 测什么 |
|---|---|---|---|
| ffa-dense | 18 | — | 高密度混战 |
| ffa-std | 24 | — | 基准 |
| ffa-open | 36 | — | 开阔发育 |
| ffa-scarce | 24 | 每玩家盘 4→2 | 资源稀缺 |
| ffa-random | 24 | randomDrop | 位置鲁棒性 |
| **ffa-resource-race** | 24 | 每玩家盘 4→2 + 中心 [0,0] 4 盘共享矿 | **中央矿争夺**（抢矿=抢信标战略位，逼正面冲突） |
| **ffa-defense-pressure** | 24 | 每玩家盘 4→1（取首格） | **持久资源枯竭压力**（定时红队降级版） |

实现方式：makeArenaScenarioN 无中央矿/定时事件参数 → 在 run-arena-report.mts
buildScenario 后处理（改 scenario JSON terrain.resources：center-race 减半 +
[0,0] 邻格 4 盘；depletion 每玩家取首盘）。引擎无中性单位、episode 无定时事件
钩子（episode.ts 冻结）→ ffa-defense-pressure 为静态降级版（审计 §6.6）。

## 5. 运行

- `--seeds` 缺省 `1,2,3,4,5`（审计 §6.12：3 seeds 击杀方差过大）。
- 出图脚本兼容 v3（economyScore 新增，survivalScore 兼容字段保留不炸）。
- 冒烟（268f3bc）：dense/resource-race/defense-pressure × seed1 × 300 tick →
  schema `arena.bench.report.v3` 输出成功。

## 6. 探针证据与重算（R1，2026-08-09）

**SDK 层键验证**（probe_tool.py replay，现有探针方式；合成 120 tick
发育弧线，基线 vs 注入 plan 差异 tick 数）：
| 键 | 差异 tick | 结论 |
|---|---|---|
| farmer `WORKER_TARGET=8` | 20/120 | 有效（>8 worker 后绑定；300 tick 小局内 farmer 到不了 8 worker，故真局窗口内不可区分） |
| core `TARGET=20+MODE=harvest` | 113/120 | 有效（harvest 达 20 即止） |
| waaiging `MEMORY_MODE=aggress` | 113/120 | 有效（aggress 模式大改） |

**桥端真局验证**（2 玩家 300 tick，变体固定 id/slot，带 env vs 不带 env 两场）：
三变体全部 Δ=0（harvested/deposited/popPeak 逐字段一致，seed1/2）——桥端通道
未生效（见 §3）。**方法论教训**：2 玩家对称场存在位置伪影（障碍不对称）与
"对手 id 字符串"伪影（tenants 按 id 排序影响结算序，同 agent 不同 id 结果不同）
——patch 文档"端到端验证"（20→14）与 268f3bc 的 Δ0.007/0.027 均为伪影，非注入
效果；判定变体行为必须以"固定 id 仅差 env"对照。

**v2-vs-v3 重算**（既有 v2 数据 data/runs/sim/arena-bench-d874a86e1931 分片，
10 玩家×5 场景×3 seeds×1000 tick；v2 榜复算与审计 §1 数字逐位一致）：
| 条目 | v2名次(10人) | v2 composite | v3名次(主榜8人) | v3 composite | 变化 |
|---|---|---|---|---|---|
| core | 6 | 0.7547 | 1 | 0.9097 | ↑5 |
| waaiging | 7 | 0.7479 | 2 | 0.7429 | ↑5 |
| waaiging-agg | 5 | 0.7735 | 3 | 0.7234 | ↑2 |
| core-mil | 4 | 0.7812 | 4 | 0.6614 | — |
| arena-evolve | 9 | 0.6163 | 5 | 0.6339 | ↑4 |
| farmer-eco | 3 | 0.8000 | 6 | 0.2012 | ↓3 |
| farmer | 8 | 0.6596 | 7 | 0.1960 | ↑1 |
| tactic | 10 | 0.2000 | 8 | 0.0087 | ↑2 |

对照组（v3 公式/主榜基准，仅参考）：ts-aggressive 1.2658、ts-safety 0.3686。
变化主因：① deposited tie-break 重排场均名次（存款高的 core/waaiging 系上升、
farmer-eco 系下降）；② kill 权重 20%→30%、survival 常量项→economy 10%。
重算脚本：`data/lb-exp/re-rank-v3.mts`（gitignored 数据目录，只读 v2 分片）。

## 7. 遗留（v3 未落地项）

- **桥端 SDK 配置通道**：bridge 导入官方 SDK（无 config_overrides）→ env 注入
  no-op；变体在真局中仍与基座同构。R2 桥接线（"桥接 decide_kwargs 合并前置"）完成后真局生效。
- 击杀归属修复（累计伤害占比 ≥20% 记 0.5/1 杀）——触结算语义，v3 保留 v2 归属，
  聚合层注释（审计 §6.3）。
- 定时红队/中性单位场景——引擎暂不支持，ffa-defense-pressure 用资源枯竭降级（§6.6）。
- 内置条目走桥同预算（§6.9）——依赖桥条目化，v4 候选。
- 事件级明细输出（每场 CORE_DESTROYED/重生记录，§6.14）——v4 候选。
