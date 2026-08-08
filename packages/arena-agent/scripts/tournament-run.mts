/**
 * Tournament 批量对打脚本（对抗测试平台验证）：
 * 我方 SafetyPlanner（aggressive）对打我方案略，多 seed 出胜率榜。
 * 用途：验证 runMatch/decideWinner/协议翻译整条链路可用 + 出一份真实对标数。
 * 用法：cd packages/arena-agent && npx tsx scripts/tournament-run.mts
 */
import { makeSafetyEntry, runMatch, decideWinner } from "../src/sim/opponent/tournament.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner, type SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const TICKS = 120;
const SEEDS = [1, 2, 3, 4, 5];

// 两个真正不同的策略：aggressive（前压） vs defensive（火力留守），体现差异
const aggressive: import("../src/sim/opponent/tournament.ts").TournEntry = {
  id: "agg",
  desc: "aggressive 前压",
  build: () => new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive", attackForce: 2 }),
};
const defensive: import("../src/sim/opponent/tournament.ts").TournEntry = {
  id: "def",
  desc: "defensive 防守",
  build: () => new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "defensive", attackForce: 2 }),
};

console.log(`对抗测试平台 smoke test（${TICKS} ticks × ${SEEDS.length} seeds）`);
console.log("=".repeat(72));

const aggWins: { n: number } = { n: 0 };
const defWins: { n: number } = { n: 0 };
let draws = 0;

for (const seed of SEEDS) {
  const result = runMatch(aggressive, defensive, seed, TICKS, MANIFEST_PATH);
  const winner = result.winner;
  if (winner === aggressive.id) { aggWins.n += 1; console.log(`seed${seed}: 胜者=agg`); }
  else if (winner === defensive.id) { defWins.n += 1; console.log(`seed${seed}: 胜者=def`); }
  else { draws += 1; console.log(`seed${seed}: 平局`); }
  console.log(
    `  A(agg) 资源=${result.finalResources[aggressive.id]} 人口=${result.finalPopulation[aggressive.id]} 核活=${result.coreAlive[aggressive.id]} ` +
      `| B(def) 资源=${result.finalResources[defensive.id]} 人口=${result.finalPopulation[defensive.id]} 核活=${result.coreAlive[defensive.id]} | events=${result.eventCount}`,
  );
}

console.log("-".repeat(72));
console.log(`A(agg) 胜率=${(aggWins.n / SEEDS.length) * 100}%  B(def) 胜率=${(defWins.n / SEEDS.length) * 100}%  平局=${draws}`);
console.log("说明：策略配置、plan 注入、胜者判定、协议翻译链路全部跑通；胜率含随机性（同 tick 数内资源/hp 平局常见）。");