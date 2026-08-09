# PROGRESS — 任务书 E：v3→main 合并冲突解决（39 文件）

日期：2026-08-08
工作树：`arena-ts/.worktrees/tmp-reconcile-20260808`（分支 tmp/reconcile-20260808，HEAD=main f9b91fa）
merge-base = 3f3290c；merge 目标 production-runtime-v3 = eddb4f5。

## 分类策略总表（每文件一行）

### 类 1：vnext/swarm 文件 → 取 HEAD（先 diff 检查 v3 独有热修）

| 文件 | 状态 | 解决方式 | 理由 |
|------|------|---------|------|
| src/algorithms/min-cost-assignment.ts | AA | 取 HEAD | v3=旧 swarm 版缺生产回流注释，代码一致，HEAD 注释更全 |
| src/alliance/task-market.ts | AA | 取 HEAD | v3 仅删一行注释，功能一致 |
| src/alliance/local-fleet.ts | AA | 取 HEAD | v3=旧 swarm 版（LocalUnit 旧 API），HEAD=306105c 新契约 |
| src/alliance/director-policy.ts | UU | 取 HEAD | v3 缺 306105c 生产控制核回流，HEAD 超集 |
| src/alliance/runtime/central-shadow-runtime.ts | AA | 取 HEAD | v3 缺 strategic profile hot-switch（742c5c5），HEAD 超集 |
| src/alliance/runtime/shadow-policy-adapter.ts | AA | 取 HEAD | v3 缺 hot-switch；no-fire 在 HEAD 有等价实现（见备注） |
| src/sim/alliance/types.ts | UU | 取 HEAD | v3 仅删 taskForces 注释，功能一致 |
| src/intel/refill-predictions.ts | AA | 取 HEAD | v3 缺 P0 修复（d609326：3000 窗口 + avgAbsent SSOT），HEAD 超集 |
| src/planning/planning-snapshot.ts | UU | 取 HEAD | v3 删注释，功能一致 |
| src/planning/task.ts | UU | 取 HEAD | v3 删 freeze fix 注释，代码一致 |
| test/alliance-central-runtime.test.ts | AA | 取 HEAD | v3 少 72 行（hot-switch 测试缺失） |
| test/alliance-shadow-cli.test.ts | UU | 取 HEAD | HEAD 断言新战略 profile 行为；v3 独有 watchdog 断言视 watchdog 合并结果定 |
| test/local-fleet.test.ts | AA | 取 HEAD | v3 测旧 LocalUnit API，HEAD 测新契约 |
| test/min-cost-assignment.test.ts | AA | 取 HEAD | v3 旧 swarm 测试，HEAD 新 backport 测试 |
| test/refill-predictions.test.ts | AA | 取 HEAD | v3 少 27 行（P0 断言缺失） |

### 类 2：生产热修核心文件 → 双向合并（逐冲突块判断）

| 文件 | 冲突块 | 解决方式 | 理由 |
|------|--------|---------|------|
| src/strategies/safety-planner.ts | 31 | 双向合并 | v3：clearance/幽灵矿/ranger/巡逻转方位；HEAD：匈牙利/Hungarian 接线 |
| src/strategies/safety-planner-config.ts | - | 双向合并 | v3 独有 harvestMemoryFreshTicks 参数必须保留 |
| src/strategies/variant-registry.ts | - | 双向合并 | 必须 45 项（3 孤儿变体 + freshTicks 在案） |
| src/app/tenant-runtime.ts | - | 双向合并 | v3：command-plane；HEAD：central shadow |
| src/app/tenant-supervisor.ts | - | 双向合并 | v3：单租户自重启 ca679d2；HEAD：central shadow |
| src/cli/run-supervisor.ts | - | 双向合并 | v3：no-fire roster 通道；HEAD：hot-switch |
| src/app/debug-server.ts | - | 双向合并 | 待读块 |
| src/planning/deterministic-planner.ts | - | 双向合并 | RECOVERY 产兵同主题双实现→核对等价 |
| src/planning/mission-planner.ts | - | 双向合并 | v3：工人外出/ranger 打野风筝；HEAD：migration-scout |
| src/planning/worker-task-planner.ts | - | 双向合并 | v3：ranger 打野/风筝 da4c24f；HEAD：匈牙利 backport |
| src/domain/world.ts | - | 双向合并 | 待读块 |
| src/domain/nav.ts | - | 双向合并 | 远距 goto 同主题双实现→HEAD 为主核对 |
| scripts/arena-watchdog.sh | - | 双向合并 | v3：watchdog 枚举 f7d77eb + 单租户自重启 ca679d2 |

