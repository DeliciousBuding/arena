# docs/ — 离线权威文档

同步自 `arena-hero` skill 内置 bundle（上游核对日 2026-08-02，规则 **v0.10** / SDK **0.2.6**，与线上 `doc.arenahero.io/reference/source-and-version` 一致）。

> 官方中文站（doc.arenahero.io/zh-Hans）与英文站同源同版本；本目录保留英文 bundle，
> 抓取中文明文会命中边缘缓存洞（偶发 8KB 空壳响应），故放弃，需要时以本目录 + 线上英文站为准。

## 按任务选读

| 要做什么 | 读 |
|----------|----|
| 任何规则依赖的战术/对战 | `game-rules.md`（全量）+ `reference-numbers.md`（速查） |
| 写/改 Python 战术 | `sdk-quickstart.md` → `sdk-reference.md` → `tactic-authoring.md` |
| 术语对照 | `reference-glossary.md` |
| 协议/前端/原生客户端 | `agent-quickstart.md` → `agent-command-loop.md` → `api-*.md` + `openapi/asyncapi.yaml`（在 skill references） |
| 直接操作模式 | `direct-play.md` |
| 版本与兼容性 | `reference-source-and-version.md`、`reference-changelog.md` |

## 文件清单

- 规则：`game-rules.md`、`reference-numbers.md`、`reference-glossary.md`
- SDK：`sdk-quickstart.md`、`sdk-reference.md`、`tactic-authoring.md`、`direct-play.md`
- Agent/API：`agent-quickstart.md`、`agent-command-loop.md`、`api-overview.md`、`api-websocket.md`、`api-commands.md`、`api-state-model.md`、`api-resolution-results.md`、`api-errors.md`
- 版本：`reference-source-and-version.md`、`reference-changelog.md`

## 更新方式

```bash
python scripts/sync_docs.py   # 从 .agents/skills/arena-hero/references/ 覆盖同步
```

skill 更新后重跑；若线上契约版本高于 v0.10，先更新 skill 再同步，禁止混版本使用。
