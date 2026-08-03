# Arena

Arena 是 Arena Hero 的 **TS-only** 安全自主运行时、确定性策略和 Digital Twin。
目标不是堆一层平台，而是在单写者、硬截止、部分可观测和不可信 Provider 条件下稳定运行。

> 正式运行链只有 `arena-hero-ts → arena-agent → SDK submit`。Pi 只能提交候选，永远不持有游戏提交权；Python 实时 runtime 已退役。

## 当前状态

已完成：

- TS SDK、wire/domain schema、Golden fixture 与协议门禁；
- DecisionLease、Coordinator、Arbiter、Validator 与确定性 fallback；
- DeterministicPlanner 经济闭环，t1–t4 历史真机窗口合计 400/400 accepted；
- Pi `createAgentSession` 原生嵌入，builtin 关闭，只开放 `arena_plan` / `arena_map`；
- Provider circuit breaker：`closed → open → half-open`，失败时快速退回 deterministic/safety；
- 单租户 manifest、single-writer lock、runtime/decision/outcome/pi JSONL；
- 原生 `TenantSupervisor`：全量 preflight、部分启动回收、lock-backed readiness、端口预占、IPC 优雅关闭与跨平台 process-tree 清理；
- 只读 Debug API：`/health`、`/ready`、`/tenants`、有界 `/events` 与 `/state`；
- Digital Twin 与首份 Runtime-Golden 数据集。

代码门禁已经通过 Windows 与 Linux Node 24；生产长期验收仍需四租户分级 soak、Provider shadow 故障注入、TS 版本回滚演练和专项 Runtime-Golden。

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
python scripts/gen-status.py --check
python scripts/docs_health.py --check
```

单租户：

```bash
npx tsx packages/arena-agent/src/cli/run-tenant.ts \
  --config=runtime/configs/t1.json --doctor

npx tsx packages/arena-agent/src/cli/run-tenant.ts \
  --config=runtime/configs/t1.json --mode=deterministic --shadow
```

四租户 Supervisor（只观察）：

```bash
npm run arena:supervisor -- \
  --configs=t1,t2,t3,t4 --mode=deterministic --shadow --port=8120
```

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

权威进度见 [`docs/progress/MASTER.md`](docs/progress/MASTER.md)，运维步骤见 [`docs/ops/supervisor-runbook.md`](docs/ops/supervisor-runbook.md)。
