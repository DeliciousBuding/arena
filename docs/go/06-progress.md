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
| 2026-08-05 | t3 真机 shadow（50 tick 实验） | `runtime/t3/shadow-50t.log` + run-scoped telemetry | 🔄 运行中（tick 52582，World 记忆/workers 观测字段已加） |

## 差异日志（行为漂移唯一记录）

> 规则：任何与 TS 版期望不一致的输出必须在此登记：分类（规则升级/修复/服务器私有/
> Go bug）、fixture 区间、理由、豁免范围。未登记的差异 = 未通过。

| 日期 | 分类 | 区间/字段 | 描述 | 处置 |
|---|---|---|---|---|
| 2026-08-05 | 对齐确认 | burnin-a 全 100 tick | 动作分布与 TS 期望**完全一致**：MOVE=317、Core 无（Go 317 / TS 317） | 阶段 A 验收通过 ✅ |

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
- [ ] Lane 2 经济 Planner：worker 全局分配/move capacity/workerTarget/respawn override（subagent 执行中）
- [ ] 50-tick shadow 实验结果收口（运行中）
- [ ] workerTarget=2/8/16 固定策略 shadow（Lane 2 后）
- [ ] 3→10→30 tick bounded live（live 三件套已就绪）
- [ ] 统一固定 Policy TS/Go 交叉赛马（Canonical Policy 已定义）
- [ ] 低频 LLM MacroPolicy 接线（最后）
