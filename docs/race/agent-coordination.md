# Agent Coordination — Race v1

## 1. 当前角色

### TS Agent

允许修改：

- `packages/arena-agent/**`
- `packages/arena-hero-ts/**`
- TS 运行/模拟/实验文档与测试
- t1/t2 本地 live 与 calibration 相关配置、看护和证据

禁止修改：

- `sim-rs/**`
- `internal/strategy/ffi_*`
- Fusion 分支 README/PROGRESS/plan
- `docs/race/**`、`contracts/race/**`（除非 Issue #27 明确分配）

### Fusion Agent

允许修改：

- `cmd/**`、`internal/**` 中 Go Host/Fusion 所属代码
- `sim-rs/**`
- Fusion 运行、shadow、FFI、模拟与性能证据
- t3/t4 shadow/bounded 配置

禁止修改：

- `packages/arena-agent/**`
- `packages/arena-hero-ts/**`
- t1/t2 live 配置与 Watchdog
- `docs/race/**`、`contracts/race/**`（除非 Issue #27 明确分配）

### Race Controller

唯一写入：

- `docs/race/**`
- `contracts/race/**`
- Issue #27 的跨线裁决

## 2. 当前任务收口协议

两边 Agent 收到 Race v1 后，不要求丢弃已有 WIP；按以下顺序处理：

1. 停止横向新增文件；
2. 将当前任务压成一个可描述的原子变更；
3. 运行对应语言门禁；
4. 提交并推送自己的分支；
5. 在 Issue #27 回执；
6. 再领取下一原子任务。

若当前 WIP 已触碰对方地界或共享契约：不要继续扩大，列出具体文件并等待裁决。

## 3. 回执模板

```text
line: TS | FUSION
branch:
head:
current task:
touched files:
tests/evidence:
uncommitted WIP:
conflicts with Race v1: none | ...
next atomic task:
```

## 4. 提交纪律

- 一个提交只解决一个可验证问题；策略实现、基线更新、文档证据可以相邻提交，但不得把无关清理混入。
- 提交信息必须写明场景、tick/seed、基线和结果；不能只写“优化”“修复”。
- 运行产物放 `runtime/**`，不得提交 token、绝对密钥路径、pprof 临时文件或大体积原始日志。
- Shared contract 变更必须先有 Issue #27 comment：字段动机、兼容性、TS 映射、Fusion 映射、fixture。
- 不直接 merge 对方实现分支；同步的是规则、fixture、profile 和结论，不是整条历史。

## 5. 文件冲突处理

| 冲突类型 | 处理 |
|---|---|
| 两边同时改共享契约 | 后提交者停手；由 Race Controller 合并语义 |
| 实现字段不同名 | 在 `implementation-mapping.md` 映射，不复制第二份 schema |
| 模拟结果不一致 | 先分类规则差异/可观测差异/实现 bug；不得直接改 golden |
| 本地未提交 WIP 与远端推进冲突 | 先保存 patch/临时分支，再 rebase；禁止 force push 覆盖他人提交 |
| live 与实验冲突 | live 数据线优先；实验只定向杀匹配 PID，禁止全局杀 Node/Go 进程 |

## 6. 本机即时通信镜像

本机协作文件仍为：

```text
D:\Code\Projects\arena-mail.md
```

Agent 看到本文件后应把以下最小通知追加到该文件，不复制整份设计：

```text
Race v1 生效：共享总控 Issue #27；跨线契约见 coordination/race-v1 的 docs/race 与 contracts/race。TS 只管 main+t1/t2，Fusion 只管 rust-rewrite+t3/t4；当前原子任务收口后到 #27 回执。
```

本机 mail 只用于即时提醒，不覆盖仓库证据和契约。

## 7. 下一阶段固定分工

TS：

1. 保持 t1/t2 live + calibration 稳定；
2. 收口当前策略实验；
3. 输出可迁移 fixture/指标，不继续扩跨线 schema；
4. 作为 Fusion 的真实回放与生产回滚基线。

Fusion：

1. 统一 deterministic-rust fail-closed；
2. FFI handshake/fallback telemetry；
3. ResourceMemory；
4. ExplorationMemory/blacklist；
5. Move reservation；
6. ThreatMemory；
7. Core defense/combat；
8. 按 promotion runbook 晋级。
