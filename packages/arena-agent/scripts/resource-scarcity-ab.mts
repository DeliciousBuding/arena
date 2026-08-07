/**
 * v0.14 资源稀缺经济 A/B（2026-08-07，worker-dense-scan-v1 候选验证）：
 * 生产实测：资源稀缺时 avgVisible 0.5-0.6 格/tick（8 方位放射巡逻在半径 24
 * 处相邻方位 ~18 格 > Worker 视野 3×2，盲区大）。本场景模拟生产形态：
 * p1 单玩家 4 worker + 核心 [0,0]，16 个稀疏资源格散布半径 8-24 各方位，
 * v0.14 默认 refillEveryTicks=4（采完 4 tick 后回填——发现率决定吞吐）。
 *
 * 对照：
 *  - baseline：8 方位 +3 步进（现状）
 *  - frontierPriority：回 home 换方位按 chunk 观察老化（补老分区）
 *  - workerDenseScan：16 方位密集扫图（间距减半）
 *
 * KPI：DEPOSIT_SUCCEEDED 数（吞吐）、HARVEST_SUCCEEDED 数、最终资源。
 * 用法：cd packages/arena-agent && npx tsx scripts/resource-scarcity-ab.mts
 */
import { runEpisode } from "../src/sim/harness/episode.ts";
import type { SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";
import { DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";

/** 稀疏资源场景：16 格散布半径 8-24 各方位（含对角），refill 默认 4 tick。 */
function sparseScenario(seed: number) {
  const resources = [
    [10, 0], [0, 10], [-10, 0], [0, -10],
    [14, 7], [-14, -7], [7, 14], [-7, -14],
    [20, 0], [0, -20], [18, -9], [-18, 9],
    [9, -18], [-9, 18], [24, 0], [0, 24],
  ];
  return {
    rulesVersion: "v0.14" as const,
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 10,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [-1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222204", owner: "p1", position: [0, -1], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const SEEDS = [1, 2, 3];
const TICKS = 300;

function runVariant(overrides: Partial<SafetyPlannerConfig>, seed: number) {
  const result = runEpisode({
    scenario: sparseScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      {
        id: "p1", planner: "safety",
        plannerConfig: { ...DEFAULT_SAFETY_CONFIG, ...overrides },
        policy: { posture: "balanced", workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: null },
      },
    ],
  } as never);
  let deposits = 0;
  let harvests = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "DEPOSIT_SUCCEEDED") deposits += 1;
      else if (event.eventType === "HARVEST_SUCCEEDED") harvests += 1;
    }
  }
  return { deposits, harvests };
}

console.log(`v0.14 资源稀缺经济 A/B（${TICKS} ticks × ${SEEDS.length} seeds，16 稀疏资源格 + refill4）`);
console.log("=".repeat(80));
for (const [label, cfg] of [
  ["baseline（8方位+3步进）", {}],
  ["frontierPriority（chunk老化）", { frontierPriority: true }],
  ["workerDenseScan（16方位）", { workerDenseScan: true }],
] as const) {
  const outcomes = SEEDS.map((seed) => runVariant(cfg as Partial<SafetyPlannerConfig>, seed));
  const avgDep = outcomes.reduce((s, o) => s + o.deposits, 0) / outcomes.length;
  const avgHar = outcomes.reduce((s, o) => s + o.harvests, 0) / outcomes.length;
  console.log(`${label.padEnd(26)} | deposit(avg)=${avgDep.toFixed(1)} | harvest(avg)=${avgHar.toFixed(1)} | 吞吐率=${(avgDep / TICKS).toFixed(3)}/tick`);
  for (const [i, o] of outcomes.entries()) {
    console.log(`  seed ${i + 1}: dep=${o.deposits} har=${o.harvests}`);
  }
}
