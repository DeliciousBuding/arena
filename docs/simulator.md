# Arena 离线模拟器与实验工具

> 状态：S0–S7、S8a 与 S9 离线链路已实现。S8b live full-plan recorder **尚未实现，仍需单独审批**。

## 1. 安全边界

模拟器是独立的离线子系统，入口为：

```bash
npm run arena:sim -w packages/arena-agent -- <command> [options]
```

自动化边界：

- `src/sim/**` 与 `src/cli/run-sim.ts` 受 import-closure isolation checker 守护；
- 不导入 Arena SDK client、live loop、tenant runtime、single-writer lock；
- 不读取 `.env`、API key、Base URL 或 WebSocket URL；
- 不监听端口，不建立网络连接，不提交真实命令；
- 所有输出只能写入仓库根目录的 `runs/sim/` 及其子目录；
- 绝对输出路径、`..` 路径穿越和其他 `runs/` 目录会被拒绝。

检查边界：

```bash
npm run sim:doctor -w packages/arena-agent
npm run sim:isolation-check -w packages/arena-agent
npm run sim:test -w packages/arena-agent
```

快捷命令：

```bash
npm run sim:run -w packages/arena-agent -- --scenario <path>
npm run sim:ab -w packages/arena-agent -- --scenario <path>
npm run sim:bench -w packages/arena-agent -- --scenario <path>
npm run sim:calibrate -w packages/arena-agent -- --case <path>
```

episode、A/B、benchmark 默认串行；`--workers` 当前只接受 `1`。这不是伪并行开关，而是显式 CPU 隔离上限。

## 2. 输入路径与规则版本

CLI 输入路径相对**仓库根目录**解析，也允许显式绝对只读输入路径。外部输入的本机绝对路径不会写入 manifest，只记录 `external:<filename>` 与内容 SHA-256。

默认规则为：

```text
packages/arena-agent/src/sim/contracts/rules-v0.11.json
```

scenario 或 calibration case 的 `rulesVersion` 必须与 manifest 一致，否则 fail closed。

## 3. Episode

运行一个 Planner 闭环：

```bash
npm run arena:sim -w packages/arena-agent -- episode \
  --scenario packages/arena-agent/test/fixtures/sim/scenario-basic.json \
  --planner deterministic \
  --ticks 1000 \
  --seed 42
```

可选 Planner：

- `deterministic`
- `safety`

同一个 scenario 中的所有 player 都会建立独立 Planner 实例。每 Tick 的流程为：

```text
SimWorld
  -> 私有 PlayerState 投影
  -> reduceTurn
  -> Planner.decide
  -> validatePlan/repair
  -> settleTick
  -> 私有事件反馈到下一 Tick
```

产物：

| 文件 | 语义 |
|---|---|
| `manifest.json` | 输入 hash、规则 hash、配置、产物 hash |
| `records.jsonl` | 每 Tick 的完整 per-tenant Plan、Plan SHA-256、验证结果、事件、unknown/unsupported |
| `final-world.json` | canonical SimWorld |
| `summary.json` | 资源变化、人口、合法性、事件计数、semantic hash |
| `performance.json` | wall time 与 ticks/s；不参与语义复现 |

同 scenario、rules、seed、ticks、Planner 的 `records.jsonl`、`final-world.json` 和 `summary.json` 应逐字节一致。运行耗时单独存放，避免污染 replay。

## 4. A/B 策略对比

```bash
npm run arena:sim -w packages/arena-agent -- ab \
  --scenario packages/arena-agent/test/fixtures/sim/scenario-basic.json \
  --planners deterministic,safety \
  --seeds 1,2,3,4,5 \
  --ticks 1000
```

`ab-report.json` 包含每个 Planner × seed 的语义摘要与聚合，并输出同 seed 的：

- `pairedDeltas`：candidate − baseline；
- `pairedAggregates`：配对均值与合法性差值。

baseline 为稳定排序后的第一个 Planner。排名采用词典序，不把机器速度揉进策略优劣：

1. 平均 Core 资源增量更高；
2. 非法计划更少；
3. 最终人口更高；
4. Planner ID 稳定排序。

`performance.json` 只记录整次 A/B 的运行耗时。

> 当 episode 触发 refill、unsupported feature、PENDING rule assumption 等 unknown 时，报告会标记 `inconclusiveRuns`。排名仍可用于探索，但不能宣称 Runtime-Golden。

`rankingStatus` 为：

- `conclusive`：所有纳入排名的运行都没有 unknown/unsupported；
- `exploratory`：至少一轮不完整，ranking 只能作为探索提示。

