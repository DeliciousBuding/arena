/**
 * M2c.1 counterfactual rollout core.
 *
 * One real/synthetic decision point is forked across the SAME candidate set
 * and SAME environment seeds. Each (seed, candidate) runs once to max horizon;
 * h20/h32/h64 labels are read from the same trajectory prefix. This gives us
 * matched comparisons (common random numbers) rather than unrelated A/B noise.
 *
 * Important honesty boundary:
 * - `full-sim-world` means the caller supplied a complete SimWorld.
 * - `private-observation-completed` means hidden state was completed by an
 *   explicit belief/completion policy. This module never pretends a private
 *   PlayerState is a full world; provenance must carry the completion method.
 */

import { reduceTurn } from "../../domain/state-reducer.ts";
import type { MacroPolicy } from "../../runtime/macro-policy.ts";
import { loadRulesManifest } from "../../sim/contracts/rules-manifest.ts";
import { runEpisodeFromWorld, type EpisodeTenant } from "../../sim/harness/episode.ts";
import { simTurnLike } from "../../sim/visibility/visibility.ts";
import type { SimWorld } from "../../sim/world/types.ts";
import { compareCodeUnit } from "../../sim/deterministic/uuid.ts";
import { applyCandidateToMacroPolicy } from "../candidate/candidate-policy.ts";
import type { DecisionCandidateV1 } from "../candidate/decision-candidate-v1.ts";
import type { MacroDecisionPointV1 } from "../runtime/macro-decision-point.ts";
import {
  makeQSampleV1,
  SIM_UNKNOWN_EFFECT_KINDS,
  type InitialStateScope,
  type QSampleEvaluation,
  type QSampleV1,
  type SimContinuationPolicy,
  type SimUnknownEffectKind,
} from "../q-sample/q-sample-v1.ts";
import {
  extractFeatureVectorV2,
  featureVectorV2ToRecord,
  type FeatureV2Context,
} from "../schema/feature-vector-v2.ts";

export interface CounterfactualRolloutOptions {
  readonly decisionPoint: MacroDecisionPointV1;
  readonly tenantId: string;
  /** Complete world or explicitly completed belief world at the decision tick. */
  readonly initialWorld: SimWorld;
  readonly rulesPath: string;
  readonly scenarioSeeds: readonly number[];
  readonly horizons?: readonly number[];
  /** Strategy version that generated previousPolicy (e.g. safety/v1.0). */
  readonly behaviorPolicyVersion: string;
  readonly simulatorVersion: string;
  readonly certificateVersion: string;
  /** Registry identity or explicit belief-opponent identity. */
  readonly opponentId: string;
  readonly initialStateScope: InitialStateScope;
  readonly completionPolicy: string;
  readonly completionSeed: number | null;
  readonly completionAssumptions: readonly string[];
  /** Explicit caller-supplied confidence; provenance remains available for later reweighting. */
  readonly confidence: number;
  readonly featureContext: FeatureV2Context;
  /** Candidate is held for one macro interval, then baseline is restored by default. */
  readonly continuationPolicy?: SimContinuationPolicy;
  readonly refillEveryTicks?: number;
  readonly validatePlans?: boolean;
}

export interface CounterfactualRolloutStats {
  readonly trajectories: number;
  readonly evaluatedCandidates: number;
  readonly skippedCandidates: readonly string[];
  readonly horizons: readonly number[];
  readonly seeds: readonly number[];
}

export interface CounterfactualRolloutResult {
  readonly sample: QSampleV1;
  readonly stats: CounterfactualRolloutStats;
}

function normalizePositiveIntegers(values: readonly number[], name: string): number[] {
  const normalized = [...new Set(values)].sort((a, b) => a - b);
  if (normalized.length === 0 || normalized.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`${name} must contain positive safe integers`);
  }
  return normalized;
}

function normalizeSeeds(values: readonly number[]): number[] {
  const normalized = [...new Set(values)].sort((a, b) => a - b);
  if (normalized.length === 0 || normalized.some((value) => !Number.isSafeInteger(value))) {
    throw new Error("scenarioSeeds must contain safe integers");
  }
  return normalized;
}

function behaviorSnapshot(policy: MacroPolicy, policyVersion: string) {
  return Object.freeze({
    policyVersion,
    workerTarget: policy.workerTarget,
    militaryRatio: policy.militaryRatio,
    posture: policy.posture,
    focusRegion: policy.focusRegion === null ? null : `${policy.focusRegion[0]},${policy.focusRegion[1]}`,
    attackPriority: policy.attackPriority,
    note: null,
  });
}

