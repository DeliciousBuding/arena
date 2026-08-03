# Digital Twin（本地模拟器）验收清单

> 执行状态：**S0-S7 已完成**（分支 `sim-digital-twin`，worktree `.worktrees/sim-digital-twin`，
> 336 测试全绿，1000 Tick ≈ 80ms）。**S8 校准进行中**（GPT 在 `src/sim/calibration/` 推进）。
> 本清单供 S8/S9 完成后逐项核验；计划原文见
> `docs/archives/spec-driven-2026-08-03-sim/`（task-breakdown.md / milestones.md）。

最后更新：2026-08-03

## S8 — 校准（进行中）

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | `sim-calibration-case-v1` schema 冻结（含完整 plan，非仅 state） | ⬜ | `src/sim/calibration/` |
| 2 | 真实 tick 序列校准：己方动作合法性一致率 100% | ⬜ | 校准报告 |
| 3 | 已知确定性事件一致率 ≥99.9% | ⬜ | 校准报告 |
| 4 | 差异 100% 分类（可见性/对手动作/refill 不可预测/规则误解/模拟器 bug） | ⬜ | 差异分类报告 |
| 5 | 旧 state-only fixture 被拒绝（校验缺失 plan） | ⬜ | 测试 |
| 6 | 规则版本变化 → calibration report 自动标 stale | ⬜ | 测试 |
| 7 | 拒绝在线更新规则；服务端不可访问不得解释为"规则已完全验证" | ⬜ | 测试 |

**S8b 特别项（唯一触碰 live loop 的切片，需独立评审）**：

| # | 验收项 | 状态 |
|---|---|---|
| 8 | full-plan recorder 只记录、不修改线上提交路径 | ⬜ 待用户批准 |
| 9 | live 提交/锁/端口/凭据行为与启用 recorder 前逐字节一致 | ⬜ |

## S9 — 收口

| # | 验收项 | 状态 |
|---|---|---|
| 1 | CLI 可用：`run-sim`（scenario/ticks/seed/output/workers，默认 workers=1 有上限） | ⬜ |
| 2 | benchmark 输出：tick 吞吐 + 经济曲线 | ⬜ |
| 3 | A/B runner：同环境比较不同策略 | ⬜ |
| 4 | `arena:sim` npm script 接入 | ⬜ |
| 5 | AGENTS.md 加"策略改动先跑模拟器"指引 | ✅（2026-08-03 main 已补） |
| 6 | README/docs 导航指向模拟器 | ✅（2026-08-03 main 已补） |

## 关单门槛（milestones.md M5，全部需过）

- [ ] 六条隔离边界全自动化证明（`npm run check` 含 isolation checker）
- [ ] micro-Golden 全绿（movement/economy 确定性事件）
- [ ] full-plan Runtime-Golden（S8b 通过后）
- [ ] 确定性事件一致率 ≥99.9%，mismatch 100% 分类
- [ ] 1000 Tick 秒级（当前 80ms，已达成）
- [ ] 10000 Tick 无 invariant failure
- [ ] root 全量门禁 + clean clone 通过（check/test/schema/replay/pytest/docs_health/gen-status）
- [ ] live 提交/锁/端口/凭据行为不变（S8b 引入后必验）
- [ ] 分支 `sim-digital-twin` merge 回 `main`

## 核验命令

```bash
cd PROJECT_ROOT/arena/.worktrees/sim-digital-twin
npm run check && npm test          # tsc + isolation + 全量测试
# merge 后（root 门禁）：
cd PROJECT_ROOT/arena
npm run check && npm test && npm run schema:check && npm run replay:check
uv run pytest tests/ -q
uv run python scripts/gen-status.py --check
uv run python scripts/docs_health.py --check
```
