# 模拟器效率与并行利用率优化报告（L-A 线，2026-08-09）

日期：2026-08-09 · 来源：L-A 执行型任务（前置测量 → 无损实现 → 逐字节验证 → 全量评测）
代码：arena-ts main（HEAD `ccb9764`；本线改动随 `735c6c5`（总负责人代提交）合入：
`episode.ts` P4g+ prefetch 调度、`opponent-adapter.ts`/`decision-types.ts` parallelPrefetch
契约、`opponent-bridge.py`/`sync-bridge.ts`/`episode.ts` 计时探针（`ARENA_BRIDGE_TIMING` /
`ARENA_EPISODE_TIMING`，默认关零行为变化））

## 0. 摘要

15 场全量评测（5 场景 × 3 seeds × 1000 tick × 10 玩家，`--pipeline --shard i/5`）：
**端到端 143s（含 merge 145s）vs 基线 ~4-5 分钟 → 加速 ~1.7-2.1×（-40~50%）**；
单场探针 33s vs 基线 46-54s（-28~39%）。同 seed 逐字节一致（diff 仅 generatedAt）。
抓手判定：状态投影放弃（实测 <3% 收益）、决策窗口放弃（bench 路径无此参数）、
**实现的是"桥先提交"调度优化**（不在原三抓手内，实测为最大收益项）。

## 1. 前置测量（探针：ffa-std seed=1 1000 tick 10 玩家 --pipeline，46-54s/场）

### 1.1 桥协议状态投影（Lever 1）——测量表

Python 侧（`ARENA_BRIDGE_TIMING=1`，opponent-bridge.py 每 tick 计时）：

| agent | 请求体 bytes | parse | validate (pydantic) | decide | dump | 往返 |
|---|---|---|---|---|---|---|
| farmer | 3288 | 0.05ms | 0.13ms | 2.88ms | 0.07ms | 3.21ms |
| core | 3009 | 0.05ms | 0.13ms | 2.13ms | 0.09ms | 2.49ms |
| waaiging | 5063 | 0.07ms | 0.16ms | 12.93ms | 0.08ms | 13.32ms |
| tactic | 2506 | 0.05ms | 0.12ms | 1.73ms | 0.08ms | 2.25ms |
| arena-evolve | 3098 | 0.06ms | 0.13ms | 2.03ms | 0.08ms | 4.69ms* |
| waaiging-agg | 3425 | 0.06ms | 0.14ms | 3.75ms | 0.07ms | 4.08ms |
| core-mil | 2989 | 0.05ms | 0.13ms | 4.54ms | 0.08ms | 4.91ms |
| farmer-eco | 3897 | 0.06ms | 0.15ms | 2.78ms | 0.08ms | 3.14ms |

\* arena-evolve persist=2.39ms/tick（process-memory 槽未配 slotEvery → 每 tick 写盘；
注册表 farmer/core/waaiging 均为 25 tick 一次）。

TS 侧（`ARENA_BRIDGE_TIMING=1`）：序列化 p50=0ms / max=1ms；请求体分布
reqBytes p50=3.25KB / p90=5.5KB / max=9.3KB。

**判定：放弃状态投影。** parse+validate+dump ≈ 0.3ms，占决策周期 <3%（waaiging
13.3ms 往返中仅 0.3ms 是协议开销）；消息体 3-9KB 极小。投影收益远低于 10% 阈值，
且字段子集有破坏逐字节一致性的风险（第三方 agent 读取字段不可控）。

### 1.2 决策窗口（Lever 2）——判定

arena-bench 路径（runFreeForAll → runEpisode）不传 `decisionBudgetMs`——护栏只存在于
sim-server 服务模式（`run-sim-server.ts`，生产语义）。放宽 200→400/800ms 对评测零影响。
**放弃**：评测端无收益，生产端属生产语义且文件被并行会话 WIP 占用（只读）。

### 1.3 桥跨场复用（Lever 3）——测量

Python 冷启动（import pydantic + SDK + agent 模块）：每进程 ~620-650ms × 8 进程 ≈
**5s/场 ≈ 11% 端到端**（46s 探针）。>10% 阈值，技术可行（进程池 + 记忆重置协议），
但实现风险中等（重置协议须保持逐字节一致）。**未实现**：与 1.4 的收益相比优先级低，
任务书要求"只做收益最大的一个"。

### 1.4 每 tick 分阶段分布（决定实现方向的关键测量）

`ARENA_EPISODE_TIMING=1`（e2 探针）：avg_tick=46.5ms =
decision 22.3ms + settlement 2.4ms + prefetch 21.5ms + record 0.2ms。

- **prefetch 21.5ms 中 ts-aggressive（内置 DeterministicPlanner）同步计算独占 16.4ms**（35%），
  8 个 Python 桥观察+提交仅 ~0.4ms×8。
