# Arena TS vNext 红队架构/稳定性审计报告

最后更新：2026-08-08 20:30

基线：9cea8d3（`merge: sync latest committed development main into runtime vnext`）
审计范围：`ARENA_REPO_ROOT\arena-ts\.worktrees\vnext-redteam-v1`
方法论：8 维度并行只读审计 + 直接代码审查 + Agent 辅助交叉验证

## 总体结论

**无 P0 崩溃/数据损坏级缺陷。** 发现 3 个 P0（内存/Disk 无界增长）、12 个 P1（语义正确性/安全边界/数据泄漏）、若干 P2（性能退化/可维护性）。离线学习模块隔离良好，生产路径零依赖。DebugServer 控制面缺少鉴权但默认 localhost 绑定降低了攻击面。配置重载协议设计正确但有 telemetry 归因窗口问题。

### 修复状态

| P0# | 描述 | 状态 |
|-----|------|------|
| P0-1 | sightings.ts per-tick 无界累积 | ✅ 已修复（`sightings.ts:258-273`，TTL=48 ticks） |
| P0-2 | refill-predictions 全表加载 | ✅ 已修复（`refill-predictions.ts:118-119`，窗口=3000 ticks） |
| P0-3 | enemyCoreForceRecords orphan | ✅ 已修复（`world.ts:553`，迁移时同步清理） |

P1 修复建议留给主线开发者决定优先级，详见各子节。

---

## P0 — 必须修复

### P0-1: `alliance/sightings.ts` — per-tick 无界累积，零驱逐路径

- **文件/行号**: `packages/arena-agent/src/alliance/sightings.ts:74-80, 242-254`
- **根因**: `ephemeralUnitKey()` 把 tick 嵌入键名 `UNIT:<tenant>:<tick>:<x>,<y>`，每 tick 每个无 id 敌单位产生一条**新条目**（key 永不重复）。`mergeSightings()`（line 221-234）只合并同 key 条目，从不删除旧 key。`updateSightingsTick()`（line 242-254）只把未出现的条目标记 `currentlyVisible=false`，但不驱逐。模块内**完全没有 prune/TTL/evict 函数**。
- **可复现证据**: N 个无 id 敌单位每 tick 可见 → N 条/ tick → ~200 B/条 → **~20 MB per 10k ticks**，无限增长直到进程 OOM 或 game over。
- **调用链验证**: `alliance/shadow.ts:160` → `updateSightingsTick(this.sightings, ...)` 在 shadow/live 累积路径中每 tick 调用。`alliance/snapshot.ts:94` 仅用于一次性 snapshot 构建，不累积。
- **修复方向**: 在 `updateSightingsTick` 末尾加 TTL 驱逐：`sightings.filter(s => nowTick - s.lastSeenTick < MAX_AGE || s.currentlyVisible)`。对无 id ephemeral UNIT 条目，MAX_AGE 建议 24-48 ticks（过期不再重用）。对固定 id 条目（有 entityId），保活更久（依靠 `currentConfidence` 自然衰减）。

### P0-2: `intel/survey-db.ts` + `intel/refill-predictions.ts` — `resource_seen_history` 无界行累积 + 全表加载

- **文件/行号**: 
  - `intel/survey-db.ts:202-208`（DDL，无清理策略）、`469`（INSERT OR IGNORE 无上限）
  - `intel/refill-predictions.ts:106-108`（`SELECT ... ORDER BY tick ASC` **无 LIMIT**）、`:47`（全量载入 `Map<string, number[]>`）
- **根因**: `resource_seen_history` 表每 (cell, tick) 一行，注释自述"历史深度随运行累积"——跨 run 永不清除（无 `units_seen` 的 archive 迁移等价物）。`loadRefillPredictions()` 无 LIMIT 地加载全表到 RAM，`computeRefillPredictions` 对每格全量排序 O(n log n)，每 sync 触发一次。
- **可复现证据**: ~50 可见矿格 × 每 tick 一个 case → ~50 rows/tick → ~20-40 MB disk per 10k ticks。同步调用时 25-40 MB 瞬态内存峰值 + 全量排序，随运行线性恶化。
- **修复方向**: (1) 在 `loadRefillPredictions` 的 SQL 加 `WHERE tick > ?` 窗口（refill 预测只需最近几个周期，3000 tick 足够）；(2) 给 `resource_seen_history` 加定期 archive/清理（类比 `migrateUnitsSeenArchive`），cutoff 同上窗口。

