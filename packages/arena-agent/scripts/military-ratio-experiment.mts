/**
 * 军事比例聚焦实验（2026-08-06 生产问题驱动）：
 * 本地 A/B 观察到 t2（aggressive/militaryRatio=0.5/attackPriority=core）
 * 濒死（资源 0）vs t1（LLM 自主）存活——回答"军事比例多高才健康"。
 *
 * 方法：双人对打（Core 间隔 10 格，真正交战），p1 固定 balanced/0.3
 * （模拟普遍对手），p2 遍历 militaryRatio 0/0.3/0.5/0.8；
 * 500 ticks × 3 seeds，输出资源/人口/Core 血量对比。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/military-ratio-experiment.mts
 */

import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";

/** 合理资源密度（14 格，模拟真实地图）；近似 refill 提供持续供给。 */
function resources(): Array<[number, number]> {
  return [[5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [35, 40], [36, 40], [37, 40], [38, 40], [20, 20], [21, 20], [22, 20], [15, 15], [25, 25]];
}

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
        core: { id: "33333333-3333-3333-3333-333333333333", position: [10, 10], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "44444444-4444-4444-4444-444444444444", owner: "p2", position: [11, 10], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "44444444-4444-4444-4444-444444444445", owner: "p2", position: [10, 11], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: {
      obstacles: [],
      resources: resources(),
    },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

/** p1 固定：balanced/0.3（普遍对手形态）。 */
const P1_POLICY: MacroPolicy = { posture: "balanced", workerTarget: 6, militaryRatio: 0.3, focusRegion: null, attackPriority: null };

const RATIOS = [0, 0.3, 0.5, 0.8];
const SEEDS = [1, 2, 3];
const TICKS = 500;

interface Result {
  readonly res1: number;
  readonly res2: number;
  readonly pop1: number;
  readonly pop2: number;
  readonly coreHp1: number;
  readonly coreHp2: number;
}

function runDuel(ratio2: number, seed: number): Result {
  const p2Policy: MacroPolicy = { posture: "balanced", workerTarget: 6, militaryRatio: ratio2, focusRegion: null, attackPriority: null };
  const config: EpisodeConfig = {
    scenario: duelScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    refill: {}, // 近似 refill：按规则 cadence 补回资源格（官方 server-secret，近似标注）
    tenants: [
      { id: "p1", planner: "deterministic", policy: P1_POLICY } as EpisodeTenant,
      { id: "p2", planner: "deterministic", policy: p2Policy } as EpisodeTenant,
    ],
  };
  const result = runEpisode(config);
  const p1 = result.finalWorld.players.get("p1");
  const p2 = result.finalWorld.players.get("p2");
  if (!p1 || !p2) throw new Error(`missing player seed=${seed}`);
  return {
    res1: p1.resources, res2: p2.resources,
    pop1: p1.units.length, pop2: p2.units.length,
    coreHp1: p1.core.hp, coreHp2: p2.core.hp,
  };
}

const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;

async function main(): Promise<void> {
  console.log("=== 军事比例实验（p1=balanced/0.3 固定；500 ticks × 3 seeds）===");
  console.log("p2 milRatio | p2 res | p1 res | p2 pop | p1 pop | p2 core | p1 core");
  for (const ratio of RATIOS) {
    const results = await Promise.all(SEEDS.map((seed) => runDuel(ratio, seed)));
    const avg = (f: (r: Result) => number) => mean(results.map(f));
    console.log(
      `${String(ratio).padStart(11)} | ${String(avg((r) => r.res2).toFixed(1)).padStart(6)} | ${String(avg((r) => r.res1).toFixed(1)).padStart(6)} | ${String(avg((r) => r.pop2).toFixed(1)).padStart(6)} | ${String(avg((r) => r.pop1).toFixed(1)).padStart(6)} | ${String(avg((r) => r.coreHp2).toFixed(1)).padStart(7)} | ${String(avg((r) => r.coreHp1).toFixed(1)).padStart(7)}`,
    );
  }
  console.log("解读：res 高 = 经济健康；pop 高 = 军队强；core hp 低 = 被拆家。");
}

void main().catch((error) => {
  console.error(`实验失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
