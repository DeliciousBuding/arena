# Arena Digital Twin MVP — 任务拆分

最后更新：2026-08-03

执行原则：**10 个任务、5 个批次；每批可独立评审和回滚。任何任务都不得修改 live 提交行为。**

## 总表

| ID | 任务 | 优先级 | 工作量 | 依赖 | 主要交付 |
|---|---|---:|---:|---|---|
| S0 | 官方来源锁定与规则 manifest | P0 | M | — | rules/provenance SSOT |
| S1 | 模拟器隔离骨架与门禁 | P0 | M | S0 | 无网络/无锁/无端口 CLI skeleton |
| S2 | 确定性原语与 SimWorld | P0 | L | S0, S1 | UUID/坐标/RNG/world/invariants |
| S3 | Settlement pipeline 骨架 | P0 | M | S2 | phase orchestration + diagnostics |
| S4 | Movement resolver | P0 | XL | S3 | dependency graph/capacity/tie-break |
| S5 | Economy resolver | P0 | XL | S3, S4 | self-destruct/upkeep/worker/core actions |
| S6 | Visibility 与 observation adapter | P0 | L | S2 | supercover/PlayerState/TurnLike |
| S7 | Planner 闭环 harness | P0 | M | S5, S6 | existing Planner 1000 Tick episode |
| S8 | Golden 录制、校准与差异分类 | P0 | XL | S5, S6, S7 | full-plan dataset + calibration report |
| S9 | CLI、benchmark、CI 与文档收口 | P1 | L | S1-S8 | scripts/report/full gates |

---

## Batch A — 来源与安全基座

### S0 — 官方来源锁定与规则 manifest

**目标**

把本次官方核对结果变成机器可验证的规则 provenance，防止模拟器在不知情的情况下使用过时规则。

**改动建议**

- 新增 `src/sim/contracts/rules-v0.11.json`；
- 新增 `rules-manifest.ts`；
- 记录 docs commit、SDK public/documented commit、server documented commit、verifiedAt、source hashes；
- typed loader 校验 required fields 与数值范围；
- 规则版本变化令 calibration report 自动标记 stale；
- 不在本任务大规模重写现有 Planner/Validator 常量。

**验收标准**

- manifest 明确包含 v0.11、docs `72de5c15...`、SDK public `4a29585...`、documented `8f967aa...`；
- 自动测试可检测 source hash/manifest 不一致；
- 未核对的新规则版本不能被 CLI 静默加载；
- `docs/game-rules.md` 未被错误标为官方 SSOT。

**测试**

- manifest schema positive/negative；
- unsupported rules version fail closed；
- provenance hash deterministic。

**禁止事项**

- 不自动联网更新规则；
- 不把服务端不可访问解释成“规则已完全验证”。

---

### S1 — 模拟器隔离骨架与门禁

**目标**

在编写 settlement 前先证明 simulator 从结构上没有线上提交能力。

**改动建议**

- 新增 `src/sim/` 与最小 `cli/run-sim.ts`；
- CLI 仅接受 scenario/ticks/seed/output/workers；
- 新增 `scripts/check-sim-isolation.mjs`；
- checker 扫描 sim/CLI import graph 与危险标识；
- 新增输出 path policy：只能写 `runs/sim-*`；
- 默认 workers=1，设置保守上限；
- 接入 `npm run check`。

**隔离 checker 至少拒绝**

```text
ArenaHeroClient
client.ts
runtime/loop.ts
tenant-runtime
single-writer-lock
fetch(
WebSocket
createServer/listen
8123/8124/8125/8126
.env / dotenv
API_KEY / BASE_URL / WEBSOCKET_URL
```

只允许对 SDK wire 类型做 `import type`，不允许 SDK client/Turn value import。

**验收标准**

- 清空所有 Arena 环境变量后 CLI 能启动并完成 no-op scenario；
- 恶意测试文件引入 Client/fetch 时 checker 必须红；
- sim 运行前后 fixtures/mapstore hash 不变；
- 不创建 lock、不监听端口、不出现网络请求；
- 输出只落 `runs/sim-*`，schema 前缀为 `sim.v1`。

