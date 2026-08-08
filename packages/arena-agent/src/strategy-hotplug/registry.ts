/**
 * HotPlugRegistry — 策略组件注册与生命周期管理（v1，2026-08-08）。
 *
 * 职责：
 * - 组件注册（不可变发布——注册后 release/config/constraint 不得修改）；
 * - 原子激活/停用——tick/replan 边界调用 activate()；
 * - 兼容性校验（provides/requires/conflicts）；
 * - last-good 追踪 + rollback；
 * - 快照（用于审计/hash 比对）。
 *
 * 约束：
 * - 纯 TypeScript 类型，无 IO / fs / process；
 * - 确定性（component 迭代按 id 字典序）；
 * - 不动态执行任意磁盘 TS（组件必须编译进 bundle）；
 * - 所有配置合并由外部 resolve 函数完成（本模块只管理 component 生命周期）。
 */

import type {
  ActivationResult,
  Capability,
  CompatibilityReport,
  ComponentState,
  RegistrySnapshot,
  StrategicPolicy,
  StrategyComponent,
} from "./types.ts";
import { simpleHash } from "./hash.ts";

// ---- Stable sort ----

function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- Implementation ----

export class HotPlugRegistry {
  /** 已注册的组件（id → 不可变 component）。 */
  private readonly components = new Map<string, StrategyComponent>();

  /** 每个组件的运行时状态。 */
  private readonly states = new Map<string, ComponentState>();

  /** 当前激活的 component id 集合（deterministic 排序）。 */
  private activeIds: readonly string[] = [];

  /**
   * 上次成功激活的快照（当前态）。
   * rollback 回退到 previousGoodSnapshot（激活前的态），不是 lastGood。
   */
  private lastGoodSnapshot: RegistrySnapshot | null = null;

  /** 最近一次激活前的快照（rollback 目标）。 */
  private previousGoodSnapshot: RegistrySnapshot | null = null;

  /** 快照序列号（每次成功激活递增）。 */
  private snapshotSeq = 0;

  // ---- Registration ----

  /**
   * 注册一个组件。同一 id 只能注册一次（重复注册 = 抛错）。
   * 注册后组件的 release/config/constraint 不可变。
   */
  register<TConfig>(component: StrategyComponent<TConfig>): void {
    if (this.components.has(component.id)) {
      throw new Error(`component already registered: ${component.id}`);
    }
    // 防御性冻结——注册后不可变
    const frozen: StrategyComponent = Object.freeze({
      ...component,
      release: Object.freeze({ ...component.release }),
      constraint: Object.freeze({
        provides: Object.freeze([...component.constraint.provides].sort(stableCompare)),
        requires: Object.freeze([...component.constraint.requires].sort(stableCompare)),
        conflicts: Object.freeze([...component.constraint.conflicts].sort(stableCompare)),
      }),
      config: Object.freeze({ ...component.config }),
      rollback: Object.freeze({ ...component.rollback }),
    });
    this.components.set(component.id, frozen);
    this.states.set(component.id, {
      id: component.id,
      active: false,
      activeHash: null,
      lastGoodHash: null,
      generation: 0,
      lastError: null,
    });
  }

  /**
   * 批量注册组件。
   */
  registerAll(components: readonly StrategyComponent[]): void {
    for (const c of components) {
      this.register(c);
    }
  }

  /**
   * 注册一个 StrategicPolicy：将其展开为 StrategyComponent 列表并注册。
   * 这只是便利方法——policy 是 named composition，底层仍是 component。
   */
  registerPolicy(policy: StrategicPolicy): void {
    for (const id of policy.components) {
      if (!this.components.has(id)) {
        throw new Error(
          `policy "${policy.name}" references unregistered component: ${id}`,
        );
      }
    }
    // Policy 本身不作为独立 component 注册——它是一个引用集合。
    // 未来可扩展为带 policy 级元数据的注册。
  }

  // ---- Query ----

  /** 获取已注册组件（只读）。 */
  get(id: string): StrategyComponent | undefined {
    return this.components.get(id);
  }

  /** 获取组件状态。 */
  stateOf(id: string): ComponentState | undefined {
    return this.states.get(id);
  }

