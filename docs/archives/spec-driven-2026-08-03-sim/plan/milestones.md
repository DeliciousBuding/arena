# Arena Digital Twin MVP — 里程碑与门禁

最后更新：2026-08-03

## M0 — 来源锁定与物理隔离

覆盖任务：S0、S1

**交付**

- v0.11 rules/provenance manifest；
- 最小 no-op sim CLI；
- import/network/lock/port/path/schema isolation checker；
- 无凭据运行 smoke。

**通过门槛**

- 官方 docs/SDK 固定 commit 可复现；
- 上游 SDK commit 引用不一致被显式记录；
- sim 代码无法 import Client/Turn submit/runtime loop；
- 不读 `.env`，不监听 8123-8126，不创建 writer lock；
- 输出只能进入 `runs/sim-*`；
- root `npm run check` 已包含 isolation checker。

**BLOCK 条件**

- checker 只能 grep 单文件、无法覆盖 import graph；
- CLI 仍接收 API key/base URL；
- 需要启动 live runtime 才能运行 sim；
- 规则来源未固定就开始写 resolver。

---

## M1 — 确定性世界与引擎骨架

覆盖任务：S2、S3

**交付**

- SimWorld、scenario/snapshot loader、canonical hash；
- raw UUID comparator、safe coordinate gate、seeded RNG port；
- settlement phase pipeline；
- invariant/rollback/unknown/unsupported 机制。

**通过门槛**

- 同输入/seed 重跑 hash 一致；
- UUID vectors 与 Python raw bytes order 一致；
- int64 超出 JS safe integer 时 fail closed；
- phase 顺序固定，异常不污染原 world；
- unsupported 功能不静默跳过；
- 1000 次 world clone/serialize 无串扰。

**BLOCK 条件**

- 使用 `localeCompare` 作为规则 tie-break；
- 使用 `Math.random()`；
- `settleTick` 原地修改输入 world；
- 用对象/Map 插入顺序决定 event 或结果。

---

## M2 — Movement + Economy + Vision 规则内核

覆盖任务：S4、S5、S6

**交付**

- movement dependency graph resolver；
- self-destruct/capacity/upkeep/harvest/deposit/heal/core action；
- integer supercover + current private observation；
- micro-Golden corpus。

**通过门槛**

- movement permutation tests 全绿；
- occupancy/cross-player contest/swap/cycle 规则有 Golden；
- v0.11 unpaid-upkeep 的近 19 保护与 UUID tie-break 有 Golden；
- 经济资源变化全有 reason/event；
- vision corner-touch/obstacle/union/stale disappearance 有 Golden；
- 10,000 个随机小图 + 10,000 Tick economy soak 无 invariant failure；
- `reduceTurn(projectPlayerState(...))` 与现有 Planner 类型兼容。

**BLOCK 条件**

- movement 按 Unit 顺序原地执行；
- refill 被硬编码成“猜测的官方算法”；
- combat/migration/Beacon 输入被当成成功或 WAIT；
- Planner 能拿到 SimWorld 隐藏字段。

---

## M3 — Planner 闭环与可用性能

覆盖任务：S7

**交付**

- existing deterministic/safety Planner 连续 episode；
- planner/config/seed snapshot；
- sim runtime/decision/outcome records；
- 1000 Tick benchmark。

**通过门槛**

- 现有 Planner 业务逻辑零 fork；
- sim 依赖 domain/planning，线上 planning 不反向依赖 sim；
- 同 seed/config/scenario 输出逐字节一致；
- 1000 Tick 秒级完成并报告真实 tick/s；
- 双 tenant/双 episode 无内存状态串扰；
- 不触发 Client、Turn.submit、lock 或端口。

**BLOCK 条件**

- 为了适配 sim 复制一份 planner；
- 只测单 Tick，不形成闭环；
- benchmark 混入 live 进程或联网；
- 把“秒级”写成固定 1000× 而无测量。

---

## M4 — Runtime-Golden 校准

覆盖任务：S8

**交付**

- `sim-calibration-case-v1`；
- full input state + final full plan + next state 旁路录制；
- dataset integrity manifest；
- calibration runner；
- divergence taxonomy 报告。

**通过门槛**

- 至少一批连续 full-plan deterministic cases；
- recorder 不改变提交 body、时序、idempotency、writer lock；
- 旧 state-only fixture 被拒绝用于 settlement accuracy；
- 已知支持的确定性 events 一致率 ≥99.9%；
- mismatch 100% 分类并附证据；
- rules manifest 变化使旧报告 stale；
- hidden opponent/refill/unsupported 不计 simulator bug，也不计 MATCH。

**BLOCK 条件**

- 只有 planHash，没有 full plan；
- 用 planner 重新生成计划冒充“实际提交计划”；
- 无法证明 recorder 与提交路径无耦合；
- 用一个漂亮窗口宣称整体高保真。

---

## M5 — 工具化与 MVP 关单

覆盖任务：S9

**交付**

- sim run/bench/calibrate/A-B CLI；
- 独立 sim schemas 与 run manifest；
- CI/full gates；
- README/roadmap/MASTER 与实际证据同步；
- clean clone 复现说明。

**最终关单门槛**

```bash
npm run check
npm test
npm run schema:check
npm run replay:check
npm run sim:isolation-check
npm run sim:test
npm run sim:bench -- --smoke
```

并且：

- 1000 Tick 秒级；
- 10,000 Tick 无 invariant failure；
- micro-Golden 全绿；
- Runtime-Golden 门槛达标；
- 六条隔离边界全部有自动化证据；
- clean clone 可复现；
- 未改变 live submission、writer lock、端口、凭据读取；
- 文档不把 MVP 夸大为完整 Arena 服务端复制品。

## 晋级语义

```text
M0 -> 可以安全写离线代码
M1 -> 可以实现规则
M2 -> 可以跑人工场景
M3 -> 可以快速筛选策略候选
M4 -> 可以声明“已在限定范围校准”
M5 -> 可以作为稳定研发工具使用
```

任何里程碑通过都**不自动解锁**：

- live 策略推广；
- 多租户扩展；
- RL/自博弈；
- Python rollback 删除；
- 将模拟收益直接当真实收益。
