# Pure Rust 实现蓝图（基于现有代码审计）

> 本文不是重新画一套理想架构，而是回答：当前 `sim-rs` 已经实现了什么，哪些代码可以直接继承，哪些边界必须重构，以及下一批原子提交按什么顺序推进。
>
> 权威裁决：Pure Rust 是 Arena 唯一长期产品主线；TS 在迁移期继续承担 t1/t2 生产、真实数据校准、策略实验、Runtime-Golden 与回滚。Go/Fusion/FFI 不进入终态运行路径。

## 1. 对当前实现的结论

当前 Rust 不是“从零开始”，但也还不是生产 Agent。它已经是一套有价值的**确定性策略与模拟研究底座**：

- `domain`：强类型动作/单位/Core/状态模型，BTreeMap/BTreeSet 确定性迭代，stamped-grid BFS；
- `engine`：移动、经济、战斗、敌方攻击、治疗、生成、视野和 refill 的本地结算；
- `strategy`：Worker 资源分配、Core 满仓让位、补员/军事比例、恢复期覆盖、BFS 导航、停滞跳出、螺旋巡逻、Vanguard/Ranger 基础战斗；
- `cli`：simrun/simsearch/optsearch/paramscan/simgolden/simdebug；
- `ffi`：保留了跨 tick planner 状态、Go JSON 镜像、panic 边界和字符串所有权等迁移经验。

当前真正缺失的是**生产闭环与正确的领域边界**：

1. 没有 Rust-native Hero HTTP/WebSocket Client；
2. 没有 tenant runtime、single-writer lock、exactly-once、稳定幂等键、run manifest 和生产 telemetry；
3. 没有 Rust plan validator；
4. `domain::TickState` 仍按 Go/FFI PascalCase JSON 形状设计，把 wire、normalized observation 和模拟状态混在一起；
5. `strategy` 反向依赖 `engine`，生产策略与模拟结算边界不干净；
6. `strategy/src/lib.rs` 已成为大文件，World、任务分配、导航、经济、战斗和 Core 决策耦合；
7. 当前 engine 以单玩家可见 `TickState` 为输入，属于可控近似模拟，不应宣称完整官方 Digital Twin；
8. `ffi` 仍是 workspace 正式成员，容易继续把 Agent 拉回 Fusion。

因此不应重写已有 Rust，也不应继续扩 FFI。正确路径是：**保留纯算法资产，先重建生产边界，再逐步把策略深化到第一名级别。**

## 2. 终态依赖方向

保持少 crate，不为形式拆包：

```text
arena-domain
   ↑       ↑       ↑
arena-client  arena-strategy  arena-engine
      \          |          /
             arena-runtime
                  ↑
              arena-cli
```

严格规则：

```text
client   -> domain
strategy -> domain
engine   -> domain
runtime  -> client + domain + strategy
cli      -> client + runtime + strategy + engine
```

禁止：

- `strategy -> engine`；
- `strategy -> client/runtime`；
- `engine -> client/runtime`；
- `domain -> serde wire DTO` 的协议耦合；
- runtime 失败后静默切回 TS/Go；
- LLM 进入每 Tick 热路径或直接 submit。

`World` 暂时作为 `strategy::world` 模块，不新增独立 crate。只有当 runtime、replay 与 simulator 确实需要共享同一套 World API 时，再以真实依赖为依据拆 crate。

## 3. 四种状态必须分开

现有 `TickState` 同时承担太多职责。迁移采用适配器，不做一次性大爆炸重命名。

### 3.1 Wire DTO

只存在于 `arena-client`：

- 与 Hero snake_case JSON 一一对应；
- `#[serde(deny_unknown_fields)]`；
- 严格数值、枚举、条件字段和消息大小校验；
- 不被 strategy/engine 直接引用。

### 3.2 Observation

当前 Tick 的规范化可见事实：

- 当前己方 Core/Units；
- 当前可见敌人、资源、障碍；
- 当前 Tick 私有事件；
- 当前资源、人口、Beacon 和生命周期；
- canonical state hash。

现有 `domain::TickState` 在第一阶段可作为 `Observation` 的兼容别名，逐文件收敛，不阻塞纵切。

### 3.3 WorldMemory

跨 Tick 持久知识：

- 障碍与已探索区域；
- 资源证据状态、失败冷却和目标粘性；
- 敌人 last seen、位置历史、静止/活跃状态和确认删除条件；
- 单位长期任务、路线、巡逻扇区和恢复状态；
- 世界 epoch/tick 回退后的完整 reset。

记忆不能简单按短 TTL 抹掉威胁。资源可以依据 refill/采空证据降级；敌人只能因明确死亡，或当前视野覆盖其全部可能区域并确认不存在而删除。

### 3.4 PlanningSnapshot

Planner 每 Tick 的唯一输入：

```text
Observation
+ immutable WorldMemory snapshot
+ current StrategyProfile / MacroPolicy
+ route reservations
+ deadline budget
= PlanningSnapshot
```

这样 planner 不直接修改 World，也不读取 client/runtime 副作用。决策完成后由 World owner 接收当前 Observation 和结算事件更新记忆。

