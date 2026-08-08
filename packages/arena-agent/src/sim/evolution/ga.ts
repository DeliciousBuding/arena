/**
 * Deterministic GA/search kernel learned from arena-evolve, but simulator-agnostic.
 *
 * Features intentionally brought over:
 * - elite preservation + tournament selection + crossover/mutation;
 * - warm-start population;
 * - per-(genome,seed) cache;
 * - optional first-seed prescreen;
 * - risk-adjusted selection mean-lambda*std;
 * - fixed holdout seeds for cross-generation comparison;
 * - rolling seed pools to reduce memorization of one training set.
 */

import { mulberry32 } from "../deterministic/rng.ts";
import { compareCodeUnit } from "../deterministic/uuid.ts";
import { summarizeRisk, type RiskSummary } from "./risk.ts";

export interface GenomeOps<G> {
  readonly hash: (genome: G) => string;
  readonly random: (random: () => number) => G;
  readonly warmStart?: (random: () => number) => G;
  readonly crossover: (left: G, right: G, random: () => number) => G;
  readonly mutate: (genome: G, random: () => number) => G;
}

export interface SeedEvaluation<D = unknown> {
  readonly score: number;
  readonly detail?: D;
}

export type SeedEvaluator<G, D = unknown> = (genome: G, seed: number) => SeedEvaluation<D>;

export interface EvolutionConfig {
  readonly populationSize?: number;
  readonly elites?: number;
  readonly tournamentSize?: number;
  readonly crossoverRate?: number;
  /** Probability that an offspring is passed through ops.mutate. */
  readonly mutationPopulationRate?: number;
  readonly generations?: number;
  readonly randomSeed?: number;
  readonly trainingSeeds: readonly number[];
  readonly holdoutSeeds?: readonly number[];
  readonly riskLambda?: number;
  /** 0 disables. Otherwise all candidates run seed[0], only this fraction gets the remaining seeds. */
  readonly prescreenFraction?: number;
  /** Optional rolling pool. Each generation uses a deterministic window from this pool. */
  readonly rollingSeedPool?: readonly number[];
  readonly rollingSeedsPerGeneration?: number;
  /** Keep a seed window stable for N generations before rolling. Default 1. */
  readonly seedRolloverGenerations?: number;
  /** Early stop on holdout if present, otherwise training riskAdjusted. */
  readonly patience?: number;
}

export interface EvaluatedGenome<G> {
  readonly genome: G;
  readonly hash: string;
  readonly training: RiskSummary;
  readonly trainingSeeds: readonly number[];
  readonly holdout: RiskSummary | null;
  readonly prescreened: boolean;
  /** False = stage-1-only prescreen loser; diagnostics kept, never selected. */
  readonly selectionEligible: boolean;
}

export interface EvolutionGeneration<G> {
  readonly generation: number;
  readonly trainingSeeds: readonly number[];
  readonly ranked: readonly EvaluatedGenome<G>[];
  readonly champion: EvaluatedGenome<G>;
}

export interface EvolutionResult<G> {
  readonly champion: EvaluatedGenome<G>;
  readonly history: readonly EvolutionGeneration<G>[];
  readonly cacheEntries: number;
  readonly stoppedEarly: boolean;
}

function uniqueSeeds(values: readonly number[], name: string): number[] {
  const out = [...new Set(values)];
  if (out.length === 0) throw new Error(`${name} requires at least one seed`);
  if (out.some((value) => !Number.isSafeInteger(value))) throw new Error(`${name} must contain safe integers`);
  return out;
}

function generationSeeds(config: EvolutionConfig, generation: number): number[] {
  if (config.rollingSeedPool === undefined || config.rollingSeedPool.length === 0) {
    return uniqueSeeds(config.trainingSeeds, "trainingSeeds");
  }
  const pool = uniqueSeeds(config.rollingSeedPool, "rollingSeedPool");
  const count = config.rollingSeedsPerGeneration ?? Math.min(config.trainingSeeds.length, pool.length);
  if (!Number.isSafeInteger(count) || count < 1 || count > pool.length) {
    throw new Error("rollingSeedsPerGeneration must be within rollingSeedPool size");
  }
  const rollover = config.seedRolloverGenerations ?? 1;
  if (!Number.isSafeInteger(rollover) || rollover < 1) throw new Error("seedRolloverGenerations must be >= 1");
  const batch = Math.floor(generation / rollover);
  const start = (batch * count) % pool.length;
  return Array.from({ length: count }, (_, index) => pool[(start + index) % pool.length]!).sort((a, b) => a - b);
}