**测试**

- checker self-test；
- path traversal/absolute output 拒绝；
- 无凭据 smoke；
- workers 边界测试。

---

## Batch B — 状态与引擎骨架

### S2 — 确定性原语与 SimWorld

**目标**

建立不会受 locale、迭代顺序、浮点越界和隐式随机影响的权威世界模型。

**改动建议**

- `compareUuidRaw()`；
- safe coordinate validators；
- seeded RNG 接口与 deterministic test implementation；
- `SimWorld/SimPlayer/SimUnit/SimCore/ResourceNode`；
- occupancy/materialized indexes；
- scenario loader 与 raw snapshot loader；
- canonical serializer/hash；
- world invariants。

**必须检查的不变量**

- tick/resolvedTickCount 单调；
- 坐标全部 safe integer；
- id 全局唯一；
- population 与 living units 一致；
- resource/cargo/hp/shield 非负且不超上限；
- occupancy index 与对象位置一致；
- 每格容量不超规则；
- 敌我终态不共格；
- rules version 与 world manifest 一致。

**验收标准**

- 同一 scenario 两次 canonical hash 一致；
- UUID comparator 对固定 vectors 与 Python raw bytes order 一致；
- 超出 JS safe integer 的坐标 fail closed；
- loader 不修改输入文件；
- 1000 次 clone/serialize 无状态串扰。

**测试**

- UUID vectors；
- coordinate boundary；
- loader/schema；
- invariants property-style table tests；
- canonical serialization。

---

### S3 — Settlement pipeline 骨架

**目标**

先固定结算时序、phase API、事件与错误语义，再实现具体规则。

**改动建议**

- `settleTick(world, plans, context)`；
- phase registry 与官方 phase mapping；
- mutable draft 仅限 settlement 内部；
- `ResolutionEvent/UnknownEffect/UnsupportedFeature`；
- phase 前后 invariant hook；
- atomic commit/rollback：任一 invariant failure 不返回半更新 world；
- stable event ordering。

**验收标准**

- 15 个内部 phase 按固定顺序运行；
- phase 抛错时原 world hash 不变；
- 触发未支持功能时明确返回 `UNSUPPORTED_FEATURE`；
- unknown/refill 不被伪装成 MATCH；
- event 顺序在不同对象插入顺序下不变。

**测试**

- phase order snapshot；
- rollback on failure；
- unsupported/unknown 分类；
- no-op tick；
- immutable input。

---

## Batch C — 规则内核

### S4 — Movement resolver

**目标**

精确实现 v0.11 Unit movement 的全局依赖、争抢与容量语义。

**实现切片**

1. 静态失败：非法方向/障碍/越界；
2. 同玩家 destination capacity + raw UUID tie-break；
3. 跨玩家 contested destination 双方失败；
4. occupant dependency graph；
5. 链式移动；
6. 同玩家 swap/长 cycle；
7. 跨玩家两两 swap 失败；
8. 失败传播；
9. occupancy commit；
10. stable movement events。

**验收标准**

- 规则文档中所有 movement pattern 有 micro-Golden；
- action/对象输入顺序打乱不改变结果；
- final occupancy ≤ 2；
- 同玩家容量赢家严格按 raw UUID；
- 跨玩家 contested 不因 UUID 优先级误放行；
- 10000 个随机合法小图不触发 invariant failure。

**最小 Golden 矩阵**

- 单步成功；
- obstacle failure；
- destination full；
- 3 抢 2、3 抢 1；
- 双玩家同目标；
- A→B→空链；
- 链尾失败传播；
- 同玩家 swap；
- 跨玩家 swap；
- 3-cycle；
- 双 occupancy 的部分离场/入场；
- resource cell Unit 进入成功。

**测试**

- table-driven micro-Golden；
- permutation tests；
- bounded randomized invariant tests。

---

### S5 — Economy resolver

**目标**