  /** 检查组件是否已注册。 */
  has(id: string): boolean {
    return this.components.has(id);
  }

  /** 所有已注册的 component id（字典序）。 */
  get registeredIds(): readonly string[] {
    return [...this.components.keys()].sort(stableCompare);
  }

  /** 当前激活的 component id（字典序）。 */
  get activeComponentIds(): readonly string[] {
    return this.activeIds;
  }

  /** 上次成功激活的快照（rollback 目标）。 */
  get lastGood(): RegistrySnapshot | null {
    return this.lastGoodSnapshot;
  }

  // ---- Compatibility Validation ----

  /**
   * 校验一组 component id 的兼容性（纯诊断，不产生副作用）。
   */
  validateCompatibility(ids: readonly string[]): CompatibilityReport {
    const requested = [...ids].sort(stableCompare);
    const conflicts: Array<readonly [string, string]> = [];
    const missingCapabilities: Capability[] = [];

    // 1) 所有 id 必须已注册
    const missingIds = requested.filter((id) => !this.components.has(id));
    if (missingIds.length > 0) {
      // 视为 capability 缺失（"组件 X 不存在"等价于"组件 X 提供的 capability 不可用"）
      for (const id of missingIds) {
        missingCapabilities.push(`component:${id}`);
      }
    }

    // 2) 收集所有 provides（含已激活 + 请求激活的）
    const provided = new Set<Capability>();
    for (const id of this.activeIds) {
      const component = this.components.get(id);
      if (component !== undefined) {
        for (const cap of component.constraint.provides) {
          provided.add(cap);
        }
      }
    }
    for (const id of requested) {
      const component = this.components.get(id);
      if (component !== undefined) {
        for (const cap of component.constraint.provides) {
          provided.add(cap);
        }
      }
    }

    // 3) 检查 requires
    const requestedComponents = requested
      .map((id) => this.components.get(id))
      .filter((c): c is StrategyComponent => c !== undefined);

    for (const component of requestedComponents) {
      for (const req of component.constraint.requires) {
        if (!provided.has(req)) {
          missingCapabilities.push(req);
        }
      }
    }

    // 4) 检查 conflicts（请求的组件之间 + 与已激活的之间）
    const allRequested = new Set(requested);
    for (const component of requestedComponents) {
      for (const conflictId of component.constraint.conflicts) {
        if (allRequested.has(conflictId) || this.activeIds.includes(conflictId)) {
          const pair: readonly [string, string] = component.id < conflictId
            ? [component.id, conflictId]
            : [conflictId, component.id];
          // 去重
          if (!conflicts.some((existing) => existing[0] === pair[0] && existing[1] === pair[1])) {
            conflicts.push(pair);
          }
        }
      }
    }

    return {
      valid: conflicts.length === 0 && missingCapabilities.length === 0,
      requestedIds: requested,
      conflicts,
      missingCapabilities: [...new Set(missingCapabilities)].sort(stableCompare),
      satisfiedCapabilities: [...provided].sort(stableCompare),
    };
  }

  // ---- Activation ----

