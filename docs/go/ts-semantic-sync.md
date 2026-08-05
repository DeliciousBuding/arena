# TS ↔ Go 语义同步表

> 目的：Go 线只同步**行为和规则**，不合并语言实现。任何 TS 主线语义变更
> （bug 修复/规则升级/研究结论）在此登记，Go 侧逐项确认或标注待办。
> 更新时机：TS 主线每次相关合并后；Go 侧每批合流后。

## 同步状态

| TS 语义 | 来源 | Go 状态 | 备注 |
|---|---|---|---|
| #23 Tick reset（tick 回退全清） | domain/world.ts | ✅ 已实现 | world.go `reset` + WorldResetCount |
| #23 Resource TTL（stale 记忆 64 tick 过期） | domain/world.ts | ✅ 已实现 | `ResourceMemoryTTLTicks = 64` |
| #23 HARVEST_FAILED 冷却 | domain/world.ts | ✅ 已实现 | `failedCells` + `DefaultFailedCooldown = 4` |
| #23 Respawn override | TS 主线 | 🔄 待接 | Lane 2 实现中（Core 恢复期经济重建） |
| #25 workerTarget 真正驱动 SPAWN | TS 主线（修复） | 🔄 待接 | Lane 2 实现中；直接采用 `workerTarget = max(policy, emergencyFloor)`，不重蹈 TS 旧错误（卡 2 worker） |
| #25 reserve guard（扩张预留） | TS 主线 | 🔄 待接 | Lane 2：`resources >= cost + reserve` |
| #25 fixed policy override | TS 主线 | ⬜ 待做 | policy 纯函数已就绪（internal/policy），接线到 Planner 待 Lane 2 后 |
| HARVEST_SUCCEEDED → harvested 负记忆 | TS 研究结论 | ✅ 已实现 | Go world.go 已吸收（早于 TS 主线） |
| Upkeep v0.11+ 规则 | hero SDK rules | 🔄 待核对 | domain/validator 与 rules 一致性待确认 |
| rulesVersion 标注漂移 | manifest | 🔄 待修正 | manifest 目前写死 "v0.11"，需与 rules 实际对齐 |
| MacroPolicy 值域（posture 三值） | TS: harvest/balanced/aggressive | ⚠️ 有意差异 | Go: aggressive/balanced/defensive；赛马输入走 Canonical Policy 映射（见下） |
| MacroPolicy 字段（attackPriority vs attackTarget） | TS: attackPriority 枚举 | ⚠️ 有意差异 | Go: attackTarget string；映射层统一 |
| Capacity 公式 `max(10, population×5)` | hero SDK rules.ts | ✅ 已实现 | domain 模型；t4 真机 deposit 满容量 bug 已修 |
| 单写者锁（原子创建/PID/stale） | TS ops | ✅ 已实现 | internal/ops/lock.go（含 PID 复用陷阱防护） |
| 幂等键跨进程稳定 | TS: 随机键 | ✅ 已改进 | Go: `arena:<tenant>:<tick>:<stateHash[:12]>` |

## Canonical Policy（赛马层统一协议）

TS 与 Go 内部枚举允许不同，赛马实验输入必须可映射：

```json
{
  "posture": "economic | balanced | aggressive",
  "workerTarget": 8,
  "militaryRatio": 0.3,
  "focusRegion": [10, -4],
  "attackTarget": "enemy_core"
}
```

Adapter 映射：
- `economic` → TS `harvest` → Go `defensive`（经济重建姿态）
- `balanced` → 双方直通
- `aggressive` → 双方直通

## 待核对清单（下批处理）

- [ ] rules 常量逐项对齐（spawn 成本/容量/upkeep 公式，从 `contracts/` 与 hero SDK rules 提取）
- [ ] manifest rulesVersion 改为实际 rules 哈希
- [ ] TS 主线最新 SafetyPlanner 行为差异（Go 最小版 vs TS 完整版）登记

## E0 P0 同步（2026-08-05）

| TS 语义 | Go 状态 | 说明 |
|---|---|---|
| 满仓满载 Worker 让出 Core（固定方向顺序） | ? 已同步（E0-2） | decideWorker yield_full_core：满载在 Core + space<=0 → MOVE 安全相邻格 |
| SPAWN 占位语义（满载 Worker 不阻止） | ? 已同步（E0-2/E0-3） | planner 持续计划 SPAWN；sim 结算 permanentCoreOccupant：满载不阻止、空载/军事阻止 |
| exactly-once Tick（重连重放去重） | ? 已同步（E0-1） | lastHandledTick 在 Reduce 前去重 |
| 错误真正即停（repair/submit rejection） | ? 已同步（E0-1） | Loop.Run 直接返回错误，不再吞 |
| 动作结算 outcome 遥测 | ? 已同步（E0-3） | planned_spawn_no_effect / cargo_blocked 位置指纹 |

## E2 P1 同步（2026-08-05）

| TS 语义 | Go 状态 | 说明 |
|---|---|---|
| 移动冲突失败后尝试改道 | ? 已同步 | moveToward 并入己方占位感知（BFS 绕行）+ 停滞指纹 3 tick 强制换目标 |
| 导航防左右振荡 | ? 已同步 | per-unit 持久巡逻目标（到达/受阻才换向） |
| 满载 Worker 位置指纹停滞检测 | ? 已同步 | cargo_blocked 诊断（遥测）+ 停滞跳出（战术层） |
| 自适应路径搜索半径 | ? 已同步 | ExploreRadius 16 + 环扩展 ×1×2×3×4 + EXPLORE_STARVED 扫掠 |
| 资源枯竭处置（非等待） | ? 已同步（评估） | Commander MIGRATE_CAND（100 tick 只评估）；执行路径 START_MOVE 已实现（EnableCoreMigration 默认关，红线） |
| Worker 路径避开全部敌方格 | ? 未同步（P2） | 敌方占位在威胁距离内 engage 优先；全面避让后续 |
| Core 自毁顺序 / Vanguard 守家锚点 | ? 未同步（P2） | militaryRatio 之后 |
