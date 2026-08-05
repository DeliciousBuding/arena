/**
 * MacroPolicy 网格扫描（v0.2.12 离线验证工具）：
 * 双玩家对抗，p1 无军事（militaryRatio=0），p2 按不同 militaryRatio 产兵清场，
 * 对比经济（资源增长/人口）。验证"militaryRatio 消费 → 清场 → 经济提升"。
 *
 * 依赖 v0.2.12 EpisodeTenant.policy 注入（episode.ts decide 携带 policy）——
 * 无注入时 workerTarget=floor=2 → 模拟器无补员 → 经济恒死（扫描全零即此故障）。
 * 用法：npx tsx scripts/policy-scan.ts（默认 3 seeds × 600 ticks）。
 */
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../packages/arena-agent/src/sim/harness/episode.ts";
import type { MacroPolicy } from "../packages/arena-agent/src/runtime/macro-policy.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "packages", "arena-agent", "src", "sim", "contracts", "rules-v0.11.json");

function scenario(seed: number) {
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
        core: { id: "33333333-3333-3333-3333-333333333333", position: [40, 40], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "44444444-4444-4444-4444-444444444444", owner: "p2", position: [41, 40], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "44444444-4444-4444-4444-444444444445", owner: "p2", position: [40, 41], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: {
      obstacles: [],
      resources: [[5, 0], [6, 0], [35, 40], [36, 40], [20, 20], [21, 20]],
    },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const BASE_POLICY: MacroPolicy = { posture: "harvest", workerTarget: 6, militaryRatio: 0, focusRegion: null, attackPriority: null };

for (const ratio of [0, 0.3, 0.5]) {
  const policy2: MacroPolicy = { posture: "balanced", workerTarget: 6, militaryRatio: ratio, focusRegion: null, attackPriority: null };
  const results: Array<{ res1: number; res2: number; pop1: number; pop2: number }> = [];
  for (const seed of [1, 2, 3]) {
    const config: EpisodeConfig = {
      scenario: scenario(seed),
      rulesPath: MANIFEST_PATH,
      seed,
      ticks: 600,
      tenants: [
        { id: "p1", planner: "deterministic", policy: BASE_POLICY } as EpisodeTenant,
        { id: "p2", planner: "deterministic", policy: policy2 } as EpisodeTenant,
      ],
    };
    const result = runEpisode(config);
    const p1 = result.finalWorld.players.get("p1");
    const p2 = result.finalWorld.players.get("p2");
    if (!p1 || !p2) continue;
    results.push({
      res1: p1.resources, res2: p2.resources,
      pop1: p1.units.length, pop2: p2.units.length,
    });
  }
  const avg = (f: (r: { res1: number; res2: number; pop1: number; pop2: number }) => number) =>
    results.reduce((s, r) => s + f(r), 0) / results.length;
  console.log(
    `militaryRatio=${ratio}: p1(res)avg=${avg((r) => r.res1).toFixed(1)} p2(res)avg=${avg((r) => r.res2).toFixed(1)} ` +
    `p1(pop)avg=${avg((r) => r.pop1).toFixed(1)} p2(pop)avg=${avg((r) => r.pop2).toFixed(1)} (3 seeds x 600 ticks)`,
  );
}
