# 命名规范与术语表（arena-ts）

状态：约定 + 现状固化（2026-08-08，命名规范核验）。只记录约定与消歧，不改代码。
权威清单：`docs/design/variant-inventory.md`（变体库存，唯一权威）。
改名属破坏性变更（需同步注册表、运行时配置与文档），按变更管理流程单独执行。

## 1. 命名约定

### 1.1 文件命名：kebab-case + 显式 `.ts` 扩展

- 源文件与脚本一律 `kebab-case`（小写字母 + 连字符），如 `safety-planner.ts`、
  `central-shadow-runtime.ts`、`official-plan.ts`。
- 显式写扩展名：源码内 import 一律带 `.ts` 扩展（TypeScript NodeNext 显式导入约定），
  如 `import type { SafetyPlannerConfig } from "./safety-planner.ts";`。
- `scripts/` 与 `packages/*/scripts/` 新脚本统一用 `.ts`（`npx tsx` 直接执行）。
  `.mts` 是历史残留（当前 72 个，全部位于 `packages/arena-agent/scripts/`，
  对比 `.ts` 469 个），**新脚本禁止写 `.mts`**；存量 `.mts` 不迁移不改名（避免
  噪音 diff），新文件一律 `.ts`。

### 1.2 变体 id：`kebab-case-v1`

- 注册表 `variant-registry.ts` 中的变体 id 一律 `kebab-case-v1` 后缀，
  如 `threat-recall-v1`、`population-ceiling-35-v1`。
- 部署配置 `runtime/configs/*.json` 的 `variants` 数组直接引用该 id（声明式启用）。

### 1.3 配置 flag：camelCase

- `SafetyPlannerConfig` / `DeterministicVariantConfig` 字段（变体开关与参数）一律
  camelCase，如 `remoteReinforce`、`beaconGrabMaxDist`、`populationCeiling`、
  `vanguardRatio`、`accumulateThreshold`。
- 规则：**id 用 kebab-case（外部契约），flag 用 camelCase（内部字段）**——二者
  由注册表显式配对，见 §3 不一致清单。

### 1.4 SQL 表 / 列：snake_case

- 数据库表与列一律 snake_case：`resources`、`obstacles`、`core_hunts`、
  `units_seen`、`sync_meta`、`heat_archive`（`intel/survey-db.ts` CREATE TABLE）。
- JSON 事件/schema 名沿用 kebab-case：`alliance-shadow-frame-v1`、
  `alliance-shadow-snapshot-v1`。

## 2. 术语消歧表

同一词汇在代码库中有多个含义。**写代码/文档时必须带限定词**，禁止裸用。

### 2.1 `shadow` — 三义

| 含义 | 文件位置 | 建议用法 |
|------|----------|----------|
| ① 联盟快照镜像（只读影子：每 interval 提取观测、写 AllianceSnapshot JSONL，不改决策不 submit） | `packages/arena-agent/src/alliance/shadow.ts`、`alliance/shadow-frame.ts`（AllianceShadowFrameV1，schema `alliance-shadow-frame-v1`） | 写"联盟快照 shadow"或直接用文件名上下文；别与 ② 混 |
| ② 联盟中央控制回路（Supervisor 侧 central Alliance shadow control loop，tokenless/ASSIST-only） | `packages/arena-agent/src/alliance/runtime/central-shadow-runtime.ts`（配套 `shadow-policy-adapter.ts`、`tenant-bridge.ts`） | 写"central shadow 控制回路" |
| ③ CLI 无提交模式（`--shadow` flag：强制只观察不提交，与 `--live` 互斥） | `packages/arena-agent/src/cli/run-tenant.ts`（L6/L32，`--mode=agent-shadow` 亦属决策模式覆盖） | 写"run-tenant --shadow 无提交模式" |

### 2.2 `phase` — 两义

| 含义 | 文件位置 | 建议用法 |
|------|----------|----------|
| ① 策略阶段（GamePhase：`early_expansion` / `balanced` / `military`，阈值驱动的宏观策略切换） | `packages/arena-agent/src/domain/phase-machine.ts`（L1 `export type GamePhase = "early_expansion" \| "balanced" \| "military"`） | 写"策略阶段（phase-machine）" |
| ② 结算阶段（sim 引擎 15 个内部 phase，映射官方结算阶段；`unsupported` 语义） | `packages/arena-agent/src/sim/engine/phase.ts` | 写"结算阶段（sim/engine/phase）" |

### 2.3 `threat` — 散布四层（同一词四层含义，引用时须指明是哪一层）

| 含义 | 文件位置 | 建议用法 |
|------|----------|----------|
| ① 威胁诊断等级（纯函数：NORMAL / ALERT / ENGAGED / BREAKOUT + ThreatAssessment） | `packages/arena-agent/src/domain/threat.ts` | 写"威胁等级（domain/threat）" |
| ② SafetyPlanner 内联威胁字段/加权（`threatSector` 巡逻方位加权、威胁召回半径 12、`threatMilitaryFloor` 等） | `packages/arena-agent/src/strategies/safety-planner.ts`（L105 `threatWeightedDirection`、L118 召回触发距离；`safety-planner-helpers.ts` 配套） | 写"威胁配置（safety-planner）" |
| ③ 联盟威胁场/威胁摘要（ThreatCell 四分量投影 + 8 扇区租户相对摘要） | `packages/arena-agent/src/alliance/threat-field.ts`、`alliance/threat-summary.ts` | 写"威胁场（threat-field）" / "威胁摘要（threat-summary）" |
| ④ 敌核威胁提炼（approaching / proximity / stale，参谋建议与 decision-input 双消费者） | `packages/command-center/lib/core-threats.ts` | 写"敌核威胁（core-threats）" |