### 类 3：command-center → 优先 HEAD，v3 独有修复手工带入

| 文件 | 解决方式 | 理由 |
|------|---------|------|
| packages/command-center/lib/map.ts | HEAD 为主 + v3 幽灵矿过滤若在 | v3 仅同步合并提交，HEAD 领先 |
| packages/command-center/server.ts | HEAD 为主 | v3 有 command-plane（已由 HEAD 侧实现？需核对） |
| packages/command-center/web/scripts/cc-regression.mjs | modify/delete | 看 v3 改动内容定 |

### 类 4：测试文件 → 内容合并

| 文件 | 解决方式 |
|------|---------|
| test/supervisor.test.ts | 双向合并（v3 watchdog 枚举适配必须保留） |
| test/deterministic-planner.test.ts | 双向合并 |
| test/human-override.test.ts | 双向合并 |
| test/mission-planner.test.ts | 双向合并 |
| test/resource-routing.test.ts | 双向合并 |
| test/worker-patrol-no-core.test.ts | 双向合并 |

### 类 5：杂项

| 文件 | 解决方式 |
|------|---------|
| packages/arena-agent/package.json | diff 后合并两边独有项 |
| packages/arena-agent/scripts/core-migrate-driver.mts | 双向合并（v3 让位单步化 9fc107b 等） |

## 遗留（拿不准/待定）

（空）

---

# PROGRESS — L-A 模拟器效率与并行利用率优化（执行型，2026-08-09）

工作树：arena-ts 主树 main（HEAD e4bac2e）。并行线：L-B 评测公正性审计 / L-C SDK 层 /
L-D 网站。地界：`packages/arena-agent/src/sim/`、`src/cli/`、`src/planning/`、`src/runtime/`、
`scripts/`、`run-arena-report.mts` 及配套；不改 packages/arena-hero-ts 与 reference/ 任何文件；
`run-sim-server.ts`/`deterministic-planner.ts`/`telemetry.ts`/`safety-planner.ts` 等 7 个 WIP
文件只读不碰。评测公共数据 `data/runs/sim/arena-bench-v2-*` 只读。

## 开工回执（2026-08-09）

- 目标：15 场全量评测（--pipeline --shard i/5）端到端再降 ≥20%，与串行逐字节一致
  （diff 仅 generatedAt/wallMs）；2330+ 测试全绿硬基线；报告 + PROGRESS + commit/push。
- 顺序：①前置测量（桥消息体大小/序列化解析占比、DECISION_BUDGET_MS 影响、桥冷启动占比）
  → ②实现收益最大的一个无损抓手 → ③同 seed 逐字节验证（≥2 场）→ ④完整 5 分片评测
  → ⑤报告 + 测试 + push。
- 最大风险：状态投影破坏逐字节一致性（字段子集被 agent 读取）；桥跨场复用泄漏记忆；
  WIP 文件冲突（已确认 7 个 dirty 文件全在并行会话手中，本线只读）。
- 禁止：有损近似、改测试放宽断言、动 data/runtime/。连败 3 次换抓手。

## 进度（2026-08-09，测量阶段完成）

### 前置测量（探针：ffa-std seed=1 1000tick 10 玩家 --pipeline，45-54s/场）

