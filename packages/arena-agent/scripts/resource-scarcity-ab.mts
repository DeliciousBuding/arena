/**
 * v0.14 资源稀缺经济 A/B 多场景（2026-08-07，worker-dense-scan-v1 候选验证 v2）：
 * 单场景证据不足——扩展 4 种资源形态验证 dense scan 增益是否普适：
 *  - sparse16：16 格散布半径 8-24 各方位（生产形态，refill4）
 *  - nearDense：资源簇近核半径 3-8（近距离密集，dense 不应拖累）
 *  - diagonalFar：仅对角远矿半径 30-40（8 方位放射线最易漏对角）
 *  - sparseNoRefill：同 sparse16 但关 refill（一次性采尽）
 * 对照 baseline / workerDenseScan / frontierPriority / frontier+dense。
 * KPI：DEPOSIT_SUCCEEDED 数。
 *
 * 结果（12 worker 生产规模 × 300 ticks × 3 seeds）：
 *   sparse16(生产形态) baseline 10.0 | dense 12.0(+20%) | frontier+dense 12.0(+20%)
 *   nearDense          全员 16.0（中性）
 *   diagonalFar        baseline 7.0 | frontier 8.0(+14%) | dense 6.0(-14%) |
 *                      frontier+dense 7.0（回归中和）
 * 结论：workerDenseScan 单开稀疏+20% 但对角远矿-14%（worker 摊薄到半八分位）；
 *   frontier+dense 组合最稳——任何场景不劣于 baseline，生产形态 +20%。
 * 用法：cd packages/arena-agent && npx tsx scripts/resource-scarcity-ab.mts
 */
import { runEpisode } from "../src/sim/harness/episode.ts";
import type { SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";
import { DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";

function scenario(seed: number, resources: number[][], refill?: boolean) {
  // 12 worker（生产规模 t1/t2 实测 11-12）环绕核心开局，workerTarget=12 不再扩编
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
  { name: "sparse16(半径8-24,refill4)", resources: [
    [10, 0], [0, 10], [-10, 0], [0, -10], [14, 7], [-14, -7], [7, 14], [-7, -14],
    [20, 0], [0, -20], [18, -9], [-18, 9], [9, -18], [-9, 18], [24, 0], [0, 24],
  ] },
  { name: "nearDense(半径3-8,refill4)", resources: [
    [3, 0], [0, 3], [-3, 0], [0, -3], [5, 2], [-5, -2], [2, 5], [-2, -5], [7, 0], [0, -7], [6, 3], [-6, -3], [3, 6], [-3, -6], [8, 0], [0, 8],
  ] },
  { name: "diagonalFar(半径30-40,refill4)", resources: [
    [22, 22], [-22, -22], [22, -22], [-22, 22], [28, 14], [-28, -14], [14, 28], [-14, -28],
    [32, 32], [-32, -32], [32, -32], [-32, 32], [30, 15], [-30, -15], [15, 30], [-15, -30],
  ] },
  { name: "t4Like(半径30-45,稀疏8,无回填)", resources: [
    [30, 0], [0, 30], [-30, 0], [0, -30], [36, 12], [-36, -12], [12, 36], [-12, -36],
  ], refill: false },
  { name: "sparseNoRefill(半径8-24,无回填)", resources: [
    [10, 0], [0, 10], [-10, 0], [0, -10], [14, 7], [-14, -7], [7, 14], [-7, -14],
    [20, 0], [0, -20], [18, -9], [-18, 9], [9, -18], [-9, 18], [24, 0], [0, 24],
  ], refill: false },
];

const SEEDS = [1, 2, 3];
const TICKS = 300;

function runVariant(resources: number[][], refill: boolean | undefined, overrides: Partial<SafetyPlannerConfig>, seed: number) {
  const result = runEpisode({
    scenario: scenario(seed, resources),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    ...(refill === false ? { refill: { everyTicks: 0 } } : {}),
    tenants: [
      {
        id: "p1", planner: "safety",
        plannerConfig: { ...DEFAULT_SAFETY_CONFIG, ...overrides },
        policy: { posture: "balanced", workerTarget: 12, militaryRatio: 0, focusRegion: null, attackPriority: null },
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

const VARIANTS: ReadonlyArray<{ label: string; cfg: Partial<SafetyPlannerConfig> }> = [
  { label: "baseline(8方位)", cfg: {} },
  { label: "frontierPriority", cfg: { frontierPriority: true } },
  { label: "workerDenseScan(16)", cfg: { workerDenseScan: true } },
  { label: "frontier+dense", cfg: { frontierPriority: true, workerDenseScan: true } },
];

console.log(`v0.14 资源稀缺经济 A/B 多场景（${TICKS} ticks × ${SEEDS.length} seeds × ${SCENARIOS.length} 场景）`);
console.log("=".repeat(96));
for (const sc of SCENARIOS) {
  console.log(`\n[${sc.name}]`);
  for (const v of VARIANTS) {
    const outcomes = SEEDS.map((seed) => runVariant(sc.resources, sc.refill, v.cfg, seed));
    const avgDep = outcomes.reduce((s, o) => s + o.deposits, 0) / outcomes.length;
    const avgHar = outcomes.reduce((s, o) => s + o.harvests, 0) / outcomes.length;
    console.log(`  ${v.label.padEnd(20)} | deposit(avg)=${avgDep.toFixed(1)} | harvest(avg)=${avgHar.toFixed(1)} | ${(avgDep / TICKS).toFixed(3)}/tick`);
  }
}
