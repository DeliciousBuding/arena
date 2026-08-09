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

  // 2026-08-10 动态参数化：四层产兵参数（P1 危机底线 / P2 高水位 / P3 硬顶）进入
  // 生产 config 表面后一律 fail-closed——undefined 走 planner 默认（黑与白 150 /
  // 守卫 8 / 起步门 4 / margin 15），显式值必须在已审查值域内，防意外数值上线。
  const highWater = surface.deterministicOverrides.resourceHighWater;
  if (highWater !== undefined && highWater !== 0 && (!Number.isSafeInteger(highWater) || highWater < 50 || highWater > 1000)) {
    fail("resourceHighWater", highWater, "undefined(default=150)|0(off)|integer 50..1000");
  }
  const milFloor = surface.deterministicOverrides.emergencyMilitaryFloor;
  if (milFloor !== undefined && (!Number.isSafeInteger(milFloor) || milFloor < 0 || milFloor > 32)) {
    fail("emergencyMilitaryFloor", milFloor, "undefined(default=8)|integer 0..32");
  }
  const vanguardTarget = surface.deterministicOverrides.emergencyVanguardTarget;
  if (vanguardTarget !== undefined && (!Number.isSafeInteger(vanguardTarget) || vanguardTarget < 0 || vanguardTarget > 16)) {
    fail("emergencyVanguardTarget", vanguardTarget, "undefined(default=4)|integer 0..16");
  }
  const workerGate = surface.deterministicOverrides.emergencyWorkerGate;
  if (workerGate !== undefined && (!Number.isSafeInteger(workerGate) || workerGate < 0 || workerGate > 16)) {
    fail("emergencyWorkerGate", workerGate, "undefined(default=4)|integer 0..16");
  }
  const margin = surface.deterministicOverrides.coreCapacityMargin;
  if (margin !== undefined && (!Number.isSafeInteger(margin) || margin < 0 || margin > 60)) {
    fail("coreCapacityMargin", margin, "undefined(default=15)|integer 0..60");
  }
}
