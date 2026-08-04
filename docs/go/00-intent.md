# Go 全量重写 · 意图与红线（00）

> 状态：已批准（2026-08-05，用户授权全权负责）。分支：`feature/go-macro-policy`。
> 基线：`2caebdb`（198 个 TS/Python/Node 文件已清出，-47,527 行）。
> 本文档是整个 Go 重写的意图 SSOT，一切实现决策不得违背本节红线。

## 1. 目标（为什么做）

在独立 worktree 分支中，用**纯 Go 全量重写** Arena 运行链——游戏层（协议/领域/决策核心）与
agent 层（AgentLoop + Harness）全部重新设计实现，**不以 1:1 复刻 TS 为目标**。

- **最终目标**：游戏拿资源、稳定运行、可长期无人值守——重写是手段，不是目的；
- **干净实现**：零 TS/Python/Node 残留、零 CGO、静态二进制、单一事实源；
- **完整实现**：覆盖 TS 版全部能力（决策核心、策略、LLM harness、supervisor、遥测、部署），
  并补齐 TS 版缺失的检查系统（race/vuln/契约/回放/故障注入）。

## 2. 可用资源（真机授权）

- 游戏服务器：`https://api.arenahero.io`（官方 Arena Hero）；
- **租户 t3/t4 已授权直接连接与测试**（token 在 `~/.secrets/arena.env` 的
  `ARENA_HERO_API_KEY_3` / `ARENA_HERO_API_KEY_4`，只从 env 读取，永不落盘）；
- t1/t2 未授权，不得连接（除非用户另行批准）；
- 模型网关：newapi（`ARENA_MODEL_BASE_URL` / `ARENA_MODEL_API_KEY`，`~/.secrets/arena.env` 与
  主工作区 `.env`）；
- Golden fixture：`fixtures/`（100 tick 真实回放，含 manifest 与脱敏数据）；
- JSON Schema：`contracts/generated/*.schema.json`（TypeBox 产物，作契约黄金文件）。

## 3. 安全红线（不可违反，违反即失败）

1. **单写者锁**：同一租户只能一个 live writer，拿不到锁直接失败退出，不降级；
2. **Agent 永不持提交权**：LLM/AgentLoop 只通过 `arena_plan` 工具向当前 DecisionLease
   提交候选计划；最终合法性校验、deadline 裁决与 submit 权只在决策核心；
3. **确定性**：同输入 state → 同输出 plan（Golden Replay / 差分门禁保护）；
4. **密钥只从 env 读**：token 永不写入代码、配置、JSONL、manifest、日志；
5. **JSONL 脱敏**：所有遥测落盘前递归脱敏，凭据不落盘；
6. **live writer 不自动重启**：跨进程幂等恢复完成前，live 只告警不拉起；
7. **不把 `INCONCLUSIVE` 写成 `MATCH`**：差分/回放中的未知项必须标 unknown/inconclusive；
8. **不引入 CGO**：modernc.org/sqlite（纯 Go SQLite）、coder/websocket（纯 Go WS）、
   标准库 net/http；任何 CGO 依赖需用户批准；
9. **不引入第二套进程框架/控制面**：supervisor 直接管理子进程，不建中间层。

## 4. 完成定义（代码级对等 + 目标导向）

Go 版"完成"的硬性定义：

1. **代码级对等**：决策链（reducer → planner → validator → coordinator → submit）在
   Golden fixture 上输出与 TS 版逐字段一致（或差异全部有记录在案的理由）；
2. **检查系统全绿**：gofmt / go vet / staticcheck / govulncheck / `go test -race ./...`
   / 契约对齐 / fixture 回放 / 故障注入，全部通过；
3. **真机验证**：t3/t4 依次通过 doctor → deterministic shadow → bounded live canary
   → 常驻 soak（shadow 级由我直接推进，live 每步单独向用户报备）；
4. **部署完整**：静态二进制 Docker 镜像 + systemd 单元 + 回滚脚本 + CI 镜像流水线；
5. **运行目标**：长期稳定运行、资源效率不劣于 TS 版（内存/CPU/提交成功率），
   最终以 t3/t4 真实提交被接受为验收事实（run/manifest/JSONL 证据）。

## 5. 范围边界（明确不做）

- 不做 per-tick LLM 作为默认生产模式（主线已确认关闭：模型延迟 18–57s > 15s tick 窗口）；
  但 AgentLoop/Harness **能力完整实现**（工具循环、abort、budget），运行模式由配置决定；
- 不做形式化验证（Z3/Kani），不建第二套配置中心；
- 不合并回主线（本分支独立演进，最终形态由用户裁决）；
- 不写 token 到任何文件。

## 6. 与 TS 版的架构差异（设计自由度的边界）

以下差异是**有意为之**（干净实现），不是漂移：

| 维度 | TS 版 | Go 版 |
|---|---|---|
| 部署形态 | node:24-slim + npm + tsx | 单静态二进制（无运行时依赖） |
| 并发模型 | 单线程事件循环 + Worker Thread | goroutine + channel（deadline race 用 select） |
| 内存/CPU | Node 常驻 ~50MB/进程 | 目标 <15MB/进程 |
| 类型检查 | tsgo（Go 编译器编译 TS） | go vet + staticcheck + race detector |
| CLI | 多个 tsx 入口 | 单一 `arena` 二进制（supervisor/tenant/doctor/…） |
| 日志 | 自定义 JSONL 写入 | slog + JSON handler（同格式） |
| 供应链 | npm 数百包（undici 高危事故） | ≤3 个经过审计的 Go 依赖 |

其余行为语义（协议、JSON 格式、锁、遥测 schema）与 TS 版保持兼容，以便复用 fixture 与
运维资产。