### 2.4 矿记忆 — 四名（同一数据四种叫法，迁移目标见 project-org-plan-20260808 轨道三）

| 名称 | 文件位置 | 建议用法 |
|------|----------|----------|
| `World.resourceMemory`（World 实例内运行期资源记忆 Map） | `packages/arena-agent/src/domain/world.ts` L280 `private readonly resourceMemory = new Map<string, ResourceMemory>()` | 写"World.resourceMemory（运行期）" |
| `knownResources`（survey-db 查询出的已知矿集合） | `packages/arena-agent/src/intel/survey-db.ts` L589 `export function knownResources(...)` | 写"knownResources（survey-db 查询）" |
| `harvestMemoryMine` / `harvestMemoryMaxDist`（记忆矿主动开采开关/最远距离，harvest-memory-mine-v1） | `packages/arena-agent/src/strategies/safety-planner.ts` L1584/L1588（`HARVEST_MEMORY_MAX_DIST` 缺省） | 写"harvestMemoryMine 配置" |
| "测绘种子"（跨 run 持久化已知矿，注入 resourceMemory 的 survey-db seed） | `packages/arena-agent/src/domain/world.ts` L705 `seedResourceMemory`（注释"跨 run 测绘种子（survey-db 联动）"） | 写"测绘种子（survey-db seed）" |

### 2.5 `core` / `home` / `base` — 近义陷阱

| 词 | 含义 | 文件位置 | 建议用法 |
|----|------|----------|----------|
| `homeCell()` | 函数：Core 附近守位/回仓的候选格（历史四邻轮转，全堵返回 null） | `packages/arena-agent/src/strategies/safety-planner-helpers.ts` L190 `export function homeCell(core: Position, obstacles, index = 0)` | 写"homeCell()（守位格函数）"；是**函数**不是目录 |
| `baseDir` | 数据目录：tenant 配置字段/运行时解析出的 runtime 根目录 | `packages/arena-agent/src/app/runtime-config.ts`（config 字段） | 写"baseDir（数据目录）"；与 homeCell 完全无关 |

### 2.6 `bridge` — 三处（都叫 bridge，功能完全不同）

| 含义 | 文件位置 | 建议用法 |
|------|----------|----------|
| ① 对抗测试平台协议桥（中立协议翻译层：官方 Arena Hero 线模型 PlayerState / CommandPlan / View 作交换格式，解耦我方模拟器与对手决策） | `packages/arena-agent/src/sim/opponent/protocol-bridge.ts` | 写"protocol-bridge（对手协议）" |
| ② 外部策略进程桥接（official-plan：CommandPlan JSON 解析；official-state：PlayerState JSON 构造；external-planner：外部策略作为 PlanProvider 接入模拟器；与 Rust 线 arena-sim-bridge 对偶） | `packages/arena-agent/src/sim/bridge/official-plan.ts`、`sim/bridge/official-state.ts`、`sim/bridge/external-planner.ts` | 写"sim/bridge（外部策略桥）"并指明具体文件 |
| ③ 官方 web 手操镜像（消费官方事件流回执 Received 的只读回显，独立镜像文件 + 审计，不合并 human-commands） | `packages/arena-agent/src/command-plane/official-bridge.ts` | 写"official-bridge（手操镜像）" |

## 3. 变体 id ↔ flag 映射（5 对不一致，已登记）

现状：变体 id 与对应 flag 名不同词干（历史命名漂移）。**id 与 flag 的配对以
`variant-registry.ts` 注册表为唯一事实**，改 flag 名需同步注册表与 safety-planner
接口。已登记；改名属破坏性变更（需同步注册表、运行时配置与文档），按变更管理
流程单独执行。

| 变体 id | 注册 flag | 注册行号 | 说明 |
|---------|-----------|----------|------|
| `reinforce-home-v1` | `remoteReinforce` | variant-registry.ts L35 | id 说"回援守家"，flag 说"远端回援" |
| `detached-squad-v1` | `detachedSquadResponse` | variant-registry.ts L203 | id 说"分遣小队"，flag 多出 Response |
| `military-frontier-scavenge-v1` | `militaryScavengeFrontier` | variant-registry.ts L207 | id 与 flag 词序相反 |
| `military-priority-v1` | `threatMilitaryPriority` | variant-registry.ts L191 | flag 带 threat 前缀（与 threatMilitaryFloor 配套命名） |
| `harvest-memory-mine-v1` | `harvestMemoryMine` | variant-registry.ts L176 | id 与 flag 基本一致，属可接受近似（保留记录） |

注：`military-frontier-scavenge-v1` / `militaryScavengeFrontier` 词序相反是 5 对中
唯一 id↔flag 语义倒置的，优先对齐。其余 4 对为词干不一致，以文档声明 + 注册表
显式配对兜底（或按变更流程统一改名）。

## 4. 使用纪律

- 新变体：id 起 `kebab-case-v1` 名，flag 起 camelCase 名，**两者词干尽量一致**；
  注册进 `variant-registry.ts` 的 `VARIANT_SAFETY_CONFIG`（safety 侧必注册，
  空覆盖也要注册——缺注册 = 配置加载 fail-fast）与需要时
  `DETERMINISTIC_VARIANT_CONFIG`。
- 写文档引用概念时带文件上下文（见 §2 建议用法列），避免裸用多义词。
- 存量命名（`.mts`、5 对不一致、矿记忆四名）不做无计划改动；改名走统一变更流程。
