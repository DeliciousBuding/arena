/**
 * Evolution v1 search space for strategic policy.
 *
 * Deliberately excludes focusRegion: absolute/scene-specific coordinates are a
 * classic simulator-overfit channel. Spatial intent stays with candidate/Q
 * search and survey-aware decision logic; GA v1 optimizes transferable knobs.
 */

import { createHash } from "node:crypto";
import {
  DEFAULT_MACRO_POLICY,
  serializeMacroPolicy,
  type AttackPriority,
  type MacroPolicy,
  type PolicyPosture,
} from "../../runtime/macro-policy.ts";

export interface MacroPolicySearchDomain {
  readonly workerTargetMin: number;
  readonly workerTargetMax: number;
  readonly militaryRatioMin: number;
  readonly militaryRatioMax: number;
  readonly militaryRatioStep: number;
  readonly postures: readonly PolicyPosture[];
  readonly attackPriorities: readonly AttackPriority[];
}

export const DEFAULT_MACRO_POLICY_SEARCH_DOMAIN: MacroPolicySearchDomain = Object.freeze({
  workerTargetMin: 4,
  workerTargetMax: 16,
  militaryRatioMin: 0,
  militaryRatioMax: 0.8,
  militaryRatioStep: 0.05,
  postures: Object.freeze(["harvest", "balanced", "aggressive"] as const),
  attackPriorities: Object.freeze([null, "workers", "core"] as const),
});

export type RandomSource = () => number;

