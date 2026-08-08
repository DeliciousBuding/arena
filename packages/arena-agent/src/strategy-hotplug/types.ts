/**
 * Strategy Hot-Plug Contract — 核心类型定义（v1，2026-08-08）。
 *
 * 设计目标：在现有 variant-registry（配置声明式变体开关）之上，提供一套低过度
 * 工程化的"注册式热插拔"契约——组件不可变发布、tick/replan 边界原子切换、
 * capability/compatibility/hash/last-good/rollback 语义。
 *
 * 原则：
 * - 不动态执行任意磁盘 TS（组件必须是已编译类型，纯函数注册）；
 * - 复用现有 variant-registry 与纯函数，不造大框架；
 * - 类型层只定义契约，不引入运行时依赖（无 IO/fs/process）。
 */

// ---- Component Identity ----

/** 组件发布（不可变）：每个 StrategyComponent 的发布元数据。 */
export interface ComponentRelease {
  /** 语义版本（semver，如 "1.0.0"）。 */
  readonly version: string;
  /** 内容哈希（sha256:hex），覆盖 config + capabilities 的 canonical JSON。 */
  readonly hash: string;
  /** 发布时间（ISO-8601），仅文档用途。 */
  readonly publishedAt?: string;
}

// ---- Capability & Compatibility ----

export type Capability = string;

/** 组件兼容性声明：声明该组件的契约约束。 */
export interface CompatibilityConstraint {
  /** 组件提供的 capabilities（用于依赖解析）。 */
  readonly provides: readonly Capability[];
  /** 必需的 capabilities（组件激活前必须已满足）。 */
  readonly requires: readonly Capability[];
  /** 互斥的 component id（同时激活会冲突）。 */
  readonly conflicts: readonly string[];
}

// ---- StrategyComponent ----

/**
 * 策略组件：命名、版本化、哈希锁定的最小可插拔单元。
 *
 * 语义：
 * - `release` 不可变（一旦注册不可修改；修改=新 id+新 release）；
 * - `constraint` 声明兼容性（provides/requires/conflicts）；
 * - `config` 是该组件对策略层的实际配置贡献（merge 进 Planner config）；
 * - `rollback` 是该组件激活失败时的安全回退配置（通常 = 组件的零值/nop 态）。
 */
export interface StrategyComponent<TConfig = Record<string, unknown>> {
  /** 唯一标识（如 "threat-recall-v1"，对应 variant-registry 的变体 id）。 */
  readonly id: string;
  /** 不可变发布元数据。 */
  readonly release: ComponentRelease;
  /** 人类可读描述。 */
  readonly description: string;
  /** 兼容性约束。 */
  readonly constraint: CompatibilityConstraint;
  /** 组件配置（merge 进 planner config 的快照）。 */
  readonly config: TConfig;
  /** 安全回退配置（激活失败/冲突时 revert 到此态）。 */
  readonly rollback: TConfig;
}

// ---- StrategicPolicy ----

/**
 * 战略策略：一组 StrategyComponent 的命名组合。
 *
 * 语义：一个 StrategicPolicy 对应一个"战术包"（如 "strike-core-v1"），
 * 它声明要激活哪些 component，以及这些 component 之间如何组合。
 */
export interface StrategicPolicy {
  /** 策略名称（如 "strike-core-v1"）。 */
  readonly name: string;
  /** 描述。 */
  readonly description: string;
  /** 组成该策略的 component id 列表。 */
  readonly components: readonly string[];
}

// ---- RunState ----

/** 单个组件的运行时状态。 */
export interface ComponentState {
  /** 组件 id。 */
  readonly id: string;
  /** 是否已激活。 */
  readonly active: boolean;
  /** 当前激活的 release hash（active=false 时为上次激活的 hash）。 */
  readonly activeHash: string | null;
  /** 上次成功激活的 release hash（last-good）。 */
  readonly lastGoodHash: string | null;
  /** 激活代数（每次成功激活 +1）。 */
  readonly generation: number;
  /** 上次激活失败原因（active=false 时有值）。 */
  readonly lastError: string | null;
}

// ---- Registry Snapshot ----

/** 注册表快照（可序列化，用于 hash 追踪与 rollback）。 */
export interface RegistrySnapshot {
  /** 快照生成时间（epoch ms）。 */
  readonly at: number;
  /** 当前激活的 component id 集合（deterministic 排序）。 */
  readonly activeIds: readonly string[];
  /** 每个组件的状态。 */
  readonly states: Readonly<Record<string, ComponentState>>;
  /** 当前合并配置的 hash。 */
  readonly configHash: string;
}

// ---- Activation Result ----

/** 激活结果：契约 API 对调用方的反馈。 */
export interface ActivationResult {
  /** 是否成功。 */
  readonly success: boolean;
  /** 成功时：新快照；失败时：null。 */
  readonly snapshot: RegistrySnapshot | null;
  /** 失败原因（success=false 时有值）。 */
  readonly error: string | null;
  /** 冲突的 component id 列表（兼容性冲突时有值）。 */
  readonly conflicts: readonly string[];
  /** 缺失的 capability（依赖不满足时有值）。 */
  readonly missingCapabilities: readonly Capability[];
}

// ---- Compatibility Report ----

/** 兼容性校验报告（纯诊断，不产生副作用）。 */
export interface CompatibilityReport {
  /** 是否通过校验。 */
  readonly valid: boolean;
  /** 要激活的 id 集合。 */
  readonly requestedIds: readonly string[];
  /** 冲突对（[componentA, componentB]）。 */
  readonly conflicts: ReadonlyArray<readonly [string, string]>;
  /** 缺失的 capability。 */
  readonly missingCapabilities: readonly Capability[];
  /** 已满足的 capability（所有已注册+已激活组件提供的）。 */
  readonly satisfiedCapabilities: readonly Capability[];
}
