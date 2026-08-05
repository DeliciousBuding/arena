/**
 * 参数网格扫描工具（智能优化）：对 SafetyPlannerConfig 参数组合跑模拟 A/B，
 * 自动找出最优组合（neat-freak：不手调参数，用网格搜索代替）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/param-scan.mts
 *
 * 扫描维度（可改 COMBO_GRID 扩展）：
 * - maxFocusDistance：focus 防呆半径（远点 policy 场景验证防呆价值）
 * - clearPath：清障开关（敌占资源格场景验证清场 ROI）
 *
 * 场景复用生产事故回归夹具（scenario-focus-exile / scenario-clear-path），
 * 每组合 2 seeds × 60 ticks，输出 p1 最终资源均值排序。
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
}

const COMBO_GRID: readonly Combo[] = [
  { maxFocusDistance: 16, clearPath: false },
  { maxFocusDistance: 24, clearPath: false },
  { maxFocusDistance: 32, clearPath: false },
  { maxFocusDistance: 48, clearPath: false },
  { maxFocusDistance: 32, clearPath: true },
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
  readonly focusExileMean: number;
  readonly clearPathMean: number;
}

const rows: ScanRow[] = COMBO_GRID.map((combo) => {
  const focusExileMean = SEEDS.reduce((sum, seed) => sum + runFocusExile(combo, seed), 0) / SEEDS.length;
  const clearPathMean = SEEDS.reduce((sum, seed) => sum + runClearPath(combo, seed), 0) / SEEDS.length;
  return { ...combo, focusExileMean, clearPathMean };
});

console.log("=== 参数网格扫描结果（p1 最终资源均值，2 seeds × 60 ticks）===");
console.log("maxFocusDistance | clearPath | focusExile(防呆) | clearPath(清障)");
for (const row of rows.sort((a, b) => b.focusExileMean - a.focusExileMean)) {
  console.log(
    `${String(row.maxFocusDistance).padStart(16)} | ${String(row.clearPath).padStart(9)} | ${String(row.focusExileMean).padStart(14)} | ${String(row.clearPathMean).padStart(14)}`,
  );
}
console.log("说明：focusExile 越高 = 防呆价值越大（worker 不被支走）；clearPath 越高 = 清障价值越大。");