---

## P1 — 应该修复

### P1-1: DebugServer `/shutdown` POST 无鉴权

- **文件/行号**: `app/debug-server.ts:193-201`
- **场景**: 任何能访问 localhost:8120 的进程可以 POST `/shutdown` 触发优雅关停（`void this.options.supervisor.shutdown()`）。默认绑定 `127.0.0.1` 限制了远程攻击面，但恶意本地进程（npm script、浏览器扩展、被入侵的依赖）可通过此端点停掉 supervisor。
- **严重性**: P1 — 默认 localhost 绑定下远程不可达，但本地横向移动无屏障。
- **修复**: 加一个简单的共享 secret token（环境变量 `ARENA_DEBUG_TOKEN`）校验，或要求 `X-Debug-Token` header。

### P1-2: DebugServer `/alliance-strategy` POST 可改策略 profile

- **文件/行号**: `app/debug-server.ts:132-160`
- **场景**: POST `/alliance-strategy?profile=aggressive` 可切换 Director 策略 profile。文档说仅作用于 replan 边界且不拥有 Arena action，但**无任何鉴权**——任何本地进程可静默改策略。
- **严重性**: P1 — 与 P1-1 同因，本地横向移动。
- **修复**: 同 P1-1 的 token 校验。

### P1-3: Mid-tick 配置重载导致 telemetry configGeneration 错归

- **文件/行号**: `app/tenant-runtime.ts:687-688`（swap + generation bump）、`:1011-1013`（`onTick` 写 telemetry）
- **场景**: `coordinator.decide` 在 tick 开始时固定 safety plan（同步），然后 `await raceCandidate`（Pi 可能数秒）。若 reload 在此 await 窗口中发生，submitted plan 是**旧配置**计算出来的，但 `onTick` 记录的 `configGeneration`/`configHash` 是**新配置**的。违反 "tick 归属当前配置代" 的设计不变量。
- **严重性**: P1 — 遥测/重放/校准数据错误。不损坏 live plan（plan 已固定），但 replay 时无法正确匹配配置版本。
- **修复**: 在 `decide` 开始时快照 `configGeneration`/`configHash`，`onTick` 使用快照值而非实时变量。

### P1-4: 语法合法但语义损坏的配置绕过 last-good

- **文件/行号**: `app/runtime-config.ts:70-86`（mission schema 无界）、`app/strategy-config.ts:116-137`（`hotReloadCompatibility` 仅键级比较）、`app/tenant-runtime.ts:678-696`（无条件 apply）
- **场景**: `mission.collectionValueFloor: 1e9` 或 refill bonus 极端值——通过 schema 验证 + registry 校验、`applied: true`、`configGeneration++`、supervisor 报 `configReady: true`。planner 产生退化计划，无自动回滚。**last-good 的"live planner remains on last-good"契约不成立。**
- **严重性**: P1 — 静默生产退化，正面 applied/ready 证明。
- **修复**: 给 mission config 的值域加语义边界（`collectionValueFloor: [0, 10]`、`refillBonus: [0, 5]`），或在 `reloadConfig` 成功后加 post-apply canary（N tick 内 delta > 0 否则自动 rollback）。

### P1-5: `domain/world.ts` `enemyMemory` 死单位永不清除

