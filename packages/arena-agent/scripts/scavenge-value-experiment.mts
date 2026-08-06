/**
 * 军事打野经济贡献实验（2026-08-06，第三十七轮）：
 * 生产 t1 画像显示 vanguard_scavenge 180 次（枯竭时 Vanguard 巡逻外扩探索）——
 * 打野不采集（Vanguard 无 cargo），价值假设 = 探索发现新矿（视野内资源格被
 * 记忆）+ 压制。对照设计：
 * A = aggressive/0.3（有军事打野）vs B = balanced/0（纯经济无军事）——
 * 枯竭（refill 300）+ 矿分布在 25-40 格外多方位——打野发现价值 vs 军事负担
 * （upkeep 2/tick？）。
 * KPI：res（400 tick）、harvest 次数、军事发现资源格（worker 视野外资源是否
 * 被军事巡逻发现——模拟器内 worker/vanguard 视野共享 player 级可见集——
 * 用"资源格首次可见 tick"间接衡量）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/scavenge-value-experiment.mts
 */
import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "scavenge-value-result.txt";

function scenario(seed: number, militaryCount: number) {
  return {
    rulesVersion: "v0.11",
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 30,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          ...Array.from({ length: militaryCount }, (_, i) => ({
            id: `22222222-2222-2222-2222-2222222222${String(i + 1).padStart(2, "0")}`,
            owner: "p1", position: [1 + i, 0] as [number, number], hp: 4, unitType: "VANGUARD", cargo: 0,
          })),
          { id: "22222222-2222-2222-2222-222222222299", owner: "p1", position: [3, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222298", owner: "p1", position: [4, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222297", owner: "p1", position: [5, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 10,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [60, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [55, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    // 矿分布在 25-40 格外（近矿只有 2 个 [2,0]/[3,1]——枯竭后打野探索找远矿）
    terrain: {
      obstacles: [],
      resources: [[2, 0], [3, 1], [25, 5], [30, -8], [35, 10], [-28, 6], [-32, -5], [40, 0], [45, -3], [-40, 0], [22, -20], [-25, 15]],
    },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const SEEDS = [1, 2];
const TICKS = 400;

function runVariant(militaryCount: number, seed: number): { res: number; harvests: number; firstFarMineTick: number | null } {
  const config: EpisodeConfig = {
    scenario: scenario(seed, militaryCount),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    refill: { everyTicks: 300 },
    tenants: [
      {
        id: "p1",
        planner: "safety",
        plannerConfig: { aggression: militaryCount > 0 ? "aggressive" : "defensive" },
        policy: {
          posture: militaryCount > 0 ? "aggressive" : "balanced",
          workerTarget: 6,
          militaryRatio: militaryCount > 0 ? 0.3 : 0,
          focusRegion: null,
          attackPriority: null,
        },
      } as EpisodeTenant,
      { id: "p2", planner: "safety" } as EpisodeTenant,
    ],
  };
  const result = runEpisode(config);
  let harvests = 0;
  let firstFarMineTick: number | null = null;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "HARVEST_SUCCEEDED") harvests += 1;
      if (event.eventType === "RESOURCE_FOUND" && firstFarMineTick === null) firstFarMineTick = record.tick;
    }
  }
  const p1 = result.finalWorld.players.get("p1")!;
  return { res: p1.resources, harvests, firstFarMineTick };
}

const rows: string[] = [];
rows.push(`军事打野经济贡献（${TICKS} ticks × ${SEEDS.length} seeds，枯竭 refill 300，矿 25-40 格多方）`);
rows.push("=".repeat(88));
for (const count of [0, 1, 2]) {
  let resSum = 0;
  let harvestSum = 0;
  const details: string[] = [];
  for (const seed of SEEDS) {
    const o = runVariant(count, seed);
    resSum += o.res;
    harvestSum += o.harvests;
    details.push(`seed ${seed}: res=${o.res} harvest=${o.harvests} 首个远矿发现tick=${o.firstFarMineTick}`);
  }
  rows.push(
    `军事=${count}（${count === 0 ? "纯经济" : "aggressive 打野"}）: 均res=${(resSum / SEEDS.length).toFixed(1)} 均harvest=${(harvestSum / SEEDS.length).toFixed(1)}`,
  );
  for (const d of details) rows.push(`  ${d}`);
}
const output = rows.join("\n");
console.log(output);
writeFileSync(RESULT_FILE, output + "\n");
