# Arena Digital Twin MVP — 依赖图与执行顺序

最后更新：2026-08-03

## 1. 任务 DAG

```text
S0 官方来源锁定
 └─> S1 隔离骨架
      └─> S2 确定性原语 + SimWorld
           ├─> S3 Settlement pipeline
           │    ├─> S4 Movement
           │    │    └─> S5 Economy
           │    └────────> S5 Economy
           └─> S6 Visibility + observation

S5 Economy ─┐
S6 Vision ──┴─> S7 Planner 闭环

S5 Economy ─┐
S6 Vision ──┼─> S8 Golden recorder/calibration
S7 Harness ─┘

S1 ... S8 ─────> S9 CLI/benchmark/CI/docs
```

## 2. 关键路径

```text
S0 -> S1 -> S2 -> S3 -> S4 -> S5 -> S7 -> S8 -> S9
```

S6 可在 S3-S5 期间并行，但不能早于 S2；S8 必须等 full plan 数据契约、engine 与 observation 都稳定后再做准确率结论。

## 3. 可并行与不可并行

### 可并行

- S4 movement 与 S6 visibility：共享 SimWorld/规则原语，但文件边界可分；
- S5 economy 的 micro-Golden 设计可在 S4 收尾时预先准备；
- S9 文档模板/CLI 参数设计可提前，但实际完成状态必须最后回写。

### 不可并行

- S1 不得晚于任何 engine 实现：隔离必须先成为门禁；
- S3 必须先于 S4/S5：否则 phase order 会被 resolver 私自决定；
- S5 不得跳过 S4：movement 后位置决定 harvest/deposit/heal；
- S7 不得在 S5/S6 未完成时用假 observation 或 fake economy 拼闭环；
- S8 不得用 planHash 或 planner 重算计划代替真实 submitted full plan；
- S9 不得在 M4 未通过前写“高保真已验证”。

## 4. 模块依赖方向

```text
sim/cli
  -> sim/harness
      -> existing planning/strategies
      -> domain/reducer/validator
      -> sim/visibility
      -> sim/engine
          -> sim/world
          -> sim/contracts
          -> sim/deterministic

sim/calibration
  -> sim/engine
  -> sim/visibility
  -> sim/contracts

existing planning/domain/runtime
  -X-> sim/*
```

`existing planning/domain/runtime -X-> sim/*` 是硬性单向依赖门禁。线上模块不得为了模拟器反向 import sim。

## 5. PR/提交切片建议

| Slice | 任务 | 内容 | 独立回滚 |
|---|---|---|---|
| PR1 | S0-S1 | provenance + isolation skeleton | 删除新增离线路径即可 |
| PR2 | S2-S3 | SimWorld + deterministic primitives + pipeline | 不接触 live |
| PR3 | S4 | movement + Golden | 不接触 live |
| PR4 | S5 | economy + Golden | 不接触 live |
| PR5 | S6-S7 | visibility + planner harness | 不接触 live |
| PR6 | S8a | calibration schema/runner（纯离线） | 不接触 live |
| PR7 | S8b | full-plan recorder（旁路线上遥测） | 可单独关闭/回滚 |
| PR8 | S9 | CLI/benchmark/CI/docs | 不接触 live |

PR7 必须独立于 settlement engine，原因：它是唯一可能接触 live loop 的切片。审查重点不是模拟规则，而是“是否改变提交时序、plan、锁、错误语义”。

## 6. 文件所有权边界

| 区域 | 主要任务 | 注意事项 |
|---|---|---|
| `src/sim/contracts/` | S0, S8 | 版本化 schema/provenance，不放策略逻辑 |
| `src/sim/deterministic/` | S2 | 唯一 UUID/RNG/coordinate 原语 |
| `src/sim/world/` | S2 | 不知道 Planner/Client |
| `src/sim/engine/` | S3-S5 | 不知道 CLI/文件系统/Client |
| `src/sim/visibility/` | S6 | 只做 observation projection |
| `src/sim/harness/` | S7 | 组装 planner 与 engine，不实现规则 |
| `src/sim/calibration/` | S8 | comparator/taxonomy，不修改 engine output |
| `src/sim/telemetry/` | S9 | 仅 sim schema |
| `src/cli/run-sim.ts` | S1, S9 | 无 env/client/network 参数 |
| live telemetry/loop | S8b | 仅 full-plan recorder，独立 PR |

## 7. Gate-to-task 映射

| 门禁 | 责任任务 |
|---|---|
| 官方版本/commit/provenance | S0 |
| 进程/提交/锁/端口/数据/CPU/产物隔离 | S1, S9 |
| UUID raw order / safe coordinates / deterministic RNG | S2 |
| phase order / atomic rollback / unsupported semantics | S3 |
| movement correctness | S4 |
| economy correctness | S5 |
| vision/full-state replacement | S6 |
| 1000 Tick closed loop / no planner fork | S7 |
| full-plan Runtime-Golden / ≥99.9% / 100% classification | S8 |
| benchmark/CI/clean clone/docs | S9 |

## 8. 执行中止条件

出现以下任一项，立即停止当前切片并回到设计/证据层：

- 需要 import Client/Turn.submit 才能复用 Planner；
- 规则 tie-break 无法从官方文档或真实事件确认；
- movement resolver 依赖迭代顺序；
- fixture 缺 full plan 却仍尝试报告 settlement accuracy；
- recorder 影响 live deadline、plan、writer lock 或 error handling；
- 无法分类的 mismatch 被批量标成 hidden/unknown；
- 模拟器改动导致现有线上 plan hash/行为变化；
- upstream rules version 变化而 manifest 未更新。