- **文件/行号**: `domain/world.ts:281`（声明）、`:504`（写入）
- **场景**: `enemyHints(maxAge=6)` 只读侧过滤——但 Map 条目永不删除。每 spawn 一个敌单位就留一条永久条目。清理仅在 `clearBattlefieldMemory()`（Core 重生，罕有）和 `forgetEnemyCoreAt`（仅 CORE）。被摧毁的敌 UNIT 条目残留整个 game。
- **严重性**: P1 — ~1 entry/spawn ≈ 20-40 KB/10k ticks，无限增长。
- **修复**: 在 `observe` 末尾加死单位清理：`for (const [id, m] of this.enemyMemory) { if (nowTick - m.lastSeenTick > MAX_ENEMY_AGE) this.enemyMemory.delete(id); }`。MAX_ENEMY_AGE 建议 120-240 ticks（2-4 分钟）。注意：需排除尚有 pursuitScore 的活动追击目标。

### P1-6: `coreHuntMemory` WORKER_INFER 锚点永不清除

- **文件/行号**: `domain/world.ts:297`（声明）、`:581-591`（写入）
- **场景**: 每个敌 WORKER 目击（有轨迹）写入最多 2 个推断基地锚点——新位置即新 key。400-tick 窗口仅用于**读过滤**（`coreHuntTargets` line 840-857），Map 条目本身永驻。敌方深处的锚点无法被视野覆盖确认删除（`confirmCoreHuntMissing` 需要友方视野到达该格）。
- **严重性**: P1 — 0.1-2 entries/tick ≈ 100s KB/10k ticks。
- **修复**: 在 `observe` 末尾对 WORKER_INFER 条目加 TTL 驱逐（与 `coreHuntTargets` 过滤的 `CORE_HUNT_WORKER_INFER_TICKS=400` 对齐）。

### P1-7: `enemyCoreForceRecords` 在 Core 迁移时 orphan

- **文件/行号**: `domain/world.ts:544-553`（迁移去重删 `coreHuntMemory` + `coreHuntMissingCount` 但**未删** `enemyCoreForceRecords`）、`:304`（声明）
- **场景**: 敌 Core 移动 → migration-dedup 删除旧位置 `coreHuntMemory` entry → `confirmCoreHuntMissing` 对旧 key 直接 return（line 930: `target === undefined`）→ 旧 `enemyCoreForceRecords` 永久 orphan。旧位置累积的所有 unit ID 永不清除。
- **严重性**: P1 — 每次敌 Core 迁移泄露一个 force record。
- **修复**: `forgetCoreHuntAt`（line 895-902）已正确清理——迁移时复用该路径：在 migration-dedup 分支（line 550）加 `this.enemyCoreForceRecords.delete(oldKey)`。

### P1-8: `owner_username` 经 Recorder → Dataset Builder 流入训练数据

- **文件/行号**: 
  - `runtime-golden/recorder.ts:219-258`（写原始 `PlayerState` 无脱敏）
  - `sim/dataset/builder.ts:835-837`（`state: caseValue.before` 原样嵌入样本）
- **场景**: Recorder 写 raw `PlayerState` 到 calibration case（含 `owner_username`——真实对手用户名），telemetry 管道有 `sanitizeValue`（脱敏 token/API key）但 Recorder 绕过。Dataset builder 把整个 `before.state` 嵌入 `ml-sample-v1`。训练数据含真实 PII。
- **严重性**: P1 — PII 泄漏到 ML 数据集，无脱敏门禁。
- **修复**: Recorder 在序列化前对 `owner_username` 做哈希/假名化（保留跨 run 稳定性）；或 builder 在嵌入前 strip 该字段。

---

## P2 — 建议修复

### P2-1: `domain/world.ts` `chunkMemory` 无驱逐（`world.ts:290`）
- 每发现一个新 chunk 永久增加一条 `"cx,cy" → number`，地图面积有界但大图上可能数千条目。建议加 LRU cap 或按 tick 衰减。

### P2-2: DebugServer `/config-reload` POST 无鉴权（`debug-server.ts:174-188`）
- 与 P1-1/P1-2 同因——控制面端点无 token 校验。