function comparisonGroupId(options: {
  readonly seed: number;
  readonly opponentId: string;
  readonly initialStateScope: InitialStateScope;
  readonly completionPolicy: string;
  readonly completionSeed: number | null;
  readonly completionAssumptions: readonly string[];
  readonly continuationPolicy: SimContinuationPolicy;
}): string {
  return [
    "sim",
    `seed=${options.seed}`,
    `opp=${options.opponentId}`,
    `scope=${options.initialStateScope}`,
    `completion=${options.completionPolicy}`,
    `cseed=${options.completionSeed ?? "none"}`,
    `assumptions=${[...options.completionAssumptions].sort().join(",") || "none"}`,
    `continue=${options.continuationPolicy}`,
  ].join("|");
}

function initialTenants(world: SimWorld, tenantId: string, policy: MacroPolicy): EpisodeTenant[] {
  return [...world.players.keys()].sort(compareCodeUnit).map((id) =>
    id === tenantId
      ? { id, planner: "deterministic" as const, policy }
      : { id, planner: "deterministic" as const },
  );
}

function playerAt(world: SimWorld, tenantId: string) {
  const player = world.players.get(tenantId);
  if (player === undefined) throw new Error(`counterfactual: tenant ${tenantId} absent from world`);
  return player;
}

function outcomeAt(
  initialWorld: SimWorld,
  snapshots: readonly SimWorld[],
  tenantId: string,
  horizon: number,
): { readonly net: number; readonly deathProb: number; readonly coreRisk: 0 | 1 } {
  const initial = playerAt(initialWorld, tenantId);
  const atHorizon = snapshots[horizon - 1];
  if (atHorizon === undefined) throw new Error(`counterfactual: missing horizon snapshot ${horizon}`);
  const finalPlayer = playerAt(atHorizon, tenantId);
  const initialIds = new Set(initial.units.map((unit) => unit.id));
  const finalIds = new Set(finalPlayer.units.map((unit) => unit.id));
  const deaths = [...initialIds].filter((id) => !finalIds.has(id)).length;
  const deathProb = initialIds.size === 0 ? 0 : deaths / initialIds.size;
  const coreRisk = snapshots.slice(0, horizon).some((world) => {
    const player = playerAt(world, tenantId);
    return player.status === "RESPAWNING" || player.core === null || player.resources === 0;
  }) ? 1 : 0;
  return {
    net: finalPlayer.resources - initial.resources,
    deathProb,
    coreRisk,
  };
}

function unknownSummary(
  records: readonly {
    readonly unknownEffects: readonly { readonly tick: number; readonly kind: SimUnknownEffectKind }[];
  }[],
  horizon: number,
): {
  readonly count: number;
  readonly counts: Readonly<Record<SimUnknownEffectKind, number>>;
  readonly firstTick: number | null;
} {
  const effects = records.slice(0, horizon).flatMap((record) => record.unknownEffects);
  const counts = Object.fromEntries(SIM_UNKNOWN_EFFECT_KINDS.map((kind) => [kind, 0])) as Record<SimUnknownEffectKind, number>;
  for (const effect of effects) counts[effect.kind] += 1;
  return {
    count: effects.length,
    counts: Object.freeze(counts),
    firstTick: effects.length === 0 ? null : Math.min(...effects.map((effect) => effect.tick)),
  };
}

function candidatePolicy(
  previousPolicy: MacroPolicy,
  candidate: DecisionCandidateV1,
): MacroPolicy | null {
  if (candidate.legality !== "legal") return null;
  return applyCandidateToMacroPolicy(previousPolicy, candidate);
}

/**
 * Fork all policy-representable candidates from one decision point.
 *
 * `revert-baseline` implements a one-macro-decision Q-style intervention:
 * candidate for intervalTicks, then previousPolicy for the remaining horizon.
 * `hold-candidate` evaluates a commitment experiment instead and is recorded
 * explicitly in provenance so the two semantics can never be mixed silently.
 */
