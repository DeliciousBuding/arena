# Digital Twin（本地模拟器）验收清单

> 执行状态：**S0–S9 全部完成**（含 S8b live full-plan recorder），已合并回 `main`。
> 仍需真机 live 录制数据（`--record-calibration`）生成首份 Runtime-Golden 数据集，才能解锁 S8a #8–#10 与关单门槛中「真实数据」三项。
>
> 运行说明见 `docs/simulator.md`；历史设计与任务拆分见
> `docs/archives/spec-driven-2026-08-03-sim/`。

最后更新：2026-08-03

## S8a — 离线校准

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | `sim-calibration-case-v1` schema 冻结，完整 Plan 必填 | ✅ | `src/sim/calibration/schema.ts`、JSON Schema、`sim-calibration.test.ts` |
| 2 | 旧 state-only fixture 被拒绝 | ✅ | parser 反向测试 |
| 3 | 规则版本不一致 fail closed / stale | ✅ | calibration 测试 |
| 4 | 差异分类：STATE / ENTITY / TERRAIN / EVENT / EXPECTED_UNKNOWN / UNSUPPORTED | ✅ | `calibrate.ts` + taxonomy 测试 |
| 5 | event phase order 参与比较，不被排序掩盖 | ✅ | event reorder 反向测试 |
| 6 | refill、隐藏 terrain、pile/node、server ID、Beacon、对手 Plan 缺失显式 INCONCLUSIVE | ✅ | unknown 矩阵测试 |
| 7 | 不在线更新规则，不把不可访问/不可观测信息解释为完全验证 | ✅ | manifest 锁定 + fail-closed 语义 |
| 8 | 真实 tick 序列己方合法性一致率 100% | ⏸ | 需要 S8b full-plan 数据集 |
| 9 | 已知确定性事件一致率 ≥99.9% | ⏸ | 需要 S8b full-plan Runtime-Golden |
| 10 | 真实样本 mismatch 100% 完成 taxonomy 分类 | ⏸ | 需要 S8b 数据集 |

### S8b — 唯一触碰 live loop 的切片

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | full-plan recorder 只旁路记录，不修改提交路径 | ✅ | `runtime-golden/recorder.ts`：observe() 只消费已 submit 的 TickOutcome，串行队列 + fail-open |
| 2 | 默认关闭、可独立回滚、录制失败不影响 live | ✅ | `--record-calibration` 默认关；close()/manifest 错误不抛回 live |
| 3 | 不记录凭据，不改变 deadline、锁、端口和错误语义 | ✅ | recorder 不触碰 lock/deadline/端口；只有旁路字段透传 |
| 4 | live 提交行为与启用前一致 | ✅ | `tenant-runtime.test.ts` 接线测试 + 379/379 全绿 |
| 5 | 未拥有对手完整锁定 Plan 时写 `opponentPlans=absent` | ✅ | `writeCase`：opponentPlans 固定 "absent"（单租户旁路） |

> S8b 已合入 `main`（`78729d3`）。下一步：真机 `--live --record-calibration` 录制首份数据集，驱动 S8a #8–#10。

## S9 — 工具化收口

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | CLI：doctor / episode / ab / benchmark / calibrate | ✅ | `src/cli/run-sim.ts`、E2E tests |
| 2 | npm scripts：`sim:doctor/run/ab/bench/calibrate/test` | ✅ | `packages/arena-agent/package.json` |
| 3 | 输出仅限 `runs/sim`，拒绝绝对路径、遍历、junction/symlink 逃逸 | ✅ | path policy + Windows junction 反向测试 |
| 4 | 语义产物 deterministic，性能产物分离 | ✅ | records/final-world/summary 字节一致测试 |
| 5 | A/B 使用相同 seeds，输出 paired delta / aggregate | ✅ | `pairedDeltas`、`pairedAggregates` |
| 6 | A/B unknown/unsupported 时 `rankingStatus=exploratory` | ✅ | A/B tests |
| 7 | benchmark：tick/s、p50/p95/max tick latency、heap memory | ✅ | benchmark report/tests |
| 8 | benchmark：完整经济曲线及 hash | ✅ | `economicCurve`、`economicCurveHash` |
| 9 | benchmark 锁定 final-world / trace / summary / economic-curve | ✅ | semantic-drift gates |
| 10 | CPU 隔离默认串行，`--workers` 上限固定为 1 | ✅ | CLI + boundary tests |
| 11 | 文档与导航同步 | ✅ | `docs/simulator.md`、README 导航 |

## 当前支持范围

确定性主线已覆盖：

- scenario / raw private snapshot 载入；
- movement 全局依赖、容量与 reason codes；
- self-destruct、tier upkeep、capacity、cargo pile；
- harvest / deposit、heal / repair / spawn；
- visibility / supercover / private observation；
- existing deterministic / safety Planner 闭环；
- offline calibration、A/B、benchmark 与可复现产物；
- **combat（S10）**：SWEEP/SHOOT 快照结算（多目标 AOE、八方向线 1-3 射程、互杀合法、Core 先盾后 HP、击杀者资源归属）；
- **core-migration（P06）**：Four-Tick Core 迁移（START_MOVE/CANCEL_MOVE、进度推进、真实移动结算、裸 MOVING fail-closed）；
- **beacon（S11）**：PICKUP/DROP 结算（同格低 UUID 争抢、落地 tick 不可拾取、持有者 harvest 加成、失去时盾 clamp）。

仍需 unknown / unsupported：respawn、server-secret refill placement、未记录对手动作、服务端 UUID、PENDING v0.11 upkeep-deficit 细节。

## 关单门槛

- [x] 六条隔离边界由自动化门禁证明
- [x] movement / economy micro-Golden 全绿
- [x] 同 seed/config/scenario 语义轨迹一致
- [x] 1000 Tick 秒级闭环并报告真实 ticks/s
- [x] 10000 Tick invariant soak
- [x] CLI / A-B / benchmark / calibration / docs 收口
- [x] full-plan Runtime-Golden（S8b）——recorder 实现与单测完成，待真机录制首份数据集
- [ ] 真实确定性事件一致率 ≥99.9%（需 S8b 真机数据集）
- [ ] 真实 mismatch 100% 分类（需 S8b 真机数据集）
- [ ] live recorder 行为不变验证（真机 `--record-calibration` 录制中比对）
- [x] 分支合并回 `main`（`78729d3`）

## 核验命令

```bash
cd PROJECT_ROOT/arena/.worktrees/sim-digital-twin
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run schema:check
npm run replay:check      # 冻结 W3 fixture：严格 state/metadata + 有界 legacy plan 豁免
npm run sim:test -w packages/arena-agent
uv sync --frozen --all-extras --dev
uv run pytest tests/ -q
uv run python scripts/gen-status.py --check
uv run python scripts/docs_health.py --check
```