| 项 | 数据 | 结论 |
|---|---|---|
| 桥请求体大小 | p50=3.25KB / p90=5.5KB / max=9.3KB | 很小 |
| Python 侧 parse/validate/dump | parse 0.05ms + validate 0.13ms + dump 0.08ms ≈ 0.3ms | 占决策周期 <3% |
| TS 侧序列化 | p50=0ms（JSON.stringify） | 可忽略 |
| 桥 await 阻塞（pipeline 稳态） | p50=0ms / p90=3ms / p99=19ms | 流水线有效 |
| Python 冷启动 | 8 进程 × ~630ms ≈ 5s/场 ≈ 11% 端到端 | >10% 阈值，候选 |
| 每 tick 分阶段 | decision 22.3ms + settlement 2.4ms + prefetch 21.5ms + record 0.2ms = 46.5ms | 见下 |
| prefetch 构成 | **ts-aggressive（内置 DeterministicPlanner）16.4ms** + ts-safety 1.5ms + 8 Python 观察 ~0.4ms×8 | ts-aggressive 35% |
| decision 构成 | waaiging 等待 avg 11.6ms（p50=0.67 / p99=334ms 长尾）+ waaiging-agg 3.8ms + core-mil 4.4ms + validate/hash | 长尾来自第三方 agent |

### 抓手判定（2026-08-09）

- **Lever 1 状态投影 → 放弃**：消息体 3-9KB、解析 <0.3ms（<3%），收益远低于 10% 阈值。
- **Lever 2 决策窗口 → 放弃**：arena-bench 路径不传 decisionBudgetMs（runFreeForAll 无此参数）；
  护栏仅 sim-server 服务模式（WIP 文件），对 bench 零影响。
- **Lever 3 桥跨场复用 → 量化通过**：冷启动 ~11% 端到端，为候选实现项。
- **新发现（episode 层调度优化）**：ts-aggressive 的 16.4ms 同步 prefetch 计算挡在 8 个
  Python 桥提交之前（提交序 = tenant 序），waaiging/waaiging-agg 的请求晚 ~17ms 发出，
  决策等待被放大。若把桥提交提到内置 planner 同步计算之前（请求序列逐 tenant 不变，
  逐字节一致），waaiging-agg/core-mil 系统性等待有望归零 → 预期端到端 -30%+。

## 进度（2026-08-09，实现+验证完成）

### 实现（P4g+，随 735c6c5 合入 main）

- `runtime/decision-types.ts`：PlanProvider 新增可选 `parallelPrefetch?: boolean`
  （缺省 false = 同步计算；真异步桥置 true）。
- `sim/opponent/opponent-adapter.ts`：OpponentAdapter.parallelPrefetch = decider 原生
  实现 prefetch/decideCached 时 true。
- `sim/harness/episode.ts`：pipelinePrefetchOrder 两遍提交（真异步桥先、同步计算后，
  组内保持原序）。只改调度顺序——每 tenant 请求内容/序列不变，逐字节一致。

### 验证（2026-08-09，全部实测）

- **逐字节一致性**：优化前 pipeline vs 优化后（probe-b1 vs o1）diff=1（仅 generatedAt）；
  串行 vs 优化后（probe-s1 vs o1）diff=1（仅 generatedAt）——2 场同 seed 过验收线。
- **加速**：单场探针 46-54s → 33s（1.4-1.6×）；**15 场全量（5 分片并行 + merge）
  143s+2s = 145s** vs 基线 4-5 分钟（1.7-2.1×，errors=0）。
- **门禁**：`pnpm -r check` 全绿（tsc + sim isolation + 全量 2330 测试 0 失败）。
- 报告：`docs/analysis/perf-optimization-2026-08-09.md`（前置测量表/实现/加速/放弃项）。
- 放弃：状态投影（<3%）、决策窗口（bench 路径无此参数）、桥跨场复用（~11%，低于
  已实现的调度优化）；详见报告 §4。
- 遗留：ts-aggressive 16.4ms/tick（WIP 文件只读）、arena-evolve 每 tick 写盘
  （slotEvery 顺手项）、waaiging 长尾（第三方只读）——报告 §5。
