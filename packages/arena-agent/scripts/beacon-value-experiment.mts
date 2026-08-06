/**
 * beacon 2x 采集收益上界实验（2026-08-06，第十二轮）：
 * 生产 t2 beacon 被 270 格外对手携带（status null/carrier null/位置移动），
 * 现阶段不可达——"派工人去拾 beacon"需要往返 540 tick。本实验量化
 * 2x 采集的收益上界：beacon 开局在 worker 同格（立即拾取、之后 2x 采）
 * vs 270 格（永远捡不到）——res/harvest 差异 = 主动拾取的最大潜在收益。
 * 供给用生产校准 cadence（65 tick/格，第十一轮）。
 * KPI：t500 最终 res、累计 harvest、pop。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/beacon-value-experiment.mts
 */
import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "beacon-value-result.txt";

function scenario(seed: number, beaconPosition: [number, number]) {
  return {
    rulesVersion: "v0.11",
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 5,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [2, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: {
      obstacles: [],
      resources: [[3, 0], [4, 0], [5, 0], [40, 0], [41, 0], [42, 0]],
    },
    beacon: { position: beaconPosition, status: "GROUND", carrierId: null },
  };
}

const POLICY: MacroPolicy = {
  posture: "balanced",
  workerTarget: 8,
  militaryRatio: 0.3,
  focusRegion: null,
  attackPriority: null,
};

const SEEDS = [1, 2, 3];
const TICKS = 500;

function runVariant(seed: number, beaconPosition: [number, number]): { res: number; harvests: number; pop: number; pickups: number } {
  const config: EpisodeConfig = {
    scenario: scenario(seed, beaconPosition),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    // 生产校准 cadence（第十一轮：真实 solo 供给 ≈60-70 tick/格）
    refill: { everyTicks: 65 },
    tenants: [{ id: "p1", planner: "deterministic", policy: POLICY } as EpisodeTenant],
  };
  const result = runEpisode(config);
  const p1 = result.finalWorld.players.get("p1")!;
  let harvests = 0;
  let pickups = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "HARVEST_SUCCEEDED") harvests += 1;
      if (event.eventType === "BEACON_PICKED_UP") pickups += 1;
    }
  }
  return { res: p1.resources, harvests, pop: p1.units.length, pickups };
}

const rows: string[] = [];
rows.push(`beacon 2x 收益上界（${TICKS} ticks × ${SEEDS.length} seeds，solo + refill everyTicks=65 生产校准）`);
rows.push("=".repeat(84));
for (const [label, beaconPosition] of [
  ["beacon@1格(可拾取)", [1, 0] as [number, number]],
  ["beacon@270格(不可达)", [270, 0] as [number, number]],
]) {
  let resSum = 0;
  let harvestSum = 0;
  let popSum = 0;
  let pickupSum = 0;
  const details: string[] = [];
  for (const seed of SEEDS) {
    const o = runVariant(seed, beaconPosition);
    resSum += o.res;
    harvestSum += o.harvests;
    popSum += o.pop;
    pickupSum += o.pickups;
    details.push(`seed ${seed}: res=${o.res} harvest=${o.harvests} pop=${o.pop} pickup=${o.pickups}`);
  }
  rows.push(
    `${label}: 均res=${(resSum / SEEDS.length).toFixed(1)} 均harvest=${(harvestSum / SEEDS.length).toFixed(1)} 均pop=${(popSum / SEEDS.length).toFixed(1)} 均pickup=${(pickupSum / SEEDS.length).toFixed(1)}`,
  );
  for (const d of details) rows.push(`  ${d}`);
}
const output = rows.join("\n");
console.log(output);
writeFileSync(RESULT_FILE, output + "\n");
