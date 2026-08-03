# Arena Digital Twin MVP — 架构计划

最后更新：2026-08-03

证据输入：

- `../analysis/findings-for-planning.md`
- `../analysis/official-source-verification.md`
- `docs/roadmap-long-term.md` W10
- 当前 TS domain/planning/runtime 代码

## 1. 决策摘要

本期实现一个**独立进程、无网络提交能力、可校准的经济模拟器 MVP**，复用线上同一套 Planner，但不复用线上 Client/Turn/tenant runtime。

核心裁决：

1. 模拟器落在 `packages/arena-agent/src/sim/`，因为它消费 domain `Plan/TickState` 与 Planner，而不是 SDK 网络能力；
2. `SimWorld` 是完整权威世界；Planner 只能看到由 visibility projector 生成的 PlayerState/TickState；
3. settlement engine 使用显式 phase pipeline，内部 phase 可比官方文档更细，但必须映射回 v0.11 官方阶段；
4. 所有随机性都通过注入端口；默认 MVP 不伪造官方 secret refill，而标记为 `unknown`；
5. 第一个可用版本只覆盖 movement/economy/vision/己方 Core action 子集，不实现 combat、Core migration、对手策略、respawn、官方 refill 位置；
6. 模拟结果只用于**筛选与相对比较**，不能自动解锁生产部署；真实收益仍需 shadow/canary/A-B 证据。

## 2. 目标与非目标

### 2.1 MVP 目标

- 1000 Tick 本地运行进入秒级；
- 同一 seed + 同一 scenario + 同一 planner config 逐字节确定；
- 线上 Planner 无业务逻辑 fork，即可在 sim 闭环运行；
- movement/economy/vision 的人工 micro-Golden 全绿；
- 有完整 plan 的真实样本上，己方确定性事件差异可分类、可追溯；
- 六条隔离边界均有自动化门禁。

### 2.2 明确非目标

本期不实现：

- combat snapshot / damage / Core capture；
- Core migration；
- Beacon 争夺；
- respawn；
- 多玩家 opponent policy；
- 服务端 secret refill 的精确复现；
- HTTP/WS、receipt、rate-limit、幂等重试；
- 自动发布策略到 live；
- RL、自博弈、价值模型训练。

遇到超出范围的输入必须返回结构化 `unsupported`，不能默默当 WAIT 或忽略。

## 3. 总体数据流

```text
Scenario / snapshot / calibration case
                 │
                 ▼
              SimWorld  ───────────────┐
                 │                     │
                 │ visibility project  │ locked full Plan(s)
                 ▼                     │
            PlayerState                │
                 │ SimTurnLike         │
                 ▼                     │
             reduceTurn                │
                 ▼                     │
              TickState                │
                 ▼                     │
      existing PlanProvider/Planner    │
                 ▼                     │
                Plan ──────────────────┘
                 │
                 ▼
        settleTick(world, plans)
                 │
                 ├── ResolutionEvent[]
                 ├── UnknownEffect[]
                 ├── UnsupportedFeature[]
                 └── next SimWorld
```

关键原则：策略层永远从私有 observation 决策，不得直接读取 `SimWorld` 中的隐藏信息。

## 4. 目录设计

```text
packages/arena-agent/
├── src/
│   ├── sim/
│   │   ├── contracts/
│   │   │   ├── rules-v0.11.json
│   │   │   ├── rules-manifest.ts
│   │   │   └── calibration-case.ts
│   │   ├── deterministic/
│   │   │   ├── compare-uuid.ts
│   │   │   ├── coordinates.ts
│   │   │   └── seeded-rng.ts
│   │   ├── world/
│   │   │   ├── model.ts
│   │   │   ├── invariants.ts
│   │   │   ├── scenario-loader.ts
│   │   │   └── snapshot-loader.ts
│   │   ├── engine/
│   │   │   ├── settle-tick.ts
│   │   │   ├── phase.ts
│   │   │   ├── self-destruct.ts
│   │   │   ├── capacity.ts
│   │   │   ├── upkeep.ts
│   │   │   ├── movement.ts
│   │   │   ├── worker-actions.ts
│   │   │   └── core-actions.ts
│   │   ├── visibility/
│   │   │   ├── supercover.ts
│   │   │   ├── visible-cells.ts
│   │   │   └── project-player-state.ts
│   │   ├── harness/
│   │   │   ├── sim-turn-like.ts
│   │   │   ├── run-episode.ts
│   │   │   └── planner-factory.ts
│   │   ├── calibration/
│   │   │   ├── recorder-contract.ts
│   │   │   ├── replay-case.ts
│   │   │   ├── compare-next-state.ts
│   │   │   └── divergence.ts
│   │   ├── telemetry/
│   │   │   ├── sim-record.ts
│   │   │   └── writer.ts
│   │   └── index.ts
│   └── cli/
│       ├── run-sim.ts
│       └── calibrate-sim.ts
├── scripts/
│   ├── check-sim-isolation.mjs
│   └── build-calibration-fixture.ts
└── test/
    ├── sim-*.test.ts
    └── fixtures/sim/
```

