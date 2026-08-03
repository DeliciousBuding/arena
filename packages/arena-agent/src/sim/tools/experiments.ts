/** Episode summaries, A/B comparison and throughput benchmark (S9). */

import { performance } from "node:perf_hooks";
import { compareCodeUnit } from "../deterministic/uuid.ts";
import { runEpisode, type EpisodeConfig, type EpisodeResult, type PlannerKind } from "../harness/episode.ts";
import { worldFromScenario } from "../world/loaders.ts";
import { sha256Json } from "./artifacts.ts";

export interface PlayerEpisodeSummary {
  readonly playerId: string;
  readonly initialResources: number;
  readonly finalResources: number;
  readonly resourceDelta: number;
  readonly initialPopulation: number;
  readonly finalPopulation: number;
}

export interface EpisodeSemanticSummary {
  readonly schema: "sim.episode-summary.v1";
  readonly ticks: number;
  readonly seed: number;
  readonly finalWorldHash: string;
  readonly players: readonly PlayerEpisodeSummary[];
  readonly totalResourceDelta: number;
  readonly totalFinalPopulation: number;
  readonly illegalPlans: number;
  readonly repairedPlans: number;
  readonly unsupported: readonly string[];
  readonly unknownEffectCount: number;
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly semanticHash: string;
}

export interface EpisodePerformance {
  readonly schema: "sim.performance.v1";
  readonly wallMs: number;
  readonly ticksPerSecond: number;
}

function countEvents(result: EpisodeResult): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of result.records) {
    for (const event of record.events) counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => compareCodeUnit(a, b)));
}

export function summarizeEpisode(config: EpisodeConfig, result: EpisodeResult): EpisodeSemanticSummary {
  const initial = worldFromScenario(config.scenario);
  const players: PlayerEpisodeSummary[] = [...result.finalWorld.players.keys()]
    .sort(compareCodeUnit)
    .map((playerId) => {
      const initialPlayer = initial.players.get(playerId)!;
      const finalPlayer = result.finalWorld.players.get(playerId)!;
      return {
        playerId,
        initialResources: initialPlayer.resources,
        finalResources: finalPlayer.resources,
        resourceDelta: finalPlayer.resources - initialPlayer.resources,
        initialPopulation: initialPlayer.units.length,
        finalPopulation: finalPlayer.units.length,
      };
    });
  const stable = {
    schema: "sim.episode-summary.v1" as const,
    ticks: config.ticks,
    seed: config.seed,
    finalWorldHash: result.finalWorldHash,
    players,
    totalResourceDelta: players.reduce((sum, player) => sum + player.resourceDelta, 0),
    totalFinalPopulation: players.reduce((sum, player) => sum + player.finalPopulation, 0),
    illegalPlans: result.metrics.illegalPlans,
    repairedPlans: result.metrics.repairedPlans,
    unsupported: [...result.metrics.unsupported].sort(compareCodeUnit),
    unknownEffectCount: result.records.reduce((sum, record) => sum + record.unknownEffects.length, 0),
    eventCounts: countEvents(result),
  };
  return { ...stable, semanticHash: sha256Json(stable) };
}

export function episodePerformance(config: EpisodeConfig, result: EpisodeResult): EpisodePerformance {
  const seconds = result.metrics.wallMs / 1000;
  return {
    schema: "sim.performance.v1",
    wallMs: result.metrics.wallMs,
    ticksPerSecond: seconds <= 0 ? 0 : config.ticks / seconds,
  };
}

export interface ABRunSummary {
  readonly planner: PlannerKind;
  readonly seed: number;
  readonly summary: EpisodeSemanticSummary;
}

export interface ABAggregate {
  readonly planner: PlannerKind;
  readonly runs: number;
  readonly meanResourceDelta: number;
  readonly meanFinalPopulation: number;
  readonly illegalPlans: number;
  readonly repairedPlans: number;
  readonly inconclusiveRuns: number;
}

export interface ABReport {
  readonly schema: "sim.ab-report.v1";
  readonly ticks: number;
  readonly seeds: readonly number[];
  readonly planners: readonly PlannerKind[];
  readonly runs: readonly ABRunSummary[];
  readonly aggregates: readonly ABAggregate[];
  readonly rankingStatus: "conclusive" | "exploratory";
  /** Lexicographic: resource delta desc, illegal plans asc, population desc, planner id. */
  readonly ranking: readonly PlannerKind[];
  readonly semanticHash: string;
}

export interface ABPerformance {
  readonly schema: "sim.ab-performance.v1";
  readonly wallMs: number;
}

