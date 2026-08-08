# Strategy Hot-Plug Contract v1

最后更新：2026-08-08

## 概述

低过度工程化的"注册式热插拔"契约，建立在现有 `variant-registry`（配置声明式变体开关）之上。提供组件的不可变发布、tick/replan 边界原子切换、capability/compatibility/hash/last-good/rollback 语义。

**核心原则：**
- **不动态执行任意磁盘 TS**：组件必须是已编译的 TypeScript 类型，纯函数注册进 registry；
- **复用现有 variant-registry 与纯函数**：不替换 `VARIANT_SAFETY_CONFIG`/`resolveVariantsConfig()`，本层是元数据包装；
- **低过度工程化**：只加契约层（类型 + lifecycle + hash），不加 DI 框架、插件发现、动态加载。

## 架构层次

```
tenant-runtime (config hot-reload)
  └─ HotPlugContract (本层：生命周期管理)
       ├─ HotPlugRegistry (注册/激活/回滚/快照)
       ├─ variant-bridge (现有变体 → StrategyComponent 映射)
       └─ 现有 variant-registry (配置值 SSOT，不变)
```

## 核心类型

### StrategyComponent\<TConfig\>

策略组件：命名、版本化、哈希锁定的最小可插拔单元。

```typescript
interface StrategyComponent<TConfig> {
  readonly id: string;               // 唯一标识（如 "threat-recall-v1"）
  readonly release: ComponentRelease; // 不可变发布元数据
  readonly description: string;      // 人类可读描述
  readonly constraint: CompatibilityConstraint; // 兼容性约束
  readonly config: TConfig;          // 配置贡献（merge 进 planner config）
  readonly rollback: TConfig;        // 安全回退配置（失败时 revert）
}

interface ComponentRelease {
  readonly version: string;  // semver
  readonly hash: string;     // sha256:hex (canonical JSON of {id, version, config})
  readonly publishedAt?: string;
}
```

### CompatibilityConstraint

组件兼容性声明：

```typescript
interface CompatibilityConstraint {
  readonly provides: readonly Capability[];   // 提供的 capabilities
  readonly requires: readonly Capability[];   // 激活前必须满足的 capabilities
  readonly conflicts: readonly string[];      // 互斥的 component id
}
```

### StrategicPolicy

命名的组件组合（如 `"strike-core-v1"`）：

```typescript
interface StrategicPolicy {
  readonly name: string;
  readonly description: string;
  readonly components: readonly string[]; // component id 列表
}
```

## Capability 分类

现有变体按 capability 分 9 类：

| Capability | 示例变体 |
|---|---|
| `worker-defense` | threat-recall-v1, scout-evade-v1 |
| `military-offense` | strike-core-v1, assault-overmatch-v1, rally-assault-v1 |
| `military-defense` | guard-axes-v1, reinforce-home-v1, raid-defense-v1 |
| `core-protection` | core-evade-v1, core-clearance-v1, spawn-yield-v1 |
| `economy` | harvest-memory-mine-v1, worker-mission-v1, beacon-grab-v1 |
| `scouting` | frontier-priority-v1, worker-dense-scan-v1 |
| `blockade` | worker-blockade-v1, vanguard-blockade-v1 |
| `alliance` | alliance-no-fire-v1 |
| `population` | population-ceiling-30-v1 |

## HotPlugRegistry

### 生命周期

```
register(id) ──→ activate([ids]) ──→ rollback()
                     │                   │
                     ├─ success: 原子切换 activeIds, 保存 snapshot
                     └─ failure: 保持 last-good, 记录 error
```

### 关键语义

1. **不可变发布**：`register()` 后组件的 `release`/`config`/`constraint` 不得修改。修改 = 新 id + 新 release。

2. **原子切换**：`activate([ids])` 只在 tick/replan 边界调用。成功则全部激活；失败则保持当前集不变（零部分激活）。

3. **兼容性校验**：
   - `requires`：所有必需的 capability 必须由已注册组件提供
   - `conflicts`：互斥的 component id 不能同时激活
   - 通过 `validateCompatibility()` dry-run 提前检查

4. **Last-good / Rollback**：
   - `lastGoodSnapshot`：最近成功激活后的快照
   - `previousGoodSnapshot`：最近成功激活前的快照
   - `rollback()`：回退到 `previousGoodSnapshot`（"撤销最近一次切换"）