## 4. Validator 是第一生产组件，不是收尾组件

Rust 当前没有独立 validator，不能先接 live 再补。

设计为两个明确 API：

```rust
validate_strict(observation, plan) -> Result<ValidatedPlan, Vec<ValidationIssue>>
explain_invalid(observation, plan) -> Vec<ValidationIssue>
```

生产 deterministic 路径：

- 任意 issue 均 fatal；
- 不 repair、不删除非法动作后继续 submit；
- plan tick、受控单位集合、能力、地形、射程、Core 状态、资源成本全部 fail closed；
- 最终 wire encode 后再做一次结构校验。

离线测试如需观察“修复后会怎样”，可以提供 test-only helper，但不得被 runtime 依赖。

## 5. Runtime 核心状态机

不要复制 TS 的所有 Agent/Lease 复杂度。Pure Rust 第一版只实现确定性主路径：

```text
Disconnected
  -> Streaming
  -> ObservationReceived
  -> Duplicate/Stale Gate
  -> WorldObserved
  -> Planned
  -> StrictValidated
  -> ShadowRecorded | LiveSubmitted
  -> ReceiptRecorded
  -> SettlementObserved
```

### 5.1 Exactly-once 顺序

去重必须发生在 planning 和 decision telemetry 之前：

```text
收到 state
-> 检查 world epoch
-> 检查 tick > last_handled_tick
-> 固化 state_hash
-> decide 一次
-> 固化 plan_hash
-> validate
-> shadow 或 submit
```

持久 journal 至少记录：

```text
tenant_id
world_epoch
last_seen_tick
last_handled_tick
last_submitted_tick
state_hash
plan_hash
idempotency_key
receipt/outcome
```

同一 `(epoch,tick)` 重放：

- state hash 相同：只更新连接/receipt 信息，不重复 decide；
- state hash 不同：protocol/world-reset 异常，立即停止并取证；
- 已记录 plan hash 与重新计算不一致：determinism violation，立即停止。

### 5.2 稳定幂等键

```text
arena:v2:<tenant>:<tick>:<stateHash16>:<planHash16>
```

同一 Tick、同一状态、同一计划跨进程保持相同。第一次计划写入 journal 后，不允许同 Tick 生成第二个不同 plan/key。

### 5.3 Single-writer lock

只在 live 模式获取，内容至少包括：

```text
tenant / pid / process-starttime / instance-nonce / acquired-at / mode
```

- 原子创建；
- 活锁绝不抢占；
- PID 复用需 starttime 一致才算活；
- shadow 不拥有 live submit 权；
- SIGINT/timeout/panic 必须释放锁和文件句柄。

### 5.4 Accepted 与 Settlement 分离

HTTP 202 只表示命令被接受，不表示动作结算成功。Telemetry 分四流即可，不再继续堆表：

1. `runtime.jsonl`：连接、去重、deadline、退出；
2. `decision.jsonl`：observation hash、profile、plan hash、intents、validator；
3. `submit.jsonl`：key、HTTP/receipt、重试；
4. `outcome.jsonl`：下一状态 delta、事件 reason、spawn/no-effect、cargo stall。

## 6. Strategy 重构方式

不改变行为地拆分，再逐版本增强：

```text
strategy/src/
├── lib.rs              # Planner trait + orchestration，保持短
├── profile.rs          # StrategyProfile + hash
├── world.rs            # WorldMemory owner / immutable snapshot
├── task.rs             # Task/priority/forced task
├── assignment.rs       # 全局目标分配与粘性
├── economy.rs          # harvest/return/deposit/spawn
├── navigation.rs       # route service
├── reservation.rs      # t+1..H 时空容量预约
├── exploration.rs      # frontier/sector/blacklist
├── threat.rs           # enemy memory/ETA/risk
├── combat.rs           # target allocation/intercept/kite
└── core.rs             # Core survival/production/migration
```

第一阶段只是移动现有函数和测试，不改变输出。完成后再引入新能力。

### 6.1 任务优先级

固定为可审计的抢占链：

```text
manual override（未来）
> Core 即时生存
> 正在发生的战斗/撤退/堵路
> 已有跟踪任务
> Worker 采集/交付/满载安全等待
> 探索/旧区域复查
> 安全巡逻
```

每个 Task 至少包含：

```text
task_id / kind / target / priority / created_tick
sticky_until / invalidation_reason / route_id
```

新目标只有在收益超过 hysteresis threshold，或旧目标明确失效时才能替换。

### 6.2 全局资源分配

现有实现是“Worker 按 ID 排序后，各取最近未占用格”，能避免抢格，但不是真正全局最优。

下一版使用小规模最小成本匹配。成本包含：

```text
worker -> resource route ETA
+ resource -> Core return ETA
+ risk penalty
+ congestion penalty
+ unreachable penalty
- sticky bonus
```

单位和资源规模很小，可先使用确定性 DP/最小费用匹配，不引入重型优化库。

### 6.3 导航与预约

保留现有 stamped BFS，但接口改为：

