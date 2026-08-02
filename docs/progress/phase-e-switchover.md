# Phase E: 集成切换（Batch 5）

最后更新：2026-08-02

里程碑：**M5 线上切换** — 对比一致；线上 accepted 稳定

## 任务

- [ ] D2: `main.py` 集成（连接 + 决策 + 日志 + 调试端点 + 优雅退出 + 阶段机挂载）
  - 验收：无凭据 dry-run 决策链可跑；Ctrl-C 优雅退出；端点在运行中可查
- [ ] E1: 全量验证 — `uv run pytest` + 新旧决策对比
  - 验收：同一合成 Turn 新旧输出一致（对比脚本）；全部测试绿
- [ ] E2: 线上切换 — 停旧进程 → uv 起新入口 → 观察
  - 验收：新进程 accepted=True 连续稳定 ≥30 tick；日志正常轮转
- [ ] E3: 文档收尾 — CLAUDE.md/README 更新 + 架构文档 + docs/archives/ 归档
  - 验收：文档与代码一致；analysis/plan/ 归档可追溯

## Notes

- 切换窗口：停旧进程（b5j5ardxo）后立即起新进程，AGENT 槽位空窗 ≤1 tick
- 切换后保留旧 tactic.py 于 legacy/ 至少一周，观察无异常后由用户确认删除
