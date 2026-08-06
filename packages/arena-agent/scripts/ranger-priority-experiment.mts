/**
 * 防守 Ranger 目标优先级实验（2026-08-06，竞品 hierarchical threat assessment 对照）：
 * 同距离双目标（敌 RANGER + 敌 WORKER 均在射程内）——
 * 现状：WORKER 优先（断经济）；候选：RANGER 优先（远程威胁消除）。
 * 场景：p1 守家 Ranger [3,0]；p2 敌 Ranger [4,0]（会射击 p1）+ 敌 Worker [5,0]（采 [5,1]）。
 * KPI：p1 Ranger 最终 hp（先杀敌 Ranger → 无损；先杀敌 Worker → 被敌 Ranger 白打）、
 * 敌军事存活。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/ranger-priority-experiment.mts
 */
import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "ranger-priority-result.txt";

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
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [3, 0], hp: 2, unitType: "RANGER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [2, 0], hp: 2, unitType: "RANGER", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 10,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [10, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "55555555-5555-5555-5555-555555555551", owner: "p2", position: [4, 0], hp: 2, unitType: "RANGER", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555552", owner: "p2", position: [4, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: {
      obstacles: [],
      resources: [[5, 1], [6, 1]],
    },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const SEEDS = [1, 2, 3];
const TICKS = 120;

function runVariant(seed: number): { p1RangerHp: number; p2MilitaryAlive: number; firstShots: string[] } {
  const config: EpisodeConfig = {
    scenario: duelScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      { id: "p1", planner: "safety" },
      { id: "p2", planner: "safety" },
    ],
  };
  const result = runEpisode(config);
  const p1 = result.finalWorld.players.get("p1")!;
  const p2 = result.finalWorld.players.get("p2")!;
  const p1Ranger = p1.units.find((u) => u.unitType === "RANGER");
  const p2Military = p2.units.filter((u) => u.unitType !== "WORKER").length;
  // p1 Ranger 前几次 SHOOT 的目标（确认先杀谁）
  const firstShots: string[] = [];
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "SHOOT" && String(event.actorId).startsWith("2222")) {
        firstShots.push(`${record.tick}:${String(event.targetId ?? "?").slice(0, 4)}`);
        if (firstShots.length >= 4) break;
      }
    }
    if (firstShots.length >= 4) break;
  }
  return { p1RangerHp: p1Ranger?.hp ?? 0, p2MilitaryAlive: p2Military, firstShots };
}

const rows: string[] = [];
rows.push(`防守 Ranger 优先级实验（${TICKS} ticks × ${SEEDS.length} seeds，RANGER/WORKER 同距混编）`);
rows.push("=".repeat(80));
for (const seed of SEEDS) {
  const o = runVariant(seed);
  rows.push(`seed ${seed}: p1 Ranger hp=${o.p1RangerHp} 敌军事存活=${o.p2MilitaryAlive} 首射=${JSON.stringify(o.firstShots)}`);
}
const output = rows.join("\n");
console.log(output);
writeFileSync(RESULT_FILE, output + "\n");