export function runAB(config: {
  readonly scenario: unknown;
  readonly rulesPath: string;
  readonly ticks: number;
  readonly seeds: readonly number[];
  readonly planners: readonly PlannerKind[];
}): { readonly report: ABReport; readonly performance: ABPerformance } {
  const seeds = [...new Set(config.seeds)].sort((a, b) => a - b);
  const planners = [...new Set(config.planners)].sort(compareCodeUnit);
  if (seeds.length === 0) throw new Error("A/B requires at least one seed");
  if (planners.length === 0) throw new Error("A/B requires at least one planner");
  const started = performance.now();
  const scenarioWorld = worldFromScenario(config.scenario);
  const playerIds = [...scenarioWorld.players.keys()].sort(compareCodeUnit);
  const runs: ABRunSummary[] = [];
  for (const planner of planners) {
    for (const seed of seeds) {
      const episodeConfig: EpisodeConfig = {
        scenario: config.scenario,
        rulesPath: config.rulesPath,
        seed,
        ticks: config.ticks,
        tenants: playerIds.map((id) => ({ id, planner })),
      };
      const result = runEpisode(episodeConfig);
      runs.push({ planner, seed, summary: summarizeEpisode(episodeConfig, result) });
    }
  }

  const aggregates: ABAggregate[] = planners
    .map((planner) => {
      const matching = runs.filter((run) => run.planner === planner);
      const divisor = matching.length || 1;
      return {
        planner,
        runs: matching.length,
        meanResourceDelta: matching.reduce((sum, run) => sum + run.summary.totalResourceDelta, 0) / divisor,
        meanFinalPopulation: matching.reduce((sum, run) => sum + run.summary.totalFinalPopulation, 0) / divisor,
        illegalPlans: matching.reduce((sum, run) => sum + run.summary.illegalPlans, 0),
        repairedPlans: matching.reduce((sum, run) => sum + run.summary.repairedPlans, 0),
        inconclusiveRuns: matching.filter((run) =>
          run.summary.unsupported.length > 0 || run.summary.unknownEffectCount > 0,
        ).length,
      };
    });
  const ranking = [...aggregates]
    .sort((a, b) =>
      b.meanResourceDelta - a.meanResourceDelta ||
      a.illegalPlans - b.illegalPlans ||
      b.meanFinalPopulation - a.meanFinalPopulation ||
      compareCodeUnit(a.planner, b.planner),
    )
    .map((aggregate) => aggregate.planner);
  const rankingStatus = aggregates.some((aggregate) => aggregate.inconclusiveRuns > 0)
    ? "exploratory" as const
    : "conclusive" as const;
  const stable = {
    schema: "sim.ab-report.v1" as const,
    ticks: config.ticks,
    seeds,
    planners,
    runs,
    aggregates,
    rankingStatus,
    ranking,
  };
  return {
    report: { ...stable, semanticHash: sha256Json(stable) },
    performance: { schema: "sim.ab-performance.v1", wallMs: performance.now() - started },
  };
}

export interface BenchmarkReport {
  readonly schema: "sim.benchmark.v1";
  readonly planner: PlannerKind;
  readonly seed: number;
  readonly ticks: number;
  readonly warmupRuns: number;
  readonly measuredRuns: number;
  readonly finalWorldHash: string;
  readonly traceHash: string;
  readonly semanticStatus: "supported" | "inconclusive";
  readonly unsupported: readonly string[];
  readonly unknownEffectCount: number;
  readonly samples: readonly { readonly wallMs: number; readonly ticksPerSecond: number }[];
  readonly medianTicksPerSecond: number;
  readonly minTicksPerSecond: number;
  readonly maxTicksPerSecond: number;
}

export function runBenchmark(config: {
  readonly scenario: unknown;
  readonly rulesPath: string;
  readonly planner: PlannerKind;
  readonly seed: number;
  readonly ticks: number;
  readonly warmupRuns: number;
  readonly measuredRuns: number;
}): BenchmarkReport {
  if (config.ticks < 1 || config.measuredRuns < 1 || config.warmupRuns < 0) {
    throw new Error("benchmark requires ticks>=1, measuredRuns>=1, warmupRuns>=0");
  }
  const world = worldFromScenario(config.scenario);
  const tenants = [...world.players.keys()].sort(compareCodeUnit).map((id) => ({ id, planner: config.planner }));
  const episodeConfig: EpisodeConfig = {
    scenario: config.scenario,
    rulesPath: config.rulesPath,
    seed: config.seed,
    ticks: config.ticks,
    tenants,
  };
  for (let index = 0; index < config.warmupRuns; index += 1) runEpisode(episodeConfig);

  const samples: { wallMs: number; ticksPerSecond: number }[] = [];
  const hashes = new Set<string>();
  const traceHashes = new Set<string>();
  let referenceSummary: EpisodeSemanticSummary | null = null;
  for (let index = 0; index < config.measuredRuns; index += 1) {
    const result = runEpisode(episodeConfig);
    hashes.add(result.finalWorldHash);
    traceHashes.add(sha256Json(result.records));
    const summary = summarizeEpisode(episodeConfig, result);
    if (referenceSummary === null) referenceSummary = summary;
    else if (summary.semanticHash !== referenceSummary.semanticHash) {
      throw new Error("benchmark semantic drift: measured runs produced different semantic summaries");
    }
    samples.push({
      wallMs: result.metrics.wallMs,
      ticksPerSecond: result.metrics.wallMs <= 0 ? 0 : config.ticks / (result.metrics.wallMs / 1000),
    });
  }
  if (hashes.size !== 1) throw new Error("benchmark semantic drift: measured runs produced different final hashes");
  if (traceHashes.size !== 1) throw new Error("benchmark semantic drift: measured runs produced different traces");
  if (referenceSummary === null) throw new Error("benchmark produced no measured summary");
  const sorted = samples.map((sample) => sample.ticksPerSecond).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    schema: "sim.benchmark.v1",
    planner: config.planner,
    seed: config.seed,
    ticks: config.ticks,
    warmupRuns: config.warmupRuns,
    measuredRuns: config.measuredRuns,
    finalWorldHash: [...hashes][0],
    traceHash: [...traceHashes][0],
    semanticStatus:
      referenceSummary.unsupported.length > 0 || referenceSummary.unknownEffectCount > 0
        ? "inconclusive"
        : "supported",
    unsupported: referenceSummary.unsupported,
    unknownEffectCount: referenceSummary.unknownEffectCount,
    samples,
    medianTicksPerSecond: median,
    minTicksPerSecond: sorted[0],
    maxTicksPerSecond: sorted[sorted.length - 1],
  };
}
