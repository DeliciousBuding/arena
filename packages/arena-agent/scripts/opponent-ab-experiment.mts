/**
 * 榜二（arena_farmer）vs 我方 deterministic 同场景 A/B（2026-08-06，
 * Rust 线 R48 对照的本地复跑）：solo 场景（3 worker、5 矿、refill 65、
 * 300 ticks）——KPI：deposits / 终值 res / 终值 pop / harvests。
 *
 * 桥接：scripts/opponent-bridge.py（榜二零改动适配面，与 Rust 线协议对偶）
 * → src/sim/bridge/external-planner.ts（进程桥接决策器）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/opponent-ab-experiment.mts
 */
import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeResult } from "../src/sim/harness/episode.ts";
import { ExternalPlanner } from "../src/sim/bridge/external-planner.ts";
import { DeterministicPlanner } from "../src/planning/deterministic-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const OPPONENT_CMD = "python scripts/opponent-bridge.py --one-shot";
const SEEDS = [1, 2, 3];
const TICKS = 300;

function soloScenario(seed: number) {
  return {
    rulesVersion: "v0.11",
    tick: 1,
    seed,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 10,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [2, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[3, 0], [4, 0], [12, 0], [13, 0], [14, 0]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

interface EconomyKpis {
  deposits: number;
  harvests: number;
  finalResources: number;
  finalPopulation: number;
  moves: number;
  waits: number;
}

function kpisOf(result: EpisodeResult): EconomyKpis {
  const player = result.finalWorld.players.get("p1")!;
  let deposits = 0;
  let harvests = 0;
  let moves = 0;
  let waits = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "DEPOSIT_SUCCEEDED") deposits += 1;
      if (event.eventType === "HARVEST_SUCCEEDED") harvests += 1;
      if (event.eventType === "UNIT_MOVE_SUCCEEDED") moves += 1;
      if (event.eventType === "UNIT_MOVE_FAILED") waits += 1;
    }
  }
  return {
    deposits,
    harvests,
    finalResources: player.resources,
    finalPopulation: player.units.length,
    moves,
    waits,
  };
}

function runSide(plannerFactory: (tenantId: string) => InstanceType<typeof DeterministicPlanner> | ExternalPlanner, seed: number): EconomyKpis {
  const config: EpisodeConfig = {
    scenario: soloScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    refill: { everyTicks: 65 },
    tenants: [{ id: "p1", planner: "deterministic" }],
    plannerFactory,
  };
  return kpisOf(runEpisode(config));
}

console.log(`榜二 vs 我方（solo，${TICKS} ticks × ${SEEDS.length} seeds，refill 65）`);
console.log("=".repeat(84));

const ours: EconomyKpis[] = [];
const theirs: EconomyKpis[] = [];
for (const seed of SEEDS) {
  const ourKpi = runSide(() => new DeterministicPlanner(), seed);
  const opponentPlanner = new ExternalPlanner({ command: OPPONENT_CMD });
  const theirKpi = runSide(() => opponentPlanner, seed);
  ours.push(ourKpi);
  theirs.push(theirKpi);
}

const mean = (values: number[]): string => (values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(1);
const output = [
  `榜二 vs 我方（solo，${TICKS} ticks × ${SEEDS.length} seeds，refill 65）`,
  "=".repeat(84),
  `我方 deterministic: 均 deposits=${mean(ours.map((k) => k.deposits))} harvest=${mean(ours.map((k) => k.harvests))} res=${mean(ours.map((k) => k.finalResources))} pop=${mean(ours.map((k) => k.finalPopulation))} moves=${mean(ours.map((k) => k.moves))}`,
  `榜二 arena_farmer: 均 deposits=${mean(theirs.map((k) => k.deposits))} harvest=${mean(theirs.map((k) => k.harvests))} res=${mean(theirs.map((k) => k.finalResources))} pop=${mean(theirs.map((k) => k.finalPopulation))} moves=${mean(theirs.map((k) => k.moves))}`,
].join("\n");
console.log(output);
writeFileSync("opponent-ab-result.txt", output + "\n");
