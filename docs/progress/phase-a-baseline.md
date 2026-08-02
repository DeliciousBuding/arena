# Phase A: 工程基座（Batch 1）

最后更新：2026-08-02

里程碑：**M1 基座可用** — `uv sync` + `uv run pytest` 全绿

## 任务

- [ ] A1: pyproject.toml + uv 初始化
  - 验收：`uv sync` 成功；`uv run pytest` 现有 38 例全过
  - 依赖：arena-hero>=0.2.6,<0.3（钉死）；pytest dev 依赖
- [ ] A2: `src/arena_bot` 包结构 + `config.py`
  - 验收：常量/参数/`.env` 读取集中；现有调优参数（EXPLORE_RADIUS=8、WORKER_TARGET=8、动态 reserve、POP_CEILING=20）全部可配置；秘钥只从 .env 读
- [ ] A3: pytest 配置
  - 验收：`uv run pytest` 从项目根跑通；tests/ 与 src/ 布局正确

## Notes

- 旧 tactic.py 保留为 `legacy/`（切换验证用），不进 src
- uv: `uv init --package` 或手工 pyproject？——用 `uv init` 生成骨架后裁剪