不新增独立 npm package。MVP 先利用 `arena-agent` 已有 domain 与 planner 类型，避免过早抽象成通用框架。

## 5. 核心模型

### 5.1 `SimWorld`

`SimWorld` 是模拟器内部唯一权威状态，至少包含：

- `tick`、`resolvedTickCount`、`rulesVersion`；
- players：资源、Core、Units、状态；
- terrain：obstacles、resource nodes 与剩余量；
- occupancy index；
- 可选 Beacon placeholder；
- deterministic seed/stream position；
- feature support flags；
- provenance：scenario/calibration case hash。

所有集合使用稳定 key 与不可变输入；phase 可以使用局部 mutable draft，但 `settleTick` 返回新快照，不原地泄漏旧 world。

### 5.2 三层状态严格分离

| 层 | 用途 | 能否含隐藏信息 |
|---|---|---|
| `SimWorld` | engine 权威状态 | 可以 |
| `PlayerState` | SDK wire 等价 observation | 不可以 |
| `TickState` | domain reducer 后的 Planner 输入 | 不可以 |

禁止把 `SimWorld` 强转为 `TickState`。唯一合法路径是：

```text
SimWorld -> projectPlayerState(playerId) -> SimTurnLike -> reduceTurn
```

### 5.3 Plan 锁定

每 Tick 每 player 输入一个完整 `Plan`。Harness 在 settlement 前冻结 plans：

- 缺失 unit action 等价 `WAIT`；
- `coreAction: null` 等价无动作；
- 同 Tick 后一个 plan 可整体替换前一个，但 episode 默认每 Tick只接收最终 plan；
- settlement 不读取 Planner 的可变对象；
- 下一 Tick 产生后旧 observation/turn handle 失效。

## 6. Settlement phase pipeline

MVP 内部 phase：

```text
P01 lock-final-plans
P02 self-destruct
P03 capacity-shrink-after-removal
P04 upkeep-and-deficit
P05 unit-movement
P06 unsupported-core-migration-check
P07 unsupported-beacon-check
P08 harvest-and-deposit
P09 unsupported-combat-check
P10 unit-heal
P11 stationary-core-action
P12 unsupported-respawn-check
P13 refill-policy
P14 invariant-check-and-commit
P15 next-observation
```

说明：

- `unsupported-*` 不是空注释；若输入/场景触发对应能力，必须把 episode 标记为不可作为确定性 Golden；
- capacity shrink 拆成独立内部 phase，但 manifest 记录其官方阶段映射；
- `refill-policy` 默认 `unknown/disabled`，micro scenario 可注入测试 RNG policy，但不能称为官方 refill；
- 每个 phase 输出稳定排序的 `ResolutionEvent[]` 与结构化诊断。

## 7. Movement resolver 设计

movement 是本期最高风险模块，采用“候选图 + 最终占用约束”而非逐 Unit 顺序执行。

步骤：

1. 静态预检：actor、cardinal direction、safe coordinate、terrain；
2. 形成 source→destination 候选；
3. 标记跨玩家 contested destination；
4. 计算同玩家目标槽位与 raw UUID tie-break；
5. 构建 occupant dependency graph；
6. 识别固定点、链、合法长 cycle、非法跨玩家 swap；
7. 失败传播；
8. 一次性写入成功移动；
9. 校验最终 occupancy ≤ 2、敌我不共格；
10. 按稳定 actor order 生成 events。

禁止“遍历 actions，能走就立即改坐标”的实现，因为它会把容器迭代顺序变成规则。

## 8. Economy resolver 设计

MVP 支持：

- `SELF_DESTRUCT`；
- capacity shrink；
- upkeep + v0.11 deficit damage；
- `HARVEST` / `DEPOSIT`；
- Unit `HEAL`；
- Core `SPAWN` / `HEAL` / `REPAIR_SHIELD`；
- Core `WAIT` / null。

经济 resolver 只读取 rules contract，不在代码中散落 magic numbers。所有资源变化记录 reason：

- upkeep paid/deficit；
- harvest node decrement；
- deposit accepted/overflow；
- spawn/heal/repair spend；
- capacity overflow destruction。

对 combat、Core migration、Beacon 引起的经济变化统一标记 unsupported，不做伪近似。

## 9. Visibility 设计

- 先计算每个 living friendly object 的 Manhattan candidate cells；
- 对 candidate 使用 integer supercover line 判断 obstacle occlusion；
- friendly objects 即使视野外也进入 PlayerState；
- enemy objects、resource、obstacle 按当前 visible cells 裁剪；
- obstacle 自身可见；
- Beacon public coordinate 与私有 carrier status 的规则留独立 projector；MVP 未启用 Beacon 行为时仍保持结构兼容；
- 输出对象/positions 使用 canonical stable sort，保证 snapshot 可 diff。

micro-Golden 必须覆盖：直线障碍、对角格角、两侧任一障碍、多个友军视野 union、资源离开视野后消失。

## 10. 六条隔离边界与自动化门禁

