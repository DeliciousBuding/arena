/**
 * 参数网格扫描工具（智能优化，neat-freak 闭环）：对 SafetyPlannerConfig 参数
 * 组合跑模拟 A/B，自动找出最优组合并输出可注册的配置候选。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/param-scan.mts
 *
 * 扫描维度：
 * - maxFocusDistance：focus 防呆半径（远点 policy 场景验证防呆价值）
 * - clearPath：清障开关（敌占资源格场景验证清场 ROI）
 * - exploreRadius：worker 巡逻半径（影响探索效率与留守圈大小）
 * - threatEnemyDistance：威胁判定距离（Vanguard 出击触发半径）
 *
 * 场景复用生产事故回归夹具，每组合 2 seeds × 60 ticks，输出 p1 最终资源均值
 * 排序 + 最优组合推荐（可直接注册为 planner variant / runtime config）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runEpisode } from "../src/sim/harness/episode.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner, type SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";
import { resolvePlannerVariant } from "../src/sim/tools/planner-variants.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const here = join(process.cwd(), "test", "fixtures", "sim");
const rulesPath = join(process.cwd(), "src", "sim", "contracts", "rules-v0.11.json");

const FOCUS_EXILE_SCENARIO = JSON.parse(readFileSync(join(here, "scenario-focus-exile.json"), "utf8")) as unknown;
const CLEAR_PATH_SCENARIO = JSON.parse(readFileSync(join(here, "scenario-clear-path.json"), "utf8")) as unknown;

/** 生产事故复现 policy（远点 focus，> 默认 maxFocusDistance=32）。 */
const FOCUS_POLICY: MacroPolicy = {
  posture: "balanced",
  workerTarget: 8,
  militaryRatio: 0,
  focusRegion: [40, 0],
  attackPriority: null,
};

interface Combo {
  readonly maxFocusDistance: number;
  readonly clearPath: boolean;
  readonly exploreRadius: number;
  readonly threatEnemyDistance: number;
}

const COMBO_GRID: readonly Combo[] = [
  // 防呆半径网格（clearPath 开关对照）
  { maxFocusDistance: 16, clearPath: false, exploreRadius: 8, threatEnemyDistance: 5 },
  { maxFocusDistance: 24, clearPath: false, exploreRadius: 8, threatEnemyDistance: 5 },
  { maxFocusDistance: 32, clearPath: false, exploreRadius: 8, threatEnemyDistance: 5 },
  { maxFocusDistance: 48, clearPath: false, exploreRadius: 8, threatEnemyDistance: 5 },
  { maxFocusDistance: 32, clearPath: true, exploreRadius: 8, threatEnemyDistance: 5 },
  // 探索半径网格（巡逻圈大小 vs 留守）
  { maxFocusDistance: 32, clearPath: false, exploreRadius: 12, threatEnemyDistance: 5 },
  { maxFocusDistance: 32, clearPath: false, exploreRadius: 16, threatEnemyDistance: 5 },
  // 威胁距离网格（Vanguard 出击触发半径）
  { maxFocusDistance: 32, clearPath: false, exploreRadius: 8, threatEnemyDistance: 8 },
  { maxFocusDistance: 32, clearPath: true, exploreRadius: 12, threatEnemyDistance: 8 },
];

const SEEDS = [1, 2];
const TICKS = 60;

function runFocusExile(combo: Combo, seed: number): number {
  const result = runEpisode({
    scenario: FOCUS_EXILE_SCENARIO,
    rulesPath,
    seed,
    ticks: TICKS,
    tenants: [{ id: "p1", planner: "deterministic", policy: FOCUS_POLICY }],
    plannerFactory: () => new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, ...combo }),
  });
  return result.finalWorld.players.get("p1")!.resources;
}

function runClearPath(combo: Combo, seed: number): number {
  const result = runEpisode({
    scenario: CLEAR_PATH_SCENARIO,
    rulesPath,
    seed,
    ticks: TICKS,
    tenants: [
      { id: "p1", planner: "deterministic" },
      { id: "p2", planner: "deterministic" },
    ],
    plannerFactory: (tenant) =>
      tenant.id === "p1"
        ? new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, ...combo } as SafetyPlannerConfig)
        : resolvePlannerVariant("idle").create("p2"),
  });
  return result.finalWorld.players.get("p1")!.resources;
}

interface ScanRow {
  readonly maxFocusDistance: number;
  readonly clearPath: boolean;
  readonly exploreRadius: number;
  readonly threatEnemyDistance: number;
  readonly focusExileMean: number;
  readonly clearPathMean: number;
  /** 两场景归一化综合分（0-1；取各自列最大值归一后平均）。 */
  readonly composite: number;
}

const rows: ScanRow[] = COMBO_GRID.map((combo) => {
  const focusExileMean = SEEDS.reduce((sum, seed) => sum + runFocusExile(combo, seed), 0) / SEEDS.length;
  const clearPathMean = SEEDS.reduce((sum, seed) => sum + runClearPath(combo, seed), 0) / SEEDS.length;
  return { ...combo, focusExileMean, clearPathMean, composite: 0 };
});

const bestFocusExile = Math.max(...rows.map((row) => row.focusExileMean));
const bestClearPath = Math.max(...rows.map((row) => row.clearPathMean));
for (const row of rows) {
  row.composite =
    (row.focusExileMean / bestFocusExile + row.clearPathMean / bestClearPath) / 2;
}

console.log("=== 参数网格扫描结果（p1 最终资源均值，2 seeds × 60 ticks）===");
console.log("maxFocus | clearPath | exploreR | threatDist | focusExile | clearPath | composite");
for (const row of [...rows].sort((a, b) => b.composite - a.composite)) {
  console.log(
    `${String(row.maxFocusDistance).padStart(8)} | ${String(row.clearPath).padStart(9)} | ${String(row.exploreRadius).padStart(9)} | ${String(row.threatEnemyDistance).padStart(10)} | ${String(row.focusExileMean).padStart(10)} | ${String(row.clearPathMean).padStart(10)} | ${row.composite.toFixed(3)}`,
  );
}

const best = [...rows].sort((a, b) => b.composite - a.composite)[0]!;
console.log("\n=== 最优组合推荐（可直接注册为 planner variant / runtime config）===");
console.log(JSON.stringify(
  { maxFocusDistance: best.maxFocusDistance, clearPath: best.clearPath, exploreRadius: best.exploreRadius, threatEnemyDistance: best.threatEnemyDistance },
  null,
  2,
));
console.log(`composite=${best.composite.toFixed(3)}（focusExile=${best.focusExileMean} vs 列最优 ${bestFocusExile}；clearPath=${best.clearPathMean} vs 列最优 ${bestClearPath}）`);
console.log("注意：扫描场景是单一聚焦夹具（focus-exile/clear-path），结论用于候选注册而非生产改配置。");
