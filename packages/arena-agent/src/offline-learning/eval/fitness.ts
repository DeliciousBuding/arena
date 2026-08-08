/**
 * W51 多目标 fitness 评分（arena-evolve `evolve/fitness.py` 的 TS 移植）。
 *
 * 目标：保证存活的同时攒下更多资源——把经济/战斗/成本账本综合为单一标量，
 * 供 GA/离线评估排序候选策略。公式与权重对齐 reference
 * `fitness_from_detail` / `combine_details` / `_risk_metrics`（2026-08-07
 * 架构评审 P0#7/#11 重设计版），权重作为 GA 超参（不进搜索空间）。
 *
 * 数据来源：`EpisodeResult.metrics.perPlayer[playerId]`（W51 cost ledger，
 * 在 episode 运行时从 settlement 事件流累计）。本模块纯函数，无副作用——
 * 评估管线负责跑 episode、收集 per-player ledger、调用 fitness。
 *
 * 与 reference 的差异（baseline 限制，不偏离公式语义）：
 * - damage_dealt 来自 SHOT_HIT.damage（reference 来自 GameStats 内部累计）；
 *   sweep 伤害不计（SWEEP_RESOLVED 无 per-target damage 字段）→ baseline
 *   低估 sweep 策略的伤害，GA 收敛后再校准。
 * - spawn_cost 在 reference detail 中收集但 fitness 公式未使用（weight=0）；
 *   本移植保持一致——detail 含 spawn_cost，公式不读它。
 */

import type { EpisodeResult, PlayerCostLedger } from "../../sim/harness/episode.ts";

/**
 * Fitness detail：单局或多局聚合的 per-player 指标快照。
 * key 命名对齐 reference `fitness_from_detail` 的 detail dict（snake_case），
 * 便于与 Python 公式逐行 diff。
 */
export interface FitnessDetail {
  harvested: number;
  deposited: number;
  res: number;
  pop: number;
  beacon: number;
  alive_ticks: number;
  damage: number;
  lost: number;
  respawn: number;
  heal_cost: number;
  repair_cost: number;
  spawn_cost: number;
  overflow_destroyed: number;
  resources_lost: number;
  /** 多局风险指标（_risk_metrics 派生；单局 detail 不含）。 */
  fitness_std?: number;
  fitness_worst?: number;
  fitness_p10?: number;
}

/** combine_details 的输入段：(detail, n_seeds[, mean_fitness])。 */
export type CombinePart =
  | readonly [FitnessDetail, number]
  | readonly [FitnessDetail, number, number | undefined];

/**
 * 多目标加权 fitness（reference `fitness_from_detail` 的 1:1 移植）。
 *
 * 13 项加权（harvested/deposited/res/pop/beacon/alive_ticks/damage/lost/
 * respawn/heal_cost/repair_cost/overflow_destroyed/resources_lost）；spawn_cost
 * 收集于 detail 但公式不读（与 reference 一致）。
 *
 * 时间归一化（P0#10）：累计类字段（采集/交付/伤害/损失/成本）除以
 * `max_ticks/600`——折算到"每 600 tick 速率"刻度，使多阶段评估的阶段
 * 权重（w_early/w_mid）代表真实重要性。快照类字段（pop/res）不缩放；
 * alive_ticks 已按 max_ticks 归一化。
 *
 * @param detail 单局或聚合后的 per-player 指标
 * @param maxTicks 该 detail 对应的局时长（默认 800，与 reference 默认一致）
 */
export function fitnessFromDetail(detail: FitnessDetail, maxTicks: number = 800): number {
  const t = maxTicks / 600.0;
  return (
    (detail.harvested / t) * 0.6 + // 采集效率（经济基础）
    (detail.deposited / t) * 1.2 + // 交付量（Core 总收入）
    detail.res * 1.0 + // 终局储备（安全垫，不重复计分）
    Math.min(detail.pop, 40.0) * 0.8 + // 兵力（只奖到 40；动态价格自然约束更高人口）
    (detail.beacon / t) * 0.05 + // Beacon 辅助
    (detail.alive_ticks / maxTicks) * 2.0 + // 存活保底（真实 ticks）
    (detail.damage / t) * 0.3 - // 战斗降为手段
    (detail.lost / t) * 0.8 - // 单位损失
    (detail.respawn / t) * 2.0 - // 重生惩罚
    // ---- 成本账本（P0#11）----
    (detail.heal_cost / t) * 0.15 - // 治疗成本（被打多/乱治疗）
    (detail.repair_cost / t) * 0.1 - // 修盾成本
    (detail.overflow_destroyed / t) * 0.5 - // 容量溢出纯浪费
    (detail.resources_lost / t) * 1.0 // 被掠夺/摧毁
  );
}

