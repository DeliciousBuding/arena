/**
 * refill 敏感性实验（2026-08-08，M4-1 更新）：
 * 官方 refill 每 4 tick 按 32×32 chunk 配额补自然点（placement seed 是
 * server-secret）；模拟器实现自洽确定性 chunk-quota 空槽模型（行为等价）。
 * 本脚本量化"资源再生节奏"对胜率/资源曲线的影响：
 *   档位：关（null）/ 65（压力测试档）/ 16 / 4（官方 cadence）
 * 每档 8 seeds × 200 ticks vs arena_farmer；seed1 每档落盘对局记录。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/refill-sensitivity.mts
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
const COORDINATION_ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "..", "..", "..");
const FARMER_REPO = join(COORDINATION_ROOT, "reference", "arena-hero-agent");
const SDK_REPO = join(COORDINATION_ROOT, "reference", "arena-hero-python");
// 落盘根：协调根下 data/runs（root 仓库 untracked 运行时输出）
const RECORD_ROOT = join(COORDINATION_ROOT, "data", "runs", "sim", "refill-sensitivity");

/** 档位：label → refillEveryTicks（null = 关闭）。 */
const TIERS: readonly { label: string; everyTicks: number | null }[] = [
  { label: "off", everyTicks: null },
  { label: "65(现状)", everyTicks: 65 },
  { label: "16", everyTicks: 16 },
  { label: "4(官方)", everyTicks: 4 },
];

const ours: TournEntry = {
  id: "mine",
  desc: "my safety aggressive",
  build: () => new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive", attackForce: 2 }),
};

function farmerEntry(seed: number): TournEntry {
  const slotDir = join(tmpdir(), "arena-refill-sens");
  mkdirSync(slotDir, { recursive: true });
  return {
    id: `farmer-s${seed}`,
    desc: "arena_farmer",
    build: () => {
      const decider = new PersistentSubprocessDecider({
        farmerRepoDir: FARMER_REPO,
        sdkRepoDir: SDK_REPO,
        farmerPath: join(FARMER_REPO, "arena_farmer.py"),
        stateSlot: join(slotDir, `slot-${seed}-${randomUUID()}.pkl`),
      });
      return new OpponentAdapter(decider, `farmer-s${seed}`, "farmer");
    },
  };
}

const mean = (values: number[]): string => (values.reduce((s, v) => s + v, 0) / values.length).toFixed(1);

console.log(`refill 敏感性：我的 SafetyPlanner vs arena_farmer（${TICKS} ticks × ${SEEDS.length} seeds）`);
console.log("=".repeat(100));

for (const tier of TIERS) {
  mkdirSync(RECORD_ROOT, { recursive: true });
  const wallStart = performance.now();
  const wins = { n: 0 };
  const farmerWins = { n: 0 };
  const myResources: number[] = [];
  const farmerResources: number[] = [];
  for (const seed of SEEDS) {
    const recordTo = seed === 1 ? join(RECORD_ROOT, `refill-${tier.label}-seed1.jsonl`) : undefined;
    const farmer = farmerEntry(seed);
    const result = runMatch(ours, farmer, seed, TICKS, MANIFEST_PATH, {
      validatePlans: false,
      refillEveryTicks: tier.everyTicks,
      ...(recordTo === undefined ? {} : { recordTo }),
    });
    if (result.winner === ours.id) wins.n += 1;
    else if (result.winner === farmer.id) farmerWins.n += 1;
    myResources.push(result.finalResources[ours.id]);
    farmerResources.push(result.finalResources[farmer.id]);
  }
  const wallSec = (performance.now() - wallStart) / 1000;
  console.log(
    `refill=${tier.label.padEnd(8)} | 我胜率=${((wins.n / SEEDS.length) * 100).toFixed(0).padStart(3)}%` +
      `  farmer=${((farmerWins.n / SEEDS.length) * 100).toFixed(0).padStart(3)}%` +
      ` | 我均资源=${mean(myResources).padStart(5)}  farmer均资源=${mean(farmerResources).padStart(5)}` +
      ` | ${wallSec.toFixed(1)}s`,
  );
}
console.log("-".repeat(100));
console.log(`落盘记录（seed1/档）：${RECORD_ROOT}`);
console.log("说明：refill=关时矿采空即枯竭；4(官方) 为官方 cadence——chunk-quota 空槽模型（确定性随机空槽，行为等价；placement seed 自洽，非官方 seed）。");
