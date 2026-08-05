# Rust+Go 融合线计划（fusion-line）

> 分析线出品（rust-rewrite worktree）。用户裁决（2026-08-05）：规划 Go 宿主 +
> Rust 决策内核的融合架构。执行线（rust-sim）按此推进。
> 事实基线：Go go-rewrite@c10f2d6 + Rust rust-sim@e6bd3d6。

## 1. 架构决策（已定）

**三层分离**：
```text
真实游戏服务器 (hero SDK)
   ▲ 每 tick state 事件 / 提交 CommandPlan
Go 生产（cmd/arena tenant + runtime.Loop）   ← 宿主保持 Go
   ├─ hero client（真实游戏对接）                留 Go（I/O/认证/生态）
   ├─ LLM 宏观层：internal/policy MacroPolicy   留 Go（低频、LLM 生态）
   ├─ Commander（指挥层）                       留 Go（81 行，低频指令）
   └─ Planner 接口 ←── adapter（FFI 调用 Rust）  ← 融合接入点
                                        │ 每 tick 决策级 JSON
Rust 库（唯一确定性决策+引擎实现）────────┘
   ├─ strategy::decide           生产 + 模拟共用同一份实现
   ├─ engine / batch             仅研究侧（模拟/回放/rollout）
   └─ [可选] rollout 评估导出     LLM 候选计划打分（12.1x 兑现点）
```

**核心原则**：
- 决策引擎单点化到 Rust（策略只有一份实现，模拟=生产行为）
- 接入点 = Go 侧 `runtime.Planner` 接口（Loop 依赖接口，生产代码零侵入）
- 边界 = 决策级 JSON（真实 tick 节奏下 ~1ms 开销占 tick 预算 <1%）
- 不扩服务器线（hero/LLM/编排留 Go：无性能诉求、无 oracle、生态耦合）

## 2. 接口契约（FFI 边界）

### Rust 侧（新 crate `arena-sim-ffi`，cdylib）
```rust
// 决策：state JSON → plan JSON（Go 侧 free 返回串）
#[no_mangle]
pub extern "C" fn arena_decide(state_json: *const c_char, err_out: *mut *mut c_char) -> *mut c_char;
// 指令下发：directive JSON → 成功/错误 JSON
#[no_mangle]
pub extern "C" fn arena_apply_directive(directive_json: *const c_char, err_out: *mut *mut c_char) -> *mut c_char;
// [可选] rollout 评估：候选 plans JSON → scores JSON
#[no_mangle]
pub extern "C" fn arena_evaluate_batch(scenes_json: *const c_char, policies_json: *const c_char, ticks: i32) -> *mut c_char;
```

契约细则：
- 序列化：serde_json，`TickState`/`Plan`（Rust domain 镜像，UPPERCASE 标签已备）
- panic 边界：入口 `catch_unwind`，panic → err_out 错误 JSON，返回空串（绝不让 panic 穿 C ABI）
- 内存：返回 `CString::into_raw`，Go 侧 `C.free`；错误走 err_out 避免歧义
- 确定性：每次调用独立 planner 实例？——**否**：planner 有状态（patrolTargets/patrolDirs 跨 tick 记忆）！Rust 侧须按 tenant 保持实例（单实例句柄：`arena_planner_new(config_json) -> *mut c_void` + `arena_planner_decide(handle, state_json)` + `arena_planner_free`）。**这是本契约最重要的设计点**——无状态接口会破坏巡逻连续性。

### Go 侧（新文件 `internal/strategy/ffi_planner.go`）
```go
// FfiPlanner 实现 runtime.Planner 接口（FFI 调用 Rust 决策内核）。
type FfiPlanner struct {
    handle unsafe.Pointer  // arena_planner_new 句柄
    lib    *dll 或 dlopen 句柄
}
func (p *FfiPlanner) Decide(state *domain.TickState) *domain.Plan
func (p *FfiPlanner) ApplyDirective(directive strategy.Directive)
```

