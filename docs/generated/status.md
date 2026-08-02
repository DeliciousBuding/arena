# 仓库状态（自动生成）

> 由 `scripts/gen-status.py` 生成，**禁止手工编辑**。每次代码改动后重跑：`python scripts/gen-status.py`。
> 背景：测试数 / commit SHA 曾手工维护于多份文档导致漂移（架构评审 R1），本文件是这些数字的唯一权威来源。

| 指标 | 数值 | 来源命令 |
|---|---|---|
| commit SHA | b8962f20831ae04ea696a56fec3b7b5ec2aa5f17 | `git rev-parse HEAD` |
| Python 测试数 | 135 | `uv run pytest tests/ --collect-only -q`（解析 "N tests collected"） |
| SDK 测试数 | 48 | 统计 `packages/arena-hero-ts/test/*.test.ts` 的 `test(` 调用（剔除 `.test(` 正则方法） |
| 编排层测试数 | 21 | 统计 `packages/arena-agent/test/*.test.ts` 的 `test(` 调用（同上） |
| schema 契约文件数 | 6 | `ls packages/arena-hero-ts/contracts/generated/*.schema.json` 计数 |
| Python 待退役模块数 | 23 | `find src/arena_bot -name '*.py'` 计数 |
| 生成时间 | 2026-08-02T23:17:26+08:00 | `datetime.now().astimezone()` |

数值与文档不一致时，以实测为准：先重跑本脚本，再修文档。
