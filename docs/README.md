# docs/ — TS 公共文档

本目录保留可随 `arena-ts` 公开的运行时、SDK、协议和规则文档。项目状态、运维、
设计变更与迁移记录不随本公开仓镜像，保留在内部协调仓库；本目录只收录面向使用者的
公开文档。

> 官方中文站（doc.arenahero.io/zh-Hans）与英文站同源同版本；本目录保留英文 bundle，
> 抓取中文明文会命中边缘缓存洞（偶发 8KB 空壳响应），故放弃，需要时以本目录 + 线上英文站为准。

## 本仓公共文档

| 要做什么 | 读 |
|----------|----|
| 项目目标与商店战略 | `GOAL.md` |
| 限流与并发边界 | `LIMITS.md` |
| 已退役 Python 架构快照 | `ARCHITECTURE.md` |
| Arena Hero 规则 | `game-rules.md` |
| SDK 使用 | `sdk-quickstart.md`、`sdk-reference.md` |
| Agent 与协议 | `agent-quickstart.md`、`agent-command-loop.md`、`api-*.md` |
| 直接操作与证据格式 | `direct-play.md`、`differential-record-v1.md`、`efficiency-trace-v1.md` |

## 规则契约（skill bundle 同步源）

| 要做什么 | 读 |
|----------|----|
| 任何规则依赖的战术/对战 | `game-rules.md`（上游同步源在 `reference/`，头注含 revision） |
| SDK 客户端 | `sdk-quickstart.md` → `sdk-reference.md` |
| 协议/前端/原生客户端 | `agent-quickstart.md` → `agent-command-loop.md` → `api-*.md` |
| 直接操作模式 | `direct-play.md` |

## 文件清单

- 规则：`game-rules.md`
- SDK：`sdk-quickstart.md`、`sdk-reference.md`、`direct-play.md`
- Agent/API：`agent-quickstart.md`、`agent-command-loop.md`、`api-overview.md`、`api-websocket.md`、`api-commands.md`、`api-state-model.md`、`api-resolution-results.md`、`api-errors.md`
- 项目自管：`GOAL.md`、`LIMITS.md`、`ARCHITECTURE.md`

## 更新方式

上游文档的来源仓库位于 `../../reference/`。同步后必须保留每份公共文档头部的来源 revision，并按共享 MASTER.md 的规则版本门禁核对，禁止混版本使用。
