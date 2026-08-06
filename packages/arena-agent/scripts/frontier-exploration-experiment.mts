/**
 * frontier 探索实验（v0.2，2026-08-06）：
 * 场景 = 资源枯竭 + 远矿分布在两个对角方位（正东 40 格 + 正西 40 格）。
 * 固定 +3 方位步进（现状）：worker 首圈覆盖东/西南/北/东南，正西要等换方位
 * 序列（东→北→西，3 圈 ≈ 300+ tick）才覆盖——西矿发现滞后。
 * frontierPriority=true：worker 回 home 换方位时按 chunk 观察老化选方向——
 * 观察最老的分区先巡（西侧 chunk 一直未被观察 → 优先补西）。
 * KPI：最终资源（采到双方向矿 → res 更高）、maxDist（探索深度）、
 * 矿发现率（东/西两区是否有 worker 到达）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/frontier-exploration-experiment.mts
 */

import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "frontier-exploration-result.txt";

/** 双对角远矿场景：近矿 2 格（开局即采）、正东 40 格 3 矿、正西 40 格 3 矿。 */
function dualFarScenario(seed: number) {
  return {
    rulesVersion: "v0.11",
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 10,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222200", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [-1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [0, -1], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: {
      obstacles: [],
      resources: [
        [2, 0], [3, 0],
        [40, 0], [41, 0], [42, 0],
        [-40, 0], [-41, 0], [-42, 0],
      ],
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
const TICKS = 400;

const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;

interface Outcome {
  readonly res: number;
  readonly pop: number;
  readonly maxDist: number;
  readonly eastReached: boolean;
  readonly westReached: boolean;
}

function runVariant(frontierPriority: boolean, seed: number): Outcome {
  const config: EpisodeConfig = {
    scenario: dualFarScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      { id: "p1", planner: "deterministic", policy: POLICY, plannerConfig: { frontierPriority } } as EpisodeTenant,
    ],
  };
  const result = runEpisode(config);
  const p1 = result.finalWorld.players.get("p1")!;
  const maxDist = Math.max(0, ...p1.units.map((u) => Math.abs(u.position[0]) + Math.abs(u.position[1])));
  const eastReached = p1.units.some((u) => u.position[0] >= 30);
  const westReached = p1.units.some((u) => u.position[0] <= -30);
  return { res: p1.resources, pop: p1.units.length, maxDist, eastReached, westReached };
}

const rows: string[] = [];
rows.push(`frontier 探索实验（v0.2，${TICKS} ticks × ${SEEDS.length} seeds，双对角远矿 40 格）`);
rows.push("=".repeat(90));
rows.push(`variant | res(avg) | pop(avg) | maxDist(avg) | east覆盖 | west覆盖`);
rows.push("-".repeat(90));

for (const frontier of [false, true]) {
  const label = frontier ? "frontierPriority=true" : "frontierPriority=false（现状）";
  const outcomes = SEEDS.map((seed) => runVariant(frontier, seed));
  const eastCoverage = outcomes.filter((o) => o.eastReached).length;
  const westCoverage = outcomes.filter((o) => o.westReached).length;
  rows.push(
    `${label.padEnd(28)} | ${mean(outcomes.map((o) => o.res)).toFixed(1).padStart(7)} | ` +
      `${mean(outcomes.map((o) => o.pop)).toFixed(1).padStart(7)} | ${mean(outcomes.map((o) => o.maxDist)).toFixed(1).padStart(7)} | ` +
      `${eastCoverage}/${SEEDS.length} | ${westCoverage}/${SEEDS.length}`,
  );
  for (const seed of SEEDS) {
    const o = outcomes[seed - 1]!;
    rows.push(`  seed ${seed}: res=${o.res} pop=${o.pop} maxDist=${o.maxDist} east=${o.eastReached} west=${o.westReached}`);
  }
}

const output = rows.join("\n");
console.log(output);
writeFileSync(RESULT_FILE, output + "\n");
