# Archived — Go Host + Rust Kernel Fusion

> **Status: Superseded / not planned.**
>
> 2026-08-06 架构裁决：Pure Rust 是 Arena 唯一长期产品主线。此前的 Go Host、Rust cdylib、DLL/SO、FFI adapter、Go fallback 和双数据模型方案停止演进。
>
> 当前权威入口：
>
> - 跨线迁移总控：Issue #27
> - Pure Rust 实现总控：Issue #26
> - 当前执行计划：`master-plan.md`
> - 当前进度：`../../PROGRESS.md`
> - Fusion 历史证据：`../archive/fusion-progress-2026-08-06.md`

## 为什么废弃

Fusion 把最危险的生产边界复制成两份：

- Go/Rust 两套领域模型和序列化；
- planner 状态跨 ABI 生命周期；
- C ABI、allocator、panic、DLL/SO 加载和平台差异；
- Go validator 与 Rust planner 的语义分裂；
- fallback 可能掩盖实际执行者；
- 模拟器与生产仍不是同一完整程序。

Linux FFI CI、`deterministic-rust` repair 语义和长程 Go/Rust divergence 已证明这些成本会持续消耗开发时间，但不会直接提高游戏策略或运行可靠性。

## 可保留的历史资产

旧 Fusion 工作只保留为知识来源：

- FFI 内存所有权和 panic 边界失败案例；
- 同 Tick 双跑差分方法；
- 长程 divergence 记录；
- Go 侧协议、exactly-once、幂等、单写者锁、重连和 telemetry fixture；
- Rust `domain` / `engine` / `strategy` / simulator/optimizer 实现。

这些资产应原生迁入 Rust，而不是继续维持 Go↔Rust 接缝。

## 禁止继续执行的旧任务

- F1/F2：扩展 `arena-sim-ffi` 或 Go `FfiPlanner`；
- F3：以 Go/Rust plan 一致性作为终态目标；
- F4：上线 `decisionMode=deterministic-rust`；
- F5：通过 Go 调用 Rust rollout；
- 修复 Fusion 专属 CI、DLL/SO 分发或 Go fallback；
- 将 Go Host 描述为“已定终态”。

## 替代路线

```text
Rust Hero client
→ Rust protocol/domain normalization
→ Rust World + deterministic strategy + validator
→ Rust exactly-once tenant runtime
→ Rust submit/lock/telemetry
→ shared Rust replay/simulator/optimizer
```

生产迁移按 `master-plan.md` 和 Race v2 promotion runbook 分阶段进行；TS 在 Rust 完成长时 Canary 前继续承担生产与回滚。
