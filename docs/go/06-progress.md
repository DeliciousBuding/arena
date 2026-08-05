# 进度跟踪（06）

> 状态：进行中。本文档是 Go 重写分支的进度 SSOT（与主线 `docs/progress/MASTER.md` 无关，
> 不合并、不覆盖）。每批完成即更新；差异日志是行为漂移的唯一记录。

## 批次状态

| 批 | 内容 | 状态 | 用例数 | 覆盖率 | 差异日志 |
|---|---|---|---|---|---|
| B1 | 地基（go.mod/骨架/门禁/CI/version） | ✅ `229fa77` | 7 | 100%（version） | — |
| B2 | contracts + 黄金对齐 | ✅ `8a322b4` | 48 函数/192 用例 | 95.9% | — |
| B3-A | hero 协议客户端 | ✅ `f39c662`+ | 测试全绿（WS fake server） | — | — |
| B3-B | domain（reducer/nav/world/validator/hash） | ✅ `f39c662` | 测试全绿（100-tick 回放） | — | — |
| B3-C | telemetry | ✅ `8a322b4` | 测试全绿 | — | — |
| B4-A | strategy（纵向切片最小版） | ✅ `f39c662` | 回放全合法 | — | 见差异日志 |
| B4-B | mapstore | ✅ `8a322b4` | 17（含 6 子用例 23） | 84.9% | — |
| B5-A | runtime（loop 最小版已接） | 🔄 lease/coordinator 待补 | — | — | — |
| B5-B | llm（agent 延后，05 裁决） | ✅ llm 测试全绿 | — | — | — |
| B6 | policy 决策 + harness | ⬜ 延后（先真机闭环） | — | — | — |
| B7-A | ops（锁/supervisor/health） | ⬜ | — | — | — |
| B7-B | sim（延后，复用 TS Simulator） | ⬜ | — | — | — |
| B8 | cmd 集成 + 回放/差分 + 真机 | 🔄 replay 通过；真机 shadow 待跑 | — | — | — |
| B9 | 部署（镜像/systemd/CI release） | ⬜ | — | — | — |
| B10 | 验收收尾与归档 | ⬜ | — | — | — |

## 真机证据记录（t3/t4）

