/**
 * W49 production strategy parameter contract for the current rules version.
 *
 * This is not a generic clamp layer. Stale/out-of-contract values fail closed
 * during strategy compilation so an old result file cannot silently alter live
 * semantics after a rules upgrade. Expanding the domain requires an explicit
 * code + test change tied to the rules version.
 */

import type { TenantRuntimeConfig } from "./runtime-config.ts";
import { DEFAULT_SAFETY_CONFIG, type SafetyPlannerConfig } from "../strategies/safety-planner-config.ts";
import type { DeterministicVariantConfig } from "../strategies/variant-registry.ts";
import { PRODUCTION_RULES_VERSION } from "../domain/rules-version.ts";

const ALLOWED_POPULATION_CEILINGS = Object.freeze([20, 30, 35, 40] as const);

export interface FrozenStrategySurface {
  readonly config: TenantRuntimeConfig;
  readonly safetyOverrides: Readonly<Partial<SafetyPlannerConfig>>;
  readonly deterministicOverrides: Readonly<DeterministicVariantConfig>;
}

function fail(name: string, value: unknown, expected: string): never {
  throw new Error(`frozen parameter ${name}=${String(value)} violates ${PRODUCTION_RULES_VERSION} contract (${expected})`);
}

function exact(name: string, value: number, expected: number): void {
  if (value !== expected) fail(name, value, `expected ${expected}`);
}

/** Validate the effective production surface after registry overrides are merged. */
export function assertFrozenStrategyParameters(surface: FrozenStrategySurface): void {
  const safety: SafetyPlannerConfig = { ...DEFAULT_SAFETY_CONFIG, ...surface.safetyOverrides };

  // Stable base economics/guarding assumptions: no registered variant currently owns these.
  exact("reserveWealthy", safety.reserveWealthy, 3);
  exact("reserveEarly", safety.reserveEarly, 1);
  exact("wealthyThreshold", safety.wealthyThreshold, 10);
  exact("workerTarget(base)", safety.workerTarget, 8);
  exact("accumulateTarget", safety.accumulateTarget, 0);
  exact("guardResources", safety.guardResources, 30);
  exact("guardForce", safety.guardForce, 4);
  exact("maxFocusDistance", safety.maxFocusDistance, 32);

  if (!ALLOWED_POPULATION_CEILINGS.includes(safety.populationCeiling as (typeof ALLOWED_POPULATION_CEILINGS)[number])) {
    fail("populationCeiling", safety.populationCeiling, `allowed ${ALLOWED_POPULATION_CEILINGS.join("|")}`);
  }

  // MacroPolicy is intentionally tunable, but its production domain is frozen and fail-closed.
  const policy = surface.config.policyOverride;
  if (policy !== undefined) {
    if (!Number.isSafeInteger(policy.workerTarget) || policy.workerTarget < 1 || policy.workerTarget > 16) {
      fail("policyOverride.workerTarget", policy.workerTarget, "integer 1..16");
    }
    if (!Number.isFinite(policy.militaryRatio) || policy.militaryRatio < 0 || policy.militaryRatio > 1) {
      fail("policyOverride.militaryRatio", policy.militaryRatio, "finite 0..1");
    }
  }

  // Deterministic reserve has one current registered override (lean-spend=1);
  // undefined means planner default reserve=2. Any new value must be consciously admitted here.
  const reserve = surface.deterministicOverrides.spawnReserve;
  if (reserve !== undefined && reserve !== 1 && reserve !== 2) {
    fail("spawnReserve", reserve, "undefined(default=2)|1|2");
  }
}
