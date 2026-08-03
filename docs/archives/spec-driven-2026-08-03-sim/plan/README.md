# Arena Digital Twin MVP — 计划入口

最后更新：2026-08-03（历史规划快照）

> 本目录是 Digital Twin MVP 的 spec-driven 规划归档，不承担当前运行状态。
> 当前主线与门禁以 `docs/progress/MASTER.md` 为准。

## 阅读顺序

1. `../analysis/findings-for-planning.md` — 本仓库现状、范围与六条隔离边界；
2. `../analysis/official-source-verification.md` — 官方 docs/SDK 实际核对、来源缺口、Golden 数据缺口；
3. `architecture.md` — 模块边界、数据流、结算 pipeline、隔离门禁与校准设计；
4. `task-breakdown.md` — S0-S9 十个执行任务、验收标准与测试矩阵；
5. `dependency-graph.md` — DAG、关键路径、PR 切片与中止条件；
6. `milestones.md` — M0-M5 里程碑、BLOCK 条件与最终关单门槛。

## 一句话方案

在 `packages/arena-agent/src/sim/` 新增一台**无网络提交能力的本地假服务器**：维护完整 `SimWorld`，按 v0.11 结算 movement/economy，按官方 vision 裁剪为 PlayerState，再复用现有 `reduceTurn + Planner` 连续闭环运行。

## 固定范围

MVP 做：

- Unit movement 全局依赖与容量；
- self-destruct/capacity/upkeep；
- harvest/deposit；
- Unit heal；
- stationary Core spawn/heal/repair；
- visibility/supercover；
- Planner 闭环、benchmark、Golden 校准。

MVP 不做：

- combat/Core capture；
- Core migration；
- Beacon；
- respawn；
- 对手策略；
- 官方 secret refill 精确复现；
- live 自动晋级、RL、自博弈。

## 十个任务

```text
S0 官方来源锁定
S1 隔离骨架与自动门禁
S2 确定性原语与 SimWorld
S3 Settlement pipeline
S4 Movement resolver
S5 Economy resolver
S6 Visibility + observation adapter
S7 Existing Planner 闭环
S8 Full-plan Golden 录制与校准
S9 CLI/benchmark/CI/docs 收口
```

## 首批执行顺序

```text
PR1: S0 + S1
PR2: S2 + S3
PR3: S4
PR4: S5
PR5: S6 + S7
PR6: S8 calibration schema/runner（纯离线）
PR7: S8 full-plan recorder（唯一 live 旁路，独立严格评审）
PR8: S9
```

## 开工前不可省略的三个事实

1. 当前公开 gameplay rules 仍为 v0.11；
2. 官方版本页引用的 SDK commit `8f967aa...` 当前不可公开解析，公开 v0.2.6 tag 实际为 `4a29585...`；
3. 现有 `burnin-20260802-a` 只有 state，没有完整实际 plan，不能直接作为 settlement Golden。

## 最终关单门槛

- 六条隔离边界全部有自动化证明；
- micro-Golden 全绿；
- full-plan Runtime-Golden 已建立；
- 已知确定性事件一致率 ≥99.9%；
- mismatch 100% 分类，数据不足不得冒充 MATCH；
- 1000 Tick 秒级，10000 Tick 无 invariant failure；
- root 全量门禁与 clean clone 通过；
- live submission、writer lock、端口、凭据读取均未改变。

## 当前裁决

可以开始 **S0 → S1**，但在 S1 isolation checker 进入 `npm run check` 之前，不允许开始 movement/economy resolver。
