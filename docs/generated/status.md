# 仓库状态（自动生成）

> 由 `scripts/gen-status.py` 生成，禁止手工编辑。
> 测试数来自实际命令输出；瞬时 SHA 和生产运行事实属于 manifest/CI，不写入该自指生成物。

| 指标 | 数值 | 来源 |
|---|---|---|
| SDK 测试 | 53 pass / 0 fail（共 53） | Node TAP 实跑 |
| 编排层测试 | 574 pass / 0 fail（共 574） | Node TAP 实跑 |
| schema 契约文件数 | 6 | contracts/generated 计数 |
| Python 实时运行模块数 | 0 | src/arena_bot/*.py 计数（目标 0） |

数值漂移时先重跑 `python scripts/gen-status.py`，再提交生成物。
