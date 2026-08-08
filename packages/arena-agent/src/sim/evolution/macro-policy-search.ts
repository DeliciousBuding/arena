/** High-level MacroPolicy evolution facade over the generic GA + tournament fitness. */

import {
  DEFAULT_MACRO_POLICY,
  type MacroPolicy,
} from "../../runtime/macro-policy.ts";
import {
  evolve,
  type EvolutionConfig,
  type EvolutionResult,
  type GenomeOps,
} from "./ga.ts";
import {
  crossoverSearchPolicy,
  DEFAULT_MACRO_POLICY_SEARCH_DOMAIN,
  macroPolicyGenomeHash,
  mutateSearchPolicy,
  randomSearchPolicy,
  warmStartSearchPolicy,
  type MacroPolicySearchDomain,
} from "./macro-policy-genome.ts";
import {
  evaluateMacroPolicyTournament,
  type MacroPolicyTournamentFitnessOptions,
  type TournamentFitnessDetail,
} from "./tournament-fitness.ts";

export interface MacroPolicyEvolutionOptions {
  readonly evolution: EvolutionConfig;
  readonly tournament: MacroPolicyTournamentFitnessOptions;
  readonly baseline?: MacroPolicy;
  readonly domain?: MacroPolicySearchDomain;
  readonly mutationGeneRate?: number;
  readonly mutationSigma?: number;
  readonly warmStartPerturbation?: number;
}

export function macroPolicyGenomeOps(options: {
  readonly baseline?: MacroPolicy;
  readonly domain?: MacroPolicySearchDomain;
  readonly mutationGeneRate?: number;
  readonly mutationSigma?: number;
  readonly warmStartPerturbation?: number;
} = {}): GenomeOps<MacroPolicy> {
  const baseline = options.baseline ?? DEFAULT_MACRO_POLICY;
  const domain = options.domain ?? DEFAULT_MACRO_POLICY_SEARCH_DOMAIN;
  const ops: GenomeOps<MacroPolicy> = {
    hash: macroPolicyGenomeHash,
    random: (random) => randomSearchPolicy(random, domain),
    warmStart: (random) => warmStartSearchPolicy(
      baseline,
      random,
      domain,
      options.warmStartPerturbation ?? 0.15,
    ),
    crossover: (left, right, random) => crossoverSearchPolicy(left, right, random, domain),
    mutate: (genome, random) => mutateSearchPolicy(genome, random, {
      domain,
      geneRate: options.mutationGeneRate ?? 0.12,
      numericSigma: options.mutationSigma ?? 0.15,
    }),
  };
  return Object.freeze(ops);
}

export function runMacroPolicyEvolution(
  options: MacroPolicyEvolutionOptions,
): EvolutionResult<MacroPolicy> {
  return evolve<MacroPolicy, TournamentFitnessDetail>(
    macroPolicyGenomeOps(options),
    (policy, seed) => evaluateMacroPolicyTournament(policy, seed, options.tournament),
    options.evolution,
  );
}