实现无 combat/无 migration 情况下可闭环的经济结算。

**实现切片**

- self-destruct 与 Worker cargo drop；
- self-destruct 后 capacity shrink；
- upkeep；
- v0.11 deficit damage（近 19 保护、远者受损、同距 UUID）；
- harvest 同格 competition（同玩家 UUID 最低成功）；
- deposit 与 Core 剩余容量；
- Unit heal；
- Core spawn/heal/repair shield；
- 经济 events/reason codes；
- refill policy port：disabled/test-seeded/unknown，不实现“官方精确 refill”。

**验收标准**

- 所有资源增减有 event 与 reason；
- 资源永不负数、容量逻辑无 off-by-one；
- 先 self-destruct/capacity，再 upkeep；
- deficit 排序对距离与 UUID tie-break 正确；
- harvest/deposit 的位置、cargo、node、capacity 条件正确；
- unsupported combat/migration/beacon 不被悄悄跳过；
- 10000 Tick economy soak 无 invariant failure。

**最小 Golden 矩阵**

- upkeep 足额/不足；
- 19/20/21 Units deficit；
- 同距 UUID tie-break；
- capacity floor 10；
- self-destruct 触发 overflow destruction；
- cargo 0/1/2 harvest；
- 多 Worker 同 resource；
- deposit full/partial/zero space；
- spawn 成功/资源不足/人口上限；
- heal/repair 成功与无需动作。

**测试**

- table-driven micro-Golden；
- phase-order regression；
- long-run economy invariants。

---

### S6 — Visibility 与 observation adapter

**目标**

把完整 `SimWorld` 裁剪成与官方 PlayerState 语义一致的当前私有视图，再复用 `reduceTurn`。

**改动建议**

- integer supercover；
- Manhattan vision union；
- obstacle occlusion；
- `projectPlayerState(world, playerId)`；
- `SimTurnLike` 适配 `reduceTurn`；
- canonical terrain batching 与 object order；
- full-state replacement semantics tests。

**验收标准**

- Core/Worker/Vanguard/Ranger 视野半径正确；
- obstacle 自身可见，behind-obstacle 不可见；
- corner-touch 两侧障碍规则正确；
- 己方对象始终可见；
- 敌人/terrain 离开视野后从下一 state 消失；
- Planner 无法从 adapter 取得 hidden world；
- `reduceTurn(project(...))` 可直接被现有 Planner 消费。

**测试**

- supercover vectors；
- occlusion matrix；
- multi-observer union；
- state replacement/stale disappearance；
- reducer compatibility with old fixture states。

---

## Batch D — 闭环与校准

### S7 — Planner 闭环 harness

**目标**

让现有 deterministic/safety Planner 在模拟状态上连续运行，不复制策略逻辑。

**改动建议**

- `runEpisode`；
- planner factory/config snapshot；
- 每 Tick：project → reduce → decide → validate → settle；
- 每个 simulated tenant 独立 planner/world memory；
- full-plan locking 与旧 observation sealing；
- episode stop conditions 与 metrics。

**验收标准**

- 现有 Planner 不 import sim；依赖方向单向 `sim -> domain/planning`；
- 同 seed/config/scenario 的 final hash 与 JSONL 逐字节一致；
- 1000 Tick 本地完整闭环成功；
- 不调用 `runTenantLoop`、Client、Turn.submit；
- planner state 不跨 episode/tenant 污染；
- unsupported feature 可终止或按配置跳过，但报告必须保留。

**测试**

- deterministic replay；
- two-tenant isolation；
- planner memory reset；
- full-plan replacement；
- 1000 Tick smoke。

---

### S8 — Golden 录制、校准与差异分类

**目标**

修复当前“只有 state、没有 full plan”的数据缺口，建立可复现的真实校准闭环。

**改动建议**

1. 定义 `sim-calibration-case-v1` schema；
2. 在**不改变提交路径**的前提下，为后续 deterministic run 旁路记录：
   - input raw state；
   - validator 后最终 full Plan；
   - accepted/error receipt 摘要；
   - next raw state；
   - next state resolution events；
   - git/config/rules hashes；
