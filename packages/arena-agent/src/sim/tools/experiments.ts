/** Episode summaries, A/B comparison and throughput benchmark (S9). */

import { performance } from "node:perf_hooks";
import { compareCodeUnit } from "../deterministic/uuid.ts";
import {
  runEpisode,
  type EpisodeConfig,
  type EpisodeResult,
  type EpisodeTickPlayerMeasurement,
  type PlannerKind,
} from "../harness/episode.ts";
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

export interface ABPairedDelta {
  readonly seed: number;
  readonly baseline: PlannerKind;
  readonly candidate: PlannerKind;
  /** Candidate minus baseline. */
  readonly resourceDelta: number;
  readonly finalPopulationDelta: number;
  readonly illegalPlansDelta: number;
  readonly repairedPlansDelta: number;
  readonly status: "conclusive" | "exploratory";
}

export interface ABPairedAggregate {
  readonly baseline: PlannerKind;
  readonly candidate: PlannerKind;
  readonly pairs: number;
  readonly meanResourceDelta: number;
  readonly meanFinalPopulationDelta: number;
  readonly illegalPlansDelta: number;
  readonly repairedPlansDelta: number;
  readonly exploratoryPairs: number;
}

export interface ABReport {
  readonly schema: "sim.ab-report.v1";
  readonly ticks: number;
  readonly seeds: readonly number[];
  readonly planners: readonly PlannerKind[];
  readonly runs: readonly ABRunSummary[];
  readonly aggregates: readonly ABAggregate[];
  readonly pairedDeltas: readonly ABPairedDelta[];
  readonly pairedAggregates: readonly ABPairedAggregate[];
  readonly rankingStatus: "conclusive" | "exploratory";
  /** Lexicographic: resource delta desc, illegal plans asc, population desc, planner id. */
  readonly ranking: readonly PlannerKind[];
  readonly semanticHash: string;
}

export interface ABPerformance {
  readonly schema: "sim.ab-performance.v1";
  readonly wallMs: number;
}

