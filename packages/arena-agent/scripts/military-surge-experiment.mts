/**
 * 爆兵节奏实验（2026-08-06 用户导向"积累到一定程度开始爆兵，以爆兵为目的
 * 打对面水晶"）：p2=aggressive/8/0.3/core + accumulateThreshold=30（资源达标
 * 前只产 Worker 积累、达标后全力爆兵）+ attackForce=6（军事成型才前压）vs
 * p1=balanced/8/0.3/null 基准。验证三阶段：积累期（worker 增长）→ 爆兵期
 * （军事规模跳增）→ 前压期（成型后打水晶）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/military-surge-experiment.mts
 */

import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "military-surge-result.txt";

/** 对打场景（p1 [0,0] vs p2 [2,2]，间距 4 格在视野内，refill）。 */
function duelScenario(seed: number) {
  return {
    rulesVersion: "v0.11",
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 100,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222222", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222223", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 100,
        core: { id: "33333333-3333-3333-3333-333333333333", position: [2, 2], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "44444444-4444-4444-4444-444444444444", owner: "p2", position: [3, 2], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "44444444-4444-4444-4444-444444444445", owner: "p2", position: [2, 3], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: {
      obstacles: [],
      resources: [[0, 5], [1, 5], [2, 5], [5, 0], [5, 1], [5, 2], [6, 6], [7, 7], [8, 8], [9, 9], [10, 10], [-5, -5], [-6, -6], [-7, -7]],
    },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const BASE_POLICY: MacroPolicy = {
  posture: "balanced", workerTarget: 8, militaryRatio: 0.3, focusRegion: null, attackPriority: null,
};

const SURGE_POLICY: MacroPolicy = {
  posture: "aggressive", workerTarget: 8, militaryRatio: 0.3, focusRegion: null, attackPriority: "core",
};

const SEEDS = [1, 2];
const TICKS = 400;

const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;

interface Outcome {
  readonly res2: number;
  readonly res1: number;
  readonly military2: number;
  readonly workers2: number;
  readonly peakMilitary: number;
  readonly pop1: number;
}

function runDuel(seed: number): Outcome {
  const config: EpisodeConfig = {
    scenario: duelScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    refill: {},
    tenants: [
      { id: "p1", planner: "deterministic", policy: BASE_POLICY } as EpisodeTenant,
      {
        id: "p2", planner: "deterministic", policy: SURGE_POLICY,
        plannerConfig: { accumulateThreshold: 30, attackForce: 6 },
      } as EpisodeTenant,
    ],
  };
  let peakMilitary = 0;
  const result = runEpisode({
    ...config,
    onTickSettled: (m) => {
      // track p2 population as proxy (decision telemetry not exposed here)
      const p2Pop = m.players.find((p) => p.playerId === "p2")?.population ?? 0;
      if (p2Pop > peakMilitary) peakMilitary = p2Pop;
    },
  });
  const p1 = result.finalWorld.players.get("p1")!;
  const p2 = result.finalWorld.players.get("p2")!;
  const military2 = p2.units.filter((u) => u.unitType === "VANGUARD" || u.unitType === "RANGER").length;
  const workers2 = p2.units.filter((u) => u.unitType === "WORKER").length;
  return { res1: p1.resources, res2: p2.resources, military2, workers2, peakMilitary, pop1: p1.units.length };
}

async function main(): Promise<void> {
  const lines: string[] = [
    `=== 爆兵节奏（p2=aggressive/core + accumulateThreshold=30 + attackForce=6 vs p1=balanced 基准；${TICKS} ticks × ${SEEDS.length} seeds + refill）===`,
    "variant            | p2 res | p1 res | edge  | p2军 | p2工 | 峰值人口 | p1 pop",
  ];
  const outs = await Promise.all(SEEDS.map((seed) => runDuel(seed)));
  const res2 = mean(outs.map((o) => o.res2));
  const res1 = mean(outs.map((o) => o.res1));
  const military2 = mean(outs.map((o) => o.military2));
  const workers2 = mean(outs.map((o) => o.workers2));
  const peak = mean(outs.map((o) => o.peakMilitary));
  const pop1 = mean(outs.map((o) => o.pop1));
  lines.push(
    `爆兵节奏(p2)        | ${String(res2.toFixed(1)).padStart(6)} | ${String(res1.toFixed(1)).padStart(6)} | ${String((res2 - res1).toFixed(1)).padStart(5)} | ${String(military2.toFixed(1)).padStart(4)} | ${String(workers2.toFixed(1)).padStart(4)} | ${String(peak.toFixed(1)).padStart(6)} | ${String(pop1.toFixed(1)).padStart(6)}`,
  );
  lines.push("", "说明：积累期 worker 优先（爆兵前经济爬坡）；爆兵期军事跳增；成型后前压拆水晶。");
  writeFileSync(RESULT_FILE, lines.join("\n") + "\n", "utf-8");
  console.log(lines.join("\n"));
}

void main().catch((error) => {
  console.error(`military-surge 实验失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