function pick<T>(values: readonly T[], random: RandomSource): T {
  if (values.length === 0) throw new Error("cannot pick from empty domain");
  return values[Math.min(values.length - 1, Math.floor(random() * values.length))]!;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function snapRatio(value: number, domain: MacroPolicySearchDomain): number {
  const clipped = clamp(value, domain.militaryRatioMin, domain.militaryRatioMax);
  const steps = Math.round((clipped - domain.militaryRatioMin) / domain.militaryRatioStep);
  return Math.round((domain.militaryRatioMin + steps * domain.militaryRatioStep) * 1e6) / 1e6;
}

export function validateMacroPolicySearchDomain(domain: MacroPolicySearchDomain): void {
  if (!Number.isSafeInteger(domain.workerTargetMin) || !Number.isSafeInteger(domain.workerTargetMax) ||
      domain.workerTargetMin < 1 || domain.workerTargetMin > domain.workerTargetMax) {
    throw new Error("invalid workerTarget search bounds");
  }
  if (!Number.isFinite(domain.militaryRatioMin) || !Number.isFinite(domain.militaryRatioMax) ||
      domain.militaryRatioMin < 0 || domain.militaryRatioMax > 1 ||
      domain.militaryRatioMin > domain.militaryRatioMax || !Number.isFinite(domain.militaryRatioStep) ||
      domain.militaryRatioStep <= 0) {
    throw new Error("invalid militaryRatio search bounds");
  }
  if (domain.postures.length === 0 || domain.attackPriorities.length === 0) {
    throw new Error("categorical search domains must be non-empty");
  }
}

export function normalizeSearchPolicy(
  policy: MacroPolicy,
  domain: MacroPolicySearchDomain = DEFAULT_MACRO_POLICY_SEARCH_DOMAIN,
): MacroPolicy {
  validateMacroPolicySearchDomain(domain);
  const posture = domain.postures.includes(policy.posture) ? policy.posture : domain.postures[0]!;
  const attackPriority = domain.attackPriorities.includes(policy.attackPriority)
    ? policy.attackPriority
    : domain.attackPriorities[0]!;
  return Object.freeze({
    posture,
    workerTarget: Math.round(clamp(policy.workerTarget, domain.workerTargetMin, domain.workerTargetMax)),
    militaryRatio: snapRatio(policy.militaryRatio, domain),
    focusRegion: null,
    attackPriority,
  });
}

export function randomSearchPolicy(
  random: RandomSource,
  domain: MacroPolicySearchDomain = DEFAULT_MACRO_POLICY_SEARCH_DOMAIN,
): MacroPolicy {
  validateMacroPolicySearchDomain(domain);
  const workerSpan = domain.workerTargetMax - domain.workerTargetMin + 1;
  const ratioSteps = Math.floor((domain.militaryRatioMax - domain.militaryRatioMin) / domain.militaryRatioStep + 1e-9) + 1;
  return Object.freeze({
    posture: pick(domain.postures, random),
    workerTarget: domain.workerTargetMin + Math.min(workerSpan - 1, Math.floor(random() * workerSpan)),
    militaryRatio: snapRatio(
      domain.militaryRatioMin + Math.min(ratioSteps - 1, Math.floor(random() * ratioSteps)) * domain.militaryRatioStep,
      domain,
    ),
    focusRegion: null,
    attackPriority: pick(domain.attackPriorities, random),
  });
}

export function crossoverSearchPolicy(
  left: MacroPolicy,
  right: MacroPolicy,
  random: RandomSource,
  domain: MacroPolicySearchDomain = DEFAULT_MACRO_POLICY_SEARCH_DOMAIN,
): MacroPolicy {
  return normalizeSearchPolicy({
    posture: random() < 0.5 ? left.posture : right.posture,
    workerTarget: random() < 0.5 ? left.workerTarget : right.workerTarget,
    militaryRatio: random() < 0.5 ? left.militaryRatio : right.militaryRatio,
    focusRegion: null,
    attackPriority: random() < 0.5 ? left.attackPriority : right.attackPriority,
  }, domain);
}

export function mutateSearchPolicy(
  policy: MacroPolicy,
  random: RandomSource,
  options: {
    readonly geneRate?: number;
    readonly numericSigma?: number;
    readonly domain?: MacroPolicySearchDomain;
  } = {},
): MacroPolicy {
  const domain = options.domain ?? DEFAULT_MACRO_POLICY_SEARCH_DOMAIN;
  validateMacroPolicySearchDomain(domain);
  const geneRate = options.geneRate ?? 0.12;
  const sigma = options.numericSigma ?? 0.15;
  if (!Number.isFinite(geneRate) || geneRate < 0 || geneRate > 1) throw new Error("geneRate must be in [0,1]");
  if (!Number.isFinite(sigma) || sigma < 0) throw new Error("numericSigma must be >= 0");
  const workerSpan = Math.max(1, domain.workerTargetMax - domain.workerTargetMin);
  const ratioSpan = Math.max(domain.militaryRatioStep, domain.militaryRatioMax - domain.militaryRatioMin);
  const signed = () => random() * 2 - 1;
  return normalizeSearchPolicy({
    posture: random() < geneRate ? pick(domain.postures, random) : policy.posture,
    workerTarget: random() < geneRate
      ? policy.workerTarget + Math.round(signed() * workerSpan * sigma)
      : policy.workerTarget,
    militaryRatio: random() < geneRate
      ? policy.militaryRatio + signed() * ratioSpan * sigma
      : policy.militaryRatio,
    focusRegion: null,
    attackPriority: random() < geneRate ? pick(domain.attackPriorities, random) : policy.attackPriority,
  }, domain);
}

/** arena-evolve-style warm start: baseline plus bounded perturbations, no spatial genes. */
export function warmStartSearchPolicy(
  baseline: MacroPolicy = DEFAULT_MACRO_POLICY,
  random: RandomSource,
  domain: MacroPolicySearchDomain = DEFAULT_MACRO_POLICY_SEARCH_DOMAIN,
  perturbation = 0.15,
): MacroPolicy {
  return mutateSearchPolicy(normalizeSearchPolicy(baseline, domain), random, {
    domain,
    // Mirror arena-evolve's warm-start spirit: perturb around a known-good
    // baseline instead of randomizing every categorical gene.
    geneRate: 0.4,
    numericSigma: perturbation,
  });
}

export function macroPolicyGenomeHash(policy: MacroPolicy): string {
  return createHash("sha256").update(serializeMacroPolicy(normalizeSearchPolicy(policy))).digest("hex");
}