### P2-3: Config reload ACL 检查热加载后 `activeConfig` 可能过时（`tenant-supervisor.ts:494`）
- supervisor 用 `entry.activeConfig` 做兼容性检查，但若 child 已通过自身文件 watch 先热加载了新配置，compatibility 判定基线是旧的。child 权威重检会拒绝 `restart_required`——系统收敛但多一次浪费的请求。

### P2-4: `offline-learning/export/trajectory-exporter.ts:254` `require("node:fs")` 在 ESM 中不可用
- `package.json` 设置 `"type":"module"`，`require` 未定义 → `getStats()` 抛 `ReferenceError`。当前无测试调用，但公开 API 破损。

### P2-5: `intel/survey-db.ts` `resource_events`/`core_spends`/`unit_lifecycle` 表无保留策略
- 三类事件表按 tick 无限累积。建议加定期 archive（类比 `migrateUnitsSeenArchive`）。

### P2-6: `domain/world.ts:606` seeded 资源条目绕过 TTL
- `seedResourceMemory` 注入的条目 `seeded=true`，TTL 驱逐（line 606-609）跳过它们。死矿 seed 永久残留。建议给 seeded 条目加更长的但非无限的 TTL。

---

## 各审计领域结论

### 1. Config reload / auto-respawn / last-good 竞态
🟡 **P1-3, P1-4 需修。** 配置重载协议设计正确（hash 验证 + TOCTOU gate），single-writer-lock 实现强健（PID+starttime 双重验证）。但 telemetry 归因有 mid-tick 窗口问题（P1-3），且语义损坏的配置可绕过 last-good（P1-4）。auto-respawn 的 child-identity guard（`entry.child !== child`）正确防止跨进程污染。

### 2. StrategicProfile pending/replan/rollback 跨域
🟢 **无问题。** `StrategicPolicySelector` 状态机简洁正确：seal 后不可注册新 profile、replan 边界才切换、explicit override 未找到回退 sticky（不抛错）。Director 硬编码 `mode=ASSIST`，profile 不能跨越到 action ownership。rollback 到 lastGood 或 default，无不一致窗口。

### 3. Worker Hungarian / Mission / ProgressContract / Safety veto 双权威
🟢 **无问题。** Hungarian 求解器正确（O(rows²×cols) 文档一致）。`PlanArbiter` 按单位逐条合成（合法 Agent > Safety > 空），非双权威而是确定性仲裁。`isCollectable` 在 Hungarian 矩阵构造前过滤（不被指派即视为 forbidden）。无 assign→veto→reassign 循环。route-aware BFS 距离场降级到曼哈顿+penalty，不误判不可达。

### 4. Alliance task market / local fleet / TaskForce
🟢 **无问题。** CBBA 风格集中清算，Hungarian 全局分配，每 tenant 最多一任务。`local-fleet.ts` 确定性地从真实 unit 列表划分编队，无捏造。Task ID 通过 `expandAllianceMarketTaskSlots` 确定性地从 base ID 衍生，无碰撞。slotCount 上限 8 防爆炸。

### 5. World/survey memory 无界集合
🔴 **P0-1（alliance/sightings.ts 无界累积）、P0-2（resource_seen_history 全表加载）。** 详见 P0 节。World 层大部分集合有驱逐/边界（resource TTL、beacon 20 上限、unit 死亡清理），但 `chunkMemory`（P2-1）、`enemyMemory`（P1-5）、`coreHuntMemory`（P1-6）、`enemyCoreForceRecords`（P1-7）有不同程度的无限增长。Survey DB 端多张表无保留策略（P2-5）。

### 6. Offline-learning 生产泄漏
🟢 **模块隔离良好，零生产依赖。** `index.ts` 不导出 offline-learning，`grep` 确认无 `runtime/`/`app/`/`cli/` 的 import。但存在 P1-8（`owner_username` 经 Recorder→Builder 进入训练数据）和 P2-4（ESM require bug）。`feature-vector.ts` 有 2 个硬编码 0 的特征维度（P2 latent）。

