/**
 * Core 迁移（PRE_EVADE-lite）对打实验（2026-08-06）：
 * p1 无守卫（纯 Core + 2 worker）vs p2 aggressive Vanguard 前压打 Core。
 * 对照：coreEvade=false（历史：Core 原地挨打）vs coreEvade=true（12 格内敌
 * → START_MOVE 远离，P06 结算 4 tick/格）。
 * KPI：p1 Core 被命中 tick 数（CORE_DAMAGED）、Core 存活与否、p2 Core 存活。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/core-evade-experiment.mts
 */
import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "core-evade-result.txt";

function duelScenario(seed: number) {
  return {
    rulesVersion: "v0.11",
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 10,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 10,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [24, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          // 远距开局（18 格 > 12 格触发阈值）：TTR≤16 应比 12 格固定提前 2 tick 触发
          { id: "55555555-5555-5555-5555-555555555551", owner: "p2", position: [18, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555552", owner: "p2", position: [19, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555553", owner: "p2", position: [23, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[2, 0], [3, 0], [19, 1]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const SEEDS = [1, 2, 3];
const TICKS = 200;

function runVariant(coreEvade: boolean, coreEvadeTtr: boolean, seed: number): { coreHits: number; p1CoreAlive: boolean; p2CoreAlive: boolean } {
  const config: EpisodeConfig = {
    scenario: duelScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      { id: "p1", planner: "safety", plannerConfig: { coreEvade, coreEvadeTtr } } as EpisodeTenant,
      { id: "p2", planner: "safety", plannerConfig: { aggression: "aggressive" } } as EpisodeTenant,
    ],
  };
  const result = runEpisode(config);
  let coreHits = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "CORE_DAMAGED" && String(event.targetId).startsWith("1111")) coreHits += 1;
    }
  }
  const p1 = result.finalWorld.players.get("p1")!;
  const p2 = result.finalWorld.players.get("p2")!;
  return { coreHits, p1CoreAlive: p1.core !== null, p2CoreAlive: p2.core !== null };
}

const rows: string[] = [];
rows.push(`Core 迁移对打实验（${TICKS} ticks × ${SEEDS.length} seeds，p1 无守卫 vs p2 双 Vanguard 前压）`);
rows.push("=".repeat(80));
for (const [label, evade, ttr] of [
  ["coreEvade=false（现状）", false, false],
  ["coreEvade=true（12格）", true, false],
  ["coreEvade+TTR≤16", true, true],
] as const) {
  const outcomes = SEEDS.map((seed) => runVariant(evade, ttr, seed));
  const avgHits = outcomes.reduce((s, o) => s + o.coreHits, 0) / outcomes.length;
  const p1Survive = outcomes.filter((o) => o.p1CoreAlive).length;
  const p2Survive = outcomes.filter((o) => o.p2CoreAlive).length;
  rows.push(
    `${label.padEnd(26)} | Core 被命中(avg)=${avgHits.toFixed(1)} | p1 Core 存活=${p1Survive}/${SEEDS.length} | p2 Core 存活=${p2Survive}/${SEEDS.length}`,
  );
  for (const seed of SEEDS) {
    const o = outcomes[seed - 1]!;
    rows.push(`  seed ${seed}: hits=${o.coreHits} p1存活=${o.p1CoreAlive} p2存活=${o.p2CoreAlive}`);
  }
}
const output = rows.join("\n");
console.log(output);
writeFileSync(RESULT_FILE, output + "\n");
