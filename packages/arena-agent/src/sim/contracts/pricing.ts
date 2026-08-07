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
 * 实机验证（2026-08-07 生产 t1）：pop 24 RANGER 实收 16、pop 25 VANGUARD
 * 实收 13（CORE_SPAWN_SUCCEEDED.values.cost）——live 动态价与公式一致。
 *
 * 版本隔离：computeUnitCost 只接受 v0.14 manifest（union 编译期限定）；
 * spawnUnitCost 按 rulesVersion 分派，v0.11 路径行为与历史实现逐字节一致。
 */

import { DYNAMIC_PRICING, unitSpawnCost } from "../../domain/pricing.ts";
import { BASE_COST as DOMAIN_BASE } from "../../domain/pricing.ts";
import type { UnitType } from "../../domain/model.ts";
import type { RulesManifest, RulesManifestV014 } from "./rules-manifest.ts";

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
  // 公式唯一实现在 domain/pricing.ts（决策侧与 sim 共用，防两处漂移）；
  // 这里校验 manifest 参数与 spec 常量一致（fail-fast 抓 manifest 漂移）。
  const { base, dynamicPricing } = rules.rules.unitCosts;
  if (
    base[unitType] !== DOMAIN_BASE[unitType] ||
    dynamicPricing.tierSize !== DYNAMIC_PRICING.tierSize ||
    dynamicPricing.tierStep !== DYNAMIC_PRICING.tierStep
  ) {
    throw new Error(
      `v0.14 unitCosts manifest 与 spec 常量不一致（${String(unitType)} base=${String(base[unitType])} ` +
        `tierSize=${String(dynamicPricing.tierSize)} tierStep=${String(dynamicPricing.tierStep)}）`,
    );
  }
  return unitSpawnCost(unitType, populationBeforeSpawn);
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