function summaryIsInconclusive(summary: EpisodeSemanticSummary): boolean {
  return summary.unsupported.length > 0 || summary.unknownEffectCount > 0;
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
        inconclusiveRuns: matching.filter((run) => summaryIsInconclusive(run.summary)).length,
      };
    });
  const baseline = planners[0];
  const pairedDeltas: ABPairedDelta[] = [];
  for (const candidate of planners.slice(1)) {
    for (const seed of seeds) {
      const baselineRun = runs.find((run) => run.planner === baseline && run.seed === seed);
      const candidateRun = runs.find((run) => run.planner === candidate && run.seed === seed);
      if (baselineRun === undefined || candidateRun === undefined) {
        throw new Error(`A/B pairing missing run for seed=${seed}, ${baseline} vs ${candidate}`);
      }
      pairedDeltas.push({
        seed,
        baseline,
        candidate,
        resourceDelta:
          candidateRun.summary.totalResourceDelta - baselineRun.summary.totalResourceDelta,
        finalPopulationDelta:
          candidateRun.summary.totalFinalPopulation - baselineRun.summary.totalFinalPopulation,
        illegalPlansDelta: candidateRun.summary.illegalPlans - baselineRun.summary.illegalPlans,
        repairedPlansDelta: candidateRun.summary.repairedPlans - baselineRun.summary.repairedPlans,
        status:
          summaryIsInconclusive(baselineRun.summary) || summaryIsInconclusive(candidateRun.summary)
            ? "exploratory"
            : "conclusive",
      });
    }
  }
  const pairedAggregates: ABPairedAggregate[] = planners.slice(1).map((candidate) => {
    const pairs = pairedDeltas.filter((pair) => pair.candidate === candidate);
    const divisor = pairs.length || 1;
    return {
      baseline,
      candidate,
      pairs: pairs.length,
      meanResourceDelta: pairs.reduce((sum, pair) => sum + pair.resourceDelta, 0) / divisor,
      meanFinalPopulationDelta:
        pairs.reduce((sum, pair) => sum + pair.finalPopulationDelta, 0) / divisor,
      illegalPlansDelta: pairs.reduce((sum, pair) => sum + pair.illegalPlansDelta, 0),
      repairedPlansDelta: pairs.reduce((sum, pair) => sum + pair.repairedPlansDelta, 0),
      exploratoryPairs: pairs.filter((pair) => pair.status === "exploratory").length,
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
    pairedDeltas,
    pairedAggregates,
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
  readonly economicCurveHash: string;
  readonly economicCurve: readonly {
    readonly tick: number;
    readonly players: readonly EpisodeTickPlayerMeasurement[];
  }[];
  readonly tickLatencyMs: {
    readonly p50: number;
    readonly p95: number;
    readonly max: number;
  };
  readonly samples: readonly {
    readonly wallMs: number;
    readonly ticksPerSecond: number;
    readonly tickLatencyP50Ms: number;
    readonly tickLatencyP95Ms: number;
    readonly tickLatencyMaxMs: number;
    readonly heapStartBytes: number;
    readonly heapEndBytes: number;
    readonly heapDeltaBytes: number;
    readonly peakHeapBytes: number;
  }[];
  readonly medianTicksPerSecond: number;
  readonly minTicksPerSecond: number;
  readonly maxTicksPerSecond: number;
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) throw new Error("percentile requires at least one value");
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(ratio * sorted.length) - 1);
  return sorted[index];
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

  const samples: Array<BenchmarkReport["samples"][number]> = [];
  const hashes = new Set<string>();
  const traceHashes = new Set<string>();
  const economicCurveHashes = new Set<string>();
  const allTickLatencies: number[] = [];
  let referenceSummary: EpisodeSemanticSummary | null = null;
  let referenceEconomicCurve: BenchmarkReport["economicCurve"] | null = null;
  for (let index = 0; index < config.measuredRuns; index += 1) {
    const tickLatencies: number[] = [];
    const economicCurve: Array<BenchmarkReport["economicCurve"][number]> = [];
    const heapStartBytes = process.memoryUsage().heapUsed;
    let peakHeapBytes = heapStartBytes;
    const result = runEpisode({
      ...episodeConfig,
      onTickSettled: (measurement) => {
        tickLatencies.push(measurement.wallMs);
        economicCurve.push({ tick: measurement.tick, players: measurement.players });
        peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
      },
    });
    const heapEndBytes = process.memoryUsage().heapUsed;
    if (tickLatencies.length !== config.ticks || economicCurve.length !== config.ticks) {
      throw new Error(
        `benchmark instrumentation mismatch: expected ${config.ticks} ticks, got ${tickLatencies.length}`,
      );
    }
    hashes.add(result.finalWorldHash);
    traceHashes.add(sha256Json(result.records));
    const economicCurveHash = sha256Json(economicCurve);
    economicCurveHashes.add(economicCurveHash);
    if (referenceEconomicCurve === null) referenceEconomicCurve = economicCurve;
    const summary = summarizeEpisode(episodeConfig, result);
    if (referenceSummary === null) referenceSummary = summary;
    else if (summary.semanticHash !== referenceSummary.semanticHash) {
      throw new Error("benchmark semantic drift: measured runs produced different semantic summaries");
    }
    allTickLatencies.push(...tickLatencies);
    samples.push({
      wallMs: result.metrics.wallMs,
      ticksPerSecond: result.metrics.wallMs <= 0 ? 0 : config.ticks / (result.metrics.wallMs / 1000),
      tickLatencyP50Ms: percentile(tickLatencies, 0.5),
      tickLatencyP95Ms: percentile(tickLatencies, 0.95),
      tickLatencyMaxMs: Math.max(...tickLatencies),
      heapStartBytes,
      heapEndBytes,
      heapDeltaBytes: heapEndBytes - heapStartBytes,
      peakHeapBytes,
    });
  }
  if (hashes.size !== 1) throw new Error("benchmark semantic drift: measured runs produced different final hashes");
  if (traceHashes.size !== 1) throw new Error("benchmark semantic drift: measured runs produced different traces");
  if (economicCurveHashes.size !== 1) {
    throw new Error("benchmark semantic drift: measured runs produced different economic curves");
  }
  if (referenceSummary === null) throw new Error("benchmark produced no measured summary");
  if (referenceEconomicCurve === null) throw new Error("benchmark produced no economic curve");
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
    economicCurveHash: [...economicCurveHashes][0],
    economicCurve: referenceEconomicCurve,
    tickLatencyMs: {
      p50: percentile(allTickLatencies, 0.5),
      p95: percentile(allTickLatencies, 0.95),
      max: Math.max(...allTickLatencies),
    },
    samples,
    medianTicksPerSecond: median,
    minTicksPerSecond: sorted[0],
    maxTicksPerSecond: sorted[sorted.length - 1],
  };
}