```text
RouteService::plan(start, goal, static_map, risk_map) -> Route
ReservationTable::reserve(route, start_tick, capacity=2)
```

- 普通格容量 2；
- Core 自身占一个槽，入口通常只剩一个可用位置；
- 事前预约 `t+1..t+H`，不是所有冲突最后都降级 WAIT；
- loser 优先 reroute，只有无安全替代才 WAIT；
- 路线迟滞与 A-B-A 环检测进入 Route 状态，不塞进 unit 行为函数。

### 6.4 探索

现有螺旋巡逻保留为 fallback，不再作为唯一探索算法。

主算法：

```text
visible frontier
+ sector ownership
+ age / expected vision gain
+ route cost
+ Core defense budget
+ unreachable blacklist
```

连续外扩语义保留，但由 frontier 和 coverage 驱动；固定 8/16/24/32/40 环只用于没有足够地图信息时的确定性兜底。

### 6.5 Threat 与战斗

在经济、地图和预约稳定后再做：

1. 敌方持久记忆与明确删除证据；
2. stationary/active 分类；
3. 位置历史与有限运动假设；
4. Core 十格重点防御区；
5. 两个 Ranger 固定环形巡逻；
6. 多单位目标分配、预测攻击点、追击/撤退/堵路；
7. 敌 Core 进攻与兵力门槛。

不要先写复杂评分公式。每增加一层，都必须有构造场景、paired seeds 和真实 shadow 证据。

## 7. Simulator 的定位修正

当前 engine 是高价值实验器，但输入是单玩家可见 `TickState`，并包含启发式 enemy attack。它不能直接叫“官方完整 Digital Twin”。

结果统一标记 fidelity：

```text
EXACT        已由规则/Runtime-Golden 证明
APPROXIMATE  明确使用近似 refill/敌方策略/可见状态重建
UNKNOWN      官方 server-secret 或不可观测
```

长期若要做真正对战世界模型，应另建 full `SimWorld`：双方完整状态、地形、行动批次、视野投影；`Observation` 只是从 `SimWorld` 投影出的玩家视角。不要继续给当前 `TickState -> next TickState` 引擎偷偷增加不可证明的官方语义。

## 8. 近期原子提交顺序

### C0 — 收口与绿色基线

1. 合并 #32，清除 active Fusion SSOT；
2. 增加 `sim-rs` 独立 CI：fmt/clippy/test；
3. 记录测试数、release benchmark 和 fixture hash；
4. 将 `strategy -> engine` 改为 dev-dependency 或移除；
5. 给 `ffi` 标记 deprecated，暂不立即删除，先完成知识提取。

### C1 — Domain trust boundary

1. Rust strict validator；
2. canonical Observation/Plan hash；
3. wire/domain adapter 测试；
4. 对现有 planner 全量运行 validator，必须 0 invalid。

### C2 — Rust-native Client read-only slice

1. `crates/client`；
2. TS raw fixtures 逐条解析；
3. WS 认证、消息上限、idle timeout、reconnect；
4. `arena shadow --tenant t3 --max-unique-ticks 100`；
5. 不实现 live submit 权限，只输出 manifest/runtime/decision JSONL。

### C3 — Exactly-once shadow runtime

1. `crates/runtime`；
2. unique Tick gate + journal；
3. 世界 reset/epoch；
4. duplicate replay、state hash conflict、determinism violation 回归；
5. t3/t4 断流重连 100 唯一 Tick，0 duplicate decide。

### C4 — Bounded live kernel

1. stable idempotency；
2. single-writer lock；
3. strict validator fatal；
4. HTTP exact-body retry；
5. settlement outcome；
6. 仅 t3/t4：3 -> 10 -> 30 Tick bounded live，任一 hard gate 非零立即退 shadow。

### C5 — World/经济

1. resource memory；
2. global min-cost matching；
3. target hysteresis；
4. Core gate / cargo stall；
5. move reservation；
6. sparse/far/core-gate paired A/B。

C5 完成后才进入 exploration/threat/combat。这样能快速形成可运行纵切，同时避免把高级策略建立在不可信 runtime 上。

## 9. 只保留四个硬门禁

为保证快速迭代，不堆几十个流程门槛。所有阶段只守四条：

1. **Safety**：第二 writer、invalid/repair、duplicate submit、panic/orphan 全为 0；
2. **Determinism**：同 fixture/profile/seed 的 plan hash 与稳定指标可复现；
3. **Outcome**：不拿 HTTP accepted 代替 settlement state delta；
4. **Evidence**：每次晋级绑定 git/profile/rules/fixture/scenario hash 和产物路径。

其余都是普通测试与指标，不升级为行政门禁。

## 10. 当前下一步

```text
Pure Rust Agent 推送/回执实际 WIP
-> 审查并合并 #32
-> 建 Rust CI 绿色基线
-> C1 strict validator + canonical hash
-> C2 Rust-native read-only client
-> C3 exactly-once shadow runtime
-> t3/t4 100 unique Tick shadow
```

此顺序完成前，不继续修 FFI，不扩 Go planner，不写高级战斗，不让 LLM 参与 Tick 决策。