/**
 * 多局分数 → 风险指标（reference `_risk_metrics`，P0#12）。
 *
 * 只看均值会选"偶尔爆高、经常崩盘"的策略；std/worst/p10 暴露下行风险。
 */
export function riskMetrics(scores: readonly number[]): {
  fitness_std: number;
  fitness_worst: number;
  fitness_p10: number;
} {
  if (scores.length === 0) {
    return { fitness_std: 0, fitness_worst: 0, fitness_p10: 0 };
  }
  if (scores.length < 2) {
    return { fitness_std: 0, fitness_worst: scores[0]!, fitness_p10: scores[0]! };
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const n = sorted.length;
  // reference: p10 = s[max(0, int(n*0.1) - 1)]
  const p10Index = Math.max(0, Math.floor(n * 0.1) - 1);
  return {
    fitness_std: sampleStdDev(scores),
    fitness_worst: sorted[0]!,
    fitness_p10: sorted[p10Index]!,
  };
}

/** 样本标准差（n-1 分母；与 Python `statistics.stdev` 一致）。 */
function sampleStdDev(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const sumSquaredDiff = values.reduce((sum, v) => sum + (v - mean) ** 2, 0);
  return Math.sqrt(sumSquaredDiff / (n - 1));
}

/**
 * 按种子数加权合并多段 detail（reference `combine_details`）。
 *
 * `parts` 接受 `(detail, n_seeds)` 或 `(detail, n_seeds, mean_fitness)`。
 * 后者让 prescreen 用 pooled-sample 方差公式合并，避免逐段平均标准差
 * 系统性低估跨种子风险。
 */
export function combineDetails(parts: readonly CombinePart[]): FitnessDetail {
  if (parts.length === 0) {
    return emptyDetail();
  }
  const normalized = parts.map((part) => {
    const [detail, n, mean] = part;
    return { detail, n, mean: mean === undefined ? null : mean };
  });
  const totalN = normalized.reduce((sum, part) => sum + part.n, 0);
  if (totalN <= 0) return emptyDetail();

  const keys = Object.keys(normalized[0]!.detail) as readonly (keyof FitnessDetail)[];
  const out: FitnessDetail = emptyDetail();
  for (const key of keys) {
    if (key === "fitness_std" || key === "fitness_worst" || key === "fitness_p10") continue;
    let weightedSum = 0;
    for (const part of normalized) {
      weightedSum += (part.detail[key] ?? 0) * part.n;
    }
    (out[key] as number) = weightedSum / totalN;
  }

  out.fitness_worst = Math.min(
    ...normalized.map((part) => part.detail.fitness_worst ?? Number.POSITIVE_INFINITY),
  );
  out.fitness_p10 = Math.min(
    ...normalized.map((part) => part.detail.fitness_p10 ?? Number.POSITIVE_INFINITY),
  );

  // Pooled-sample std（仅当所有段都提供 mean_fitness 且 totalN > 1）。
  const allMeansProvided = normalized.every((part) => part.mean !== null);
  if (allMeansProvided && totalN > 1) {
    const pooledMean =
      normalized.reduce((sum, part) => sum + (part.mean ?? 0) * part.n, 0) / totalN;
    const sumSquared =
      normalized.reduce((sum, part) => {
        const std = part.detail.fitness_std ?? 0;
        const mean = part.mean ?? 0;
        return sum + Math.max(0, part.n - 1) * std ** 2 + part.n * (mean - pooledMean) ** 2;
      }, 0);
    out.fitness_std = Math.sqrt(sumSquared / (totalN - 1));
  }
  return out;
}

function emptyDetail(): FitnessDetail {
  return {
    harvested: 0,
    deposited: 0,
    res: 0,
    pop: 0,
    beacon: 0,
    alive_ticks: 0,
    damage: 0,
    lost: 0,
    respawn: 0,
    heal_cost: 0,
    repair_cost: 0,
    spawn_cost: 0,
    overflow_destroyed: 0,
    resources_lost: 0,
  };
}

/**
 * 从 EpisodeResult.metrics.perPlayer[playerId] 派生 FitnessDetail。
 *
 * 单局快照：不含 risk 指标（fitness_std/worst/p10）——那些需多局
 * 聚合后由 `evaluateMultiSeed` 派生。本函数只做字段名映射
 * （camelCase ledger → snake_case detail），保持与 reference detail 同构。
 *
 * @param result EpisodeResult（W51 已含 perPlayer ledger）
 * @param playerId 被评估玩家
 */
export function buildFitnessDetail(
  result: EpisodeResult,
  playerId: string,
): FitnessDetail | null {
  const ledger = result.metrics.perPlayer[playerId];
  if (ledger === undefined) return null;
  return ledgerToDetail(ledger);
}

/** PlayerCostLedger → FitnessDetail 字段映射（camelCase → snake_case）。 */
export function ledgerToDetail(ledger: PlayerCostLedger): FitnessDetail {
  return {
    harvested: ledger.harvested,
    deposited: ledger.deposited,
    res: ledger.finalResources,
    pop: ledger.finalPopulation,
    beacon: ledger.beaconTicks,
    alive_ticks: ledger.aliveTicks,
    damage: ledger.damageDealt,
    lost: ledger.unitsLost,
    respawn: ledger.respawnCount,
    heal_cost: ledger.healCost,
    repair_cost: ledger.repairCost,
    spawn_cost: ledger.spawnCost,
    overflow_destroyed: ledger.overflowDestroyed,
    resources_lost: ledger.resourcesLost,
  };
}

/**
 * 多种子评估（reference `evaluate_individual` 的 TS 等价出口）。
 *
 * 输入：每个 seed 的 (EpisodeResult, playerId)。累计 per-player ledger →
 * 按种子数平均 → 注入 risk 指标 → 计算 fitness。
 *
 * 与 reference 的区别：reference 跑 Game.run() 取 g.results()[slot]；
 * 本函数接受已跑完的 EpisodeResult（评估管线负责跑 episode），只做
 * fitness 聚合。这把"如何跑局"与"如何评分"解耦——sim 端跑 episode，
 * eval 端算 fitness。
 *
 * @param runs 每个种子一个 (EpisodeResult, playerId) 对
 * @param maxTicks 单局时长（与 fitness_from_detail 的归一化基准一致）
 */
export function evaluateMultiSeed(
  runs: readonly { readonly result: EpisodeResult; readonly playerId: string }[],
  maxTicks: number = 800,
): { fitness: number; detail: FitnessDetail } {
  if (runs.length === 0) {
    return { fitness: 0, detail: emptyDetail() };
  }

  const aggregateKeys: readonly (keyof FitnessDetail)[] = [
    "harvested",
    "deposited",
    "res",
    "pop",
    "beacon",
    "alive_ticks",
    "damage",
    "lost",
    "respawn",
    "heal_cost",
    "repair_cost",
    "spawn_cost",
    "overflow_destroyed",
    "resources_lost",
  ];
  const aggregate: FitnessDetail = emptyDetail();
  const perGame: number[] = [];

  for (const run of runs) {
    const detail = buildFitnessDetail(run.result, run.playerId);
    if (detail === null) continue;
    for (const key of aggregateKeys) {
      (aggregate[key] as number) += detail[key] ?? 0;
    }
    perGame.push(fitnessFromDetail(detail, maxTicks));
  }

  const n = runs.length;
  const detail: FitnessDetail = emptyDetail();
  for (const key of aggregateKeys) {
    (detail[key] as number) = (aggregate[key] ?? 0) / n;
  }
  const risk = riskMetrics(perGame);
  detail.fitness_std = risk.fitness_std;
  detail.fitness_worst = risk.fitness_worst;
  detail.fitness_p10 = risk.fitness_p10;
  return { fitness: fitnessFromDetail(detail, maxTicks), detail };
}
