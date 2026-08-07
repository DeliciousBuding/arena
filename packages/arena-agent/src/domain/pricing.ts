/**
 * Unit 产兵成本（v0.14 动态定价，共享纯函数）。
 *
 * 官方 changelog 2026-08-06（docs commit 166ef86、server commit b24cfcd）：
 * - Worker/Vanguard/Ranger 保留 base 价 5/10/12 给 Units 1-20；
 * - 第 21 单位起 price = round_half_up(base × (13/10)^k)，
 *   k = max(0, floor((population − 20) / 5) + 1)；
 * - population = 同 tick 自毁/战死结算后的存活人口（spawn 定价时点，
 *   即 spawn 前人口）；"The exact fraction is rounded only once at the end"。
 *
 * 权威实证（2026-08-07 生产 t1）：pop 24 RANGER 实收 16、pop 25 VANGUARD
 * 实收 13（CORE_SPAWN_SUCCEEDED.values.cost）——live 动态价与公式一致，
 * 而决策侧此前用 base 价预算导致连串 INSUFFICIENT_RESOURCES 失败。
 *
 * 本模块是唯一公式实现：sim（sim/contracts/pricing.ts）与决策侧
 * （deterministic-planner）共用，避免两处漂移。
 */

import type { UnitType } from "./model.ts";

/** v0.14 动态定价参数（rules-v0.14.json unitCosts 镜像）。 */
export const DYNAMIC_PRICING = Object.freeze({
  /** 1-20 号单位按 base 价。 */
  tierSize: 20,
  /** 21 号起每 5 人口一档。 */
  tierStep: 5,
  /** 增长因子 13/10。 */
  growthFactor: 1.3,
});

export const BASE_COST: Readonly<Record<UnitType, number>> = Object.freeze({
  WORKER: 5,
  VANGUARD: 10,
  RANGER: 12,
});

/** growthFactor 13/10 的整数形式：base × 13^k / 10^k 只取整一次。 */
const GROWTH_NUMERATOR = 13;
const GROWTH_DENOMINATOR = 10;

/**
 * v0.14 动态产兵成本：populationBeforeSpawn ≤20 用 base 价；
 * ≥21 用 round_half_up(base × (13/10)^k)，k = floor((pop−20)/5)+1。
 * 整数乘方避免中间取整；k 极大（13^k 溢出 double）时饱和为
 * MAX_SAFE_INTEGER（恒不可负担且 JSON 可序列化，防御性兜底）。
 */
export function unitSpawnCost(unitType: UnitType, populationBeforeSpawn: number): number {
  const basePrice = BASE_COST[unitType];
  const k = Math.max(
    0,
    Math.floor((populationBeforeSpawn - DYNAMIC_PRICING.tierSize) / DYNAMIC_PRICING.tierStep) + 1,
  );
  if (k === 0) {
    return basePrice;
  }
  const exactFraction = (basePrice * GROWTH_NUMERATOR ** k) / GROWTH_DENOMINATOR ** k;
  const price = Math.round(exactFraction);
  return Number.isFinite(price) ? price : Number.MAX_SAFE_INTEGER;
}

/** 按人口批量计算三类产兵成本（决策/面板通用）。 */
export function unitSpawnCosts(populationBeforeSpawn: number): Readonly<Record<UnitType, number>> {
  return Object.freeze({
    WORKER: unitSpawnCost("WORKER", populationBeforeSpawn),
    VANGUARD: unitSpawnCost("VANGUARD", populationBeforeSpawn),
    RANGER: unitSpawnCost("RANGER", populationBeforeSpawn),
  });
}
