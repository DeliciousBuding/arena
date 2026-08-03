# 交接文档：经济闭环已跑通，进入 burn-in 与逐租户迁移

> 交接时间：2026-08-03 16:30 | 交接人：Claude（核实）+ GPT（实施）| 状态：**真实经济闭环已验证（HARVEST → cargo → DEPOSIT → Core 增长），t1 deterministic live burn-in 进行中**

## 1. 一句话项目

Arena Hero 游戏 bot，目标：积累 Core 资源 → 兑换公益站注册码。

**已定结论**：per-tick LLM 直控与 15s 游戏窗口结构性不兼容（冷启动 22.8s ≫ 14s deadline）。生产路径 = DeterministicPlanner + 异步 MacroPolicy + Safety fallback。

**最新进展**：确定性经济闭环首次真机跑通——不是"架构正确但不赚钱"，而是真实采集和入库闭环。

## 2. 当前现场（2026-08-03 16:30）

| 项 | 状态 |
|---|---|
| 代码 HEAD | `4f5151a`（本地 = 远端，无未推送） |
| t1 | **活跃**：deterministic live burn-in，pid 39064，run `9ec7b2c7`，gitSha `4f5151a`，16:12:29 启动 |
| t1 资源 | Core 10（两轮 Canary 从 6 → 9，burn-in 继续到 10） |
| t2 | 无锁（Python 旧进程可能仍在跑，未验证） |
| t3/t4 | Python 旧进程仍在跑（最近 300 tick 数据差，受旧导航振荡影响） |

## 3. 根因裁决（修正 handoff 旧猜测）

handoff 曾怀疑 `resourceCells` 丢失，**实际不是**：

- 游戏原始 Turn 包含 `kind: "RESOURCE"`；
- TS SDK 正确生成 `turn.resourceCells`；
- `state-reducer.ts` 也正确传入 `TickState`。

**真正问题**：

1. 导航算法只看下一步，遇到障碍在两格间振荡（Python 生产也有同样问题，cargo Worker 数百 tick 回不到 Core）；
2. 原 DeterministicPlanner 是单 Tick 骨架：资源离视野就丢目标、无资源直接 WAIT、无巡逻/记忆/回仓状态机。

## 4. 已完成的代码（勿重复）

### 4.1 经济闭环基础（7bd60f7 + 3c3161a）

- **有界 BFS 最短路导航**（`nav.ts`）：margin 4/8/16/32 扩大搜索框，返回最短路第一步，绕过长墙不再振荡；极端全堵 → fail-safe 单步；
- **DeterministicPlanner 复用 SafetyPlanner**：World 障碍记忆、资源线索、跨 Tick Worker 状态、分散巡逻；WorkerTaskPlanner 负责资源格全局唯一分配；
- **单写者锁加固**：真实 `wx`（O_CREAT | O_EXCL）原子创建，绝无"先 exists 再 write"竞态；
- **遥测语义修正**：deterministic 来源真实上报（不再伪装 safety）；无 Agent 热路径 deadlineOutcome=not_applicable（不再伪报 soft_deadline）；
- **经济遥测**：MOVE/HARVEST/DEPOSIT/WAIT 动作数（decision trace）；可见资源格数、cargo Worker 数/总量（outcome trace）。

### 4.2 效率与 burn-in 加固（3c3161a → 4f5151a，10 个提交）

```text
40989b9 feat(telemetry): attribute failed actions to prior plans（失败动作归因）
9baeb1f feat(runtime): add bounded graceful burn-in runs（有界优雅 burn-in）
4e78224 feat(telemetry): retain submit failure details
2d3bc72 fix(planner): resolve cell capacity before submit
5964354 feat(telemetry): measure intent mix and exploration spread
75249ed fix(map-store): retry concurrent WAL initialization
511c6d9 fix(runtime): synchronize before first live submission
d78df90 perf(planner): expand patrol coverage to eight directions
5db5313 perf(planner): expand patrol through layered rings
4f5151a feat(ops): add executable burn-in quality gates
```

## 5. 真机证据