- **decision 22.3ms 中 waaiging 桥等待 avg 11.6ms**（分布 p50=0.67 / p90=12 / p99=334ms——
  长尾来自第三方 SmartTactic 决策本身）、waaiging-agg 3.8ms、core-mil 4.4ms；validate
  仅 0.01-0.03ms/tenant。
- 提交顺序 = tenant 序：ts-aggressive 的 16.4ms 同步计算挡在 waaiging/waaiging-agg 的
  桥请求**之前** → 后者请求晚 ~17ms 发出，决策等待被放大。
- 机器 28 核（无 CPU 争用）；桥 await 阻塞 p50=0ms（流水线本身有效）。

**结论**：把"真异步桥"（parallelPrefetch）的请求提到内置 planner 同步计算之前发出，
Python 决策与主线程计算重叠——逐字节一致的调度优化，预期收益最大。

## 2. 实现（P4g+ prefetch 调度，2026-08-09）

- `src/runtime/decision-types.ts`：`PlanProvider.parallelPrefetch?: boolean`（可选契约，
  缺省 false——同步计算；真异步桥置 true）。
- `src/sim/opponent/opponent-adapter.ts`：`OpponentAdapter.parallelPrefetch` =
  decider 原生实现 prefetch/decideCached（持久桥）时为 true。
- `src/sim/harness/episode.ts`：`pipelinePrefetchOrder` —— pipeline 模式 prefetch 循环
  按 parallelPrefetch 分组两遍提交（真异步桥先、同步计算后，组内保持原相对序）。

**无损性论证**：只改变跨 tenant 的提交顺序；每个 tenant 每 tick 恰好一次请求、
内容不变、自身请求序列不变（同一结算后世界观察）；决策循环（tenant 序）、settlement、
记录逻辑零改动。串行模式（无 pipeline）路径完全不变。

## 3. 验证

### 3.1 逐字节一致性（同 seed 全字段递归 diff，results.json）

| 对比 | 结果 |
|---|---|
| 优化前 pipeline（probe-b1，原代码）vs 优化后 pipeline（probe-o1） | **diff=1：仅 generatedAt** |
| 串行无 pipeline（probe-s1）vs 优化后 pipeline（probe-o1） | **diff=1：仅 generatedAt** |

```
diff count: 1
  root.generatedAt: "2026-08-09T15:03:12.645Z" vs "2026-08-09T15:30:57.261Z"
```
（winner/rank/perPlayer/ledger/eventCount 等全部一致；2 场同 seed 通过验收线）

### 3.2 加速倍数（同机同配置实测）

| 形态 | 基线 | 优化后 | 加速 |
|---|---|---|---|
| 单场探针（ffa-std s1 1000t 10p pipeline） | 46-54s（b1/e1/e2 三次） | 33s（o1） | **1.4-1.6×** |
| 15 场全量（5 场景 × 3 seeds，5 分片并行 + merge） | ~240-300s（任务书基线 4-5 分钟） | **143s + 2s merge = 145s** | **1.7-2.1×** |

（探针期机器有并行会话负载，基线三次 46/54/50s 波动；优化后 33s 与 e3 同负载窗口
39s 对比亦有 15%+。全量评测与任务书基线同口径）

### 3.3 测试与门禁

- `pnpm -r check` 全绿：tsc + sim isolation（116 文件）+ **全量 2330 测试 0 失败**
  （check-test-count 跑完整测试套件，基线 1966 只增不减）。
- 全量评测 errors=0；`--merge` 校验 5 分片完整（无重叠/无缺失）。

## 4. 抓手放弃汇总

| 抓手 | 实测收益 | 放弃原因 |
|---|---|---|
| 桥状态投影（Lever 1） | <3%（协议开销 0.3ms / 决策 13ms） | 低于 10% 阈值；字段子集有破一致风险 |
| 决策窗口放宽（Lever 2） | 0%（bench 路径无 decisionBudgetMs） | 评测无收益；生产语义在 WIP 文件 |
| 桥跨场复用（Lever 3） | ~11%（冷启动 5s/场） | 低于已实现的调度优化（1.7-2.1×）；留作后续 |
| **桥先提交调度（新发现）** | **-40~50% 端到端** | **已实现**（P4g+，逐字节一致） |

## 5. 遗留

- ts-aggressive（DeterministicPlanner）16.4ms/tick 同步计算现为最大单项（prefetch 35%）——
  `deterministic-planner.ts` 被并行会话 WIP 占用，只读未动；后续可在其空闲后优化算法
  （匈牙利分配等）或移入 worker 线程。
- waaiging 决策长尾（p99=334ms）来自第三方 SmartTactic 本身，不可改（只读）；
  若未来需要可评估调度缓解（提前提交/降级）。
