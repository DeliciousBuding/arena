/**
 * Worker 满载吞吐实验（2026-08-06，用户导向"获取最多的资源才是目的"）：
 * 场景 = 远矿 20 格外 10 格资源（往返成本大，满载收益放大）+ 无 refill。
 * 修改前：cargo>0 即回仓（每趟运 1）vs 修改后：cargo 满 2 才回仓（每趟运 2）。
 * KPI：累计 harvest 数（采集吞吐）、最终存量 res、t100 时点 res（早期经济速度）。
 * 预期：满载后累计 harvest ≈ 1.5-2×（往返减半）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/cargo-throughput-experiment.mts
 */
import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "cargo-throughput-result.txt";

function farMineScenario(seed: number) {
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
    ],
    terrain: {
      obstacles: [],
      resources: [[20, 0], [21, 0], [22, 0], [23, 0], [24, 0], [20, 1], [21, 1], [22, 1], [23, 1], [24, 1]],
    },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const POLICY: MacroPolicy = {
  posture: "balanced",
  workerTarget: 4,
  militaryRatio: 0,
  focusRegion: null,
  attackPriority: null,
};

const SEEDS = [1, 2];
const TICKS = 400;

interface Outcome {
  harvestsBy200: number;
  depositsBy200: number;
  resFinal: number;
  harvests: number;
  pop: number;
}

function runVariant(seed: number): Outcome {
  const config: EpisodeConfig = {
    scenario: farMineScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [{ id: "p1", planner: "deterministic", policy: POLICY } as EpisodeTenant],
  };
  const result = runEpisode(config);
  const p1 = result.finalWorld.players.get("p1")!;
  let harvests = 0;
  let harvestsBy200 = 0;
  let depositsBy200 = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "HARVEST_SUCCEEDED") {
        harvests += 1;
        if (record.tick <= 200) harvestsBy200 += 1;
      }
      if (event.eventType === "DEPOSIT_SUCCEEDED" && record.tick <= 200) depositsBy200 += 1;
    }
  }
  return { res100: harvestsBy200, resFinal: p1.resources, harvests, pop: p1.units.length, depositsBy200 };
}

const rows: string[] = [];
rows.push(`Worker 满载吞吐实验（${TICKS} ticks × ${SEEDS.length} seeds，远矿 20 格 10 格资源）`);
rows.push("=".repeat(80));
for (const seed of SEEDS) {
  const o = runVariant(seed);
  rows.push(`seed ${seed}: t200 累计harvest=${o.harvestsBy200} t200 DEPOSIT=${o.depositsBy200} 最终 res=${o.resFinal} 总harvest=${o.harvests} pop=${o.pop}`);
}
const output = rows.join("\n");
console.log(output);
writeFileSync(RESULT_FILE, output + "\n");
