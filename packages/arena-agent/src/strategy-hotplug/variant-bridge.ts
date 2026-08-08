/**
 * Variant Bridge — 现有 variant-registry → StrategyComponent 映射（v1，2026-08-08）。
 *
 * 将 VARIANT_SAFETY_CONFIG + DETERMINISTIC_VARIANT_CONFIG 的每个变体
 * 映射为 StrategyComponent 并注册进 HotPlugContract。
 *
 * 原则：
 * - 零破坏性——现有 variant-registry 的 config 值照搬，不修改任何逻辑；
 * - 只增加元数据层（release hash / capability / compatibility）；
 * - 变体 id 与现有 config.variants 字符串完全一致（不需要迁移配置）。
 *
 * 能力分类（capability taxonomy）：
 * - `worker-defense`    worker 召回/撤离/守家
 * - `military-offense`  攻坚/前压/爆兵/攻击
 * - `military-defense`  守家/回援/守卫轮转
 * - `core-protection`   Core 迁移/清障/通道保护
 * - `economy`          采集/产兵配比/使命层
 * - `scouting`         探索/巡逻/侦察/测绘
 * - `blockade`         锁阵/拦截（worker + Vanguard）
 * - `alliance`         联盟 no-fire
 * - `population`       人口上限调整
 */

import { deterministicCanonicalJson, simpleHash } from "./hash.ts";
import type { HotPlugContract } from "./contract.ts";
import type { Capability, CompatibilityConstraint, ComponentRelease, StrategyComponent } from "./types.ts";

// ---- Re-import from existing variant-registry ----
import {
  DETERMINISTIC_VARIANT_CONFIG,
  VARIANT_SAFETY_CONFIG,
} from "../strategies/variant-registry.ts";
import type { SafetyPlannerConfig } from "../strategies/safety-planner-config.ts";
import type { DeterministicVariantConfig } from "../strategies/variant-registry.ts";

// ---- Capability taxonomy ----

type CapGroup = readonly Capability[];

const CAP: Record<string, CapGroup> = {
  WORKER_DEFENSE: ["worker-defense"],
  MILITARY_OFFENSE: ["military-offense"],
  MILITARY_DEFENSE: ["military-defense"],
  CORE_PROTECTION: ["core-protection"],
  ECONOMY: ["economy"],
  SCOUTING: ["scouting"],
  BLOCKADE: ["blockade"],
  ALLIANCE: ["alliance"],
  POPULATION: ["population"],
};

// ---- Capability declarations per variant ----

/**
 * 每个变体的 capability 声明。
 * 不在此映射中的变体 = 空 capability（不提供任何能力）。
 */
const VARIANT_CAPABILITIES: Readonly<Record<string, readonly Capability[]>> = Object.freeze({
  // worker-defense
  "threat-recall-v1": CAP.WORKER_DEFENSE,
  "scout-evade-v1": CAP.WORKER_DEFENSE,
  "threat-breakout-v1": CAP.WORKER_DEFENSE,
  "outnumbered-retreat-v1": [...CAP.MILITARY_DEFENSE, ...CAP.WORKER_DEFENSE],

  // military-offense
  "strike-core-v1": [...CAP.MILITARY_OFFENSE, ...CAP.ECONOMY],
  "vanguard-heavy-v1": CAP.ECONOMY,
  "detached-squad-v1": CAP.MILITARY_OFFENSE,
  "bounded-raid-v1": CAP.MILITARY_OFFENSE,
  "ranger-memory-shot-v1": CAP.MILITARY_OFFENSE,
  "weak-core-first-v1": CAP.MILITARY_OFFENSE,
  "assault-overmatch-v1": CAP.MILITARY_OFFENSE,
  "rally-assault-v1": CAP.MILITARY_OFFENSE,
  "vanguard-prey-worker-v1": CAP.MILITARY_OFFENSE,
  "military-priority-v1": [...CAP.MILITARY_OFFENSE, ...CAP.ECONOMY],

  // military-defense
  "guard-axes-v1": CAP.MILITARY_DEFENSE,
  "guard-heal-rotation-v1": CAP.MILITARY_DEFENSE,
  "reinforce-home-v1": CAP.MILITARY_DEFENSE,
  "threat-adaptive-defense-v1": CAP.MILITARY_DEFENSE,
  "raid-defense-v1": CAP.MILITARY_DEFENSE,

  // core-protection
  "core-evade-v1": CAP.CORE_PROTECTION,
  "core-evade-persist-v1": CAP.CORE_PROTECTION,
  "core-evade-ttr-v1": CAP.CORE_PROTECTION,
  "core-clearance-v1": CAP.CORE_PROTECTION,
  "core-moving-hold-v1": CAP.CORE_PROTECTION,
  "spawn-yield-v1": CAP.CORE_PROTECTION,
  "core-threat-watch-v1": CAP.CORE_PROTECTION,
  "clear-path-v1": CAP.CORE_PROTECTION,
  "move-failed-avoidance-v1": CAP.CORE_PROTECTION,

  // economy
  "harvest-memory-mine-v1": CAP.ECONOMY,
  "worker-mission-v1": CAP.ECONOMY,
  "beacon-grab-v1": CAP.ECONOMY,

  // scouting
  "frontier-priority-v1": CAP.SCOUTING,
  "worker-dense-scan-v1": CAP.SCOUTING,
  "threat-sector-scout-v1": CAP.SCOUTING,

  // blockade
  "worker-blockade-v1": CAP.BLOCKADE,
  "vanguard-blockade-v1": CAP.BLOCKADE,

  // alliance
  "alliance-no-fire-v1": CAP.ALLIANCE,

  // population
  "population-ceiling-30-v1": CAP.POPULATION,
});

