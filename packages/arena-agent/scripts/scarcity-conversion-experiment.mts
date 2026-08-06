/**
 * 枯竭转化时机实验（2026-08-06，用户导向"获取最多的资源才是目的"）：
 * 有限资源（无 refill）下，爆兵积累阈值 accumulateThreshold 决定"先养经济
 * 再爆兵" vs "随产随造"的资源转化效率。
 * - threshold=0（现状）：worker 到 8 后边产兵边采——早期军事占用资源
 * - threshold=15/30：先全力 worker 采集（累计采集快），达标后集中爆兵
 * KPI：累计 harvest 数（资源获取总量）、最终存量 res、军事单位数、总 pop。
 * 预期：高 threshold 累计采集更高或相同、军事转化更集中（枯竭前成型）；
 * 若高 threshold 军事更少且存量低 → 转化时机过晚（资源被 upkeep 吃掉）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/scarcity-conversion-experiment.mts
 */
import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "scarcity-conversion-result.txt";

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
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: {
      obstacles: [],
      resources: Array.from({ length: 40 }, (_, i) => [2 + i, 0] as const),
    },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const POLICY: MacroPolicy = {
  posture: "balanced",
  workerTarget: 8,
  militaryRatio: 0.4,
  focusRegion: null,
  attackPriority: null,
};

const SEEDS = [1, 2, 3];
const TICKS = 400;

const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length;

interface Outcome {
  res: number;
  pop: number;
  military: number;
  harvests: number;
}

function runVariant(threshold: number, seed: number): Outcome {
  const config: EpisodeConfig = {
    scenario: scenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      {
        id: "p1", planner: "deterministic", policy: POLICY,
        plannerConfig: threshold > 0 ? { accumulateThreshold: threshold } : undefined,
      } as EpisodeTenant,
    ],
  };
  const result = runEpisode(config);
  const p1 = result.finalWorld.players.get("p1")!;
  const military = p1.units.filter((u) => u.unitType !== "WORKER").length;
  let harvests = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "HARVEST_SUCCEEDED") harvests += 1;
    }
  }
  return { res: p1.resources, pop: p1.units.length, military, harvests };
}

const rows: string[] = [];
rows.push(`枯竭转化时机实验（${TICKS} ticks × ${SEEDS.length} seeds，12 格有限资源无 refill）`);
rows.push("=".repeat(96));
rows.push("accumulateThreshold | 存量res(avg) | pop(avg) | 军事(avg) | 累计harvest(avg)");
rows.push("-".repeat(96));
for (const threshold of [0, 15, 30]) {
  const outcomes = SEEDS.map((seed) => runVariant(threshold, seed));
  rows.push(
    `${String(threshold).padEnd(19)} | ${mean(outcomes.map((o) => o.res)).toFixed(1).padStart(9)} | ` +
      `${mean(outcomes.map((o) => o.pop)).toFixed(1).padStart(8)} | ${mean(outcomes.map((o) => o.military)).toFixed(1).padStart(7)} | ` +
      `${mean(outcomes.map((o) => o.harvests)).toFixed(1).padStart(15)}`,
  );
  for (const seed of SEEDS) {
    const o = outcomes[seed - 1]!;
    rows.push(`  seed ${seed}: res=${o.res} pop=${o.pop} military=${o.military} harvests=${o.harvests}`);
  }
}
const output = rows.join("\n");
console.log(output);
writeFileSync(RESULT_FILE, output + "\n");
