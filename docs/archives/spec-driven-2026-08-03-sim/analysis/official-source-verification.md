# Arena Digital Twin — 官方来源核对记录

最后核对：2026-08-03 16:43+08:00

> 本文是模拟器计划的证据底座。它不取代官方文档；任何后续实现必须把本文件记录的上游版本写入规则 manifest，并在上游漂移时主动失效校准结果。

## 1. 本次实际核对的官方来源

| 来源 | 本次核对结果 | 固定版本 |
|---|---|---|
| `https://github.com/arena-hero/arena-hero-doc` | 公开可访问，当前读者规则仍为 gameplay **v0.11**、public API **v0.1** | `72de5c15f334e5e224132f46ae6f791f71d158db` |
| `https://github.com/arena-hero/arena-hero-python` | 公开可访问，最新公开 tag 为 **v0.2.6** | `4a295851002ac5e73b34fa652e8d084f780c01ed` |
| `https://github.com/arena-hero/arena-hero` | 本次匿名 clone 返回 Repository not found | 不可核对 |
| 本仓库 `reference/arena-hero-python/arena_hero/` | 与公开 SDK HEAD 的 13 个文件逐文件 SHA-256 一致 | 对齐 `4a29585` |

官方文档自身的 `source-and-version.md` 说明：若读者文档与服务端实现冲突，应以服务端代码与测试为准。但服务端仓库本次不可公开读取，因此当前可建立的证据链是：

```text
官方公开 docs 固定 commit
+ 官方公开 Python SDK 固定 commit/tag
+ 本仓库真实运行 state/events/receipts
+ Golden Simulation 差分证据
```

不能把本仓库 `docs/game-rules.md`、fixtures 或模拟器测试反过来声明为官方权威。

## 2. 上游来源不一致记录

官方文档当前声称 Python SDK 为 v0.2.6，并引用 reviewed commit：

```text
8f967aa86eb7909de74e57cdbb6ec845f8e21959
```

但公开 SDK 仓库的 `main` 与 tag `v0.2.6` 当前都指向：

```text
4a295851002ac5e73b34fa652e8d084f780c01ed
```

直接访问 `8f967aa...` 当前返回 404。处理原则：

1. 不猜测该 commit 是否来自私有/重写历史；
2. 模拟器规则 manifest 同时记录“官方文档声明值”和“本次可复现公开值”；
3. 协议实现以本次可检出的 `4a29585` 与真实线上行为为校准对象；
4. 上游一旦恢复该 commit 或更新版本页，先重新核对再更新 manifest。

## 3. 规则逐项核对

### 3.1 Tick 与结算顺序

官方 `world-and-ticks.md` 当前公开顺序为 15 个阶段：

1. 锁定最终 Agent/Manual plans；
2. `SELF_DESTRUCT`；
3. upkeep 与 unpaid-upkeep damage；
4. Unit movement 与完成中的 Core migration；
5. 新 Core `START_MOVE`；
6. Beacon；
7. Worker harvest/deposit；
8. 冻结 combat snapshot；
9. 同时伤害、死亡与 Core 资源转移；
10. Unit heal；
11. stationary Core action；
12. respawn；
13. 每四个 resolved ticks 的 resource refill；
14. 原子提交；
15. 下一 Tick 与新 state。

本仓库 `docs/game-rules.md` 展开为 16 步，额外把两次 capacity overflow destruction 写成显式步骤。经对照，这属于**编排粒度差异**，当前未发现语义冲突：

- self-destruct 后人口减少导致的容量收缩必须在 upkeep 前处理；
- combat 导致人口/库存变化后必须再次处理 overflow；
- 模拟器内部可以使用更细 phase，但对外必须保留官方阶段映射。

### 3.2 经济规则

| 规则 | 官方当前值 | 本仓库记录 | 结论 |
|---|---:|---:|---|
| Core capacity | `max(10, population × 5)` | 相同 | 对齐 |
| Worker cost | 5 | 5 | 对齐 |
| Vanguard cost | 10 | 10 | 对齐 |
| Ranger cost | 12 | 12 | 对齐 |
| Upkeep | 每 Unit 每 Tick 1 | 相同 | 对齐 |
| Worker cargo capacity | 2 | 2 | 对齐 |
| 单次 harvest | 1 | 1 | 对齐 |
| 单次 deposit | 受 Core 剩余容量限制 | 相同 | 对齐 |
| refill cadence | 每 4 个 resolved ticks | 相同 | 对齐 |
| refill placement | 服务端秘密、确定性 | 本仓库标记不可预测 | 对齐 |

v0.11 的 unpaid-upkeep 语义已确认：Core 不受 deficit damage；离 Core 最近的 19 个 Units 受保护，其余从最远到最近受损，同距按 UUID 决定顺序。

### 3.3 视野

