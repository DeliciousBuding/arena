# Digital Twin（本地模拟器）验收清单

> 执行状态：**S0–S12 / P06 / P12 的实现与 micro-Golden 已完成**；离线模拟器、S8b live full-plan recorder 和首份真实 Runtime-Golden 校准已融合进 `main`。
> 首份真机数据集已通过四层完整性校验：3 cases、硬差异 0、未分类差异 0、其实际覆盖的已知确定性事件 6/6（100%）。该数据集主要覆盖 movement / economy / visibility，**不等于 combat、Core migration、Beacon、respawn 已获真机覆盖**。
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
| 8 | 真实 tick 序列己方合法性一致率 100% | ✅ | 真机 run `26600fea…`：3/3 submit accepted、3/3 full-plan cases 完整闭合 |
| 9 | 已知确定性事件一致率 ≥99.9% | ✅ | Runtime-Golden：6/6，accuracy=1.000000，门槛 0.999 |
| 10 | 真实样本 mismatch 100% 完成 taxonomy 分类 | ✅ | 3 cases：硬差异 0、未分类 0；16 条均为 `EXPECTED_UNKNOWN` |

### S8b — 唯一触碰 live loop 的切片

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | full-plan recorder 只旁路记录，不修改提交路径 | ✅ | `runtime-golden/recorder.ts`：observe() 只消费已 submit 的 TickOutcome，串行队列 + fail-open |
| 2 | 默认关闭、可独立回滚、录制失败不影响 live | ✅ | `--record-calibration` 默认关；close()/manifest 错误不抛回 live |
| 3 | 不记录凭据，不改变 deadline、锁、端口和错误语义 | ✅ | recorder 不触碰 lock/deadline/端口；只有旁路字段透传 |
| 4 | live 提交行为与启用前一致 | ✅ | on/off 提交 body 逐对象相同；真机 recorder run 3/3 accepted、0 recorder errors |
| 5 | 未拥有对手完整锁定 Plan 时写 `opponentPlans=absent` | ✅ | `writeCase`：opponentPlans 固定 "absent"（单租户旁路） |

> 真机证据：dataset `26600fea-e8c7-45da-98e8-5a4bc03919f9`，source SHA `93a63e3`；校准报告 `runs/sim/runtime-golden-t3-26600fea/calibration-dataset-report.json`。

## S9 — 工具化收口

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | CLI：doctor / episode / ab / benchmark / calibrate / calibrate-dataset | ✅ | `src/cli/run-sim.ts`、E2E tests |
| 2 | npm scripts：`sim:doctor/run/ab/bench/calibrate/calibrate-dataset/test` | ✅ | `packages/arena-agent/package.json` |
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
- offline calibration、Runtime-Golden dataset integrity/accuracy gate、A/B、benchmark 与可复现产物；
- **combat（S10）**：SWEEP/SHOOT 快照结算（多目标 AOE、八方向线 1–3 射程、互杀合法、Core 先盾后 HP、击杀者资源归属）；
- **core-migration（P06）**：Four-Tick Core 迁移（START_MOVE/CANCEL_MOVE、进度推进、真实移动结算、裸 MOVING fail-closed）；
- **beacon（S11）**：PICKUP/DROP 结算（同格低 UUID 争抢、落地 Tick 不可拾取、持有者 harvest 加成、失去时盾 clamp）；
- **respawn（P12）**：Core 摧毁后同 Tick 确定性重生与完整事件/状态落地。

仍需 unknown / unsupported：server-secret refill placement、未记录对手动作、服务端生成 UUID、PENDING v0.11 upkeep-deficit 细节。

### 证据分层

- **Runtime-Golden 已验证**：首份数据集实际触发的 movement / economy / visibility 路径；known deterministic events 6/6。
- **实现 + micro-Golden 已验证**：combat、Unit/Core 统一移动图、Four-Tick Core migration、Beacon、respawn，以及跨 resolver 组合语义。
- **仍待专项 Runtime-Golden**：真实 SWEEP/SHOOT、第四 Tick Unit/Core 争抢、Beacon pickup/drop/death、Core destruction/respawn。respawn placement、服务端 UUID 与未记录对手 Plan 在拿到充分证据前不得宣称与服务端完全一致。

## 关单门槛

- [x] 六条隔离边界由自动化门禁证明
- [x] movement / economy micro-Golden 全绿
- [x] 同 seed/config/scenario 语义轨迹一致
- [x] 1000 Tick 秒级闭环并报告真实 ticks/s
- [x] 10000 Tick invariant soak
- [x] CLI / A-B / benchmark / calibration / docs 收口
- [x] full-plan Runtime-Golden（S8b）：真机 3 cases、四层 hash 完整
- [x] 首份样本实际覆盖的确定性事件一致率 ≥99.9%：6/6 = 100%
- [x] 首份样本 mismatch 100% 分类：硬差异 0、未分类 0
- [ ] combat / Core migration / Beacon / respawn 专项触发型 Runtime-Golden 覆盖
- [x] live recorder 行为不变验证：3/3 accepted、0 recorder errors
- [x] 两条开发线已融合回 `main`

## 核验命令

```bash
cd <repo-root>
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run schema:check
npm run replay:check      # 冻结 W3 fixture：严格 state/metadata + 有界 legacy plan 豁免
npm run sim:test -w packages/arena-agent
npm run sim:calibrate-dataset -w packages/arena-agent -- --manifest runtime/t3/calibration/26600fea-e8c7-45da-98e8-5a4bc03919f9/manifest.json --run-id runtime-golden-t3-26600fea --force
uv sync --frozen --all-extras --dev
uv run pytest tests/ -q
uv run python scripts/gen-status.py --check
uv run python scripts/docs_health.py --check
```
