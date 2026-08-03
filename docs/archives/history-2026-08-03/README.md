# 历史归档：2026-08-03 治理

> 本目录存放 2026-08-03 仓库治理时归档的历史叙事文档。**它们不是当前事实源**——
> 当前进度以 `docs/progress/MASTER.md` 为准，迁移计划以 `docs/migration-plan.md` 为准，
> 规则以 `docs/game-rules.md`（v0.11）为准。本目录仅供追溯。

## 归档清单

| 文件 | 原位置 | 性质 |
|------|--------|------|
| `architecture-review-gpt-2026-08-02.md` | `docs/` | GPT 架构评审原文存档（1179 行） |
| `prompt-gpt-architecture-review.md` | `docs/` | 评审输入 prompt（一次性） |
| `slice4-progress-gpt-review-2026-08-03.md` | `docs/` | 切片 4 进度报告（已并入 MASTER） |
| `handoff-gpt-2026-08-03.md` | `docs/` | 交接文档（内容已被 MASTER 吸收） |
| `handoff-pi-llm-bridge.md` | `docs/` | Python RPC 桥交接（方案已被 #8 裁决否定） |
| `RESEARCH-NOTES.md` | `docs/` | 旧权威记录（被 MASTER 取代） |

## 引用方（已更新为指向本目录）

- `docs/migration-plan.md` §4 → 本目录 `architecture-review-gpt-2026-08-02.md`
- `docs/differential-record-v1.md` 头部 → 本目录 `architecture-review-gpt-2026-08-02.md`

## 未来归档约定

- 一次性评审/交接/handoff 文档默认进 `docs/archives/history-<date>/`，不留在 docs/ 根。
- 归档后必须更新所有引用方，避免坏链接（由 `scripts/docs_health.py` 门禁）。