function validateConfig(config: EvolutionConfig): Required<Pick<EvolutionConfig,
  "populationSize" | "elites" | "tournamentSize" | "crossoverRate" | "mutationPopulationRate" |
  "generations" | "randomSeed" | "riskLambda" | "prescreenFraction" | "patience">> {
  const resolved = {
    populationSize: config.populationSize ?? 24,
    elites: config.elites ?? 2,
    tournamentSize: config.tournamentSize ?? 3,
    crossoverRate: config.crossoverRate ?? 0.8,
    mutationPopulationRate: config.mutationPopulationRate ?? 0.4,
    generations: config.generations ?? 20,
    randomSeed: config.randomSeed ?? 0,
    riskLambda: config.riskLambda ?? 0,
    prescreenFraction: config.prescreenFraction ?? 0,
    patience: config.patience ?? 0,
  };
  if (!Number.isSafeInteger(resolved.populationSize) || resolved.populationSize < 2) throw new Error("populationSize >= 2 required");
  if (!Number.isSafeInteger(resolved.elites) || resolved.elites < 1 || resolved.elites >= resolved.populationSize) throw new Error("elites must be in [1,populationSize)");
  if (!Number.isSafeInteger(resolved.tournamentSize) || resolved.tournamentSize < 2) throw new Error("tournamentSize >= 2 required");
  if (!Number.isSafeInteger(resolved.generations) || resolved.generations < 1) throw new Error("generations >= 1 required");
  for (const [name, value] of [["crossoverRate", resolved.crossoverRate], ["mutationPopulationRate", resolved.mutationPopulationRate], ["prescreenFraction", resolved.prescreenFraction]] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be in [0,1]`);
  }
  if (!Number.isFinite(resolved.riskLambda) || resolved.riskLambda < 0) throw new Error("riskLambda >= 0 required");
  if (!Number.isSafeInteger(resolved.randomSeed)) throw new Error("randomSeed must be a safe integer");
  if (!Number.isSafeInteger(resolved.patience) || resolved.patience < 0) throw new Error("patience must be >= 0");
  uniqueSeeds(config.trainingSeeds, "trainingSeeds");
  const holdout = config.holdoutSeeds !== undefined && config.holdoutSeeds.length > 0
    ? uniqueSeeds(config.holdoutSeeds, "holdoutSeeds")
    : [];
  if (config.rollingSeedPool !== undefined && config.rollingSeedPool.length > 0 && holdout.length === 0) {
    throw new Error("rollingSeedPool requires independent holdoutSeeds for cross-generation selection");
  }
  const trainingUniverse = new Set(
    config.rollingSeedPool !== undefined && config.rollingSeedPool.length > 0
      ? uniqueSeeds(config.rollingSeedPool, "rollingSeedPool")
      : uniqueSeeds(config.trainingSeeds, "trainingSeeds"),
  );
  const overlap = holdout.filter((seed) => trainingUniverse.has(seed));
  if (overlap.length > 0) throw new Error(`holdoutSeeds overlap training seeds: ${overlap.join(",")}`);
  return resolved;
}

export function evolve<G, D = unknown>(
  ops: GenomeOps<G>,
  evaluator: SeedEvaluator<G, D>,
  config: EvolutionConfig,
): EvolutionResult<G> {
  const settings = validateConfig(config);
  const random = mulberry32(settings.randomSeed);
  const cache = new Map<string, SeedEvaluation<D>>();
  const evalSeed = (genome: G, seed: number): SeedEvaluation<D> => {
    const key = `${ops.hash(genome)}:${seed}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const result = evaluator(genome, seed);
    if (!Number.isFinite(result.score)) throw new Error(`non-finite fitness for ${key}`);
    cache.set(key, result);
    return result;
  };
  const aggregate = (genome: G, seeds: readonly number[]): RiskSummary =>
    summarizeRisk(seeds.map((seed) => evalSeed(genome, seed).score), settings.riskLambda);

  let population: G[] = Array.from({ length: settings.populationSize }, (_, index) =>
    index === 0 && ops.warmStart !== undefined ? ops.warmStart(random) :
      (ops.warmStart !== undefined ? ops.warmStart(random) : ops.random(random)));
  const history: EvolutionGeneration<G>[] = [];
  let overall: EvaluatedGenome<G> | null = null;
  let bestMetric = Number.NEGATIVE_INFINITY;
  let staleGenerations = 0;
  let stoppedEarly = false;

  for (let generation = 0; generation < settings.generations; generation += 1) {
    const seeds = generationSeeds(config, generation);
    const firstSeed = seeds[0]!;
    const firstScores = population.map((genome) => evalSeed(genome, firstSeed).score);
    let fullyEvaluated = new Set<number>(population.map((_g, index) => index));
    if (settings.prescreenFraction > 0 && seeds.length > 1 && population.length > 2) {
      const keep = Math.max(2, Math.round(population.length * settings.prescreenFraction));
      const order = population.map((_g, index) => index).sort((a, b) => firstScores[b]! - firstScores[a]! || a - b);
      fullyEvaluated = new Set(order.slice(0, keep));
    }

    const evaluated = population.map((genome, index): EvaluatedGenome<G> => {
      const usedSeeds = fullyEvaluated.has(index) ? seeds : [firstSeed];
      const training = aggregate(genome, usedSeeds);
      const selectionEligible = usedSeeds.length === seeds.length;
      return Object.freeze({
        genome,
        hash: ops.hash(genome),
        training,
        trainingSeeds: Object.freeze([...usedSeeds]),
        holdout: null,
        prescreened: !selectionEligible,
        selectionEligible,
      });
    });
    evaluated.sort((a, b) =>
      Number(b.selectionEligible) - Number(a.selectionEligible) ||
      b.training.riskAdjusted - a.training.riskAdjusted ||
      compareCodeUnit(a.hash, b.hash));
    const selectionPool = evaluated.filter((entry) => entry.selectionEligible);
    if (selectionPool.length < 2) throw new Error("prescreen must leave at least two selection-eligible genomes");

    let champion = selectionPool[0]!;
    const holdoutSeeds = config.holdoutSeeds === undefined || config.holdoutSeeds.length === 0
      ? []
      : uniqueSeeds(config.holdoutSeeds, "holdoutSeeds");
    if (holdoutSeeds.length > 0) {
      const championIndex = evaluated.indexOf(champion);
      champion = Object.freeze({ ...champion, holdout: aggregate(champion.genome, holdoutSeeds) });
      evaluated[championIndex] = champion;
    }
    const metric = champion.holdout?.riskAdjusted ?? champion.training.riskAdjusted;
    if (metric > bestMetric) {
      bestMetric = metric;
      overall = champion;
      staleGenerations = 0;
    } else {
      staleGenerations += 1;
    }
    history.push(Object.freeze({
      generation,
      trainingSeeds: Object.freeze([...seeds]),
      ranked: Object.freeze([...evaluated]),
      champion,
    }));
    if (settings.patience > 0 && staleGenerations >= settings.patience) {
      stoppedEarly = true;
      break;
    }

    const tournamentPick = (): G => {
      let winner: EvaluatedGenome<G> | null = null;
      for (let draw = 0; draw < settings.tournamentSize; draw += 1) {
        const candidate = selectionPool[Math.floor(random() * selectionPool.length)]!;
        if (winner === null || candidate.training.riskAdjusted > winner.training.riskAdjusted ||
            (candidate.training.riskAdjusted === winner.training.riskAdjusted && candidate.hash < winner.hash)) {
          winner = candidate;
        }
      }
      return winner!.genome;
    };
    const next = selectionPool.slice(0, settings.elites).map((entry) => entry.genome);
    while (next.length < settings.populationSize) {
      const left = tournamentPick();
      const right = tournamentPick();
      let child = random() < settings.crossoverRate ? ops.crossover(left, right, random) : left;
      if (random() < settings.mutationPopulationRate) child = ops.mutate(child, random);
      next.push(child);
    }
    population = next;
  }

  if (overall === null) throw new Error("evolution produced no champion");
  return Object.freeze({
    champion: overall,
    history: Object.freeze(history),
    cacheEntries: cache.size,
    stoppedEarly,
  });
}