### 第一轮经济闭环 Canary（run 7a0f9b0a，tick 43974→44009）

| 指标 | 结果 |
|---|---|
| accepted | 37/37 |
| HARVEST | 3 |
| DEPOSIT | 2 |
| Core 资源 | 6 → 8 |

### 第二轮效率 Canary（run f38102de，commit 3c3161a，tick 44010→44032）

| 指标 | 结果 |
|---|---|
| accepted | 14/14 |
| decisionSource | deterministic |
| WAIT | 0 |
| DEPOSIT | 1 |
| Core 资源 | 8 → 9 |

### 移动失败率对比（修复价值量级）

| 窗口 | MOVE | FAILED | 失败率 |
|---|---|---|---|
| 旧导航（1856 tick） | 4450 | 1765 | **39.7%** |
| run1 新导航 | 204 | 0 | 0% |
| run2 | 109 | 2 | 1.8% |

### 活跃 burn-in（run 9ec7b2c7，进行中）

- 观察点：tick 44322+，Core 10，visibleResourceCellCount 0→1（巡逻重新发现资源）
- 最近 40 tick：MOVE=312、FAILED=0、H=0/D=0（窗口内无 harvest——资源发现是稀疏事件）

## 6. 当前问题清单

### P1：移动冲突与失败原因

- run2 有 2 次 UNIT_MOVE_FAILED（tick 44010、44020，间隔 10 tick——疑似同一 worker 周期性被另一 worker 占格）；
- 下一步：补 reason_code 遥测 + Worker 下一格预约。

### P1：t1 100 Tick burn-in 门禁（进行中）

- accepted 必须 100%；
- repair=0；
- 不允许连续 20 tick 经济停滞；
- Core 净资源必须为正；
- 移动失败率低位。

### P2：逐租户迁移

- 先停对应 Python tenant；
- 单独切 t2 → 验证 → t3 → t4；
- 不四租户同时开闸。

### P2：MacroPolicy（#8 第二阶段，暂停中）

- LLM 只异步输出战略指令，永不控制每 Tick 动作。

### P2：仓库 SSOT（#6，未开始）

- `gen-status.py` 与实测不同步（报 TS 127 实际 226+）；
- CI 无防漂移。

### P2：Dependabot 1 个 high 漏洞（未处理）

- GitHub push 提示默认分支有 1 个 high 级依赖漏洞，未顺手修。

## 7. 下一步

```
1. 等 burn-in 完成（或按门禁提前判定）
2. 移动冲突修复：reason_code + 下一格预约
3. 逐租户迁移：t2 → t3 → t4
4. 仓库 SSOT（#6）
5. MacroPolicy（#8）最后接
```

## 8. 关键文件索引

| 路径 | 说明 |
|---|---|
| `packages/arena-agent/src/domain/nav.ts` | 有界 BFS 绕障寻路（核心修复） |
| `packages/arena-agent/src/planning/deterministic-planner.ts` | 确定性 Planner（巡逻/记忆/唯一分配） |
| `packages/arena-agent/src/strategies/safety-planner.ts` | 安全网 Planner（World 记忆/巡逻被复用） |
| `packages/arena-agent/src/app/tenant-runtime.ts` | 主入口 |
| `packages/arena-agent/src/app/single-writer-lock.ts` | wx 原子锁 |
| `packages/arena-agent/src/runtime/decision-coordinator.ts` | 决策核心 |
| `packages/arena-agent/src/telemetry/decision-trace.ts` | 遥测 schema（经济字段） |
| `runtime/t1/telemetry/` | t1 遥测数据（JSONL） |
| `runtime/configs/t1.json` | t1 配置（gitignored） |
| `docs/progress/MASTER.md` | 进度表（已同步） |

## 9. 密钥与环境变量

- `ARENA_HERO_API_KEY_1` ~ `ARENA_HERO_API_KEY_4`：四个租户的游戏 API 密钥
- `ARENA_MODEL_BASE_URL`：模型网关地址（newapi）
- 密钥只从 `process.env[name]` 读取，不落盘、不进 manifest/日志/issue