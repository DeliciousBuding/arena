/**
 * 补员 reserve × solo 刷新平衡实验（2026-08-06，第十轮）：
 * 生产 t2 坐实死锁平衡——res 恒 5 < WORKER_SPAWN_COST(5) + reserve(2) = 7
 * → 永不 SPAWN → pop 3 冻结（供给≈upkeep）。本实验复刻 t2 形态
 * （3 worker、res=5、solo + 校准 refill），对照 spawnReserve=2（生产默认）
 * vs 0（突破平衡扩编）：
 * - reserve=2：预期复现生产冻结（pop 3、res 4-5）
 * - reserve=0：res≥5 即产 worker → pop 增长 → 采集加速突破供给平衡？
 *   若采集增益 > upkeep 负担 → 总资源更高（资源获取最大化）；否则崩。
 * KPI：t400 最终 res、pop、累计 harvest、SPAWN 次数。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/spawn-reserve-experiment.mts
 */
import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import { DeterministicPlanner } from "../src/planning/deterministic-planner.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "spawn-reserve-result.txt";

function scenario(seed: number) {
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
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
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

function runVariant(seed: number, everyTicks: number): { res: number; harvests: number; pop: number; spawns: number } {
  const config: EpisodeConfig = {
    scenario: scenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    refill: { everyTicks },
    tenants: [{ id: "p1", planner: "deterministic", policy: POLICY } as EpisodeTenant],
  };
  const result = runEpisode(config);
  const p1 = result.finalWorld.players.get("p1")!;
  let harvests = 0;
  let spawns = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "HARVEST_SUCCEEDED") harvests += 1;
      if (event.eventType === "SPAWN_SUCCEEDED") spawns += 1;
    }
  }
  return { res: p1.resources, harvests, pop: p1.units.length, spawns };
}

const rows: string[] = [];
rows.push(`refill cadence 校准扫描（${TICKS} ticks × ${SEEDS.length} seeds，solo，生产默认 planner）`);
rows.push("=".repeat(84));
for (const everyTicks of [50, 75, 100]) {
  let resSum = 0;
  let harvestSum = 0;
  let popSum = 0;
  const details: string[] = [];
  for (const seed of SEEDS) {
    const o = runVariant(seed, everyTicks);
    resSum += o.res;
    harvestSum += o.harvests;
    popSum += o.pop;
    details.push(`seed ${seed}: res=${o.res} harvest=${o.harvests} pop=${o.pop} spawn=${o.spawns}`);
  }
  rows.push(
    `everyTicks=${everyTicks}: 均res=${(resSum / SEEDS.length).toFixed(1)} 均harvest=${(harvestSum / SEEDS.length).toFixed(1)} 均pop=${(popSum / SEEDS.length).toFixed(1)}`,
  );
  for (const d of details) rows.push(`  ${d}`);
}
const output = rows.join("\n");
console.log(output);
writeFileSync(RESULT_FILE, output + "\n");