| 日期 | 步骤 | 证据（run/manifest/JSONL 路径） | 结果 |
|---|---|---|---|
| 2026-08-05 | t3 真机 shadow（首轮，10 tick） | `runtime/t3/telemetry/{runtime,decision}.jsonl` | ✅ 连接成功，tick 52455–52460 连续处理，每 tick 1 action + core，全部 valid、0 repair |
| 2026-08-05 | t3 真机 shadow（debug 轮，15 tick） | `runtime/t3/shadow-debug.log` + telemetry | ✅ 15/15 完整跑完，`tenant stopped ticks=15 submits=0 rejected=0 repaired=0`，干净退出 |
| 2026-08-05 | t4 真机 shadow（15 tick） | `runtime/t4/telemetry/` | ✅ 15/15（tick 52523–52537，零提交）；**暴露 capacity 满 deposit bug**（repaired=15 → 已修：ResourceSpace<=0 → WAIT） |
| 2026-08-05 | t3 真机 shadow（50 tick 实验） | `runtime/t3/shadow-50t.log` + run-scoped telemetry | ⚠️ 判定修正：**无挂死**。服务器偶发停顿 30–90s 后自动恢复（v7/v8 完整收口证实） |
| 2026-08-05 | t3 真机 shadow v7（25 tick） | `runtime/t3/shadow-25t-v7.log` + run-...193725 | ✅ **25/25 完整**：`tenant stopped ticks=25 submits=0 rejected=0 repaired=0`，干净退出 |
| 2026-08-05 | t3 真机 shadow v8（20 tick，--log-file） | `runtime/t3/shadow-20t-v8.log` + run-...194013 | ✅ **20/20 完整**：`ticks=20 submits=0 rejected=0 repaired=0`；经历 2 次服务器停顿（含 90s）自动恢复；零缓冲日志与 decision.jsonl 交叉一致 |
| 2026-08-05 | t4 固定策略实验 wt=2（shadow） | `runtime/t4/policy-wt2.log` + run-...194805 | ✅ **spawn 意图 0%**（7 tick；2 workers >= workerTarget=2 不 spawn）——workerTarget 接线验证 |
| 2026-08-05 | t4 固定策略实验 wt=8（shadow） | `runtime/t4/policy-wt8.log` + run-...195009 | ✅ **spawn 意图 100%**（7 tick；2 workers < workerTarget=8 且 resources>=cost+reserve 持续 spawn）——**接线对比成立** |
| 2026-08-05 | t4 真机 100t（新默认参数，shadow） | `runtime/t4/runs/run-20260805T121419/` + `e7-refill-100t.log` | ✅ **100/100 tick 零提交零 repair 干净退出**：`ticks=100 submits=0 rejected=0`；模式 GROWTH=30→EXPLORE_STARVED=70（t4 资源采空后 30t 无进展触发，符合预期）；动作 MOVE=352/WAIT=41 全 valid；unit moves 36/99t 无停滞；world enemies 4.5/tick；workers 4→3（敌方击杀，战斗真实场景） |
| 2026-08-05 | **t4 长期 shadow 常驻（持续运行中）** | `runtime/t4/runs/run-20260805T124841/` + `longrun.log` | ✅ **600+ ticks 持续稳定**：0 ERROR、0 repaired、进程 ALIVE（PID 68264）；数据收集线 `C:\Users\Ding\tmp\arena-tenants-monitor.log` 每 2 分钟采样 |
| 2026-08-05 | **t3 长期 shadow 常驻（补启动，持续运行中）** | `runtime/t3/runs/run-20260805T153401/` + `longrun.log` | ✅ 启动即产出；**双租户并行常驻**：t3/t4 各自独立进程（arena-ten-t3 / arena-ten）、独立 run/锁；监控循环双采样 ALIVE |

## 差异日志（行为漂移唯一记录）

> 规则：任何与 TS 版期望不一致的输出必须在此登记：分类（规则升级/修复/服务器私有/
> Go bug）、fixture 区间、理由、豁免范围。未登记的差异 = 未通过。

| 日期 | 分类 | 区间/字段 | 描述 | 处置 |
|---|---|---|---|---|
| 2026-08-05 | 对齐确认 | burnin-a 全 100 tick | 动作分布与 TS 期望**完全一致**：MOVE=317、Core 无（Go 317 / TS 317） | 阶段 A 验收通过 ✅ |
| 2026-08-05 | 有意变更 | burnin-a 全 100 tick | Lane 2 move capacity 仲裁后动作分布 MOVE=317 → MOVE=230+WAIT=87（路径冲突让路）；**valid_plans 保持 100/100、0 repair** | 已记录，仲裁语义见 03-module-spec M4 |

## 当前焦点

- [x] 基线：198 个 TS/Python/Node 文件清出（`2caebdb`）
- [x] 设计定稿：00-intent / 01-architecture / 02-contracts / 03-module-spec /
      04-test-strategy / 05-delivery-plan（2026-08-05）
- [x] B1 地基（`229fa77`）、B2 契约（`8a322b4`，192 用例/95.9%）、B4-B mapstore
- [x] B3-A/B3-B/B4-A 纵向切片（`f39c662`+）：domain/hero/strategy + replay/tenant 命令
- [x] 分支改名 `go-rewrite`（worktree 移至 `.worktrees/go-rewrite`，正式远端 `origin/go-rewrite` 已建 upstream，`03e8c8c`）
- [x] 阶段 A 验收：100/100 tick 回放合法、0 repair、动作分布与 TS 完全一致（MOVE=317）
- [x] 阶段 B 真机 shadow：t3 三轮（10/15/50t）+ t4 一轮（15t）全部连续处理零提交；
      deposit 容量满 bug 已修（t4 暴露）；debug 日志/重连可观测性补齐
