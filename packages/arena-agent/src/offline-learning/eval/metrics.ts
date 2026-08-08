/**
 * 策略评估标准指标定义。
 *
 * 所有指标为标量，可直接聚合（mean/stdev/min/max）。
 * 与 benchmark-result-v1 schema 字段一一对应。
 */

import type { EpisodeResult } from "../../sim/harness/episode.ts";

export interface EpisodeMetrics {
  /** 存活 tick 数（= episode 总 tick，Core 未死 = 全时长）。 */
  readonly survivalTicks: number;
  /** 最终资源量。 */
  readonly finalResources: number;
  /** 最终人口。 */
  readonly finalPopulation: number;
  /** 总资源采集量（含 deposit + beacon bonus，由事件累计）。 */
  readonly totalResourcesCollected: number;
  /** 总死亡单位数。 */
  readonly totalDeaths: number;
  /** 总 spawn 数。 */
  readonly totalSpawns: number;
  /** 击杀敌方战斗单位数。 */
  readonly combatKills: number;
  /** Core 是否被摧毁。 */
  readonly coreDestroyed: boolean;
  /** 平均威胁等级（NORMAL=0, ALERT=1, ENGAGED=2, BREAKOUT=3）。 */
  readonly meanThreatLevel: number;
  /** 人口峰值。 */
  readonly peakPopulation: number;
  /** 资源峰值。 */
  readonly peakResources: number;
  /** 效率比 = totalResourcesCollected / survivalTicks（资源/tick）。 */
  readonly efficiencyRatio: number;
  /** 非法计划数。 */
  readonly illegalPlans: number;
  /** 修复计划数。 */
  readonly repairedPlans: number;
}

const THREAT_LEVEL_VALUE: Record<string, number> = {
  NORMAL: 0,
  ALERT: 1,
  ENGAGED: 2,
  BREAKOUT: 3,
};

/**
 * 从 EpisodeResult 计算标准指标。
 * 需要 tickData 提供每个 tick 的详细事件信息。
 */
export function computeEpisodeMetrics(
  result: EpisodeResult,
  tickData: readonly {
    tick: number;
    resources: number;
    population: number;
    threatLevel: string;
    resourceCollected: number;
    deaths: number;
    spawns: number;
    combatKills: number;
    coreAlive: boolean;
  }[],
): EpisodeMetrics {
  if (tickData.length === 0) {
    return {
      survivalTicks: 0,
      finalResources: 0,
      finalPopulation: 0,
      totalResourcesCollected: 0,
      totalDeaths: 0,
      totalSpawns: 0,
      combatKills: 0,
      coreDestroyed: true,
      meanThreatLevel: 0,
      peakPopulation: 0,
      peakResources: 0,
      efficiencyRatio: 0,
      illegalPlans: result.metrics.illegalPlans,
      repairedPlans: result.metrics.repairedPlans,
    };
  }

  const last = tickData[tickData.length - 1]!;
  let totalResourcesCollected = 0;
  let totalDeaths = 0;
  let totalSpawns = 0;
  let combatKills = 0;
  let threatSum = 0;
  let peakPopulation = 0;
  let peakResources = 0;

  for (const td of tickData) {
    totalResourcesCollected += td.resourceCollected;
    totalDeaths += td.deaths;
    totalSpawns += td.spawns;
    combatKills += td.combatKills;
    threatSum += THREAT_LEVEL_VALUE[td.threatLevel] ?? 0;
    if (td.population > peakPopulation) peakPopulation = td.population;
    if (td.resources > peakResources) peakResources = td.resources;
  }

  return {
    survivalTicks: tickData.length,
    finalResources: last.resources,
    finalPopulation: last.population,
    totalResourcesCollected,
    totalDeaths,
    totalSpawns,
    combatKills,
    coreDestroyed: !last.coreAlive,
    meanThreatLevel: tickData.length > 0 ? threatSum / tickData.length : 0,
    peakPopulation,
    peakResources,
    efficiencyRatio: tickData.length > 0 ? totalResourcesCollected / tickData.length : 0,
    illegalPlans: result.metrics.illegalPlans,
    repairedPlans: result.metrics.repairedPlans,
  };
}

/** 聚合多个 episode 的指标（mean）。 */
export function aggregateMetrics(
  metricsList: readonly EpisodeMetrics[],
): EpisodeMetrics {
  if (metricsList.length === 0) {
    return {
      survivalTicks: 0, finalResources: 0, finalPopulation: 0,
      totalResourcesCollected: 0, totalDeaths: 0, totalSpawns: 0,
      combatKills: 0, coreDestroyed: true, meanThreatLevel: 0,
      peakPopulation: 0, peakResources: 0, efficiencyRatio: 0,
      illegalPlans: 0, repairedPlans: 0,
    };
  }
  const n = metricsList.length;
  const sum = (fn: (m: EpisodeMetrics) => number) =>
    metricsList.reduce((s, m) => s + fn(m), 0) / n;

  return {
    survivalTicks: sum((m) => m.survivalTicks),
    finalResources: sum((m) => m.finalResources),
    finalPopulation: sum((m) => m.finalPopulation),
    totalResourcesCollected: sum((m) => m.totalResourcesCollected),
    totalDeaths: sum((m) => m.totalDeaths),
    totalSpawns: sum((m) => m.totalSpawns),
    combatKills: sum((m) => m.combatKills),
    coreDestroyed: metricsList.filter((m) => m.coreDestroyed).length / n >= 0.5,
    meanThreatLevel: sum((m) => m.meanThreatLevel),
    peakPopulation: sum((m) => m.peakPopulation),
    peakResources: sum((m) => m.peakResources),
    efficiencyRatio: sum((m) => m.efficiencyRatio),
    illegalPlans: sum((m) => m.illegalPlans),
    repairedPlans: sum((m) => m.repairedPlans),
  };
}