| # | 边界 | 结构实现 | 自动化验收 |
|---|---|---|---|
| 1 | 进程隔离 | 仅 `run-sim.ts`/`calibrate-sim.ts` CLI | 测试中不创建 tenant runtime；CLI 可在无任何凭据环境运行 |
| 2 | 提交通道隔离 | sim 禁止 Client/Turn/runtime loop；无 submit port | AST/import checker 禁 `client.ts`、`ArenaHeroClient`、`runtime/loop`、`tenant-runtime`、`fetch`、`WebSocket`；恶意 fixture 写 API key 也不能发网 |
| 3 | 锁/端口隔离 | 不调用 single-writer-lock，不监听端口 | checker 禁 lock/8123-8126/listen/createServer；测试前后端口状态不变 |
| 4 | 数据隔离 | 输入只读；输出限 `runs/sim-*` | path policy 拒绝写 fixtures/mapstore/普通 runs；输入 hash 前后一致 |
| 5 | CPU 隔离 | 默认 serial，显式 `--workers` 上限 | 默认并发 1；上限不超过配置；benchmark 与 live run 无隐式联动 |
| 6 | 产物隔离 | `sim.v1.*` record + 独立目录 | schema/prefix 检查；禁止写 runtime/decision/outcome 线上文件名 |

`check-sim-isolation.mjs` 必须进入 root `npm run check`，不能只靠 README 约定。

## 11. 规则 SSOT 与漂移处理

`rules-v0.11.json` 包含可执行数值；`rules-manifest.ts` 包含 provenance：

```text
rulesVersion
docCommit
sdkVersion
sdkPublicCommit
sdkDocumentedCommit
serverDocumentedCommit
verifiedAt
supportedFeatures
sourceFiles + content hashes
```

规则漂移门禁：

- 官方 docs commit 变化时，不自动改数值；
- 先生成 source diff，人工核对；
- manifest hash 变化后，旧 calibration report 状态变为 `stale`；
- 旧 benchmark 可保留，但不得作为新 rules version 的晋级证据。

Planner/Validator/Simulator 当前不强行一次性改成 JSON 动态读取。第一步先建立一份 typed rules module 由 JSON 生成/校验，随后再逐步消除散落常量；避免为了 SSOT 大爆炸重构线上路径。

## 12. Golden Simulation 与差异分类

### 12.1 两类 Golden

**A. Micro-Golden（规则单元）**

- 人工构造完整 SimWorld + plans；
- 精确断言 next world/events；
- 覆盖 movement graph、upkeep、capacity、harvest/deposit、vision；
- 是 MVP 开发的首要 correctness gate。

**B. Runtime-Golden（真实校准）**

- 必须包含 full input state、full submitted plan、next state；
- 先只比较可观察且本期支持的确定性字段；
- 隐藏对手/refill/视野外变化不能被错误计为 simulator bug。

### 12.2 差异 taxonomy

```text
MATCH
SIMULATOR_BUG
RULE_MISUNDERSTANDING
UPSTREAM_VERSION_DRIFT
HIDDEN_OPPONENT_EFFECT
SECRET_REFILL_EFFECT
UNSUPPORTED_FEATURE
INSUFFICIENT_CALIBRATION_DATA
OBSERVATION_ONLY_DIFFERENCE
```

每一个 mismatch 必须有且只有一个最终分类；未知不能自动归入“可解释”，必须附证据。

## 13. CLI 设计

```bash
npm run sim:run -- --scenario test/fixtures/sim/economy-basic.json --ticks 1000 --seed 1
npm run sim:bench -- --scenario-dir test/fixtures/sim/bench --ticks 10000
npm run sim:calibrate -- --case-dir fixtures/sim-calibration/<dataset>
npm run sim:isolation-check
```

输出：

```text
runs/sim-<timestamp>-<shortid>/
├── manifest.json
├── sim.runtime.jsonl
├── sim.decisions.jsonl
├── sim.outcomes.jsonl
├── final-world.json
└── report.md
```

CLI 不读取 `.env`，不接受 API key/base URL/websocket URL 参数。

## 14. 晋级与回滚

### 14.1 MVP 完成门槛

- isolation checker 100% 通过；
- micro-Golden 全绿；
- 同 seed 重跑 hash 一致；
- 10,000 Tick benchmark 无 invariant failure；
- 1000 Tick 达到秒级，报告实际 tick/s；
- Runtime-Golden 有至少一批 full-plan 样本；
- 所有差异完成 taxonomy 分类；
- root 全量门禁通过。

### 14.2 不自动解锁的事项

即使模拟器全绿，也不自动：

- 修改 live submission mode；
- 扩大租户；
- 合并策略收益结论；
- 启动 RL；
- 删除 Python rollback 链。

### 14.3 回滚方式

模拟器是新增离线路径：

- 删除/回滚 sim 目录与 package scripts 即可；
- 不改 Client、tenant runtime、single-writer lock；
- Planner 若为复用而抽取纯函数，必须先证明线上输出逐字节不变；
- 任一线上行为变化都视为越界，单独拆 PR，不与模拟器 MVP 混合。