- [x] Lane1 收口（`1c0cc39`/`7b61f25`/`03e8c8c`）：World 接主链、run-scoped telemetry、
      稳定幂等键、事件流错误传播、live 双确认 + 单写者锁、gitignore 根锚定修复
- [x] DecisionLease/LeaseRegistry/DeadlineBudget（`7b61f25`，subagent lane，审查通过）
- [x] 单写者锁（`1c0cc39`，subagent lane，含 PID 复用陷阱防护）
- [x] MacroPolicy 纯函数（`7b4946e`，23 函数/65 用例 98.3%）
- [x] TS↔Go 语义同步表 + Canonical Policy（`03e8c8c`）
- [x] Lane 2 经济 Planner（`705e13b`）：worker 全局分配/move capacity 仲裁
      （下一步格粒度）/workerTarget+reserve/respawn override（管理者接管，
      subagent 后台 40min 无产出）；economic_test.go 9 项专项，strategy 97.6%
- [x] hero idle watchdog（`ced8a4d`）：服务器停推不关连接 → 60s 自动断流
      重连（TestIdleTimeoutForcesReconnect）；真机证实服务器偶发停顿
      30–90s 自动恢复，watchdog 为超阈值兜底
- [x] 可观测性诊断链（`9653930`）：连接/消息/阶段计时/30s 静默栈 dump/
      --log-file 零缓冲日志
- [x] 阶段 B 真机完整收口：v7 25/25 + v8 20/20 tick 零提交零 repair 干净退出
- [x] 固定策略接线验证（`b84a688`）：t4 wt=2 spawn 0% vs wt=8 spawn 100%
      （workerTarget 参数真实驱动决策，config→planner→遥测全链路）
- [x] ops health 检查（subagent lane，85% 覆盖）：env/配置/可写性/live 锁
- [ ] sim 结算引擎（subagent 执行中）
- [ ] 3→10→30 tick bounded live（live 三件套已就绪，待用户授权执行）
- [ ] 统一固定 Policy TS/Go 交叉赛马（Canonical Policy 已定义）
- [ ] 低频 LLM MacroPolicy 接线（最后）

## E0 轮（2026-08-05 最新裁决执行）

- [x] E0-1 exactly-once tick（`8a3c86e`）：lastHandledTick 去重（Reduce/Plan/
      Telemetry/Submit 前）、ProcessedTicks 统计唯一 tick、handleState 错误
      （repair/submit rejection）Loop.Run 立即返回；Loop 接口化注入回归；
      3 个回归测试
- [x] E0-2 满仓 Core 占位破锁（`09ed8ac`）：满载 Worker 在 Core + 满仓 →
      确定性让位 MOVE（yield_full_core，UP→RIGHT→DOWN→LEFT 跳过障碍/资源/
      占用格）；t4 真实状态回归（同计划 MOVE 让位 + SPAWN WORKER + valid）
- [x] E0-3 sim SPAWN + outcome 遥测（`6cdc13f`）：SPAWN 结算（资源扣除/容量
      刷新/新 worker 出生）、占位语义（满载不阻止/空载与军事阻止）、结算
      顺序（MOVE 让位→SPAWN）；20-tick 经济闭环测试达成（让位→SPAWN→资源
      降→worker 增→空间恢复→DEPOSIT）；decision 记录含 actionKinds/
      intentCounts/coreAction/resources-workers-cargo delta/
      planned_spawn_no_effect/cargo_blocked

### 真机里程碑（E0 后）
- bounded live：3/3 → 10/10 → 29/30（409 幂等冲突根因=重连重放重复决策，
  E0-1 exactly-once 修复）
- sim 经济闭环：t4 死锁状态 20 tick 内完整破锁（离线确定性验证）

## E1 视野研究 + 停滞根因链（2026-08-05）