export function runCounterfactualRollouts(
  options: CounterfactualRolloutOptions,
): CounterfactualRolloutResult {
  if (!Number.isFinite(options.confidence) || options.confidence < 0 || options.confidence > 1) {
    throw new Error("counterfactual: confidence must be in [0,1]");
  }
  if (options.initialWorld.tick !== options.decisionPoint.tick) {
    throw new Error(
      `counterfactual: initialWorld.tick ${options.initialWorld.tick} != decisionPoint.tick ${options.decisionPoint.tick}`,
    );
  }
  if (options.initialStateScope === "full-sim-world" && options.completionPolicy !== "none") {
    throw new Error("counterfactual: full-sim-world requires completionPolicy=none");
  }
  if (options.initialStateScope === "full-sim-world" && options.completionSeed !== null) {
    throw new Error("counterfactual: full-sim-world requires completionSeed=null");
  }
  if (options.initialStateScope === "full-sim-world" && options.completionAssumptions.length !== 0) {
    throw new Error("counterfactual: full-sim-world requires no completion assumptions");
  }

  playerAt(options.initialWorld, options.tenantId);
  const seeds = normalizeSeeds(options.scenarioSeeds);
  const horizons = normalizePositiveIntegers(options.horizons ?? [20, 32, 64], "horizons");
  const maxHorizon = horizons[horizons.length - 1]!;
  const continuationPolicy = options.continuationPolicy ?? "revert-baseline";
  const rules = loadRulesManifest(options.rulesPath);
  if (rules.rulesVersion !== options.initialWorld.rulesVersion) {
    throw new Error(
      `counterfactual: world rules ${options.initialWorld.rulesVersion} != manifest ${rules.rulesVersion}`,
    );
  }

  const initialState = reduceTurn(simTurnLike(options.initialWorld, options.tenantId, rules, []));
  const features = featureVectorV2ToRecord(extractFeatureVectorV2(initialState, options.featureContext));
  const evaluations: QSampleEvaluation[] = [];
  const skippedCandidates: string[] = [];
  let trajectories = 0;
  let evaluatedCandidates = 0;

  for (const candidate of options.decisionPoint.candidates) {
    const policy = candidatePolicy(options.decisionPoint.previousPolicy, candidate);
    if (policy === null) {
      skippedCandidates.push(candidate.deterministicHash);
      continue;
    }
    evaluatedCandidates += 1;

    for (const seed of seeds) {
      const snapshots: SimWorld[] = [];
      const result = runEpisodeFromWorld({
        initialWorld: options.initialWorld,
        rulesPath: options.rulesPath,
        seed,
        ticks: maxHorizon,
        tenants: initialTenants(options.initialWorld, options.tenantId, options.decisionPoint.previousPolicy),
        policyProvider: (tenantId, tick) => {
          if (tenantId !== options.tenantId) return null;
          if (continuationPolicy === "hold-candidate") return policy;
          const elapsed = tick - options.initialWorld.tick;
          return elapsed < options.decisionPoint.intervalTicks
            ? policy
            : options.decisionPoint.previousPolicy;
        },
        refill: { everyTicks: options.refillEveryTicks ?? rules.rules.economy.refillEveryTicks },
        validatePlans: options.validatePlans ?? true,
        onTickRecorded: ({ after }) => snapshots.push(after),
      });
      trajectories += 1;

      for (const horizon of horizons) {
        const outcome = outcomeAt(options.initialWorld, snapshots, options.tenantId, horizon);
        const unknown = unknownSummary(result.records, horizon);
        const interventionTicks = continuationPolicy === "hold-candidate"
          ? horizon
          : Math.min(options.decisionPoint.intervalTicks, horizon);
        evaluations.push({
          candidateHash: candidate.deterministicHash,
          comparisonGroupId: comparisonGroupId({
            seed,
            opponentId: options.opponentId,
            initialStateScope: options.initialStateScope,
            completionPolicy: options.completionPolicy,
            completionSeed: options.completionSeed,
            completionAssumptions: options.completionAssumptions,
            continuationPolicy,
          }),
          label: {
            horizonTicks: horizon,
            outcome,
            source: "SIM",
            confidence: options.confidence,
            observed: false,
          },
          sim: {
            simulatorVersion: options.simulatorVersion,
            certificateVersion: options.certificateVersion,
            scenarioSeed: seed,
            opponentId: options.opponentId,
            initialStateScope: options.initialStateScope,
            completionPolicy: options.completionPolicy,
            completionSeed: options.completionSeed,
            completionAssumptions: Object.freeze([...options.completionAssumptions]),
            interventionTicks,
            continuationPolicy,
            rolloutHorizon: horizon,
            unknownEffectCount: unknown.count,
            unknownEffectCounts: unknown.counts,
            firstUnknownTick: unknown.firstTick,
            terminatedByUnknown: false,
          },
        });
      }
    }
  }

  if (evaluations.length === 0) {
    throw new Error("counterfactual: no candidate is representable by the current MacroPolicy executor");
  }

  const sample = makeQSampleV1({
    decisionPointId: options.decisionPoint.decisionPointId,
    processRunId: options.decisionPoint.processRunId,
    tenantId: options.tenantId,
    tick: options.decisionPoint.tick,
    features,
    behaviorPolicy: behaviorSnapshot(options.decisionPoint.previousPolicy, options.behaviorPolicyVersion),
    candidateSet: options.decisionPoint.candidates,
    evaluations,
  });

  return Object.freeze({
    sample,
    stats: Object.freeze({
      trajectories,
      evaluatedCandidates,
      skippedCandidates: Object.freeze([...skippedCandidates]),
      horizons: Object.freeze([...horizons]),
      seeds: Object.freeze([...seeds]),
    }),
  });
}
