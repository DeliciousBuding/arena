# Arena

Arena 是 Arena Hero 的 **TS-only** 安全自主运行时、确定性策略和 Digital Twin。
目标不是堆一层平台，而是在单写者、硬截止、部分可观测和不可信 Provider 条件下稳定运行。

> 正式运行链只有 `arena-hero-ts → arena-agent → SDK submit`。Pi 只能提交候选，永远不持有游戏提交权；Python 实时 runtime 已退役。

## 当前状态

已完成：

- TS SDK、wire/domain schema、Golden fixture 与协议门禁；
- DecisionLease、Coordinator、Arbiter、Validator 与确定性 fallback；
- DeterministicPlanner 经济闭环，历史有界真机窗口合计 400/400 accepted；
- Pi `createAgentSession` 原生嵌入，builtin 关闭，只开放 `arena_plan` / `arena_map`；
- Provider circuit breaker：`closed → open → half-open`，失败时快速退回 deterministic/safety；
- 单租户 manifest、single-writer lock、runtime/decision/outcome/pi JSONL；
- 原生 `TenantSupervisor`：全量 preflight、部分启动回收、lock-backed readiness、端口预占、IPC 优雅关闭与跨平台 process-tree 清理；
- 只读 Debug API：`/health`、`/ready`、`/tenants`、有界 `/events` 与 `/state`；
- 原生服务器基线：systemd cgroup、不可变 release、外置 config/runtime、shadow 有界自恢复、live 禁止自动重启、有限 JSONL 轮转；
- Digital Twin 与首份 Runtime-Golden 数据集。

已进一步完成（2026-08-05/06）：

- **决策指挥状态机五层闭环**（policy discipline → StallRecovery 自愈 → 执行层防呆 maxFocusDistance=32 → 模拟级验证 → KPI）：生产 t1 事故链（远点 focus → 经济冻结）根因修复，生产 KPI 全 0（stall_warning 0 / stall_recovery 0 / policy_discipline 0）；
- **死锁攻坚闭环**（v0.2.3→v0.2.9）：守家锚点/SPAWN 解锁/资源满让位/敌格绕行/半径受限 BFS/敌方 CORE 并入障碍/fail-safe 不横跳——生产验证经济循环恢复；
- **低频 MacroPolicy 策略层**（LLM 战略 + deterministic 执行）：normalize-first 修复后生产 0 error，prompt 约束落地（militaryRatio 0.3-0.4 拐点、workerTarget 8 平衡区）；
- **模拟器真实性校准**：refill cadence 校准=65；calibration 大样本（1700+ cases/租户）7 次回放**零确定性误差**——模拟器对真实服务器行为无硬差异；
- **TS 版本回滚演练**已完成（逃生通道须用同部署形态 commit sha 镜像）；
- **外部参考对照**：榜二（arena-hero-agent）威胁状态机/Core 迁移/Ranger 优先级对照落地或阴性记录，对照线完结；官方规则源（arena-hero-doc）纳入追踪（官方 v0.13 vs 我们服务器实测 v0.11）。

代码门禁已经通过 Windows 与 Linux Node 24；生产长期验收剩余项：t1/t2/t3/t4 分级 soak、Provider shadow 故障注入、combat/Core migration/Beacon/respawn 专项 Runtime-Golden。

## 原生边界

```text
Arena stream
  → arena-hero-ts (wire / WebSocket / Turn / submit)
  → arena-agent   (state / planner / lease / validator / telemetry)
  → Pi optional   (candidate only; no submit capability)
```

- 一个租户一个 OS 进程、一个 writer lock；
- Supervisor 只管理进程生命周期，不复制租户业务状态；
- 子进程通过 Node IPC 自行清理，超时后才强杀整棵进程树；
- live writer 不自动重启：跨进程幂等恢复完成前，自动拉起可能造成同 Tick 重复提交；
- Debug API 只读，不提供绕过 Coordinator/Validator 的控制接口；
- 没有真实收益证据时，生产保持 deterministic。

## 常用命令

```bash
npm ci
npm run check
npm test
npm run schema:check
npm run replay:ts
```

单租户：

```bash
npx tsx packages/arena-agent/src/cli/run-tenant.ts \
  --config=../data/runtime/configs/t1.json --doctor

npx tsx packages/arena-agent/src/cli/run-tenant.ts \
  --config=../data/runtime/configs/t1.json --mode=deterministic --shadow
```

多租户 Supervisor（只观察）：

```bash
npm run arena:supervisor -- \
  --configs=t1,t2,t3,t4 --mode=deterministic --shadow --port=8120
```

> 运行配置默认放在共享数据层 `../data/runtime/configs/`，运行产物写入
> `../data/runtime/`；token 值放 `.env` / `.env.local` / `~/.secrets/arena.env`。

## 共享数据根

`ARENA_DATA_ROOT` 默认是仓库同级的 `../data`。路径优先级保持显式：

1. CLI `--data-root`；
2. 环境变量 `ARENA_DATA_ROOT`；
3. 内置默认 `<repo>/../data`。

Supervisor 的 `--config-dir` / `ARENA_CONFIG_DIR` 和
`--runtime-dir` / `ARENA_RUNTIME_DIR` 仍是更具体的覆盖项；未提供时分别使用
`<dataRoot>/runtime/configs` 与 `<dataRoot>/runtime`。租户配置中的相对
`baseDir` 从 data root 解析，因此标准值 `runtime` 对应共享运行目录。

离线模拟器遵循相同 data-root 优先级，默认输出到
`<dataRoot>/runs/sim`。`--output` 只能填写 data root 下的相对
`runs/sim[/subdir]`，绝对路径、`..` 和 symlink/junction 逃逸都会拒绝；测试使用独立临时 data root，不接触真实共享数据。

`--record-calibration` 只旁路记录 accepted plan、相邻 raw state 与 receipt；
不在线构建模型或派生训练数据。Runtime-Golden 校准与分析只通过离线模拟器命令执行。

只有取得明确真机授权、doctor 通过并确认无第二 writer 后，才可增加 `--live` 和有界 `--live-ticks=N`。

## 观测

```bash
curl http://127.0.0.1:8120/health
curl http://127.0.0.1:8120/ready
curl http://127.0.0.1:8120/tenants
curl 'http://127.0.0.1:8120/events?n=50'
curl 'http://127.0.0.1:8120/state?tenant=t1&stream=runtime'
```

`/health` 证明 Supervisor 活着；`/ready` 只有在每个 child PID 与对应 single-writer lock PID 持续一致时返回 200。

## 证据边界

- Pi t1 shadow 30 Tick：27 candidate、2 soft deadline、1 cold-start error、216 valid actions、0 invalid；这不是 hybrid/live 生产验收。
- Runtime-Golden 首份数据集：3 cases，已触发的 known deterministic events 6/6；主要覆盖 movement/economy/visibility。
- combat、Core migration、Beacon、respawn 已有实现、micro-Golden 和 invariant 测试，但仍需专项真机触发数据。
- `INCONCLUSIVE` 不能写成 `MATCH`，单个漂亮窗口不能写成长期收益。

共享权威进度见 [`../docs/progress/MASTER.md`](../docs/progress/MASTER.md)，本地运维见 [`../docs/ops/supervisor-runbook.md`](../docs/ops/supervisor-runbook.md)，服务器部署见 [`../docs/ops/server-deployment.md`](../docs/ops/server-deployment.md)。
