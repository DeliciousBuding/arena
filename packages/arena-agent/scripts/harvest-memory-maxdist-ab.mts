/**
 * harvestMemoryMaxDist 模拟 A/B（2026-08-08）：远矿记忆采集距离上限。
 * 背景：t1 测绘库 292 资源全向分布（S 带 max 131），worker 却集中在核心 30 格内
 *  ——HARVEST_MEMORY_MAX_DIST=40 挡住 40+ 格真矿（survey seed 记忆）。t4 追空
 *  风险（worker 跨 70+ 格追空记忆）已被视线感知资源失效（1c85a0e）兜底。
 * 场景：核心 [0,0] + 12 worker 环绕，当前视野无资源（远矿在视野外），远矿
 *  （40/60/80 档各 4 方位 = 12 个）经 seedResourceMemory 注入 World（模拟
 *  survey 库种子）；worker 只能靠 harvestMemoryMine 记忆去采。
 * 变体：harvestMemoryMaxDist = 40 / 60 / 80。
 * KPI：HARVEST_SUCCEEDED / DEPOSIT_SUCCEEDED（能否到达并采到远矿）。
 * 用法：cd packages/arena-agent && npx tsx scripts/harvest-memory-maxdist-ab.mts
 */
import { runEpisode } from "../src/sim/harness/episode.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import { World } from "../src/domain/world.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";

/** 远矿：40/60/80 档 × 4 方位。 */
const FAR_RESOURCES: number[][] = [
  [40, 0], [0, 40], [-40, 0], [0, -40],
  [60, 0], [0, 60], [-60, 0], [0, -60],
  [80, 0], [0, 80], [-80, 0], [0, -80],
];

function scenario(seed: number) {
  const spawn = [
    [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1],
    [2, 0], [0, 2], [-2, 0], [0, -2],
  ];
  const units = spawn.map(([x, y], i) => ({
    id: `22222222-2222-2222-2222-2222222222${String(i).padStart(2, "0")}`,
    owner: "p1", position: [x, y], hp: 2, unitType: "WORKER", cargo: 0,
  }));
  return {
    rulesVersion: "v0.14" as const,
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 10,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units,
      },
    ],
    terrain: { obstacles: [], resources: FAR_RESOURCES },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const SEEDS = [1, 2, 3];
const TICKS = 400;

function runVariant(maxDist: number, seed: number) {
  const result = runEpisode({
    scenario: scenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      {
        id: "p1", planner: "safety",
        plannerConfig: {
          ...DEFAULT_SAFETY_CONFIG,
          harvestMemoryMine: true,
          harvestMemoryMaxDist: maxDist,
        },
        policy: { posture: "balanced", workerTarget: 12, militaryRatio: 0, focusRegion: null, attackPriority: null },
      },
    ],
    plannerFactory: (tenant) => {
      const planner = new SafetyPlanner(tenant.plannerConfig ?? DEFAULT_SAFETY_CONFIG, new World());
      // 注入 survey 种子：远矿记忆（stale seeded，不受 maxAge 窗口限制）
      planner.world.seedResourceMemory(
        FAR_RESOURCES.map(([x, y]) => [x, y] as const),
        0,
      );
      return planner;
    },
  } as never);

  let deposits = 0;
  let harvests = 0;
  let failNotResource = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "DEPOSIT_SUCCEEDED") deposits += 1;
      else if (event.eventType === "HARVEST_SUCCEEDED") harvests += 1;
      else if (event.eventType === "HARVEST_FAILED" && event.reasonCode === "NOT_RESOURCE_CELL") failNotResource += 1;
    }
  }
  return { deposits, harvests, failNotResource };
}

const VARIANTS = [40, 60, 80];

console.log(`harvestMemoryMaxDist A/B（${TICKS} ticks × ${SEEDS.length} seeds，12 远矿 40/60/80 档 × 4 方位）`);
console.log("=".repeat(90));
for (const maxDist of VARIANTS) {
  const outcomes = SEEDS.map((seed) => runVariant(maxDist, seed));
  const avg = (k: keyof typeof outcomes[0]) => outcomes.reduce((s, o) => s + o[k], 0) / outcomes.length;
  console.log(
    `  maxDist=${String(maxDist).padEnd(3)} | deposit=${avg("deposits").toFixed(1)} | harvest=${avg("harvests").toFixed(1)} | NOT_RESOURCE=${avg("failNotResource").toFixed(1)}`,
  );
}