/**
 * Unit 价格解析（S0：官方来源锁定）。
 *
 * v0.14 动态价格公式（官方 changelog 2026-08-06，docs commit 166ef86、
 * server commit b24cfcd）：
 * - Worker/Vanguard/Ranger 保留 base 价 5/10/12 给 Units 1-20；
 * - 第 21 单位起 price = round_half_up(base × (13/10)^k)，
 *   k = max(0, floor((population − 20) / 5) + 1)；
 * - population = 同 tick 自毁/战死结算后的存活人口（spawn 定价时点，
 *   即 spawn 前人口）；"The exact fraction is rounded only once at the end"；
 * - 初始/respawn Worker 免费由 world 初始化/respawn resolver 保证，本模块
 *   只负责主动 SPAWN 的价格。
 *
 * 未实机验证：生产人口峰值 8，pop ≥ 21 的行为按文档公式实现（见
 * rules-v0.14.json evidence.discrepancies）。
 *
 * 版本隔离：computeUnitCost 只接受 v0.14 manifest（union 编译期限定）；
 * spawnUnitCost 按 rulesVersion 分派，v0.11 路径行为与历史实现逐字节一致。
 */

import type { UnitType } from "../../domain/model.ts";
import type { RulesManifest, RulesManifestV014 } from "./rules-manifest.ts";

/** growthFactor 13/10 的整数形式：base × 13^k / 10^k 只取整一次。 */
const GROWTH_NUMERATOR = 13;
const GROWTH_DENOMINATOR = 10;

/**
 * v0.14 动态价格：第 21 单位起 round_half_up(base × (13/10)^k)。
 * k=1、base=5 的 .5 边界（6.5）在 IEEE-754 中精确可表示，Math.round
 * 对正数即 round half up（6.5 → 7）。
 */
export function computeUnitCost(
  unitType: UnitType,
  populationBeforeSpawn: number,
  rules: RulesManifestV014,
): number {
  const { base, dynamicPricing } = rules.rules.unitCosts;
  const basePrice = base[unitType];
  const k = Math.max(0, Math.floor((populationBeforeSpawn - dynamicPricing.tierSize) / dynamicPricing.tierStep) + 1);
  if (k === 0) {
    return basePrice;
  }
  // 官方公式要求"exact fraction rounded only once at the end"：用整数乘方
  // 避免中间取整；k 极大（13^k 溢出 double）时饱和为 MAX_SAFE_INTEGER
  // （恒不可负担且 JSON 可序列化，防御性兜底，现实人口不可达）。
  const exactFraction = (basePrice * GROWTH_NUMERATOR ** k) / GROWTH_DENOMINATOR ** k;
  const price = Math.round(exactFraction);
  return Number.isFinite(price) ? price : Number.MAX_SAFE_INTEGER;
}

/**
 * spawn 结算统一价格入口：v0.11 走静态 base 价（workerCost/vanguardCost/
 * rangerCost），v0.14 走动态价。未知版本在 parse 层已 fail closed，此处
 * union 穷尽后只剩 v0.11 分支（编译期保证，不需要运行时默认分支）。
 */
export function spawnUnitCost(
  unitType: UnitType,
  populationBeforeSpawn: number,
  rules: RulesManifest,
): number {
  if (rules.rulesVersion === "v0.14") {
    return computeUnitCost(unitType, populationBeforeSpawn, rules);
  }
  const production = rules.rules.production;
  if (unitType === "WORKER") {
    return production.workerCost;
  }
  if (unitType === "VANGUARD") {
    return production.vanguardCost;
  }
  return production.rangerCost;
}
