/** Evolution v1: deterministic GA + MacroPolicy search-space + tournament fitness. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_MACRO_POLICY } from "../src/runtime/macro-policy.ts";
import { mulberry32 } from "../src/sim/deterministic/rng.ts";
import { evolve, type GenomeOps } from "../src/sim/evolution/ga.ts";
import {
  crossoverSearchPolicy,
  macroPolicyGenomeHash,
  mutateSearchPolicy,
  normalizeSearchPolicy,
  randomSearchPolicy,
  warmStartSearchPolicy,
} from "../src/sim/evolution/macro-policy-genome.ts";
import { runMacroPolicyEvolution } from "../src/sim/evolution/macro-policy-search.ts";
import { sampleStd, summarizeRisk } from "../src/sim/evolution/risk.ts";
import {
  evaluateMacroPolicyTournament,
  scoreTournamentMatch,
} from "../src/sim/evolution/tournament-fitness.ts";
import { makeSafetyEntry, type MatchResult } from "../src/sim/opponent/tournament.ts";

const RULES = "src/sim/contracts/rules-v0.14.json";

test("evolution risk: sample std + mean-lambda*std + lower tail", () => {
  assert.equal(sampleStd([10]), 0);
  assert.ok(Math.abs(sampleStd([1, 2, 3]) - 1) < 1e-12);
  const summary = summarizeRisk([1, 2, 3, 10], 0.5);
  assert.equal(summary.mean, 4);
  assert.equal(summary.worst, 1);
  assert.equal(summary.p10, 1);
  assert.equal(summary.riskAdjusted, summary.mean - 0.5 * summary.std);
});

test("MacroPolicy genome stays bounded, translation-free and deterministic", () => {
  const aRng = mulberry32(42);
  const bRng = mulberry32(42);
  const a = Array.from({ length: 20 }, () => randomSearchPolicy(aRng));
  const b = Array.from({ length: 20 }, () => randomSearchPolicy(bRng));
  assert.deepEqual(a, b);
  for (const policy of a) {
    assert.equal(policy.focusRegion, null, "v1 GA must not evolve absolute spatial focus");
    assert.ok(policy.workerTarget >= 4 && policy.workerTarget <= 16);
    assert.ok(policy.militaryRatio >= 0 && policy.militaryRatio <= 0.8);
    assert.equal(Math.round(policy.militaryRatio * 20), policy.militaryRatio * 20);
  }

  const random = mulberry32(7);
  const warm = warmStartSearchPolicy(DEFAULT_MACRO_POLICY, random);
  const mutated = mutateSearchPolicy(warm, random, { geneRate: 1 });
  const crossed = crossoverSearchPolicy(warm, mutated, random);
  for (const policy of [warm, mutated, crossed]) {
    assert.deepEqual(policy, normalizeSearchPolicy(policy));
    assert.match(macroPolicyGenomeHash(policy), /^[0-9a-f]{64}$/u);
  }
});

test("GA: cache + holdout + rolling seeds are deterministic", () => {
  let callsA = 0;
  const ops: GenomeOps<number> = {
    hash: (value) => String(value),
    random: () => 7,
    warmStart: () => 7,
    crossover: (left) => left,
    mutate: (value) => value,
  };
  const config = {
    populationSize: 4,
    elites: 1,
    tournamentSize: 2,
    generations: 3,
    randomSeed: 99,
    trainingSeeds: [1, 2],
    rollingSeedPool: [1, 2, 4, 5],
    rollingSeedsPerGeneration: 2,
    holdoutSeeds: [9],
    riskLambda: 0.25,
    prescreenFraction: 0.5,
  } as const;
  const a = evolve(ops, (genome, seed) => {
    callsA += 1;
    return { score: 100 - Math.abs(genome - 7) + seed / 1000 };
  }, config);
  let callsB = 0;
  const b = evolve(ops, (genome, seed) => {
    callsB += 1;
    return { score: 100 - Math.abs(genome - 7) + seed / 1000 };
  }, config);
  assert.deepEqual(a, b);
  assert.equal(callsA, callsB);
  assert.deepEqual(a.history.map((generation) => generation.trainingSeeds), [[1, 2], [4, 5], [1, 2]]);
  // One genome only: rolling training unique seeds {1,2,4,5} + holdout {9}.
  assert.equal(a.cacheEntries, 5);
  assert.equal(callsA, 5);
  assert.ok(a.champion.holdout !== null);
});

test("GA: rolling seeds require a disjoint holdout", () => {
  const ops: GenomeOps<number> = {
    hash: String,
    random: () => 1,
    crossover: (left) => left,
    mutate: (value) => value,
  };
  assert.throws(() => evolve(ops, (value) => ({ score: value }), {
    populationSize: 3,
    elites: 1,
    tournamentSize: 2,
    generations: 1,
    trainingSeeds: [1, 2],
    rollingSeedPool: [1, 2, 3, 4],
  }), /requires independent holdoutSeeds/u);
  assert.throws(() => evolve(ops, (value) => ({ score: value }), {
    populationSize: 3,
    elites: 1,
    tournamentSize: 2,
    generations: 1,
    trainingSeeds: [1, 2],
    holdoutSeeds: [2, 9],
  }), /overlap training seeds/u);
});

test("tournament fitness scores relative resources/population and runs through FFA", () => {
  const synthetic: MatchResult = {
    players: ["subject", "other"],
    winner: "subject",
    tick: 0,
    tickCount: 10,
    coreAlive: { subject: true, other: true },
    finalResources: { subject: 20, other: 10 },
    finalPopulation: { subject: 5, other: 3 },
    eventCount: 1,
  };
  const scored = scoreTournamentMatch(synthetic, "subject");
  assert.equal(scored.resourceMargin, 10);
  assert.equal(scored.populationMargin, 2);
  assert.ok(scored.score > 100);

  const evaluated = evaluateMacroPolicyTournament(DEFAULT_MACRO_POLICY, 3, {
    rulesPath: RULES,
    ticks: 12,
    opponents: [makeSafetyEntry("baseline")],
    subjectId: "candidate",
    validatePlans: true,
  });
  assert.ok(Number.isFinite(evaluated.score));
  assert.equal(evaluated.detail.fitnessMode, "event-ledger");
  assert.ok(evaluated.detail.ledger !== null);
  assert.ok(evaluated.detail.ledger!.aliveTicks > 0);
  assert.ok(Number.isFinite(evaluated.detail.legacyScore));
  assert.equal(evaluated.detail.match.tickCount, 12);
  assert.deepEqual([...evaluated.detail.match.players].sort(), ["baseline", "candidate"]);
  assert.equal(evaluated.detail.match.players[3 % 2], "candidate");

  const legacyEvaluated = evaluateMacroPolicyTournament(DEFAULT_MACRO_POLICY, 3, {
    rulesPath: RULES,
    ticks: 12,
    opponents: [makeSafetyEntry("baseline")],
    subjectId: "candidate",
    validatePlans: true,
    fitnessMode: "legacy",
  });
  assert.equal(legacyEvaluated.detail.fitnessMode, "legacy");
  assert.equal(legacyEvaluated.detail.ledger, null);
  assert.equal(legacyEvaluated.score, legacyEvaluated.detail.legacyScore);
});

test("MacroPolicy evolution runs end-to-end on the official tournament stack", () => {
  const result = runMacroPolicyEvolution({
    evolution: {
      populationSize: 4,
      elites: 1,
      tournamentSize: 2,
      generations: 2,
      randomSeed: 123,
      trainingSeeds: [1, 2],
      holdoutSeeds: [9],
      riskLambda: 0.1,
      prescreenFraction: 0.5,
    },
    tournament: {
      rulesPath: RULES,
      ticks: 12,
      opponents: [makeSafetyEntry("baseline")],
      subjectId: "candidate",
      validatePlans: true,
    },
  });
  assert.equal(result.history.length, 2);
  assert.ok(result.champion.holdout !== null);
  assert.equal(result.champion.genome.focusRegion, null);
  assert.ok(result.cacheEntries > 0);
});
