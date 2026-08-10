/**
 * vs-farmer 端到端对打矩阵（对抗测试平台）：
 * 我方 SafetyPlanner（aggressive）vs 参考对手（--opponent farmer|core），
 * 多 seed 出胜率/资源/人口榜。
 *
 * 对手桥（路线 A，2026-08-08）：PersistentSubprocessDecider——常驻 Python 进程
 * （worker + Atomics 同步 RPC），每 tick 不再重建进程/import pydantic，
 * 热往返 ~12ms（对比旧 spawnSync --one-shot 的 ~300ms）。state-slot 语义不变。
 *
 * 对手（--opponent）：
 *   farmer（默认）：榜二 arena_farmer（守矿型，CoreFarmer）
 *   core         ：VelvetEvening 社区双策略指南 agent（arena_core_agent.py，
 *                  5895 行，含搜索/战斗小队/核心推演——更接近真实对手）
 *
 * 链路（平台层全量验证）：
 *   runEpisode → plannerFactory 注入 OpponentAdapter
 *   → tickStateToProto（官方 wire，UUID 适配）
 *   → PersistentSubprocessDecider（常驻桥 + state-slot 跨 tick 记忆）
 *   → 对手决策（CoreFarmer.choose_actions / arena_core_agent.plan_turn，
 *     官方 SDK Turn，零改动）
 *   → 官方 CommandPlan → protoPlanToPlan → 模拟器 settle
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/vs-farmer.mts [--opponent core]
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runMatch, type TournEntry } from "../src/sim/opponent/tournament.ts";
import {
  OpponentAdapter,
  PersistentSubprocessDecider,
} from "../src/sim/opponent/opponent-adapter.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const TICKS = 200;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

const OPPONENT_ARG = process.argv.find((arg) => arg.startsWith("--opponent="));
const OPPONENT: "farmer" | "core" =
  OPPONENT_ARG?.slice("--opponent=".length) === "core" ? "core" : "farmer";

// 协调根 = arena-ts 的父目录（reference/official + reference/third-party 各仓库
// 在其下；bridge 按自身位置定位）
const COORDINATION_ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "..", "..", "..");
const FARMER_REPO = join(COORDINATION_ROOT, "reference", "third-party", "arena-hero-agent");
const SDK_REPO = join(COORDINATION_ROOT, "reference", "official", "arena-hero-python");

/** 我方：SafetyPlanner aggressive。 */
const ours: TournEntry = {
  id: "mine",
  desc: "my safety aggressive",
  build: () => new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive", attackForce: 2 }),
};

/** 参考对手（常驻桥 + 独立 state-slot 保留记忆）。 */
function opponentEntry(seed: number): TournEntry {
  const slotDir = join(tmpdir(), `arena-vs-${OPPONENT}`);
  mkdirSync(slotDir, { recursive: true });
  const opponentId = `${OPPONENT}-s${seed}`;
  return {
    id: opponentId,
    desc: OPPONENT === "core" ? "arena_core_agent" : "arena_farmer",
    build: () => {
      const decider = new PersistentSubprocessDecider({
        farmerRepoDir: FARMER_REPO,
        sdkRepoDir: SDK_REPO,
        farmerPath: join(FARMER_REPO, "arena_farmer.py"),
        stateSlot: join(slotDir, `slot-${seed}-${randomUUID()}.pkl`),
        agent: OPPONENT,
      });
      return new OpponentAdapter(decider, opponentId, OPPONENT);
    },
  };
}

const OPPONENT_LABEL = OPPONENT === "core" ? "arena_core_agent" : "arena_farmer";
console.log(`我的 SafetyPlanner vs ${OPPONENT_LABEL}（${TICKS} ticks × ${SEEDS.length} seeds，v0.14 规则，常驻桥）`);
console.log("=".repeat(84));

const wallStart = performance.now();
const wins: { n: number } = { n: 0 };
const opponentWins: { n: number } = { n: 0 };
let draws = 0;
const myResources: number[] = [];
const opponentResources: number[] = [];

for (const seed of SEEDS) {
  const opponent = opponentEntry(seed);
  const result = runMatch(ours, opponent, seed, TICKS, MANIFEST_PATH, { validatePlans: false });
  const winner = result.winner;
  let label = "平局";
  if (winner === ours.id) { wins.n += 1; label = "胜者=我"; }
  else if (winner === opponent.id) { opponentWins.n += 1; label = `胜者=${OPPONENT}`; }
  myResources.push(result.finalResources[ours.id]);
  opponentResources.push(result.finalResources[opponent.id]);
  console.log(
    `seed${String(seed).padStart(2)}: ${label} | 我 资源=${result.finalResources[ours.id]} 人口=${result.finalPopulation[ours.id]} 核活=${result.coreAlive[ours.id]}` +
      ` | ${OPPONENT} 资源=${result.finalResources[opponent.id]} 人口=${result.finalPopulation[opponent.id]} 核活=${result.coreAlive[opponent.id]} | events=${result.eventCount}`,
  );
}

const wallSec = (performance.now() - wallStart) / 1000;
const mean = (values: number[]): string => (values.reduce((s, v) => s + v, 0) / values.length).toFixed(1);
console.log("-".repeat(84));
console.log(`我的胜率=${(wins.n / SEEDS.length) * 100}%  ${OPPONENT} 胜率=${(opponentWins.n / SEEDS.length) * 100}%  平局=${draws}`);
console.log(`我 均资源=${mean(myResources)}  ${OPPONENT} 均资源=${mean(opponentResources)}`);
console.log(`总耗时 ${wallSec.toFixed(1)}s（${((wallSec * 1000) / (TICKS * SEEDS.length)).toFixed(1)}ms/tick，含首 tick 启动；旧 one-shot 桥 ~300ms/tick）`);
console.log(`说明：${OPPONENT_LABEL} 每 seed 独立 state-slot（跨 tick 记忆），常驻进程随用随起；胜率含随机性。`);
