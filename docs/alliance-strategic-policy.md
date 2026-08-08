# Alliance Strategic Policy — Registry & Selection Foundation

最后更新：2026-08-08

## 概述

Strategic Policy 是 Alliance Director 的"战略热插拔线"——允许 DEFEND/RAID/ESCORT/SCOUT/RESERVE
等战略在 Director replan 边界按已注册 policy profile 热切换，无需重启或修改 Director 代码。

## 核心约束

| 约束 | 实现 | 验证 |
|------|------|------|
| Director 无 Arena submit/action ownership | `mode: "ASSIST"` 硬编码，profile 不可修改 | 编译时+测试 |
| Tenant 仍为唯一 writer | 合同层不含 Plan/CandidateSink/submit | 类型系统+测试 |
| ASSIST-only 默认硬约束 | `decideAllianceShadowPolicy` 中 `mode` 永远为 `"ASSIST"` | 43 个测试 |
| 禁止动态加载任意 TS | 所有 profile 编译时注册，无 `import()` | 架构约束 |
| Local Safety variants 不混入战略层 | profile 只返回 `AllianceRole`，不引用 Safety/Stall/Discipline | 类型+测试 |

## 架构

```text
StrategicPolicyRegistry (static, compile-time)
├── BALANCED_PROFILE   (default, = v1 行为)
├── AGGRESSIVE_PROFILE (远征优先, 低 RAID 阈值)
├── SCOUT_PROFILE      (侦察优先, 扩大侦察半径)
├── DEFEND_PROFILE     (纯防御, 禁止远征/侦察)
└── RESERVE_PROFILE    (护航储备, 极高远征门槛)

StrategicPolicySelector (deterministic, per-replan)
├── select(tick, override?) → StrategicPolicySelection
├── markLastGood() → 当前 profile 标记为 lastGood
├── rollback(tick) → 回到 lastGood/default
└── history (bounded, max 64)
```

## Profile 结构

```typescript
interface StrategicPolicyProfile {
  name: string;                    // registry key, kebab-case
  version: number;                 // 语义版本，递增=breaking
  contentHash: string;             // SHA-256 前 16 hex，跨 run 可审计
  description: string;
  strategies: StrategyKind[];      // 覆盖的战略维度
  missionPriority: MissionKind[];  // Director 求值顺序
  thresholds?: Partial<ShadowDirectorPolicyConfig>;  // 参数覆盖
  roleFor(kind, treasury, member): AllianceRole;     // 角色映射
}
```

### missionPriority 语义

`missionPriority` 是 Director per-member 求值的顺序。**先列出先检查，首次匹配即分配。**
未命中时回退到最后一个 entry（无条件检查），兜底为 ASSEMBLE。

- `RETREAT` 触发条件：多方向压力 + (高威胁或低耐久)
- `INTERCEPT` 触发条件：可见战斗单位在 interceptDistance 内
- `DEFEND` 触发条件：任一方向压力 > 阈值
- `ASSEMBLE` 触发条件：兵力低于 assembleMilitaryBelow
- `SCOUT` 无条件（低风险方向）
- `RAID` 触发条件：安全窗口 + 兵力达标 + 新鲜高置信敌核目击

### 安全不变式

1. RESPAWNING/Core-null 总是先 ASSEMBLE——不受 profile 控制（死了不能执行任何策略）
2. `mode` 永远是 `"ASSIST"`——profile 不可修改
3. `contentHash` 记录在 mission scope 和 directive explanation 中，实现跨 run 审计

## 选择器协议

### 优先级

1. **Explicit override**：operator 显式指定 `strategyName`（如 "aggressive"）
2. **Sticky**：保持上次选择的 profile
3. **Default**：首轮使用 registry default（当前为 "balanced"）

### 回滚

```typescript
// 正常流程
selector.select(tick, "aggressive");  // 切换到激进
selector.markLastGood();              // 确认当前策略良好

// 检测到问题 → 回滚
selector.rollback(tick);              // 回到 lastGood（balanced）
```

无 `lastGood` 时回滚到 registry default。

### 审计 trail

每次选择产生 `StrategicPolicySelection`：
- `profile`：选择的 profile（含 contentHash）
- `revision`：严格递增的全局序号
- `selectedAtTick`：选择时的 tick
- `reason`：选择原因（default/sticky/explicit-override/rollback）
- `previousHash`：上一轮的 profile hash
- `lastGoodHash`：最近标记的 lastGood hash

## 内置 Profile 一览

| Profile | strategies | missionPriority 核心特征 | 关键阈值变化 |
|---------|-----------|------------------------|------------|
| `balanced` | DEFEND, SCOUT | RETREAT→INTERCEPT→DEFEND→ASSEMBLE→SCOUT→RAID | 默认（=v1） |
| `aggressive` | RAID, DEFEND | RAID→INTERCEPT→RETREAT→DEFEND→SCOUT→ASSEMBLE | minRaidMilitary=4, raidMaxDistance=96 |
| `scout-first` | SCOUT, DEFEND | SCOUT→RETREAT→INTERCEPT→DEFEND→RAID→ASSEMBLE | scoutDistance=20, retreatThreshold=1.5 |
| `defend-only` | DEFEND | RETREAT→INTERCEPT→DEFEND→ASSEMBLE | 无 SCOUT/RAID, minInterceptMilitary=1 |
| `reserve` | ESCORT, RESERVE, DEFEND | RETREAT→DEFEND→INTERCEPT→ASSEMBLE→SCOUT→RAID | minRaidMilitary=10, raidMinConfidence=0.85 |

## Director 集成

```typescript
// 默认 balanced（= v1 行为，完全向后兼容）
decideAllianceShadowPolicy(snapshot);

// 显式指定策略
decideAllianceShadowPolicy(snapshot, { strategyName: "aggressive" });

// 直接注入 profile（测试/确定性注入）
decideAllianceShadowPolicy(snapshot, { strategicProfile: DEFEND_PROFILE });

// Sim 端运行时热切换
const director = new ShadowPolicyAllianceDirector();
director.setStrategyName("scout-first");
```

## 扩展新 Profile

1. 定义 profile 对象（implements `StrategicPolicyProfile`）
2. `computeProfileHash(profile)` 生成 contentHash
3. `STRATEGIC_REGISTRY.register(profile)` 注册
4. 测试验证：missionPriority 顺序、thresholds 合并、roleFor 映射
5. 无需修改 Director 代码

## 测试覆盖

- **109 tests**：contracts (55) + director-policy (7) + strategic-policy (43) + 编译时
- Profile contentHash 稳定性、registry 操作、selector 选择/回滚/lastGood
- Director 集成：5 个 profile 的 mission 产出差异验证
- ASSIST-only 硬约束：所有 profile × 所有 member 验证
- 确定性回归：相同输入相同输出
- 安全边界：profile 不含 Safety/Stall/Discipline 概念

## 风险

| 风险 | 缓解 |
|------|------|
| Profile 切换导致 mission 震荡 | sticky 语义 + rollback lastGood；每 replan 周期才切换 |
| 新 profile 参数不合理 | thresholds 有 bounded 校验（positiveInt/finiteNonNegative） |
| contentHash 碰撞 | SHA-256 前 16 hex → 碰撞概率 < 2^-64 |
| 无效 strategyName 使 Director 停机 | fail-safe fallback 到 default（不抛错） |
| Profile 注册表膨胀 | 编译时注册，code review 门禁 |