- [x] 视野研究（官方 v0.13）：并集视野（Worker 3/Core 5/Vanguard 4/Ranger 5）、
      state 全量快照、资源 4 tick/chunk 配额补满且仅在视野扫过时揭示、
      采空格立即消失、Core 迁移（START_MOVE 4 tick/格）是资源恢复正解
- [x] t4 停滞根因链（提交体实证）：worker 排成一排计划互相踩格 →
      moveToward 占位感知（03e3415）；sim 分列一致性修复（Settle 重建分列）；
      巡逻半径 8→16（8bfa1ca）；首目标 ID 哈希分散（ecda3d4）
- [x] 位置实证：占位感知前 4+ tick 不动 → 修复后 10t 扩散 6-8 格
      （(92-105,76) → (86-111,72)），10/10 accepted 0 repair
- [x] 工具：cmd/mapview ASCII 地图渲染；提交体 debug 日志

### 待办（视野研究指引）
- Core 迁移决策（连续 N tick 零资源 → START_MOVE 朝 beacon/未知 chunk）
- t4 资源发现等待（workers 外扩扫描中）或新地图验证

## E2 决策指挥分层（2026-08-05，f956999）

- [x] Commander 指挥层：GROWTH / EXPLORE_STARVED（30 tick 无进展）/
      MIGRATE_CAND（100 tick，只评估不执行）；economy.stagnant /
      migration.candidate 事件；decision 记录 directiveMode
- [x] 停滞跳出（第二类）：服务器反馈位置连续 3 tick 不变 → 强制换
      巡逻目标（计划合法但结算未生效的拥挤/被占场景）
- [x] EXPLORE_STARVED 扫掠：全部 worker 朝 Beacon 焦点推进（半径环
      扩展 + ID 错开扫掠线）
- [x] 遥测：unitPositions（analyze 移动量指标）；cmd/analyze run
      实验报告工具（模式分布/资源趋势/动作统计/移动量）
- [ ] t4 真机 40t 验证（运行中）

## E2.5 Core 迁移执行路径（2026-08-05，197e0b9）

- [x] PlanToCommandPlan 补 START_MOVE direction（wire 缺口修复）
- [x] domain.CoreAction 加 Direction；decideCore：MIGRATE_CAND +
      EnableCoreMigration（默认 false，红线）→ START_MOVE 朝焦点方向
- [x] Core MOVING 自动停止（不重复发）；3 个迁移测试

## E3 运行监控工具（2026-08-05）

- [x] 工具：cmd/runwatch 运行性能监控（零新依赖，纯 stdlib + os/exec）——
      pid 模式：tasklist /V 采集 RSS（Working Set）与 CPU%（累计 CPU Time
      差值/墙钟，秒级粒度）；log-dir 模式：decision.jsonl 行数（tick 进度）
      + 最新 *.log 尾部 200 行 ERROR/WARN 计数；Ctrl+C 输出平均/峰值 RSS、
      运行时长、tick 速率汇总（stdout 纯 TSV，汇总走 stderr）

## E5 100t 里程碑（2026-08-05，run-20260805T104905）