3. 生成只读 fixture dataset；
4. calibration runner；
5. supported deterministic field comparator；
6. divergence taxonomy 与 Markdown/JSON 报告；
7. dataset integrity hashes。

**关键边界**

- recorder 是生产遥测增强，不能改变计划、提交时间、idempotency key 或 writer 锁；
- recorder 失败必须 fail-open 于游戏循环，但明确告警；
- 第一批样本只选无 combat、无 migration、无 Beacon 影响、无可疑 refill 的窗口；
- 旧 `burnin-20260802-a` 标记 `state-only`，不能计入 settlement accuracy。

**验收标准**

- 至少录得一批连续 full-plan cases；
- 每个 case 的 input/plan/next hashes 完整；
- calibration 可区分 simulator bug、隐藏对手、secret refill、unsupported、数据不足；
- 所有 mismatch 100% 有分类与证据字段；
- 已知支持的 deterministic events 目标一致率 ≥99.9%，不足时不晋级；
- 规则 manifest 变化会令报告 stale。

**测试**

- schema/integrity；
- missing plan/next state；
- forged hash；
- taxonomy exhaustiveness；
- old state-only dataset refusal；
- sample calibration report snapshot。

---

## Batch E — 产品化收口

### S9 — CLI、benchmark、CI 与文档收口

**目标**

把模拟器变成可重复使用的工程工具，而不是一次性测试代码。

**改动建议**

- `sim:run` / `sim:bench` / `sim:calibrate` / `sim:isolation-check`；
- `runs/sim-*` manifest 与三类 `sim.v1` JSONL；
- benchmark：tick/s、p50/p95 tick latency、memory、episode result；
- A/B runner：同 scenario/seed 比较两个 planner config；
- package/root scripts；
- README/roadmap/MASTER 只写实际完成状态；
- clean-clone verification instructions。

**验收标准**

- 1000 Tick 进入秒级，报告实际数据，不硬编码“1000×”；
- 10,000 Tick benchmark 无 invariant failure；
- A/B 使用相同 seeds/scenarios，输出 paired delta；
- sim JSONL 不混入线上 telemetry；
- root 全量门禁：

```bash
npm run check
npm test
npm run schema:check
npm run replay:check
npm run sim:isolation-check
npm run sim:test
npm run sim:bench -- --smoke
```

- clean clone 可按文档复现；
- 未完成 Runtime-Golden 时文档不得写“高保真已验证”。

**测试**

- CLI argument/error paths；
- output schema；
- benchmark smoke；
- paired A/B determinism；
- clean-tree/no-secret scan。

---

## 批次与提交建议

| Batch | 任务 | 提交边界 | 是否接触线上路径 |
|---|---|---|---|
| A | S0-S1 | provenance + isolation skeleton | 否 |
| B | S2-S3 | world + phase engine | 否 |
| C | S4-S6 | movement/economy/vision | 否 |
| D | S7-S8 | harness + recorder/calibration | S8 recorder 仅旁路遥测，需独立严格评审 |
| E | S9 | CLI/benchmark/docs | 否 |

S8 的线上 recorder 不与 settlement 代码同 commit；应先合并纯离线引擎，再单独审 recorder，确保任何问题都可关闭 recorder 而不影响模拟器与 live runtime。

## Definition of Done

本计划全部完成必须同时满足：

- 10 个任务均通过各自验收；
- 六条隔离边界有自动化证明；
- 当前官方版本与 provenance 固定；
- micro-Golden 全绿；
- 至少一批 full-plan Runtime-Golden；
- 已知确定性事件一致率 ≥99.9%；
- 所有差异可解释率 100%，且“数据不足”不能冒充 MATCH；
- 1000 Tick 秒级、10000 Tick无 invariant failure；
- root 全量门禁与 clean clone 通过；
- live 提交行为、writer 锁、端口、凭据读取均未被模拟器路径改变。
