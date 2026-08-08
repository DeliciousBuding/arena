/**
 * MacroPolicy fitness adapter over the official-semantics tournament/FFA stack.
 *
 * v1 is intentionally small and auditable: survival + winner + relative
 * resources/population. Rich event-ledger objectives can extend the detail
 * without changing the GA kernel.
 */

import type { Plan, TickState } from "../../domain/model.ts";
import { DeterministicPlanner } from "../../planning/deterministic-planner.ts";
import type { PlanProvider } from "../../runtime/decision-types.ts";
import type { MacroPolicy } from "../../runtime/macro-policy.ts";
import {
  FitnessLedgerCollector,
  type EventLedgerFitnessDetail,
  type EventLedgerFitnessWeights,
} from "../opponent/fitness.ts";
import { opponentEntry, type OpponentSpec } from "../opponent/registry.ts";
import {
  liveMixedSpawnProfiles,
  makeGeneratedArenaScenarioN,
  makeArenaScenarioN,
  rotateEntriesForSubject,
  runFreeForAll,
  type MatchResult,
  type TournEntry,
} from "../opponent/tournament.ts";

export interface TournamentFitnessWeights {
  readonly survival: number;
  readonly win: number;
  readonly resourceMargin: number;
  readonly populationMargin: number;
  readonly finalResources: number;
  readonly finalPopulation: number;
}

export const DEFAULT_TOURNAMENT_FITNESS_WEIGHTS: TournamentFitnessWeights = Object.freeze({
  survival: 100,
  win: 40,
  resourceMargin: 1,
  populationMargin: 3,
  finalResources: 0.25,
  finalPopulation: 0.5,
});

export interface TournamentFitnessDetail {
  readonly subjectId: string;
  readonly coreAlive: boolean;
  readonly winner: boolean;
  readonly finalResources: number;
  readonly finalPopulation: number;
  readonly meanOpponentResources: number;
  readonly meanOpponentPopulation: number;
  readonly resourceMargin: number;
  readonly populationMargin: number;
  readonly score: number;
  readonly match: MatchResult;
}

export interface MacroPolicyTournamentFitnessOptions {
  readonly rulesPath: string;
  readonly ticks: number;
  /** Registry opponents (Python/HTTP) and/or in-process tournament entries. */
  readonly opponents: readonly (OpponentSpec | TournEntry)[];
  readonly subjectId?: string;
  readonly validatePlans?: boolean;
  /** Legacy terminal-margin weights; only used when fitnessMode="legacy". */
  readonly weights?: TournamentFitnessWeights;
  /** GA/search defaults to the richer W51 event ledger; legacy keeps historical KPI semantics. */
  readonly fitnessMode?: "event-ledger" | "legacy";
  readonly eventLedgerWeights?: EventLedgerFitnessWeights;
  /** W54: default true for search fairness; false only for historical reproduction. */
  readonly rotateSubjectSlot?: boolean;
  /** W54 birth-state distribution. uniform keeps official-newborn starts. */
  readonly spawnProfileMode?: "uniform" | "live-mixed";
  readonly liveMixedRadius?: number;
  /** W53: fixed keeps legacy six layouts; generated-survey samples calibrated chunk terrain. */
  readonly terrainMode?: "fixed" | "generated-survey";
  readonly refillEveryTicks?: number | null;
}

export interface MacroPolicyTournamentFitnessDetail extends TournamentFitnessDetail {
  readonly fitnessMode: "event-ledger" | "legacy";
  readonly legacyScore: number;
  readonly ledger: EventLedgerFitnessDetail | null;
}

class PolicyBoundPlanner implements PlanProvider {
  private readonly planner = new DeterministicPlanner();
  private readonly policy: MacroPolicy;

  constructor(policy: MacroPolicy) {
    this.policy = policy;
  }

  decide(input: { readonly state: TickState; readonly policy?: MacroPolicy }): Plan {
    return this.planner.decide({ state: input.state, policy: this.policy });
  }
}

