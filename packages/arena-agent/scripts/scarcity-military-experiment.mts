/**
 * 枯竭供给下军事化收益实验（2026-08-06，第二十六轮）：
 * 生产 t1 实证枯竭对局（harvest 0.014/tick vs t2 0.039——3 倍差距）+ 军事化
 * 应对（Vanguard 拆敌 CORE）。此前 militaryRatio 实验在富供给（refill 65）
 * 下无区分（供给掩盖军事价值）——本实验用枯竭供给（refill everyTicks=300
 * 慢供给）验证军事化的真实价值：拆 CORE 掠夺 vs 纯经济。
 * 场景：p1 aggressive/core（拆家）vs p2 balanced/null（纯经济）——双人枯竭。
 * KPI：p1 拆 CORE 次数、p1/p2 res、pop。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/scarcity-military-experiment.mts
 */
import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "scarcity-military-result.txt";

function scenario(seed: number) {
  return {
    rulesVersion: "v0.11",
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 30,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [1, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [2, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 30,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [20, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "55555555-5555-5555-5555-555555555551", owner: "p2", position: [21, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555552", owner: "p2", position: [20, 1], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[3, 0], [4, 0], [19, 0], [18, 0], [25, 0], [26, 0], [-5, -5], [-6, -6]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const SEEDS = [1, 2, 3];
const TICKS = 400;

function runVariant(military: boolean, seed: number): { res1: number; res2: number; pop1: number; pop2: number; core2Destroyed: boolean } {
  const p1Policy: MacroPolicy = military
    ? { posture: "aggressive", workerTarget: 6, militaryRatio: 0.4, focusRegion: null, attackPriority: "core" }
    : { posture: "balanced", workerTarget: 6, militaryRatio: 0, focusRegion: null, attackPriority: null };
  const p2Policy: MacroPolicy = { posture: "balanced", workerTarget: 6, militaryRatio: 0, focusRegion: null, attackPriority: null };
  const config: EpisodeConfig = {
    scenario: scenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    // 枯竭供给（300 tick 慢补回——模拟 t1 枯竭对局）
    refill: { everyTicks: 300 },
    tenants: [
      { id: "p1", planner: "deterministic", policy: p1Policy } as EpisodeTenant,
      { id: "p2", planner: "deterministic", policy: p2Policy } as EpisodeTenant,
    ],
  };
  const result = runEpisode(config);
  const p1 = result.finalWorld.players.get("p1")!;
  const p2 = result.finalWorld.players.get("p2")!;
  return { res1: p1.resources, res2: p2.resources, pop1: p1.units.length, pop2: p2.units.length, core2Destroyed: p2.core === null };
}

const rows: string[] = [];
rows.push(`枯竭供给军事化实验（${TICKS} ticks × ${SEEDS.length} seeds，refill everyTicks=300，p1 军事化 vs p2 纯经济）`);
rows.push("=".repeat(84));
for (const [label, military] of [
  ["p1 纯经济（balanced/0）", false],
  ["p1 军事化（aggressive/core）", true],
] as const) {
  let res1 = 0; let res2 = 0; let pop1 = 0; let pop2 = 0; let destroyed = 0;
  const details: string[] = [];
  for (const seed of SEEDS) {
    const o = runVariant(military, seed);
    res1 += o.res1; res2 += o.res2; pop1 += o.pop1; pop2 += o.pop2;
    if (o.core2Destroyed) destroyed += 1;
    details.push(`seed ${seed}: p1res=${o.res1} p2res=${o.res2} p1pop=${o.pop1} p2pop=${o.pop2} p2core毁=${o.core2Destroyed}`);
  }
  rows.push(
    `${label}: 均p1res=${(res1 / SEEDS.length).toFixed(1)} 均p2res=${(res2 / SEEDS.length).toFixed(1)} 均pop=${(pop1 / SEEDS.length).toFixed(1)}/${(pop2 / SEEDS.length).toFixed(1)} p2Core摧毁=${destroyed}/${SEEDS.length}`,
  );
  for (const d of details) rows.push(`  ${d}`);
}
const output = rows.join("\n");
console.log(output);
writeFileSync(RESULT_FILE, output + "\n");