- [x] 100/100 accepted、0 rejected、0 repaired（t4 真机最长窗口）
- [x] 指挥层全链路：GROWTH=30 → EXPLORE_STARVED=70 实机验证
- [x] unit moves 393/99 ticks——移动完全正常（停滞问题彻底解决）
- [x] obs idle.dump 落盘验证（服务器 2 分钟停顿期间，dumps/*.stack）
- [x] cmd/paramscan 参数扫描（reserve=8 死锁发现 + 钳制修复 00447bf）
- [x] cmd/runwatch 进程/日志监控（e68ea54，8 单测）
- [x] migration.candidate 边界验证（105t 运行中：100 no-progress 需
      101 tick，首个 Update 为基线）

## E6 综合优化（2026-08-05，neat-freak）

### 模拟退火参数优化（cmd/optsearch）
- [x] 智能搜索（模拟退火，400 迭代 × 多资源格 6 格 sim 闭环 100 tick 评分）
- [x] 默认参数产出 +26%：spawnReserve 5→2（减少攒资源浪费）、
      exploreRadius 16→22（更快发现远处资源格）、
      populationCeiling 20→30（高产能下允许更多工人）
- [x] 确定性种子（20260805）可复现；离线优化运行时零开销
- [x] 回归：population ceiling 测试边界同步更新（30 而非 20）
- [x] 提交：`623dec7`（feat）、`81f43ea`（test）

### 螺旋覆盖探索（starved patrol 升级）
- [x] 从直线扫掠升级为环形螺旋覆盖（64 方位角分辨率）
- [x] 方位角 = focus 方位 + ID 哈希 + 环进度 angle（个体分散覆盖不同方位）
- [x] 角步长按 radius 缩放（环越大步长越大，覆盖密度恒定）
- [x] 走完一圈 ring+1，半径 22→44→66→88（88 后重置环 0）
- [x] 相比直线扫掠：不漏环间区域，探索覆盖率最大化
- [x] 提交：`08a98a0`

### 遗传算法参数搜索（cmd/optsearch --ga）
- [x] 种群 20 个体 × 40 代锦标赛选择 + 均匀交叉 + 变异
- [x] 同评分函数（多资源格 sim 闭环 100 tick）
- [x] 结果：`{workerTarget:11 spawnReserve:2 exploreRadius:14 populationCeiling:28} score=142`
      与模拟退火同分（142），不同局部最优——退火偏探索半径（22），GA 偏工人数（11）
- [x] 确定性种子可复现

## E8 战斗闭环 + 多场景评分（2026-08-05）

### sim 战斗结算（subagent lane，ba2dd68）
- [x] `internal/sim/combat.go`：Ranger SHOOT（5 格 Chebyshev + LineBlocked
      视线、target_id 精度/空格最低 HP）、Vanguard SWEEP（相邻格 AOE、
      敌 Core 受击）、伤害同时应用（战斗快照语义）、死亡移除
- [x] Settle 顺序：MOVE → HARVEST/DEPOSIT → COMBAT → Core SPAWN
- [x] SettleStats 新增 Kills/ShotsFired/SweepsFired；8 项测试
- [x] 集成测试：planner SWEEP 两 tick 击杀闭环、Ranger SHOOT 击杀
      （combat_integration_test.go，840a101）

### planner 战斗意图（3a281b8）
- [x] Vanguard 相邻敌 → SWEEP（AOE，比 engage 逼近优先，确定性顺序
      UP→RIGHT→DOWN→LEFT）；3 项测试
- [x] 军事生产（2ca2c9b）：worker 达 WorkerTarget 后按 MilitaryRatio
      （默认 25%）补 Vanguard/Ranger 交替（防御优先）；3 项测试

### 多场景评分（subagent lane，7c89d0d）
- [x] optsearch 升级三拓扑最差分：base（fixture 6 格）/ dense（8 格）/
      sparse（3 格 + 障碍），score = 最低分（鲁棒性优先）
- [x] 冒烟：默认 {8,5,16,20} 三场景 {129,120,83}，最差 83 由 sparse 决定
- [x] 全量搜索：SA {13,0,17,16}=110、GA {13,0,10,19}=110（默认 83，+33%）
      ——共识 workerTarget=13、spawnReserve=0
- [x] DefaultConfig 落地（f124e88）：workerTarget 13、spawnReserve 0、
      populationCeiling 16、exploreRadius 17、MilitaryRatio 25

### 真机验证（run-20260805T121419，100t）
- [x] t4 真机 100t 零提交零 repair 干净退出（新默认参数
      workerTarget=13/spawnReserve=0/MilitaryRatio=25）
- [x] 模式 GROWTH=30→EXPLORE_STARVED=70（t4 资源采空后 30t 无进展
      触发，符合预期）；economy.stagnant 事件持续
- [x] 动作 MOVE=352/WAIT=41 全 valid；unit moves 36/99t 无停滞；
      world enemies 4.5/tick；workers 4→3（敌方击杀）

## E7 游戏逻辑利用 + 振荡修复（2026-08-05）

### refill 引擎（官方 v0.13 落地）
- [x] `internal/sim/refill.go`：每 4 tick chunk 配额补满
      `max(2, floor(128/(8+ring)))`，视野揭示，采空格立即消失
- [x] `internal/sim/vision.go`：并集视野 Worker 3 / Core 5 /
      Vanguard 4 / Ranger 5（Chebyshev）
- [x] `internal/sim/economy.go`：harvest 成功后格从 ResourceCells 移除
- [x] `internal/sim/engine.go`：Engine.Refill 可选挂载（nil = 纯结算，
      fixture 回放路径不变）
- [x] refill_test.go 8 项（reveal/mined/配额/集成/视野数值）

### planner 振荡/死循环修复（refill 真实化后暴露）
- [x] 排队不绕行：moveToward 不再把己方单位并入 BFS 障碍——拥挤时
      绕行路径每 tick 变化 → 横跳振荡；理想第一步被占 → WAIT 排队
- [x] 目标被占走相邻格等待（不横跳远离）
- [x] 仲裁降级的空载 worker 在 Core 上 → 让位（yield_core_wait）：
      deposit 完的空载 worker 堵仓库口，满载进不来
- [x] Core 格路径语义：目标非 Core 时 Core 视为障碍（探索路径不穿越
      仓库口）
- [x] 实证：8 格 refill 闭环 60 tick H=17 D=13 S=4 workers 2→6
      （修复前 t10 后经济冻结）
- [x] 提交：`fd05415`

### 参数优化升级（refill 评分）
- [x] optsearch 挂载 refill 引擎（optLatentResources 12 格池）
- [x] 旧模型 SA/GA 同分（单格场景参数平坦）；refill 模型区分度显现：
      默认 129 分 → SA `{6,1,16,21}`=174（+35%）、GA `{10,1,22,13}`=174
- [x] 双算法共识：spawnReserve=1（refill 下资源持续流入）
- [x] DefaultConfig 落地：workerTarget 8→6、spawnReserve 5→1、
      populationCeiling 20→21（`c7d22ab`）
- [x] mapview -vision 视野圈叠加（cmd/mapview/main.go）

### Rust+Go 融合线对接准备（2026-08-06，用户裁决：go 侧整理对接、不冲突、届时 merge）

状态：go-rewrite 稳定运行中（t3/t4 双租户 shadow，新激进策略 `2f00793`）；
rust-rewrite/sim-rs F1（arena-sim-ffi crate）已完成，Go 侧 F2 adapter 半成品
（执行线 agent 所写，编译失败）备份在 `C:\Users\Ding\tmp\ffi-backup-20260806\`
（`ffi_planner.go` / `ffi_planner_windows.go` / `ffi_planner_test.go`）。

对接契约兼容性验证（Go 侧零改动即可满足，融合线 fusion-line.md §2）：
- Planner 接口：`runtime.Planner{Decide(*domain.TickState) *domain.Plan; ApplyDirective(strategy.Directive)}`
  （loop.go:69）与 FfiPlanner 实现目标一致；
- TickState JSON：Go 默认字段名 = PascalCase（无标签），`Set[T]` map 序列化为
  `{"x,y":{}}` 对象形状——与 Rust `StateJsonIn`（PascalCase + BTreeMap 镜像）
  完全匹配；`ID` 字段 Go 输出 "ID"（Rust 侧已备 alias）；
- Directive JSON：`{"Mode":"GROWTH","Focus":[0,0]}` 与 Rust serde 期望一致；
- fail-safe：dll 加载失败/err_out 非空 → 回退 Go planner（F2 待实现）。

merge 注意事项：F2 文件恢复时须对齐当前 strategy 包（激进产兵后的
MilitarySpawnFloor 等新字段）——Rust `Config` 反序列化需容忍未知字段。
