/**
 * 军事配比（VANGUARD vs RANGER）对比实验（2026-08-06）：
 * p2=aggressive/8/0.3/attack=core 变 vanguardRatio（0=全远程 / 0.3 / 0.5=交替 /
 * 0.7 / 1=全近战攻坚）对打两种对手姿态：
 * - p1=balanced（防守）：Vanguard 配比越高越优（1: +35.0 / 交替: +33.0 / 全远程: +28.0）
 *   ——攻坚拆家无对攻压力；
 * - p1=aggressive（对攻）：全 Ranger 唯一存活（+28.0 vs 含 Vanguard 全灭 -22.5）
 *   ——Vanguard 前压被集火送死。
 * 结论：**配比应适配对手姿态**（防守对手 Vanguard 攻坚、进攻对手偏 Ranger 存活），
 * 不存在全局最优固定配比；默认交替（0.5）是两场景的稳健折中。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/military-composition-experiment.mts
 */

import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "military-composition-result.txt";

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

const ATTACK_POLICY: MacroPolicy = {
  posture: "aggressive", workerTarget: 8, militaryRatio: 0.3, focusRegion: null, attackPriority: "core",
};

const VARIANTS: readonly { readonly name: string; readonly vanguardRatio: number }[] = [
  { name: "0（全 Ranger 远程）", vanguardRatio: 0 },
  { name: "0.3（偏远程）", vanguardRatio: 0.3 },
  { name: "0.5（交替=默认）", vanguardRatio: 0.5 },
  { name: "0.7（偏近战）", vanguardRatio: 0.7 },
  { name: "1（全 Vanguard 近战）", vanguardRatio: 1 },
];

const DUEL_SEEDS = [1, 2];
const DUEL_TICKS = 300;

const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;

interface DuelOutcome {
  readonly res2: number;
  readonly res1: number;
  readonly vanguards: number;
  readonly rangers: number;
  readonly pop1: number;
}

function runDuel(vanguardRatio: number, seed: number): DuelOutcome {
  const config: EpisodeConfig = {
    scenario: duelScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: DUEL_TICKS,
    refill: {},
    tenants: [
      { id: "p1", planner: "deterministic", policy: BASE_POLICY } as EpisodeTenant,
      { id: "p2", planner: "deterministic", policy: ATTACK_POLICY, plannerConfig: { vanguardRatio } } as EpisodeTenant,
    ],
  };
  const result = runEpisode(config);
  const p1 = result.finalWorld.players.get("p1");
  const p2 = result.finalWorld.players.get("p2");
  if (!p1 || !p2) throw new Error(`missing player seed=${seed}`);
  const p2Units = p2.units.filter((unit) => unit.unitType === "VANGUARD" || unit.unitType === "RANGER");
  return {
    res1: p1.resources,
    res2: p2.resources,
    vanguards: p2Units.filter((unit) => unit.unitType === "VANGUARD").length,
    rangers: p2Units.filter((unit) => unit.unitType === "RANGER").length,
    pop1: p1.units.length,
  };
}

async function main(): Promise<void> {
  const lines: string[] = [
    `=== 军事配比对比（p1=balanced/8/0.3/null 基准 vs p2=aggressive/core 变 vanguardRatio；${DUEL_TICKS} ticks × ${DUEL_SEEDS.length} seeds + refill）===`,
    "variant             | p2 res | p1 res | edge  | VG | RG | p1 pop",
  ];
  const rows: { name: string; edge: number }[] = [];
  for (const { name, vanguardRatio } of VARIANTS) {
    const duels = await Promise.all(DUEL_SEEDS.map((seed) => runDuel(vanguardRatio, seed)));
    const edge = mean(duels.map((d) => d.res2 - d.res1));
    const res2 = mean(duels.map((d) => d.res2));
    const res1 = mean(duels.map((d) => d.res1));
    const vg = mean(duels.map((d) => d.vanguards));
    const rg = mean(duels.map((d) => d.rangers));
    const pop1 = mean(duels.map((d) => d.pop1));
    rows.push({ name, edge });
    lines.push(
      `${String(name).padEnd(20)} | ${String(res2.toFixed(1)).padStart(6)} | ${String(res1.toFixed(1)).padStart(6)} | ${String(edge.toFixed(1)).padStart(5)} | ${String(vg.toFixed(1)).padStart(2)} | ${String(rg.toFixed(1)).padStart(2)} | ${String(pop1.toFixed(1)).padStart(6)}`,
    );
  }
  rows.sort((a, b) => b.edge - a.edge);
  lines.push("", `=== 最优配比：${rows[0]!.name}（edge=${rows[0]!.edge.toFixed(1)}）===`);
  writeFileSync(RESULT_FILE, lines.join("\n") + "\n", "utf-8");
  console.log(lines.join("\n"));
}

void main().catch((error) => {
  console.error(`military-composition 实验失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
