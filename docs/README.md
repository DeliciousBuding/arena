# docs/ — 离线权威文档

同步自 `arena-hero` skill 内置 bundle（上游核对日 2026-08-02）。**规则单源 `game-rules.md` 已手工升级到 v0.11**（sync_docs.py 按版本比较保护：docs 领先时保留 docs 并告警，skill 更新后自动同步）。bundle 其余文档为 v0.10（待 skill 更新后同步）。

> 官方中文站（doc.arenahero.io/zh-Hans）与英文站同源同版本；本目录保留英文 bundle，
> 抓取中文明文会命中边缘缓存洞（偶发 8KB 空壳响应），故放弃，需要时以本目录 + 线上英文站为准。

## 项目自管文档（导航）

| 要做什么 | 读 |
|----------|----|
| 当前进度 / 门禁 / 未通过项 | `progress/MASTER.md` |
| **TS 当前执行计划 / 6 周波次 / Issue-ready backlog** | `ts-execution-plan.md` |
| TS 迁移计划 W0-W6 切片 | `migration-plan.md` |
| 长期能力愿景 W7-W18（非当前 backlog） | `roadmap-long-term.md` |
| 项目目标与商店战略 | `GOAL.md` |
| 限流与并发边界 | `LIMITS.md` |
| 架构（Python 退役参考 + TS 主线） | `ARCHITECTURE.md`、`ts-architecture.md` |
| 本地模拟器运行 / 校准 / A-B / benchmark | `simulator.md` |
| 本地模拟器历史计划（Digital Twin） | `archives/spec-driven-2026-08-03-sim/` |
| 模拟器验收清单 | `digital-twin-acceptance.md`（S8/S9 逐项核验） |
| 历史归档（评审/交接/旧记录） | `archives/history-2026-08-03/`（索引见该目录 README） |
| 生成状态（测试数单源） | `generated/status.md`（gen-status 生成，勿手改） |

## 规则契约（skill bundle 同步源）

| 要做什么 | 读 |
|----------|----|
| 任何规则依赖的战术/对战 | `game-rules.md`（v0.11 全量）+ `reference-numbers.md`（速查） |
| 写/改 Python 战术 | `sdk-quickstart.md` → `sdk-reference.md` → `tactic-authoring.md` |
| 术语对照 | `reference-glossary.md` |
| 协议/前端/原生客户端 | `agent-quickstart.md` → `agent-command-loop.md` → `api-*.md`（openapi/asyncapi.yaml 在 .agents/skills/arena-hero/references/ 根） |
| 直接操作模式 | `direct-play.md` |
| 版本与兼容性 | `reference-source-and-version.md`、`reference-changelog.md` |

## 文件清单

- 规则：`game-rules.md`、`reference-numbers.md`、`reference-glossary.md`
- SDK：`sdk-quickstart.md`、`sdk-reference.md`、`tactic-authoring.md`、`direct-play.md`
- Agent/API：`agent-quickstart.md`、`agent-command-loop.md`、`api-overview.md`、`api-websocket.md`、`api-commands.md`、`api-state-model.md`、`api-resolution-results.md`、`api-errors.md`
- 版本：`reference-source-and-version.md`、`reference-changelog.md`
- 项目自管：`GOAL.md`、`LIMITS.md`、`migration-plan.md`、`ts-execution-plan.md`、`roadmap-long-term.md`、`ARCHITECTURE.md`、`ts-architecture.md`、`simulator.md`、`digital-twin-acceptance.md`、`progress/MASTER.md`、`archives/`

## 更新方式

```bash
python scripts/sync_docs.py   # 从 .agents/skills/arena-hero/references/ 覆盖同步
python scripts/docs_health.py # 文档健康门禁（版本分叉/相对时间/坏链接/超大文件）
```

skill 更新后重跑；若线上契约版本高于 v0.10，先更新 skill 再同步，禁止混版本使用。