## 5. Benchmark

```bash
npm run arena:sim -w packages/arena-agent -- benchmark \
  --scenario packages/arena-agent/test/fixtures/sim/scenario-basic.json \
  --planner deterministic \
  --ticks 10000 \
  --warmup 1 \
  --repeats 5 \
  --seed 42
```

`benchmark.json` 记录：

- wall time、ticks/s、min/median/max throughput；
- 每 Tick latency 的 p50/p95/max；
- heap start/end/delta/peak；
- 每 Tick、每玩家的 resources/population 经济曲线及 `economicCurveHash`。

所有测量轮次必须同时产生相同：

- `finalWorldHash`；
- 完整 `records` 的 `traceHash`；
- episode `semanticHash`。
- `economicCurveHash`。

任一漂移都会使 benchmark 失败，避免用计划/事件漂移换速度。`semanticStatus=inconclusive` 表示该 benchmark 覆盖了 refill、unsupported 或其他 unknown，其吞吐量仍可测，但不能作为完整规则 Golden。

## 6. 离线校准

case schema：

```text
packages/arena-agent/src/sim/calibration/sim-calibration-case-v1.schema.json
```

执行：

```bash
npm run arena:sim -w packages/arena-agent -- calibrate \
  --case packages/arena-agent/test/fixtures/sim/calibration-wait-match.json
```

`sim-calibration-case-v1` 必须包含：

- 完整 before PlayerState；
- 本 Tick 实际执行的完整 Plan；
- 完整 after PlayerState；
- `metadata.opponentPlans`：`complete` 或 `absent`；
- 规则版本、seed 与来源元数据。

只有 before/after state、没有完整 Plan 的旧 fixture 会被拒绝。

结果与退出码：

| 状态 | 退出码 | 含义 |
|---|---:|---|
| `MATCH` | 0 | 支持范围内逐项一致，且没有会影响结论的 unknown |
| `INCONCLUSIVE` | 2 | refill、隐藏 terrain、对手 Plan 缺失、Beacon 可见性、cargo pile/node 歧义、server-generated ID、unsupported 等使结论不完整 |
| `MISMATCH` | 3 | 支持且可观测的规则、实体、terrain 或事件存在硬差异 |
| 输入/执行错误 | 1 | schema、规则版本、路径或运行失败 |

差异分类：

- `STATE`
- `ENTITY`
- `TERRAIN`
- `EVENT`
- `EXPECTED_UNKNOWN`
- `UNSUPPORTED`

事件顺序属于结算契约；比较器不会排序掉 phase-order 回归。

## 7. 输出目录与可复现 run ID

默认 run ID 由 command 类型与输入/config 内容 hash 生成。同一配置重复运行会命中同一目录并 fail closed：

```text
run directory already exists ... (use --force to replace)
```

显式控制：

```bash
--output runs/sim/experiments
--run-id deterministic-seed-42
--force
```

`--run-id` 只允许字母、数字、点、下划线和连字符，不允许目录分隔符。

## 8. 当前支持范围与禁止宣称

确定性支持的主线包括：

- scenario/raw private snapshot 载入；
- 单位 movement；
- self-destruct、capacity、tier upkeep；
- harvest/deposit、cargo pile；
- Unit/Core heal、shield repair、spawn；
- visibility、supercover 遮挡与 Planner observation；
- Planner 闭环、A/B、benchmark、offline calibration。

仍需显式 unknown/unsupported 的内容包括：

- combat；
- Core migration 完整状态；
- Beacon pickup/drop 与真实持有者全局状态；
- respawn；
- server-secret refill placement；
- 未记录的对手动作与隐藏世界；
- 服务端生成 UUID；
- v0.11 upkeep deficit 的 `PENDING-VERIFICATION` 细节。

不得把 `INCONCLUSIVE` 当作 MATCH，也不得用模拟器输出替代真实服务器 Golden。

## 9. S8b 审批门

为了获得真实 Runtime-Golden，未来可能需要在 live loop 旁路记录：

```text
before private state + 实际提交的完整 Plan + after private state
```

这会接触线上路径，因此必须作为独立 S8b：

- 单独设计与评审；
- 默认关闭；
- 可独立回滚；
- 不记录凭据；
- 不改变提交时序或 deadline；
- 录制失败不得影响 live 决策；
- 明确 `opponentPlans=absent`，除非确实拥有全体锁定 Plan。

当前分支没有实现或修改任何 recorder/live loop 代码。
