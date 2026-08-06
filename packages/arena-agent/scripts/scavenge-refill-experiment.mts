/**
 * 打野 × refill 收益实验（2026-08-06，第八轮）：
 * 生产坐实真实服务器低频资源刷新（t2 visibleResourceCellCount 非零 14.3%）。
 * 场景：单人 aggressive + 近似 refill（EpisodeConfig.refill）——近矿采尽后
 * 远矿（40 格）按 cadence 刷新。打野（第一轮修复）Vanguard 外扩发现刷新矿 →
 * worker 采到 → 经济恢复；对照 = 打野关闭（Vanguard 守家，刷新矿永远在
 * 视野外——worker 巡逻也覆盖 40 格？worker 环 5 巡逻覆盖——为区分度，场景
 * 设刷新矿在 40 格且 worker 少（2 只，巡逻慢））。
 * KPI：t400 最终 res、累计 harvest、Vanguard maxDist（外扩深度）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/scavenge-refill-experiment.mts
 */
import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "scavenge-refill-result.txt";

function scenario(seed: number) {
  return {
    rulesVersion: "v0.11",
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 10,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [1, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [2, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: {
      obstacles: [],
      resources: [[3, 0], [4, 0], [40, 0], [41, 0], [42, 0]],
    },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const POLICY: MacroPolicy = {
  posture: "aggressive",
  workerTarget: 4,
  militaryRatio: 0.3,
  focusRegion: null,
  attackPriority: null,
};

const SEEDS = [1, 2];
const TICKS = 400;

function runVariant(seed: number, exploreRadius: number): { res: number; harvests: number; vgMaxDist: number; pop: number } {
  const config: EpisodeConfig = {
    scenario: scenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    // 校准 refill cadence：生产校准值 ≈65 tick/格（第十一轮：真实 solo 供给
    // 介于 50（res 11 正积累）与 75（res 3 负）之间）。
    refill: { everyTicks: 65 },
    tenants: [
      {
        id: "p1",
        planner: "deterministic",
        policy: POLICY,
        plannerConfig: { exploreRadius },
      } as EpisodeTenant,
    ],
  };
  const result = runEpisode(config);
  const p1 = result.finalWorld.players.get("p1")!;
  let harvests = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "HARVEST_SUCCEEDED") harvests += 1;
    }
  }
  const vgMaxDist = Math.max(
    0,
    ...p1.units
      .filter((u) => u.unitType === "VANGUARD")
      .map((u) => Math.abs(u.position[0]) + Math.abs(u.position[1])),
  );
  return { res: p1.resources, harvests, vgMaxDist, pop: p1.units.length };
}

const rows: string[] = [];
rows.push(`巡逻半径扫描（${TICKS} ticks × ${SEEDS.length} seeds，aggressive + 近似 refill everyTicks=65 生产校准，solo 刷新场景）`);
rows.push("=".repeat(84));
for (const radius of [5, 8, 12]) {
  let resSum = 0;
  let harvestSum = 0;
  let popSum = 0;
  const details: string[] = [];
  for (const seed of SEEDS) {
    const o = runVariant(seed, radius);
    resSum += o.res;
    harvestSum += o.harvests;
    popSum += o.pop;
    details.push(`seed ${seed}: res=${o.res} harvest=${o.harvests} vgDist=${o.vgMaxDist} pop=${o.pop}`);
  }
  rows.push(
    `exploreRadius=${radius}: 均res=${(resSum / SEEDS.length).toFixed(1)} 均harvest=${(harvestSum / SEEDS.length).toFixed(1)} 均pop=${(popSum / SEEDS.length).toFixed(1)}`,
  );
  for (const d of details) rows.push(`  ${d}`);
}
const output = rows.join("\n");
console.log(output);
writeFileSync(RESULT_FILE, output + "\n");
