# docs/ — TS 公共文档

本目录收录面向使用者的公开文档：运行时、SDK、协议与规则。项目状态与运维记录
不随本公开仓镜像，保留在部署侧仓库。

> 官方文档提供中文与英文站点（同源同版本）；本目录以英文 bundle 为准。

## 本仓公共文档

| 要做什么 | 读 |
|----------|----|
| 项目目标与策略评估 | `GOAL.md` |
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

公共文档头部保留来源 revision；更新时按规则版本门禁核对，禁止混版本使用。
