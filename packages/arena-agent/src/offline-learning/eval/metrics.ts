/**
 * 策略评估标准指标定义。
 *
 * 所有指标为标量，可直接聚合（mean/stdev/min/max）。
 * 与 benchmark-result-v1 schema 字段一一对应。
 */

import type { EpisodeResult, PlayerCostLedger } from "../../sim/harness/episode.ts";

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
  // ---- W51 cost ledger（追加字段，对齐 reference fitness detail） ----
  // 可选（?）：既有调用方构造 EpisodeMetrics 时不传这些字段仍可编译；
  // aggregateMetrics/computeEpisodeMetrics 用 ZERO_LEDGER_METRICS 兜底为 0。
  /** 造成伤害（SHOT_HIT 累计；sweep 不计，baseline 限制）。 */
  readonly damageDealt?: number;
  /** 持有 Beacon 的 tick 数。 */
  readonly beaconTicks?: number;
  /** Core 重生次数。 */
  readonly respawnCount?: number;
  /** 损失单位数（UNIT_DAMAGED hp==0 + SELF_DESTRUCT）。 */
  readonly unitsLost?: number;
  /** 治疗开销（CORE/UNIT HEAL cost）。 */
  readonly healCost?: number;
  /** 修盾开销（CORE_REPAIR cost）。 */
  readonly repairCost?: number;
  /** Spawn 开销（CORE_SPAWN cost）。 */
  readonly spawnCost?: number;
  /** 容量溢出销毁资源量。 */
  readonly overflowDestroyed?: number;
  /** 被掠夺/摧毁资源量。 */
  readonly resourcesLost?: number;
  /** 总采集量（harvested + beacon bonus）。 */
  readonly harvested?: number;
  /** 交付量（DEPOSIT_SUCCEEDED amount）。 */
  readonly deposited?: number;
  /** 真实存活 tick（core!==null 的 tick 数；与 survivalTicks 区别：
   *  survivalTicks=episode 总 tick，aliveTicks=core 实际存活 tick）。 */
  readonly aliveTicks?: number;
}

const THREAT_LEVEL_VALUE: Record<string, number> = {
  NORMAL: 0,
  ALERT: 1,
  ENGAGED: 2,
  BREAKOUT: 3,
};

/** 空的 cost ledger 字段集（用于缺省/聚合零值）。 */
const ZERO_LEDGER_METRICS = {
  damageDealt: 0,
  beaconTicks: 0,
  respawnCount: 0,
  unitsLost: 0,
  healCost: 0,
  repairCost: 0,
  spawnCost: 0,
  overflowDestroyed: 0,
  resourcesLost: 0,
  harvested: 0,
  deposited: 0,
  aliveTicks: 0,
} as const;

/**
 * 从 EpisodeResult 计算标准指标。
 * 需要 tickData 提供每个 tick 的详细事件信息。
 *
 * W51：可选 `costLedger` 参数从 EpisodeResult.metrics.perPlayer[playerId]
 * 注入 cost ledger 字段；缺省时全部为 0（向后兼容，不破坏既有调用方）。
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
  costLedger?: PlayerCostLedger,
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
      ...ZERO_LEDGER_METRICS,
      ...(costLedger === undefined ? {} : extractLedgerFields(costLedger)),
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
    ...ZERO_LEDGER_METRICS,
    ...(costLedger === undefined ? {} : extractLedgerFields(costLedger)),
  };
}

/** 把 PlayerCostLedger 的字段提取为 EpisodeMetrics cost ledger 子集。 */
function extractLedgerFields(ledger: PlayerCostLedger): Partial<EpisodeMetrics> {
  return {
    damageDealt: ledger.damageDealt,
    beaconTicks: ledger.beaconTicks,
    respawnCount: ledger.respawnCount,
    unitsLost: ledger.unitsLost,
    healCost: ledger.healCost,
    repairCost: ledger.repairCost,
    spawnCost: ledger.spawnCost,
    overflowDestroyed: ledger.overflowDestroyed,
    resourcesLost: ledger.resourcesLost,
    harvested: ledger.harvested,
    deposited: ledger.deposited,
    aliveTicks: ledger.aliveTicks,
    finalPopulation: ledger.finalPopulation,
    finalResources: ledger.finalResources,
  };
}

/**
 * 从 EpisodeResult 直接派生指定玩家的 cost ledger EpisodeMetrics 视图。
 * 不需要 tickData（cost ledger 已在 episode 运行时累计）。
 */
export function computeEpisodeMetricsFromLedger(
  result: EpisodeResult,
  playerId: string,
  survivalTicks?: number,
): EpisodeMetrics {
  const ledger = result.metrics.perPlayer[playerId];
  if (ledger === undefined) {
    return {
      survivalTicks: survivalTicks ?? result.metrics.ticks,
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
      ...ZERO_LEDGER_METRICS,
    };
  }
  const ticks = survivalTicks ?? result.metrics.ticks;
  return {
    survivalTicks: ticks,
    finalResources: ledger.finalResources,
    finalPopulation: ledger.finalPopulation,
    totalResourcesCollected: ledger.harvested,
    totalDeaths: ledger.unitsLost,
    totalSpawns: 0,
    combatKills: 0,
    coreDestroyed: ledger.aliveTicks === 0,
    meanThreatLevel: 0,
    peakPopulation: ledger.finalPopulation,
    peakResources: ledger.finalResources,
    efficiencyRatio: ticks > 0 ? ledger.harvested / ticks : 0,
    illegalPlans: result.metrics.illegalPlans,
    repairedPlans: result.metrics.repairedPlans,
    ...extractLedgerFields(ledger),
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
      ...ZERO_LEDGER_METRICS,
    };
  }
  const n = metricsList.length;
  const sum = (fn: (m: EpisodeMetrics) => number) =>
    metricsList.reduce((s, m) => s + fn(m), 0) / n;
  const optSum = (fn: (m: EpisodeMetrics) => number | undefined) =>
    metricsList.reduce((s, m) => s + (fn(m) ?? 0), 0) / n;

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
    damageDealt: optSum((m) => m.damageDealt),
    beaconTicks: optSum((m) => m.beaconTicks),
    respawnCount: optSum((m) => m.respawnCount),
    unitsLost: optSum((m) => m.unitsLost),
    healCost: optSum((m) => m.healCost),
    repairCost: optSum((m) => m.repairCost),
    spawnCost: optSum((m) => m.spawnCost),
    overflowDestroyed: optSum((m) => m.overflowDestroyed),
    resourcesLost: optSum((m) => m.resourcesLost),
    harvested: optSum((m) => m.harvested),
    deposited: optSum((m) => m.deposited),
    aliveTicks: optSum((m) => m.aliveTicks),
  };
}
