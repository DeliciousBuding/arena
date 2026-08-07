/**
 * 视线感知资源失效 A/B（2026-08-08，ref arena-hero-agent v0.2.0
 * "Vision-aware resource invalidation"）：
 * 对照 World({ visionInvalidation: true }) vs false：
 * - nearFastDeplete（半径3-8 无回填）：采空后格子仍在 Core/worker 视野内 →
 *   开启时应立即 harvested 负记忆、worker 转向，减少空追（NOT_RESOURCE_CELL
 *   HARVEST_FAILED）与 stale 回访；
 * - t4Like（半径30-45 稀疏8 无回填）：t4 病态形态（远矿），验证无回归；
 * - sparse16（半径8-24 refill4）：生产形态 refill，验证无回归。
 * KPI：DEPOSIT_SUCCEEDED / HARVEST_SUCCEEDED / HARVEST_FAILED(全)/NOT_RESOURCE_CELL。
 * 用法：cd packages/arena-agent && npx tsx scripts/vision-invalidation-ab.mts
 */
import { runEpisode } from "../src/sim/harness/episode.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import { World } from "../src/domain/world.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";

function scenario(seed: number, resources: number[][], refill?: boolean) {
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
    terrain: { obstacles: [], resources },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const SCENARIOS: ReadonlyArray<{ name: string; resources: number[][]; refill?: boolean }> = [
  { name: "nearFastDeplete(半径3-8,无回填)", resources: [
    [3, 0], [0, 3], [-3, 0], [0, -3], [5, 2], [-5, -2], [2, 5], [-2, -5], [7, 0], [0, -7], [6, 3], [-6, -3], [3, 6], [-3, -6], [8, 0], [0, 8],
  ], refill: false },
  { name: "t4Like(半径30-45,稀疏8,无回填)", resources: [
    [30, 0], [0, 30], [-30, 0], [0, -30], [36, 12], [-36, -12], [12, 36], [-12, -36],
  ], refill: false },
  { name: "sparse16(半径8-24,refill4)", resources: [
    [10, 0], [0, 10], [-10, 0], [0, -10], [14, 7], [-14, -7], [7, 14], [-7, -14],
    [20, 0], [0, -20], [18, -9], [-18, 9], [9, -18], [-9, 18], [24, 0], [0, 24],
  ] },
];

const SEEDS = [1, 2, 3];
const TICKS = 300;

function runVariant(
  resources: number[][],
  refill: boolean | undefined,
  visionInvalidation: boolean,
  seed: number,
) {
  const result = runEpisode({
    scenario: scenario(seed, resources),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    ...(refill === false ? { refill: { everyTicks: 0 } } : {}),
    tenants: [
      {
        id: "p1", planner: "safety",
        plannerConfig: { ...DEFAULT_SAFETY_CONFIG },
        policy: { posture: "balanced", workerTarget: 12, militaryRatio: 0, focusRegion: null, attackPriority: null },
      },
    ],
    plannerFactory: (tenant) =>
      new SafetyPlanner(
        tenant.plannerConfig ?? DEFAULT_SAFETY_CONFIG,
        new World({ visionInvalidation }),
      ),
  } as never);

  let deposits = 0;
  let harvests = 0;
  let failAll = 0;
  let failNotResource = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "DEPOSIT_SUCCEEDED") deposits += 1;
      else if (event.eventType === "HARVEST_SUCCEEDED") harvests += 1;
      else if (event.eventType === "HARVEST_FAILED") {
        failAll += 1;
        if (event.reasonCode === "NOT_RESOURCE_CELL") failNotResource += 1;
      }
    }
  }
  return { deposits, harvests, failAll, failNotResource };
}

const VARIANTS: ReadonlyArray<{ label: string; on: boolean }> = [
  { label: "visionOff(旧stale)", on: false },
  { label: "visionOn(新harvested)", on: true },
];

console.log(`视线感知资源失效 A/B（${TICKS} ticks × ${SEEDS.length} seeds × ${SCENARIOS.length} 场景）`);
console.log("=".repeat(110));
for (const sc of SCENARIOS) {
  console.log(`\n[${sc.name}]`);
  for (const v of VARIANTS) {
    const outcomes = SEEDS.map((seed) => runVariant(sc.resources, sc.refill, v.on, seed));
    const avg = (k: keyof typeof outcomes[0]) =>
      outcomes.reduce((s, o) => s + o[k], 0) / outcomes.length;
    console.log(
      `  ${v.label.padEnd(20)} | deposit=${avg("deposits").toFixed(1)} | harvest=${avg("harvests").toFixed(1)}` +
      ` | fail=${avg("failAll").toFixed(1)} | NOT_RESOURCE=${avg("failNotResource").toFixed(1)}`,
    );
  }
}
