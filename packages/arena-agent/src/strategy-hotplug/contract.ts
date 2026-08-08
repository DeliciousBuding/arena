/**
 * HotPlugContract — 顶层契约 API（v1，2026-08-08）。
 *
 * 提供注册、激活、回滚、快照的统一入口。本模块是 tenant-runtime 与
 * HotPlugRegistry 之间的适配层——接收 component id 列表，返回合并后的
 * planner config（复用现有 resolveVariantsConfig 的 Object.assign 合并模式）。
 *
 * 与现有 variant-registry 的关系：
 * - 现有 VARIANT_SAFETY_CONFIG/DETERMINISTIC_VARIANT_CONFIG 是"配置声明表"；
 * - HotPlugContract 是"生命周期管理器"——track hash/last-good/rollback；
 * - variant-bridge.ts 将现有变体映射为 StrategyComponent 并注册进 contract；
 * - resolveVariantsConfig() 的合并逻辑由 contract.activate() 内部的
 *   mergeConfigs() 等价替代（不重复实现）。
 *
 * 调用方（tenant-runtime）的集成路径：
 *   1. 启动时：创建 contract → 通过 variant-bridge 注册所有变体 →
 *             contract.activate(config.variants) → 获得合并 config；
 *   2. 热加载时：contract.activate(nextConfig.variants) → 成功则更新 planner，
 *               失败则 keep last-good（contract 内部原子保护）。
 */

import { HotPlugRegistry } from "./registry.ts";
import type {
  ActivationResult,
  CompatibilityReport,
  RegistrySnapshot,
  StrategicPolicy,
  StrategyComponent,
} from "./types.ts";

// ---- Config merge function type ----

/**
 * 配置合并函数签名：component 列表 → 合并后的 config。
 * 默认实现 = Object.assign（与 resolveVariantsConfig 同语义）。
 */
export type ConfigMergeFn<TConfig = Record<string, unknown>> = (
  components: readonly StrategyComponent[],
) => TConfig;

/**
 * 默认合并：浅合并所有 component config（后面覆盖前面）。
 * 与 resolveVariantsConfig 的 `Object.assign({}, ...)` 完全等价。
 */
export function defaultMergeConfig<TConfig extends Record<string, unknown>>(
  components: readonly StrategyComponent[],
): TConfig {
  const merged = {} as Record<string, unknown>;
  for (const c of components) {
    Object.assign(merged, c.config);
  }
  return merged as TConfig;
}

// ---- Contract ----

export interface HotPlugContract<TConfig = Record<string, unknown>> {
  // -- Registration (startup time) --

  /** 注册单个组件（不可变——注册后 release/config 不得修改）。 */
  register(component: StrategyComponent): void;

  /** 批量注册组件。 */
  registerAll(components: readonly StrategyComponent[]): void;

  /** 注册 StrategicPolicy（展开为 component 引用，校验引用完整性）。 */
  registerPolicy(policy: StrategicPolicy): void;

  // -- Activation (tick/replan boundary) --

  /**
   * 原子激活一组 component id。只在 tick/replan 边界调用。
   *
   * 成功 → 返回合并后的 config + snapshot；
   * 失败 → 保持当前激活集不变（component 状态不变），返回错误。
   */
  activate(ids: readonly string[]): ActivationResult;

  /**
   * 激活并返回合并后的 config（便利方法）。
   * 成功 → config；失败 → undefined（调用方应 fallback 到 lastGood/默认 config）。
   */
  activateAndResolve(ids: readonly string[]): TConfig | undefined;

  /**
   * 停用单个组件。
   */
  deactivate(id: string): ActivationResult;

  // -- Rollback --

  /** 回滚到上次成功激活的快照。 */
  rollback(): ActivationResult;

  // -- Query --

  /** 当前激活的 component id 集合。 */
  readonly activeIds: readonly string[];

  /** 上次成功激活的快照（rollback 目标）。 */
  readonly lastGood: RegistrySnapshot | null;

  /** 所有已注册的 component id。 */
  readonly registeredIds: readonly string[];

  /** 获取已注册组件。 */
  get(id: string): StrategyComponent | undefined;

  /** 检查组件是否已注册。 */
  has(id: string): boolean;

  // -- Validation & Snapshot --

  /** 兼容性校验（dry-run，不产生副作用）。 */
  validate(ids: readonly string[]): CompatibilityReport;

  /** 生成当前注册表快照。 */
  snapshot(): RegistrySnapshot;
}

// ---- Factory ----

export interface HotPlugContractOptions<TConfig = Record<string, unknown>> {
  /**
   * 配置合并函数。缺省 = defaultMergeConfig（Object.assign 顺序合并，与
   * resolveVariantsConfig 完全一致）。
   */
  readonly mergeConfig?: ConfigMergeFn<TConfig>;
}

/**
 * 创建 HotPlugContract 实例。
 *
 * 用法：
 *   const contract = createHotPlugContract();
 *   // 注册所有变体（启动时一次性）
 *   registerAllVariants(contract);
 *   // 激活生产配置
 *   const result = contract.activate(["threat-recall-v1", "core-clearance-v1"]);
 *   if (!result.success) { ... handle error ... }
 */
export function createHotPlugContract<TConfig extends Record<string, unknown> = Record<string, unknown>>(
  options: HotPlugContractOptions<TConfig> = {},
): HotPlugContract<TConfig> {
  const registry = new HotPlugRegistry();
  const mergeConfig = options.mergeConfig ?? (defaultMergeConfig as ConfigMergeFn<TConfig>);

  const contract: HotPlugContract<TConfig> = {
    register(component: StrategyComponent): void {
      registry.register(component);
    },

    registerAll(components: readonly StrategyComponent[]): void {
      registry.registerAll(components);
    },

    registerPolicy(policy: StrategicPolicy): void {
      registry.registerPolicy(policy);
    },

    activate(ids: readonly string[]): ActivationResult {
      return registry.activate(ids);
    },

    activateAndResolve(ids: readonly string[]): TConfig | undefined {
      const result = registry.activate(ids);
      if (!result.success) return undefined;
      const activeComponents = ids
        .map((id) => registry.get(id))
        .filter((c): c is StrategyComponent => c !== undefined);
      return mergeConfig(activeComponents);
    },

    deactivate(id: string): ActivationResult {
      return registry.deactivate(id);
    },

    rollback(): ActivationResult {
      return registry.rollback();
    },

    get activeIds(): readonly string[] {
      return registry.activeComponentIds;
    },

    get lastGood(): RegistrySnapshot | null {
      return registry.lastGood;
    },

    get registeredIds(): readonly string[] {
      return registry.registeredIds;
    },

    get(id: string): StrategyComponent | undefined {
      return registry.get(id);
    },

    has(id: string): boolean {
      return registry.has(id);
    },

    validate(ids: readonly string[]): CompatibilityReport {
      return registry.validateCompatibility(ids);
    },

    snapshot(): RegistrySnapshot {
      return registry.takeSnapshot();
    },
  };

  return contract;
}