5. **Hash 追踪**：
   - 每个组件有 `release.hash`（内容哈希，canonical JSON）
   - 快照有 `configHash`（activeIds + 每个激活组件的 hash 的摘要）

## 与现有系统的集成

### tenant-runtime 集成点

```typescript
// 启动时（一次性）
import { createHotPlugContract } from "./strategy-hotplug/contract.ts";
import { registerAllVariants } from "./strategy-hotplug/variant-bridge.ts";

const contract = createHotPlugContract();
registerAllVariants(contract, "both");

// 解析初始变体
const result = contract.activateAndResolve(config.variants ?? []);
if (result === undefined) {
  // 兼容性失败 → 回退到默认配置
}

// 热加载时（reloadConfig 回调内）
const hotResult = contract.activate(nextConfig.variants ?? []);
if (!hotResult.success) {
  // 自动保持 last-good（contract 内部原子保护）
  logError(hotResult.error);
}

// 手动回滚（Supervisor API 触发）
contract.rollback();
```

### 现有代码不变

- `VARIANT_SAFETY_CONFIG` — 配置值 SSOT，不变
- `DETERMINISTIC_VARIANT_CONFIG` — 同上
- `resolveVariantsConfig()` — 继续可用（本层是其元数据包装）
- `planner.updateConfig()` — 热加载的实际执行者，不变

## 文件清单

| 文件 | 职责 |
|---|---|
| `src/strategy-hotplug/types.ts` | 核心类型定义（StrategyComponent, ComponentRelease, CompatibilityConstraint 等） |
| `src/strategy-hotplug/registry.ts` | HotPlugRegistry 类（注册/激活/停用/回滚/快照） |
| `src/strategy-hotplug/contract.ts` | HotPlugContract 顶层 API + ConfigMergeFn |
| `src/strategy-hotplug/hash.ts` | 确定性序列化与哈希工具（FNV-1a） |
| `src/strategy-hotplug/variant-bridge.ts` | 现有 variant-registry → StrategyComponent 映射 |
| `src/strategy-hotplug/index.ts` | barrel export |
| `test/strategy-hotplug-registry.test.ts` | HotPlugRegistry 单元测试（22 用例） |
| `test/strategy-hotplug-contract.test.ts` | HotPlugContract 集成测试（9 用例） |
| `test/strategy-hotplug-variant-bridge.test.ts` | Variant Bridge 测试（13 用例） |
| `docs/design/strategy-hotplug-contract.md` | 本文档 |

## 设计决策记录

### 为什么不动态加载磁盘 TS？

安全红线：任意磁盘 TS 可被篡改、无法审计。所有组件必须编译进 bundle——修改组件 = 新 commit + 新 release hash。

### 为什么 Object.assign 合并而不是 deep merge？

与现有 `resolveVariantsConfig()` 的语义完全一致（`Object.assign({}, ...ids.map(...))` ）。深合并会引入"数组追加/嵌套覆盖"的二义性，现有 config 全部是扁平布尔/数值，浅合并已足够。

### 为什么用 FNV-1a 而不是 SHA-256？

Release hash 用于完整性校验（检测配置变更），不是安全场景。FNV-1a 无外部依赖（不触发 Node `crypto` 权限问题）、速度快、确定性。生产环境如需更强者可注入自定义 hash 函数。

## 风险与待办

1. **Capability taxonomy 是主观分类**：现有 9 类可能不够细或过细。随新变体增加需维护 `VARIANT_CAPABILITIES` 映射表。
2. **Conflicts 尚未充分利用**：当前 `variant-bridge` 将所有变体的 `conflicts` 设为空数组。真实的互斥关系（如 `core-evade-v1` vs `core-evade-ttr-v1` 语义重叠）适合后续增量填写。
3. **未集成 tenant-runtime**：本层是 foundation，尚未接入 `tenant-runtime.ts` 的 `reloadConfig()` 路径。接入时需保留现有的 `resolveVariantsConfig()` 作为 fallback，确保零回归。
4. **模拟器侧未覆盖**：`sim/tools/planner-variants.ts` 的 `PLANNER_VARIANTS` 是独立的注册表。桥接 sim 侧是后续工作。