| 对象 | Manhattan radius |
|---|---:|
| Core | 5 |
| Worker | 3 |
| Vanguard | 4 |
| Ranger | 5 |

遮挡使用 integer supercover line：障碍格自身可见，其后的格不可见；恰好穿过格角时两侧格都计入，任一侧障碍均可阻挡。

完整 PlayerState 是每次的**当前完整私有视图替换**，不是增量 patch：

- 己方对象始终可见；
- 敌方对象仅在当前视野中出现；
- terrain 仅包含当前可见部分；
- 客户端记忆不等于当前真相。

### 3.4 Movement 与容量

- Unit 每 Tick 最多 cardinal move 一格；
- obstacle 阻挡；resource cell 接受 Unit，但拒绝 migrating Core；
- 每格最多 2 个 occupying entities；
- 两个玩家争抢同一 destination：双方失败；
- 同一玩家超额争抢空位：按 UUID raw bytes 升序取胜；
- 全局 dependency graph 支持链式移动；任一依赖失败向后传播；
- 跨玩家两两 swap 必失败；更长合法 cycle 可成功；
- 敌我对象不能在 Tick 结束时共格。

### 3.5 Command/Turn 协议语义

官方 Python SDK `turn.py` / `client.py` 当前确认：

1. `unit.move()/harvest()/...` 只修改本地 builder；
2. 同一对象后一次调用覆盖前一次；
3. `turn.submit()` 提交当前 Tick 的**完整计划**；
4. 服务端同 source 新 plan 整体替换旧 plan，不做 patch；
5. SDK 对提交使用相同 body + 相同 idempotency key 做安全重试；
6. 新 state 到来后旧 Turn 被 seal，旧 Turn 不得继续修改；
7. state 是完整替换；received receipt 仅保留当前 Tick 最新 source receipt；
8. 每 `(player, tick, source)` 最多接受 64 个新 submissions，重放同幂等请求不重复计数。

模拟器不需要复刻 HTTP/WS/receipt/rate-limit，但闭环 harness 必须保留“每 Tick 完整 plan、旧 Turn 失效、state 完整替换”三项语义，否则 planner 行为会产生 sim-to-real 偏差。

## 4. 本仓库需要先修正的规划假设

### 4.1 现有 Golden fixture 不含完整真实 plan

`fixtures/differential/burnin-20260802-a/` 当前仅包含连续 raw state 与 manifest。现有 `decision.jsonl` 只记录 `planHash` 等摘要，`outcome.jsonl` 只记录经济/event 摘要；它们都没有可重放的完整 `Plan`。

因此不能直接执行原设想：

```text
state N + 实际提交 plan N -> 模拟器 -> 对比 state N+1
```

必须先新增版本化校准样本契约，并从后续真实 deterministic run 同步录制：

```text
input_state.json
submitted_plan.json
accepted_receipt.json (可选)
next_state.json
previous_resolution_events.json
manifest.json
```

旧 fixture 仍可用于：

- PlayerState parser/reducer 兼容性；
- 连续状态不变量；
- vision/state projection 的结构校验；
- 但不能充当 settlement Golden oracle。

### 4.2 UUID 排序应集中为 raw-order comparator

当前若干 TS 模块使用 `localeCompare`。规范需要 raw UUID bytes order。对标准 lowercase canonical UUID，二进制字符串顺序与 raw bytes 顺序等价；但 `localeCompare` 是 locale-sensitive API，不适合作为跨机器确定性原语。

计划要求新增唯一 comparator：

```ts
compareUuidRaw(a, b) => a < b ? -1 : a > b ? 1 : 0
```

并用固定 UUID vectors 验证与 Python `UUID.bytes` 排序一致。模拟器与所有规则 tie-break 只能调用该 comparator。

### 4.3 JS number 与 signed int64 的边界

官方坐标是 signed 64-bit integer，当前 TS `Position` 使用 `number`。MVP 不做全仓 bigint 迁移，但必须 fail closed：

- 所有 scenario/fixture/world 输入要求 `Number.isSafeInteger(x/y)`；
- 超出安全整数立即报 `UNSUPPORTED_COORDINATE_RANGE`；
- 不允许静默舍入后继续模拟；
- 若真实数据未来触达该边界，再单独立项 bigint/world-coordinate 迁移。

## 5. 本次核对结论

- 当前公开 gameplay rules：**v0.11**；
- 当前公开 SDK：**v0.2.6 @ 4a29585**；
- 本仓库 SDK 镜像与公开 SDK 当前一致；
- 当前未发现需要立即改写 `docs/game-rules.md` 的规则数值错误；
- 结算顺序存在 15 步/16 步的表达粒度差异，不构成已证实语义冲突；
- 模拟器必须把“服务端源码不可核对、SDK commit 引用不一致、现有 fixture 缺 full plan”作为显式证据缺口，而不是隐藏假设。
