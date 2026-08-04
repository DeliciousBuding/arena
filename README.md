# Arena Go

Arena Hero 自主决策系统的**纯 Go 实现**（独立分支 `feature/go-macro-policy`，与 TS 主线平行）。

在硬实时截止、部分可观测、长期经济目标和不可信智能组件条件下，能够安全运行、持续评估和自我改进的自主决策系统。

## 特性

- 纯 Go 静态二进制，零 CGO、零 Node/Python 依赖；
- 单写者锁 + DecisionLease（runId/tick/stateHash 三重校验）安全治理；
- AgentLoop + Harness（LLM 低频战略层），Agent 永不持有游戏提交权；
- SQLite WAL 跨进程知识层、JSONL 遥测（脱敏）、Runtime-Golden 回放；
- supervisor 多租户进程管理，Docker + systemd 部署。

## 快速开始

```bash
go build -o bin/arena ./cmd/arena
bin/arena version

# 全量门禁（本地与 CI 同一命令）
bash scripts/go-check.sh          # Windows: powershell scripts\go-check.ps1
```

## 文档

- 设计规格：`docs/go/`（00 意图红线 → 05 编排计划 → 06 进度）
- 进度与差异日志：`docs/go/06-progress.md`
- 门禁与检查系统：`docs/go/04-test-strategy.md`

## 安全

- 密钥只从环境变量读取（`ARENA_HERO_API_KEY_*`），永不落盘；
- 仓库为 public：任何 token、绝对路径、个人邮箱禁止入仓（pre-commit hook 强制）。
