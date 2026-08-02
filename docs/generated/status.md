# 仓库状态（自动生成）

> 由 `scripts/gen-status.py` 生成，**禁止手工编辑**。每次代码改动后重跑：`python scripts/gen-status.py`。
> 背景：测试数曾手工维护于多份文档导致漂移（架构评审 R1），本文件是这些数字的唯一权威来源。
> 注：本文件不含 commit SHA 与生成时间（生成物自身提交会使 SHA 过期，属自指）；瞬时事实见运行 manifest 与 CI。

| 指标 | 数值 | 来源命令 |
|---|---|---|
| Python 测试 | 139 passed / 0 failed / 0 skipped | `uv run pytest tests/ -q`（实际执行输出解析） |
| SDK 测试 | 48 pass / 0 fail（共 48） | `node --experimental-transform-types --test --test-reporter=tap test/*.test.ts` |
| 编排层测试 | 22 pass / 0 fail（共 22） | `npx tsx --test --test-reporter=tap test/*.test.ts` |
| schema 契约文件数 | 6 | `ls packages/arena-hero-ts/contracts/generated/*.schema.json` 计数 |
| Python 待退役模块数 | 23 | `find src/arena_bot -name '*.py'` 计数 |

数值与文档不一致时，以实测为准：先重跑本脚本，再修文档。