  /**
   * 原子激活一组 component id。
   *
   * 流程：
   * 1. 校验所有 id 已注册
   * 2. 校验兼容性（provides/requires/conflicts）
   * 3. 校验通过 → 原子切换 activeIds + 更新所有 state
   * 4. 保存 last-good snapshot
   * 5. 校验失败 → 保持当前 activeIds，不修改任何 state（除 lastError）
   *
   * 调用时机：tick/replan 边界（config reload 回调内）。
   */
  activate(ids: readonly string[]): ActivationResult {
    // 1) 校验所有 id 已注册
    const unknown = ids.filter((id) => !this.components.has(id));
    if (unknown.length > 0) {
      return {
        success: false,
        snapshot: null,
        error: `unknown components: ${unknown.join(", ")}`,
        conflicts: [],
        missingCapabilities: [],
      };
    }

    // 2) 兼容性校验
    const report = this.validateCompatibility(ids);
    if (!report.valid) {
      return {
        success: false,
        snapshot: null,
        error: [
          report.conflicts.length > 0
            ? `conflicts: ${report.conflicts.map((pair) => pair.join("/")).join(", ")}`
            : null,
          report.missingCapabilities.length > 0
            ? `missing capabilities: ${report.missingCapabilities.join(", ")}`
            : null,
        ]
          .filter(Boolean)
          .join("; "),
        conflicts: report.conflicts.flat(),
        missingCapabilities: report.missingCapabilities,
      };
    }

    // 3) 原子切换
    const previousActive = new Set(this.activeIds);
    const requested = new Set(ids);

    // 3a) 停用：之前在 active 但现在不在的 → active=false
    for (const id of previousActive) {
      if (!requested.has(id)) {
        const state = this.states.get(id);
        if (state !== undefined) {
          this.states.set(id, {
            ...state,
            active: false,
            lastError: null,
          });
        }
      }
    }

    // 3b) 激活：在请求中的 → active=true, 更新 hash + generation
    for (const id of ids) {
      const component = this.components.get(id)!;
      const state = this.states.get(id)!;
      this.states.set(id, {
        ...state,
        active: true,
        activeHash: component.release.hash,
        lastGoodHash: component.release.hash,
        generation: state.generation + 1,
        lastError: null,
      });
    }

    // 4) 更新 activeIds（先保存当前快照作为 rollback 目标）
    this.previousGoodSnapshot = this.activeIds.length === 0 && this.lastGoodSnapshot === null
      ? null
      : this.takeSnapshot(); // snapshot of CURRENT state before switching
    this.activeIds = [...ids].sort(stableCompare);

    // 5) 保存新快照
    const snapshot = this.takeSnapshot();
    this.lastGoodSnapshot = snapshot;

    return {
      success: true,
      snapshot,
      error: null,
      conflicts: [],
      missingCapabilities: [],
    };
  }

  /**
   * 停用单个组件（从 active set 中移除）。
   */
  deactivate(id: string): ActivationResult {
    if (!this.activeIds.includes(id)) {
      return {
        success: true,
        snapshot: this.lastGoodSnapshot,
        error: null,
        conflicts: [],
        missingCapabilities: [],
      };
    }
    const nextIds = this.activeIds.filter((activeId) => activeId !== id);
    return this.activate(nextIds);
  }

  // ---- Rollback ----

  /**
   * 回滚到最近一次激活前的快照（previousGood）。
   * 无 previousGood 时退化为 activate([])（清空所有激活）。
   */
  rollback(): ActivationResult {
    if (this.previousGoodSnapshot === null) {
      return this.activate([]);
    }
    return this.activate([...this.previousGoodSnapshot.activeIds]);
  }

  // ---- Snapshot ----

  /**
   * 生成当前注册表快照。
   */
  takeSnapshot(): RegistrySnapshot {
    const states: Record<string, ComponentState> = {};
    for (const id of [...this.states.keys()].sort(stableCompare)) {
      states[id] = { ...this.states.get(id)! };
    }

    // 配置哈希：activeIds + 每个激活组件的 release hash 的简单摘要
    const configParts = this.activeIds
      .map((id) => `${id}:${this.states.get(id)?.activeHash ?? "none"}`)
      .join(",");
    const configHash = simpleHash(configParts);

    return Object.freeze({
      at: Date.now(),
      activeIds: [...this.activeIds],
      states: Object.freeze(states),
      configHash,
    });
  }
}

// ---- Pure helpers (exported for testing / external use) ----

/**
 * 从已排序的 states 构建兼容性所需的 capability 集合。
 * 纯函数，不在 registry 类内（方便单测）。
 */
export function collectCapabilities(
  components: ReadonlyMap<string, StrategyComponent>,
  activeIds: readonly string[],
): Set<Capability> {
  const caps = new Set<Capability>();
  for (const id of activeIds) {
    const c = components.get(id);
    if (c !== undefined) {
      for (const cap of c.constraint.provides) {
        caps.add(cap);
      }
    }
  }
  return caps;
}

/**
 * 合并多个 StrategyComponent 的 config 为一个（Object.assign 顺序）。
 * 后面的 config 覆盖前面的同名字段。
 */
export function mergeConfigs(
  components: readonly StrategyComponent[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const c of components) {
    Object.assign(merged, c.config);
  }
  return merged;
}
