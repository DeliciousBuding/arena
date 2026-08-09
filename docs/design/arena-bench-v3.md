# arena-bench v3 评测设计（2026-08-09）

取代 v2（`arena-bench-v2.md`）。v3 = 审计报告
（`docs/analysis/bench-fairness-audit-2026-08-09.md`）14 条建议的首轮落地。

## 1. 与 v2 的差异（判定/场景/条目/运行）

| 面 | v2 | v3 | 审计依据 |
|---|---|---|---|
| 胜者判定 | 存活→资源→人口（无击杀键） | 存活→击杀→资源→人口（与排名统一） | §1.4 |
| 排名 tie-break | 存活→击杀→资源→人口 | 存活→击杀→**deposited（累计存款）**→资源→人口 | §6.4 |
| 综合分权重 | rank 60% + kill 20% + survival 20% | rank 60% + kill 30% + **economy（resourcesPerTick）10%** | §1.2/§6.2 |
| survivalScore | 20% 权重（恒 1.0 退化） | 字段保留（兼容旧消费者）但退出权重 | §1.2 |
| 变体条目 | 3 个全部降级默认（无效条目） | core-mil/farmer-eco 经 SDK 注入通道真参数化；waaiging-agg 无注入键保持降级注明 | §4/§6.10 |
| 内置条目 | 参与主榜排名 | 参与主榜但榜单标注"对照组"（图表层） | §6.9 |
| 场景 | 5 个（dense/std/open/scarce/random） | +2：**ffa-resource-race**（中央矿争夺）、**ffa-defense-pressure**（资源枯竭压力，定时红队降级版） | §6.5/§6.6 |
| seeds | 缺省 3 | 缺省 **5** | §6.12 |
| schema | `arena.bench.report.v2` | `arena.bench.report.v3`（v2 字段向后兼容） | — |

## 2. 判定语义（v3）

- 每场排名：存活 → 击杀 → deposited → 资源 → 人口（竞争式排名 1,2,2,4）。
- 每场胜者：与排名同链（存活 → 击杀 → 资源 → 人口）——**消除"榜首从没赢过"的矛盾**。
- 综合分 = 0.6·rankScore + 0.3·killScore + 0.1·economyScore（各自跨条目 min-max；
  economyScore 归一化在**全部场景×条目**的 resourcesPerTick 池上做，防止跨场景偏差）。
- survivalMedian/survivalScore 保留在结果 JSON（旧消费者兼容），权重不再使用。

## 3. 条目（v3）

- 社区默认 5：farmer/core/waaiging/tactic/arena-evolve（不变）。
- 变体 3：
  - **farmer-eco**：`ARENA_CFG_WORKER_TARGET=6`（默认 12→6，纯经济对照；注入通道
    端到端验证过 harvested 差异）。
  - **core-mil**：`ARENA_CFG_TARGET=20 + ARENA_CFG_MODE=harvest`（默认 target=30 提前
    收经济——mode 无 military 值，用 target 缩短发育期）。
  - **waaiging-agg**：降级默认（SmartTactic 仅接受 memory/control_path，无进攻
    参数可注入；SDK 通道已就绪，缺目标字段——v3 记录，等 waaiging 侧暴露参数）。
- 内置对照 2：ts-aggressive/ts-safety（榜单标注"对照组"）。

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

## 5. 运行

- `--seeds` 缺省 `1,2,3,4,5`（审计 §6.12：3 seeds 击杀方差过大）。
- 出图脚本兼容 v3（leaderboard 字段 economyScore 新增，旧图脚本读 survivalScore
  兼容字段不炸）。

## 6. 遗留（v3 未落地项）

- 击杀归属修复（累计伤害占比 ≥20% 记 0.5/1 杀）——触结算语义，v3 保留 v2 归属
  （destroyed_by 同 tick 集火多记），在报告口径注明（审计 §6.3）。
- 定时红队/中性单位场景——引擎暂不支持，ffa-defense-pressure 用资源枯竭降级（§6.6）。
- 内置条目走桥同预算（§6.9）——依赖桥条目化，v4 候选。
- 事件级明细输出（每场 CORE_DESTROYED/重生记录，§6.14）——v4 候选。