细则：
- cdylib 加载：`runtime/<tenant>/arena-sim-ffi.dll|.so`（与二进制同分发，路径可配置）
- 序列化：`json.Marshal(state)`（TickState serde 标签对齐）+ `json.Unmarshal` 回 Plan
- 错误处理：err_out 非空 → 分类（Rust panic/解析失败），日志 + 回退 Go planner（fail-safe）
- `ValidatePlan` 守门员保留在 Go（decide 后校验不变，deterministic 模式非法动作仍停止）

## 3. 阶段任务

| ID | 任务 | 验收 |
|---|---|---|
| F1 | Rust `arena-sim-ffi` crate：句柄化 planner + decide/apply_directive 导出 + catch_unwind + 测试 | `cargo test` 绿；跨 C 冒烟（Go 测试桩调 dll） |
| F2 | Go `FfiPlanner` adapter：接口实现 + 序列化 + 错误分类 + fail-safe 回退 | Go 单测（mock：状态 JSON 往返、panic 注入、回退触发） |
| F3 | **shadow 双跑验证**（核心验收）：同一 tenant 同 tick 流，Go planner 与 Rust planner 并行决策，`decision.jsonl` 逐 tick 对比 | 双跑 diff 报告：行为一致或差异登记 PARITY |
| F4 | 切换与回滚：`decisionMode=deterministic-rust` 配置；live 切换 + 回滚演练 | live 提交通过；回滚一条命令 |
| F5 | [可选] rollout：`arena_evaluate_batch` 导出 + Go 侧 LLM 候选评估调用 | 冒烟测试 |

## 4. 验证策略

- **F3 是融合线核心验收**：生产级差分（同 tick 同状态双决策引擎对比）比离线差分更硬——它直接证明"模拟器里 Rust planner 的行为 = 生产里 Rust planner 的行为"
- 确定性：Rust planner 双跑一致（已有）；F3 双跑 diff 为空（或登记差异）
- 失败注入：kill Rust 侧/注入 panic → Go 自动回退 Go planner，tenant 不中断（反向验证 fail-safe）
- 回滚演练：live 中途切回 go planner，行为连续

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| cgo/C ABI 复杂度（内存/调试） | 边界最小化（3 个函数）；JSON 契约测试；错误全走 err_out |
| **planner 状态跨 tick**（patrol 记忆） | 句柄化实例（F1 契约第一设计点），禁止无状态接口 |
| 语义漂移（Rust vs Go planner） | F3 shadow 双跑 diff 是最直接发现手段；差异登记 PARITY |
| Directive 映射（Go Commander 指令 → Rust） | DirectiveMode 已对齐（Growth/ExploreStarved/MigrateCand），契约测试覆盖 |
| 动态库部署（dll/so 分发） | 路径可配置 + 加载失败 = 回退 Go planner（fail-safe） |

## 6. 里程碑

| 里程碑 | 判定 |
|---|---|
| M-F1 | ffi crate 绿 + Go 冒烟调用通 |
| M-F2 | adapter 绿（mock 全路径） |
| M-F3 | shadow 双跑 diff 报告（核心验收） |
| M-F4 | live 切换 + 回滚演练通过 |

## 7. 与既有计划的关系

- 依赖：Rust strategy 稳定（✅ 已完成）、模拟线差分门禁（P2）先行（fusion 的 shadow 双跑复用其差分方法论）
- 位置：融合线在模拟线收尾（Phase 5）后启动，或与 Phase 4 加固并行（F1/F2 与加固无文件重叠）
- 范围：融合线不扩服务器线——hero/LLM/编排全部留 Go，只新增 adapter + ffi crate

## 8. 决策点（用户拍板）

| # | 决策 | 建议 |
|---|---|---|
| F-D1 | 融合线启动时机 | 模拟线 P2 差分绿后启动（方法论复用） |
| F-D2 | rollout（F5）是否纳入 | 先不做，12.1x 已解决研究侧；生产 rollout 等真实需求 |
| F-D3 | 全量 Rust | 已否决（收益/成本分析见对话），融合线为终态 |