// ---- Component factory ----

/** 为 safety config 变体创建 StrategyComponent。 */
function safetyComponent(
  id: string,
  config: Partial<SafetyPlannerConfig>,
): StrategyComponent<Partial<SafetyPlannerConfig>> {
  const provides = VARIANT_CAPABILITIES[id] ?? [];
  const release = computeRelease(id, "1.0.0", config);

  return {
    id,
    release,
    description: `Safety planner variant: ${id}`,
    constraint: {
      provides,
      requires: [],
      conflicts: [],
    },
    config,
    rollback: {}, // 回退 = 清空该组件的 config 覆盖（恢复到 planner 默认）
  };
}

/** 为 deterministic config 变体创建 StrategyComponent。 */
function deterministicComponent(
  id: string,
  config: DeterministicVariantConfig,
): StrategyComponent<Record<string, unknown>> {
  const provides = VARIANT_CAPABILITIES[id] ?? [];
  const configRecord = config as Record<string, unknown>;
  const release = computeRelease(id, "1.0.0", configRecord);

  return {
    id,
    release,
    description: `Deterministic planner variant: ${id}`,
    constraint: {
      provides,
      requires: [],
      conflicts: [],
    },
    config: configRecord,
    rollback: {},
  };
}

// ---- Hash computation ----

/**
 * 计算组件的 release hash。
 * 覆盖：id + version + canonical JSON(config)。
 */
function computeRelease(
  id: string,
  version: string,
  config: Record<string, unknown>,
): ComponentRelease {
  const canonical = deterministicCanonicalJson({ id, version, config });
  return Object.freeze({
    version,
    hash: `sha256:${simpleHash(canonical)}`,
  });
}

// ---- Registration ----

/**
 * 将所有现有变体注册进 HotPlugContract。
 *
 * 用法（tenant-runtime 启动时一次性）：
 *   import { createHotPlugContract } from "./strategy-hotplug/contract.ts";
 *   import { registerAllVariants } from "./strategy-hotplug/variant-bridge.ts";
 *   const contract = createHotPlugContract();
 *   registerAllVariants(contract);
 *
 * @param contract - HotPlugContract 实例（safety + deterministic 两个 domain 需分别注册）。
 * @param domain - "safety" | "deterministic" | "both"（默认 "both"）。
 */
export function registerAllVariants(
  contract: HotPlugContract,
  domain: "safety" | "deterministic" | "both" = "both",
): void {
  if (domain === "safety") {
    for (const [id, config] of Object.entries(VARIANT_SAFETY_CONFIG)) {
      contract.register(safetyComponent(id, config as Partial<SafetyPlannerConfig>));
    }
    return;
  }

  if (domain === "deterministic") {
    for (const [id, config] of Object.entries(DETERMINISTIC_VARIANT_CONFIG)) {
      contract.register(deterministicComponent(id, config));
    }
    return;
  }

  // "both": some variant ids exist in both registries.
  // Safety-side config merged with deterministic-side config into a single component.
  const merged = new Map<string, Record<string, unknown>>();

  for (const [id, config] of Object.entries(VARIANT_SAFETY_CONFIG)) {
    merged.set(id, { ...(config as Record<string, unknown>) });
  }

  for (const [id, config] of Object.entries(DETERMINISTIC_VARIANT_CONFIG)) {
    const existing = merged.get(id);
    if (existing !== undefined) {
      // Merge: deterministic overrides safety on same keys
      Object.assign(existing, config as Record<string, unknown>);
    } else {
      merged.set(id, { ...(config as Record<string, unknown>) });
    }
  }

  // Register merged components (all as safety components since they contain safety config)
  // Deterministic-only fields are opaque to the safety resolver; they're consumed by
  // resolveDeterministicVariantsConfig separately.
  for (const [id, config] of merged) {
    const provides = VARIANT_CAPABILITIES[id] ?? [];
    const release = computeRelease(id, "1.0.0", config);
    contract.register({
      id,
      release,
      description: `Merged variant: ${id}`,
      constraint: {
        provides,
        requires: [],
        conflicts: [],
      },
      config,
      rollback: {},
    });
  }
}

/**
 * 获取变体的 capability 声明（供外部诊断）。
 */
export function capabilitiesOf(id: string): readonly Capability[] {
  return VARIANT_CAPABILITIES[id] ?? [];
}

/**
 * 列出所有已知 capability。
 */
export function allCapabilities(): readonly Capability[] {
  const set = new Set<Capability>();
  for (const caps of Object.values(VARIANT_CAPABILITIES)) {
    for (const cap of caps) set.add(cap);
  }
  return [...set].sort();
}
