/**
 * vs-farmer 端到端对打矩阵（对抗测试平台）：
 * 我方 SafetyPlanner（aggressive）vs 榜二 arena_farmer（经 opponent-bridge.py
 * 决策提取，随用随起 + pickle state-slot 跨 tick 记忆），多 seed 出胜率/资源/人口榜。
 *
 * 链路（平台层全量验证）：
 *   runEpisode → plannerFactory 注入 OpponentAdapter
 *   → tickStateToProto（官方 wire，UUID 适配）
 *   → ReferenceSubprocessDecider（spawnSync opponent-bridge.py --one-shot --state-slot）
 *   → CoreFarmer.choose_actions（官方 SDK Turn，零改动）
 *   → 官方 CommandPlan → protoPlanToPlan → 模拟器 settle
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/vs-farmer.mts
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runMatch, type TournEntry } from "../src/sim/opponent/tournament.ts";
import {
  OpponentAdapter,
  ReferenceSubprocessDecider,
} from "../src/sim/opponent/opponent-adapter.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const TICKS = 200;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

// 协调根 = arena-ts 的父目录（reference/arena-hero-agent + arena-hero-python 在其下）
const COORDINATION_ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "..", "..", "..");
const FARMER_REPO = join(COORDINATION_ROOT, "reference", "arena-hero-agent");
const SDK_REPO = join(COORDINATION_ROOT, "reference", "arena-hero-python");

/** 我方：SafetyPlanner aggressive。 */
const ours: TournEntry = {
  id: "mine",
  desc: "my safety aggressive",
  build: () => new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive", attackForce: 2 }),
};

/** 榜二：arena_farmer（官方 SDK 决策提取，独立 state-slot 保留记忆）。 */
function farmerEntry(seed: number): TournEntry {
  const slotDir = join(tmpdir(), "arena-vs-farmer");
  mkdirSync(slotDir, { recursive: true });
  return {
    id: `farmer-s${seed}`,
    desc: "arena_farmer",
    build: () => {
      const decider = new ReferenceSubprocessDecider({
        farmerRepoDir: FARMER_REPO,
        sdkRepoDir: SDK_REPO,
        farmerPath: join(FARMER_REPO, "arena_farmer.py"),
        stateSlot: join(slotDir, `slot-${seed}-${randomUUID()}.pkl`),
      });
      decider.ready = true;
      return new OpponentAdapter(decider, `farmer-s${seed}`, "farmer");
    },
  };
}

console.log(`我的 SafetyPlanner vs arena_farmer（${TICKS} ticks × ${SEEDS.length} seeds，v0.14 规则）`);
console.log("=".repeat(84));

const wins: { n: number } = { n: 0 };
const farmerWins: { n: number } = { n: 0 };
let draws = 0;
const myResources: number[] = [];
const farmerResources: number[] = [];

for (const seed of SEEDS) {
  const farmer = farmerEntry(seed);
  const result = runMatch(ours, farmer, seed, TICKS, MANIFEST_PATH, { validatePlans: false });
  const winner = result.winner;
  let label = "平局";
  if (winner === ours.id) { wins.n += 1; label = "胜者=我"; }
  else if (winner === farmer.id) { farmerWins.n += 1; label = "胜者=farmer"; }
  myResources.push(result.finalResources[ours.id]);
  farmerResources.push(result.finalResources[farmer.id]);
  console.log(
    `seed${String(seed).padStart(2)}: ${label} | 我 资源=${result.finalResources[ours.id]} 人口=${result.finalPopulation[ours.id]} 核活=${result.coreAlive[ours.id]}` +
      ` | farmer 资源=${result.finalResources[farmer.id]} 人口=${result.finalPopulation[farmer.id]} 核活=${result.coreAlive[farmer.id]} | events=${result.eventCount}`,
  );
}

const mean = (values: number[]): string => (values.reduce((s, v) => s + v, 0) / values.length).toFixed(1);
console.log("-".repeat(84));
console.log(`我的胜率=${(wins.n / SEEDS.length) * 100}%  farmer 胜率=${(farmerWins.n / SEEDS.length) * 100}%  平局=${draws}`);
console.log(`我 均资源=${mean(myResources)}  farmer 均资源=${mean(farmerResources)}`);
console.log("说明：farmers 每 seed 独立 state-slot（跨 tick 记忆），spawnSync 随用随起；胜率含随机性。");