- arena-evolve 每 tick 写盘（persist 2.39ms/tick）：注册表补 `slotEvery: 25` 可省
  ~5% 端到端（行为不变——常驻进程记忆在进程内，槽仅备份）；本次未做（"只做收益最大
  的一个"），留给后续顺手项。
- 计时探针（ARENA_BRIDGE_TIMING / ARENA_EPISODE_TIMING）保留，默认关，供后续优化复测。

---

## 6. 追加（R2）：桥状态投影落地（2026-08-09，总负责人裁决执行）

背景：L-A §1.1 曾判"放弃状态投影"（协议开销 <3%）。总负责人随后拍板执行
R2：**字段并集审计先行**，投影实现默认关，逐字节一致性全过后才谈启用——
即把"投影"从预判转为**可安全启用的能力**（审计 + 实现 + 验证，见
`docs/analysis/bridge-field-audit.md`）。

### 6.1 字段并集审计摘要

- 5 agent（farmer/core/waaiging/tactic/arena-evolve）静态分析：
  **并集 = 现状 wire 全字段**——无"任何 agent 都不读"的字段可整字段删除
  （SDK Turn 基类还无条件读 `state.objects`）。事件数组不能删（4/5 读）。
- 投影 = **值条件省略**（并集内恒 null 可选字段省略键，桥端 pydantic 默认
  None 还原）：`respawn_at_tick`（ACTIVE）、NORMAL 核心迁移字段、非受控
  WORKER 的 `cargo`、beacon null `status`/`carrier_id`、事件 null 可选字段。
  MOVING/RESPAWNING/CARRIED 必带字段按官方 wire validator 强制保留。
- pydantic 缺失字段兼容实测通过（reference SDK 0.2.6）。

### 6.2 实现

`tickStateToProto(state, selfPlayerId, { projectFields })` →
`OpponentAdapter.setProjection` → `runFreeForAll({ bridgeProjection })`。
**默认关**；逐 agent 白名单 `BRIDGE_PROJECTION_AUDITED_AGENTS`（5/5 审计可
投影；未审计第三方/HTTP 端点不投影；未来发现动态读字段的 agent 移出白名单
即降级）。

### 6.3 逐字节一致性验证（4 场，全部 agent）

同 seed 同场景、投影关 vs 开、400-1000 tick、pipeline 模式；记录
（recorder JSONL：每 tick players/events/planHashes）diff 仅 `meta.startedAt`：

```
match=a (farmer+core, seed7, 500t)          tick_line_diffs=0  ALL BYTE-IDENTICAL
match=b (waaiging+tactic, seed11, 400t)     tick_line_diffs=0  ALL BYTE-IDENTICAL
match=c (arena-evolve+core, seed13, 400t)   tick_line_diffs=0  ALL BYTE-IDENTICAL
match=d (5 agent ×2, seed42, 1000t)         tick_line_diffs=0  ALL BYTE-IDENTICAL
```

kills/ledger/事件序/每 tick planHash 逐字段一致。

### 6.4 收益测量（同场 10 玩家 5 agent ×2，流水线探针）

| 指标 | 关 | 开 | 变化 |
|---|---|---|---|
| 桥消息 avg reqBytes（500t，10000 请求） | 2105 B | 1744 B | **-17.1%** |
| 桥消息 avg reqBytes（1000t，20000 请求） | 2651 B | 2218 B | **-16.3%** |
| Python avg_parse / validate（1000t） | 0.058 / 0.129 ms | 0.054 / 0.137 ms | 噪声内 |
| episode avg_tick（1000t 10 玩家） | 20.6 ms | 22.6 ms | 噪声内（±10%） |

- 桥消息体积稳定 **-16~18%**（farmer 1619→1328、core 2273→1877、waaiging
  2592→2153、tactic 1797→1482、arena-evolve 1950→1624）。
- **端到端 avg_tick 无显著变化**——与 L-A §1.1 的 <3% 结论一致：本尺度下
  序列化+桥解析只占 prefetch 小部分（serializeMs <0.05ms/请求），prefetch
  主体是 observeAndPolicy，decision 主体是 Python decide；投影不触及两者。
  原始"20-30% 端到端"预估不成立；收益边界 = 序列化/解析占比（~2-4%），
  随状态体积（更多单位/更长对局）增大而上升。投影默认保持关闭，是否在
  评测路径启用由总负责人按本验证裁决。

### 6.5 不可投影 agent

- 无（5/5 静态可枚举，见 audit §5——tactic 的 getattr 均字面量名，model_dump
  仅作用于输出 plan）。未审计第三方/HTTP 端点默认不投影（黑盒，字段读取
  不可控）。

