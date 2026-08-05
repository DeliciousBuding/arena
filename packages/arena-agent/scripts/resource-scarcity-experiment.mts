/**
 * 资源枯竭应对实验（2026-08-06，focusRegion 维度补全）：
 * 场景复刻生产 t1 真实困境——近处资源采完（visibleRes=0）、经济冻结 res 4。
 * 资源只放在 Core 30 格外（巡逻半径 8 够不到），无 refill：
 * - balanced/null（现状守家）：永远发现不了远处资源 → 经济恒死
 * - balanced + focusRegion 指向远处资源（合理近距焦点）：worker 被聚焦支过去
 *   发现新资源 → 经济复活？（验证 focusRegion 救枯竭价值）
 * - harvest/null（纯经济扩员）：worker 多但巡逻半径不变 → 同样枯竭？
 * - aggressive/null（军事压制——solo 无对象，对照探索行为）
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/resource-scarcity-experiment.mts
 */

import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "resource-scarcity-result.txt";

/** 资源枯竭场景：近处 2 格资源（开局即采），远处 40 格外 6 格资源（复刻生产
 *  t1 实测：矿在 Core 40 格外——4 环巡逻覆盖 32 格永远测绘不到）。 */
function scarcityScenario(seed: number) {
  return {
    rulesVersion: "v0.11",
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 10,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222222", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222223", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: {
      obstacles: [],
      resources: [[2, 0], [3, 0], [40, 0], [41, 0], [42, 0], [43, 0], [40, 1], [41, 1]],
    },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const VARIANTS: readonly { readonly name: string; readonly policy: MacroPolicy; readonly plannerConfig?: Record<string, unknown> }[] = [
  { name: "balanced/null（现状守家）", policy: { posture: "balanced", workerTarget: 8, militaryRatio: 0.3, focusRegion: null, attackPriority: null } },
  { name: "balanced/focus 远矿", policy: { posture: "balanced", workerTarget: 8, militaryRatio: 0.3, focusRegion: [32, 0], attackPriority: null } },
  { name: "balanced/探索半径24", policy: { posture: "balanced", workerTarget: 8, militaryRatio: 0.3, focusRegion: null, attackPriority: null }, plannerConfig: { exploreRadius: 24 } },
  { name: "harvest/null（纯经济）", policy: { posture: "harvest", workerTarget: 10, militaryRatio: 0, focusRegion: null, attackPriority: null } },
  { name: "aggressive/null（军事对照）", policy: { posture: "aggressive", workerTarget: 8, militaryRatio: 0.3, focusRegion: null, attackPriority: "core" } },
];

const SEEDS = [1, 2];
const TICKS = 400;

const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;

interface Outcome {
  readonly res: number;
  readonly pop: number;
  readonly workerMaxDist: number;
}

function runVariant(policy: MacroPolicy, plannerConfig: Record<string, unknown> | undefined, seed: number): Outcome {
  const config: EpisodeConfig = {
    scenario: scarcityScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      { id: "p1", planner: "deterministic", policy, plannerConfig } as EpisodeTenant,
    ],
  };
  const result = runEpisode(config);
  const p1 = result.finalWorld.players.get("p1")!;
  const maxDist = Math.max(0, ...p1.units.map((u) => Math.abs(u.position[0]) + Math.abs(u.position[1])));
  return { res: p1.resources, pop: p1.units.length, workerMaxDist: maxDist };
}

async function main(): Promise<void> {
  const lines: string[] = [
    `=== 资源枯竭应对（近处资源采完、远处 30 格外、无 refill；${TICKS} ticks × ${SEEDS.length} seeds）===`,
    "variant                    | res   | pop  | workerMaxDist",
  ];
  const rows: { name: string; res: number }[] = [];
  for (const { name, policy, plannerConfig } of VARIANTS) {
    const outs = await Promise.all(SEEDS.map((seed) => runVariant(policy, plannerConfig, seed)));
    const res = mean(outs.map((o) => o.res));
    const pop = mean(outs.map((o) => o.pop));
    const dist = mean(outs.map((o) => o.workerMaxDist));
    rows.push({ name, res });
    lines.push(
      `${String(name).padEnd(26)} | ${String(res.toFixed(1)).padStart(5)} | ${String(pop.toFixed(1)).padStart(4)} | ${String(dist.toFixed(1)).padStart(13)}`,
    );
  }
  rows.sort((a, b) => b.res - a.res);
  lines.push("", `=== 最优枯竭应对：${rows[0]!.name}（res=${rows[0]!.res.toFixed(1)}）===`);
  writeFileSync(RESULT_FILE, lines.join("\n") + "\n", "utf-8");
  console.log(lines.join("\n"));
}

void main().catch((error) => {
  console.error(`resource-scarcity 实验失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
