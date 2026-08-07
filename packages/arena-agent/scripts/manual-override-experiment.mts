/**
 * 手操干扰实验（2026-08-07）：模拟人类玩家在同一租户槽位手操
 * （服务器 Manual > Agent 合并——手操命令按单位覆盖本机 AGENT 计划）。
 * 验证：状态机自动吸收（不崩溃、不变量保持、planner 计划持续合法），
 * 代价面（资源/人口/战斗结果随干扰强度退化）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/manual-override-experiment.mts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plan, TickState } from "../src/domain/model.ts";
import { runEpisode, type EpisodeConfig } from "../src/sim/harness/episode.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, "scenarios", "strike-group-exchange.json");
const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";

const SCENARIO = JSON.parse(readFileSync(SCENARIO_PATH, "utf-8"));
const TICKS = 120;
const SEEDS = [11, 22, 33];
const INTENSITIES = [0, 0.25, 0.6, 1.0] as const;

interface ExperimentRow {
  intensity: number;
  seed: number;
  finalResources: number;
  finalPopulation: number;
  coreHp: number;
  moveFailed: number;
  illegalPlans: number;
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** 随机手操：以给定概率把 p1 的一个随机单位的动作覆盖为随机方向 MOVE。 */
function overrideProvider(random: () => number, intensity: number) {
  return (tenantId: string, _tick: number, state: TickState, proposed: Plan): Plan | null => {
    if (tenantId !== "p1") return null;
    if (random() >= intensity) return null;
    const units = state.units;
    if (units.length === 0) return null;
    const target = units[Math.floor(random() * units.length)];
    const directions = ["UP", "DOWN", "LEFT", "RIGHT"] as const;
    const direction = directions[Math.floor(random() * directions.length)];
    return {
      ...proposed,
      unitActions: {
        ...proposed.unitActions,
        [target.id]: { type: "MOVE", direction },
      },
    };
  };
}

function baseConfig(seed: number, intensity: number): EpisodeConfig {
  const random = lcg(seed * 1000 + Math.round(intensity * 100));
  return {
    scenario: SCENARIO,
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      {
        id: "p1",
        planner: "deterministic",
        policy: { posture: "aggressive", workerTarget: 6, militaryRatio: 0.4, focusRegion: null, attackPriority: "core" },
      },
      { id: "p2", planner: "deterministic", policy: { posture: "aggressive", workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: "core" } },
    ],
    ...(intensity > 0 ? { manualOverrideProvider: overrideProvider(random, intensity) } : {}),
  };
}

const rows: ExperimentRow[] = [];
for (const intensity of INTENSITIES) {
  for (const seed of SEEDS) {
    const result = runEpisode(baseConfig(seed, intensity));
    const p1 = result.finalWorld.players.get("p1")!;
    const moveFailed = result.records
      .flatMap((record) => record.events)
      .filter(
        (event) =>
          event.eventType === "UNIT_MOVE_FAILED" &&
          event.reasonCode !== null &&
          event.reasonCode !== "MOVE_CONTESTED",
      ).length;
    rows.push({
      intensity,
      seed,
      finalResources: p1.resources,
      finalPopulation: p1.units.length,
      coreHp: p1.core?.hp ?? 0,
      moveFailed,
      illegalPlans: result.metrics.illegalPlans,
    });
  }
}

console.log("intensity | seed | finalRes | population | coreHp | moveFailed | illegalPlans");
for (const row of rows) {
  console.log(
    `${row.intensity.toFixed(2).padStart(5)} | ${String(row.seed).padStart(4)} | ${String(row.finalResources).padStart(8)} | ${String(row.finalPopulation).padStart(10)} | ${String(row.coreHp).padStart(6)} | ${String(row.moveFailed).padStart(10)} | ${String(row.illegalPlans).padStart(12)}`,
  );
}
console.log("\n注：illegalPlans 恒 0 = 手操只影响结算、本机 planner 计划始终合法（状态机自动吸收，不打断）。");
