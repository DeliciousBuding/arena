/**
 * Strategy Hot-Plug Contract — barrel export（v1，2026-08-08）。
 */

// Types
export type {
  ActivationResult,
  Capability,
  CompatibilityConstraint,
  CompatibilityReport,
  ComponentRelease,
  ComponentState,
  RegistrySnapshot,
  StrategicPolicy,
  StrategyComponent,
} from "./types.ts";

// Core
export { HotPlugRegistry, collectCapabilities, mergeConfigs } from "./registry.ts";

// Contract
export {
  createHotPlugContract,
  defaultMergeConfig,
  type ConfigMergeFn,
  type HotPlugContract,
  type HotPlugContractOptions,
} from "./contract.ts";

// Hash
export { deterministicCanonicalJson, simpleHash } from "./hash.ts";

// Variant bridge (integration with existing variant-registry)
export {
  allCapabilities,
  capabilitiesOf,
  registerAllVariants,
} from "./variant-bridge.ts";
