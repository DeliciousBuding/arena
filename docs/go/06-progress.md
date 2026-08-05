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
