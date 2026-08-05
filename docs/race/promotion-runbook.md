# Promotion and Rollback Runbook — Race v1

## 1. 总原则

Fusion 的离线成绩好不等于可直接替换 TS。晋级每次只扩大一个变量：实现、租户或 Tick 窗口，不同时扩大。

TS 始终保留可执行回滚基线，直到 Fusion 完成长期 Canary 并经过用户裁决。

## 2. Stage 0 — 语言内门禁

TS：

```bash
npm ci
npm run check
npm test
npm run schema:check
npm run replay:ts
python scripts/gen-status.py --check
python scripts/docs_health.py --check
```

Fusion：

```bash
go test ./...
go vet ./...
cd sim-rs
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

要求：无 skipped-by-accident、无未登记 golden 漂移、无未提交生成文件。

## 3. Stage 1 — 统一 fixture 回放

- 两边加载相同 `StrategyProfile` 和 scenario fixture；
- 输出规范化 `RaceResult`；
- 同实现相同 seed 重跑必须完全一致；
- 规则不可观测项明确 `INCONCLUSIVE`；
- 若 TS/Fusion 有意策略差异，登记为 race difference，不强求 plan 逐字节一致。

## 4. Stage 2 — 同状态 shadow

同一个真实 TickState：

```text
TS decide ─┐
           ├─ compare plans/intents/metrics
Rust decide┘
```

生产提交仍由当前 TS baseline 执行。记录：

- decision latency；
- plan validity；
- 目标/意图差异；
- fallback；
- 首个差异 tick 与持续 streak。

目标不是把差异归零，而是确保差异可解释、Rust 无非法动作、无 ABI/fallback 异常。

## 5. Stage 3 — t3/t4 长时 shadow

最少连续 24 小时或 10,000 处理 Tick，满足：

- panic=0；
- silent fallback=0；
- invalid=0；
- unknown repair=0；
- memory growth 可解释；
- reconnect 后 exactly-once；
- run manifest、kernel version、schema hash 齐全。

## 6. Stage 4 — bounded live

只使用 t3/t4；每一级独立 run：

```text
3 Tick → 10 Tick → 30 Tick → 100 Tick
```

每级必须：

- accepted/rejected/duplicate 证据；
- hard gate 全 0；
- Ctrl+C/超时停止后锁释放、进程树为 0；
- FFI 加载失败演练能安全 fail-fast 或显式 fallback；
- deterministic-rust 非法计划故障注入导致停止，不继续 repair 长跑。

任一级失败，停止晋级并回 shadow。

## 7. Stage 5 — 单租户 Canary

选择 t3 或 t4，另一租户保持 shadow 对照。至少：

- 1,000 Tick 零错误提交；
- 再完成 10,000 Tick soak；
- 包含一次正常重启、一次流停顿、一次内核加载失败演练；
- 相对 TS/Go baseline 的经济或稳定性存在正收益；
- 尾部表现不显著恶化。

## 8. Stage 6 — 正式对调

只有用户明确裁决后：

1. 选一个 t1/t2 作为 Fusion Canary；
2. 另一个保持 TS baseline；
3. 固定 profile/config hash；
4. 先 bounded，再长期；
5. 对调成功后才讨论第二租户。

不允许同一窗口同时切两个生产租户。

## 9. 回滚触发器

任一触发立即回滚：

- hard gate 非 0；
- FFI ABI/schema/version 不匹配；
- silent fallback；
- 连续未知 repair；
- Core 灾难性损失超过基线门槛；
- decision p95 超过 Tick 预算；
- second writer、锁无法释放、orphan；
- telemetry 缺失导致无法判断状态。

## 10. 回滚动作

```text
停止当前 Fusion writer
→ 确认 PID/进程树消失
→ 确认 tenant lock 释放
→ 保存 run manifest / logs / kernel metadata
→ 启动已固定 TS deterministic baseline
→ 验证首个 accepted Tick
→ 在 Issue #27 登记原因与证据
```

不得在旧 writer 未确认死亡时抢锁启动回滚 writer。

## 11. FFI 生产门禁

Fusion 进入 bounded live 前必须具备：

- ABI version；
- planner schema version/hash；
- Rust kernel git/version；
- Go host git/version；
- `planner_new/decide/apply/free` 生命周期测试；
- panic `catch_unwind`；
- 返回内存释放测试；
- 加载失败、解析失败、panic、超时 telemetry；
- 禁止运行中未经 manifest 记录的热切换。
