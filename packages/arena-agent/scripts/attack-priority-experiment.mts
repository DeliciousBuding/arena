/**
 * 攻击目标（attackPriority）对比实验（2026-08-06）：
 * p1=balanced/8/0.3/null 固定（生产形态），p2=aggressive/8/0.3 只变
 * attackPriority（null 追击 / core 拆家掠夺 / workers 断经济）——
 * 前压仅 aggressive 姿态触发（balanced 下攻击目标字段不消费）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/attack-priority-experiment.mts
 */

import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "attack-priority-result.txt";

/** 对打场景（p1 基准 vs p2 候选，间距 10 格，refill）。 */
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

const VARIANTS: readonly { readonly name: string; readonly policy: MacroPolicy }[] = [
  { name: "null（追击最近敌）", policy: { posture: "aggressive", workerTarget: 8, militaryRatio: 0.3, focusRegion: null, attackPriority: null } },
  { name: "core（拆家掠夺）", policy: { posture: "aggressive", workerTarget: 8, militaryRatio: 0.3, focusRegion: null, attackPriority: "core" } },
  { name: "workers（断敌经济）", policy: { posture: "aggressive", workerTarget: 8, militaryRatio: 0.3, focusRegion: null, attackPriority: "workers" } },
];

const DUEL_SEEDS = [1, 2];
const DUEL_TICKS = 300;

const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;

interface DuelOutcome {
  readonly res2: number;
  readonly res1: number;
  readonly pop2: number;
  readonly pop1: number;
}

function runDuel(policy: MacroPolicy, seed: number): DuelOutcome {
  const config: EpisodeConfig = {
    scenario: duelScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: DUEL_TICKS,
    // 生产校准 cadence（第十一轮：真实 solo 供给 ≈60-70 tick/格）——
    // 原实验 refill:{} 用规则默认 ≈200（远慢于真实），校准后重验结论。
    refill: { everyTicks: 65 },
    tenants: [
      { id: "p1", planner: "deterministic", policy: BASE_POLICY } as EpisodeTenant,
      { id: "p2", planner: "deterministic", policy } as EpisodeTenant,
    ],
  };
  const result = runEpisode(config);
  const p1 = result.finalWorld.players.get("p1");
  const p2 = result.finalWorld.players.get("p2");
  if (!p1 || !p2) throw new Error(`missing player seed=${seed}`);
  return { res1: p1.resources, res2: p2.resources, pop2: p2.units.length, pop1: p1.units.length };
}

async function main(): Promise<void> {
  const lines: string[] = [
    `=== 攻击目标对比（p1=balanced/8/0.3/null 基准 vs p2 同姿态变 attackPriority；${DUEL_TICKS} ticks × ${DUEL_SEEDS.length} seeds + refill）===`,
    "variant          | p2 res | p1 res | edge  | p2 pop | p1 pop",
  ];
  const rows: { name: string; edge: number; res2: number; pop2: number }[] = [];
  for (const { name, policy } of VARIANTS) {
    const duels = await Promise.all(DUEL_SEEDS.map((seed) => runDuel(policy, seed)));
    const edge = mean(duels.map((d) => d.res2 - d.res1));
    const res2 = mean(duels.map((d) => d.res2));
    const pop2 = mean(duels.map((d) => d.pop2));
    const pop1 = mean(duels.map((d) => d.pop1));
    rows.push({ name, edge, res2, pop2 });
    lines.push(
      `${String(name).padEnd(18)} | ${String(res2.toFixed(1)).padStart(6)} | ${String(mean(duels.map((d) => d.res1)).toFixed(1)).padStart(6)} | ${String(edge.toFixed(1)).padStart(5)} | ${String(pop2.toFixed(1)).padStart(6)} | ${String(pop1.toFixed(1)).padStart(6)}`,
    );
  }
  rows.sort((a, b) => b.edge - a.edge);
  lines.push("", `=== 最优攻击目标：${rows[0]!.name}（edge=${rows[0]!.edge.toFixed(1)}）===`);
  writeFileSync(RESULT_FILE, lines.join("\n") + "\n", "utf-8");
  console.log(lines.join("\n"));
}

void main().catch((error) => {
  console.error(`attack-priority 实验失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
