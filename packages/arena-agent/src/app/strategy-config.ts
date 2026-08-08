/**
 * Runtime strategy compiler: one source of truth for startup, hot reload and deploy preflight.
 *
 * Hot-pluggable means registered strategy components can be reconfigured atomically at a Tick
 * boundary. It deliberately does NOT mean loading arbitrary TypeScript modules into a live writer.
 * Code changes still move through immutable release promotion/rollback.
 */

import { sha256Canonical } from "../domain/integrity.ts";
import {
  resolveDeterministicVariantsConfig,
  resolveVariantsConfig,
  type DeterministicVariantConfig,
} from "../strategies/variant-registry.ts";
import type { SafetyPlannerConfig } from "../strategies/safety-planner-config.ts";
import { loadRuntimeConfig, type TenantRuntimeConfig } from "./runtime-config.ts";

export interface CompiledRuntimeStrategy {
  readonly config: TenantRuntimeConfig;
  readonly variants: readonly string[];
  readonly safetyOverrides: Readonly<Partial<SafetyPlannerConfig>>;
  readonly deterministicOverrides: Readonly<DeterministicVariantConfig>;
  /** Hash of the complete validated config file. */
  readonly configHash: string;
  /** Hash of only the strategy surface that can be swapped without rebuilding the writer. */
  readonly strategyHash: string;
  /** Hash of all restart-required config fields (everything except `variants`). */
  readonly restartHash: string;
}

export interface HotReloadCompatibility {
  readonly compatible: boolean;
  readonly restartRequiredFields: readonly string[];
  readonly variantsChanged: boolean;
}

function hash(value: unknown): string {
  return `sha256:${sha256Canonical(value)}`;
}

function comparableHash(value: unknown): string {
  return value === undefined ? "<undefined>" : hash(value);
}

function restartSurface(config: TenantRuntimeConfig): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(config).filter(([key]) => key !== "variants"),
  ));
}

/** Compile + validate all registered strategy ids. Unknown or duplicate ids fail closed. */
export function compileRuntimeStrategy(config: TenantRuntimeConfig): CompiledRuntimeStrategy {
  const variants = Object.freeze([...(config.variants ?? [])]);
  const duplicate = variants.find((id, index) => variants.indexOf(id) !== index);
  if (duplicate !== undefined) {
    throw new Error(`duplicate strategy variant: ${duplicate}`);
  }

  // resolveVariantsConfig is the canonical registry validation boundary. Every production id must
  // exist on the safety registry even when its runtime effect is deterministic-only.
  const safetyOverrides = Object.freeze({ ...resolveVariantsConfig(variants) });
  const deterministicOverrides = Object.freeze({ ...resolveDeterministicVariantsConfig(variants) });
  const configHash = hash(config);
  const strategyHash = hash({ variants, safetyOverrides, deterministicOverrides });
  const restartHash = hash(restartSurface(config));

  return Object.freeze({
    config,
    variants,
    safetyOverrides,
    deterministicOverrides,
    configHash,
    strategyHash,
    restartHash,
  });
}

export function compileRuntimeStrategyFile(path: string): CompiledRuntimeStrategy {
  return compileRuntimeStrategy(loadRuntimeConfig(path));
}

/**
 * The current live-reload contract intentionally supports only `variants`.
 * Any other config change must go through an immutable release restart so we never claim a partial
 * reload for writer ownership, model/runtime, deadlines, policy orchestration or filesystem roots.
 */
export function hotReloadCompatibility(
  active: TenantRuntimeConfig,
  candidate: TenantRuntimeConfig,
): HotReloadCompatibility {
  const keys = new Set([...Object.keys(active), ...Object.keys(candidate)]);
  keys.delete("variants");
  const activeRecord = active as unknown as Record<string, unknown>;
  const candidateRecord = candidate as unknown as Record<string, unknown>;
  const restartRequiredFields = [...keys]
    .filter((key) => comparableHash(activeRecord[key]) !== comparableHash(candidateRecord[key]))
    .sort();
  const activeVariants = active.variants ?? [];
  const candidateVariants = candidate.variants ?? [];
  const variantsChanged = hash(activeVariants) !== hash(candidateVariants);
  return Object.freeze({
    compatible: restartRequiredFields.length === 0,
    restartRequiredFields: Object.freeze(restartRequiredFields),
    variantsChanged,
  });
}