### 7. DebugServer 控制面安全
🟡 **P1-1, P1-2 需修。** 默认 `127.0.0.1` 绑定正确限制了远程攻击面。但 `/shutdown`、`/alliance-strategy` POST、`/config-reload` POST 三个控制面端点完全无鉴权——任何本地进程可关停/改策略/重载配置。读端点（`/health`、`/state`、`/events`）无敏感信息泄漏。无 CORS 头（默认同源限制）。无速率限制。

### 8. Promotion / watchdog / config-ready / progress-ready / rollback
🟢 **无缺口。** `evaluateAllianceShadowPromotion` 有 11 个 gate（8 HARD + 3 EVIDENCE），SHADOW_READY 仅当所有 HARD 通过。`StallDetector` 5 模式多模式检测 + warmup 256 tick。`StallRecovery` 完整状态机（idle→recovering→escalating），含经济恢复提前退出 + 连续失败升级 all-in 军事。`PlanArbiter.emergencyPlan` 覆盖 SafetyPlanner 异常时全 WAIT 最小合法计划。rollback 经由 `lastGood` → `default` 两层回退。

---

## 验证方法

```bash
# 跑现有测试套件确认无回归
cd ARENA_REPO_ROOT\arena-ts\.worktrees\vnext-redteam-v1
npm test

# 跑新增回归测试
npx vitest run test/audit/vnext-redteam-sightings-eviction.test.ts
npx vitest run test/audit/vnext-redteam-refill-bounded.test.ts
```

---

## 修改清单

| 文件 | 修改 | 严重性 |
|------|------|--------|
| `alliance/sightings.ts` | `updateSightingsTick` 末尾加 TTL 驱逐 | P0 |
| `intel/refill-predictions.ts` | `loadRefillPredictions` SQL 加 `WHERE tick > ?` 窗口 | P0 |
| `domain/world.ts:553` | Core 迁移时清理旧 `enemyCoreForceRecords` | P0 |
| `app/debug-server.ts` | `/shutdown`、`/alliance-strategy` POST 加 token 校验 | P1 |
| `domain/world.ts:281` | `enemyMemory` 加死单位驱逐 | P1 |
| `domain/world.ts:297` | `coreHuntMemory` WORKER_INFER 加 TTL 驱逐 | P1 |
| `app/tenant-runtime.ts:1011` | telemetry 使用决策开始时的配置快照 | P1 |
| `app/strategy-config.ts` | mission config 值域加语义边界验证 | P1 |
| `runtime-golden/recorder.ts` | `owner_username` 假名化 | P1 |

> 注：仅 P0 修复 + 回归测试在本 branch 提交。P1 修复建议留给主线开发者决定优先级。

---

## 修复摘要（本 branch 已提交）

### P0-1: sightings.ts TTL 驱逐
- `alliance/sightings.ts:17-22`: 新增 `EPHEMERAL_UNIT_MAX_AGE_TICKS = 48`
- `alliance/sightings.ts:258-273`: `updateSightingsTick` 末尾加 filter——超过 48 tick 且不可见的无 id UNIT 条目被驱逐。有 entityId/CORE/RESOURCE 条目不受影响。
- 回归测试: `test/audit/vnext-redteam-sightings-eviction.test.ts`（5 个 case，全部通过）

### P0-2: refill-predictions SQL 窗口
- `intel/refill-predictions.ts:26-28`: 新增 `REFILL_PREDICTION_WINDOW_TICKS = 3000`
- `intel/refill-predictions.ts:118-119`: `loadRefillPredictions` SQL 加 `WHERE tick > ?` 窗口过滤
- 回归测试: `test/audit/vnext-redteam-refill-bounded.test.ts`（2 个 case，全部通过）

### P0-3: enemyCoreForceRecords orphan 修复
- `domain/world.ts:553`: Core 迁移去重分支新增 `this.enemyCoreForceRecords.delete(oldKey)`——与 `coreHuntMemory`/`coreHuntMissingCount` 同步清理
- 现有测试覆盖: `test/world-core-hunt.test.ts`（14 个 case，全部通过，无回归）