export function macroPolicyEntry(id: string, policy: MacroPolicy): TournEntry {
  return Object.freeze({
    id,
    desc: `macro-policy ${JSON.stringify(policy)}`,
    build: () => new PolicyBoundPlanner(policy),
  });
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function scoreTournamentMatch(
  match: MatchResult,
  subjectId: string,
  weights: TournamentFitnessWeights = DEFAULT_TOURNAMENT_FITNESS_WEIGHTS,
): TournamentFitnessDetail {
  if (!match.players.includes(subjectId)) throw new Error(`fitness subject ${subjectId} is not in match`);
  const opponents = match.players.filter((id) => id !== subjectId);
  const finalResources = match.finalResources[subjectId] ?? 0;
  const finalPopulation = match.finalPopulation[subjectId] ?? 0;
  const meanOpponentResources = mean(opponents.map((id) => match.finalResources[id] ?? 0));
  const meanOpponentPopulation = mean(opponents.map((id) => match.finalPopulation[id] ?? 0));
  const resourceMargin = finalResources - meanOpponentResources;
  const populationMargin = finalPopulation - meanOpponentPopulation;
  const coreAlive = match.coreAlive[subjectId] === true;
  const winner = match.winner === subjectId;
  const score =
    (coreAlive ? weights.survival : 0) +
    (winner ? weights.win : 0) +
    resourceMargin * weights.resourceMargin +
    populationMargin * weights.populationMargin +
    finalResources * weights.finalResources +
    finalPopulation * weights.finalPopulation;
  return Object.freeze({
    subjectId,
    coreAlive,
    winner,
    finalResources,
    finalPopulation,
    meanOpponentResources,
    meanOpponentPopulation,
    resourceMargin,
    populationMargin,
    score,
    match,
  });
}

export function evaluateMacroPolicyTournament(
  policy: MacroPolicy,
  seed: number,
  options: MacroPolicyTournamentFitnessOptions,
): { readonly score: number; readonly detail: MacroPolicyTournamentFitnessDetail } {
  const subjectId = options.subjectId ?? "evolve-candidate";
  if (options.opponents.length === 0) throw new Error("macro-policy tournament fitness requires at least one opponent");
  const opponents = options.opponents.map((spec) => "build" in spec ? spec : opponentEntry(spec, seed));
  if (opponents.some((entry) => entry.id === subjectId)) throw new Error(`subjectId collides with opponent: ${subjectId}`);
  const logicalEntries = [macroPolicyEntry(subjectId, policy), ...opponents];
  const entries = options.rotateSubjectSlot === false
    ? logicalEntries
    : rotateEntriesForSubject(logicalEntries, subjectId, seed);
  const spawnProfileMode = options.spawnProfileMode ?? "uniform";
  const profiles = spawnProfileMode === "live-mixed"
    ? liveMixedSpawnProfiles(subjectId, opponents.map((entry) => entry.id))
    : undefined;
  const radius = spawnProfileMode === "live-mixed" ? options.liveMixedRadius ?? 50 : undefined;
  const terrainMode = options.terrainMode ?? "fixed";
  const scenario = terrainMode === "generated-survey"
    ? makeGeneratedArenaScenarioN(entries, seed, { radius, spawnProfiles: profiles })
    : spawnProfileMode === "live-mixed"
      ? makeArenaScenarioN(entries, seed, { radius, spawnProfiles: profiles })
      : undefined;
  const fitnessMode = options.fitnessMode ?? "event-ledger";
  const ledgerCollector = fitnessMode === "event-ledger" ? new FitnessLedgerCollector() : null;
  const match = runFreeForAll(
    entries,
    seed,
    options.ticks,
    options.rulesPath,
    {
      validatePlans: options.validatePlans ?? true,
      refillEveryTicks: options.refillEveryTicks,
      observer: ledgerCollector ?? undefined,
      scenario,
    },
  );
  const legacy = scoreTournamentMatch(match, subjectId, options.weights);
  ledgerCollector?.finalize(match);
  const ledger = ledgerCollector?.detail(subjectId) ?? null;
  const score =
    fitnessMode === "event-ledger"
      ? ledgerCollector!.score(subjectId, options.ticks, options.eventLedgerWeights)
      : legacy.score;
  const detail: MacroPolicyTournamentFitnessDetail = Object.freeze({
    ...legacy,
    score,
    fitnessMode,
    legacyScore: legacy.score,
    ledger,
  });
  return Object.freeze({ score, detail });
}
