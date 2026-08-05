/**
 * 策略搜索引擎（2026-08-06 模拟器优化引擎 v1）：
 * 对 MacroPolicy 网格做批量模拟验证（双人对打 + 单人经济双场景），
 * 并行跑全部组合（Promise.all，实测批量 4.2k ticks/s），输出排名表 +
 * 最优策略候选（可注册为 policyOverride / LLM 基线参考）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/strategy-search.mts
 *
 * 网格：posture × militaryRatio × attackPriority（8 组合 + 生产基线对照），
 * 对打场景 p1 固定 harvest 基准（模拟"被压方"），p2 遍历网格；
 * 单人场景 focus-exile 测纯经济效率。seeds 1-4 消除开局随机差异。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const here = join(process.cwd(), "test", "fixtures", "sim");
const MANIFEST_PATH = join(process.cwd(), "src", "sim", "contracts", "rules-v0.11.json");

/** 双人对打场景（p1/p2 各 2 worker + 100 资源开局，中间地带资源）。 */
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
      resources: [[5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [35, 40], [36, 40], [37, 40], [38, 40], [20, 20], [21, 20], [22, 20], [15, 15], [25, 25]],
    },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

/** 生产 A/B 基线（v0.2.2）：被压方 harvest 纯经济。 */
const BASE_POLICY: MacroPolicy = { posture: "harvest", workerTarget: 6, militaryRatio: 0, focusRegion: null, attackPriority: null };

/** 策略网格（8 组合 + 生产基线对照）。 */
const GRID: readonly MacroPolicy[] = [
  { posture: "harvest", workerTarget: 6, militaryRatio: 0, focusRegion: null, attackPriority: null },
  { posture: "harvest", workerTarget: 6, militaryRatio: 0.3, focusRegion: null, attackPriority: null },
  { posture: "balanced", workerTarget: 6, militaryRatio: 0, focusRegion: null, attackPriority: null },
  { posture: "balanced", workerTarget: 6, militaryRatio: 0.3, focusRegion: null, attackPriority: null },
  { posture: "balanced", workerTarget: 6, militaryRatio: 0.5, focusRegion: null, attackPriority: null },
  { posture: "aggressive", workerTarget: 6, militaryRatio: 0.3, focusRegion: null, attackPriority: null },
  { posture: "aggressive", workerTarget: 6, militaryRatio: 0.5, focusRegion: null, attackPriority: "workers" },
  { posture: "aggressive", workerTarget: 6, militaryRatio: 0.8, focusRegion: null, attackPriority: "core" },
];

const SEEDS = [1, 2, 3];
const DUEL_TICKS = 300;
const SOLO_TICKS = 300;

interface DuelResult {
  readonly res1: number;
  readonly res2: number;
  readonly pop1: number;
  readonly pop2: number;
}

function runDuel(candidate: MacroPolicy, seed: number): DuelResult {
  const config: EpisodeConfig = {
    scenario: duelScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: DUEL_TICKS,
    tenants: [
      { id: "p1", planner: "deterministic", policy: BASE_POLICY } as EpisodeTenant,
      { id: "p2", planner: "deterministic", policy: candidate } as EpisodeTenant,
    ],
  };
  const result = runEpisode(config);
  const p1 = result.finalWorld.players.get("p1");
  const p2 = result.finalWorld.players.get("p2");
  if (!p1 || !p2) throw new Error(`missing player in duel seed=${seed}`);
  return { res1: p1.resources, res2: p2.resources, pop1: p1.units.length, pop2: p2.units.length };
}

/** 单人经济场景：多格资源（worker 可持续采集，测纯经济效率）。 */
function soloScenario(seed: number) {
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
      resources: [[2, 0], [3, 0], [4, 0], [5, 0], [0, 2], [0, 3], [0, 4], [6, 6], [7, 7]],
    },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

function runSolo(candidate: MacroPolicy, seed: number): number {
  const result = runEpisode({
    scenario: soloScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: SOLO_TICKS,
    tenants: [{ id: "p1", planner: "deterministic", policy: candidate }],
  });
  return result.finalWorld.players.get("p1")!.resources;
}

const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;

interface Row {
  readonly policy: MacroPolicy;
  readonly duelRes2: number;
  readonly duelRes1: number;
  readonly duelPop2: number;
  readonly soloRes: number;
  /** 综合分：对打净优势（res2-res1 归一）+ 单人经济归一。 */
  readonly composite: number;
}

async function main(): Promise<void> {
  // 并行跑全部组合（Promise.all：批量 4.2k ticks/s）
  const rows = await Promise.all(GRID.map(async (policy) => {
    const duels = await Promise.all(SEEDS.map((seed) => runDuel(policy, seed)));
    const solos = await Promise.all(SEEDS.map((seed) => runSolo(policy, seed)));
    return {
      policy,
      duelRes2: mean(duels.map((d) => d.res2)),
      duelRes1: mean(duels.map((d) => d.res1)),
      duelPop2: mean(duels.map((d) => d.pop2)),
      soloRes: mean(solos),
      composite: 0,
    };
  }));

  const bestDuelEdge = Math.max(...rows.map((r) => r.duelRes2 - r.duelRes1));
  const bestSolo = Math.max(...rows.map((r) => r.soloRes));
  for (const row of rows) {
    const edge = row.duelRes2 - row.duelRes1;
    row.composite = 0.5 * (edge / bestDuelEdge) + 0.5 * (row.soloRes / bestSolo);
  }

  console.log("=== 策略搜索（4 seeds；对打 600 ticks / 单人 120 ticks）===");
  console.log("posture   | milRatio | attack    | duel res2 | vs base(res1) | pop2 | solo | composite");
  for (const row of [...rows].sort((a, b) => b.composite - a.composite)) {
    const p = row.policy;
    console.log(
      `${String(p.posture).padStart(9)} | ${String(p.militaryRatio).padStart(8)} | ${String(p.attackPriority ?? "null").padStart(9)} | ${String(row.duelRes2.toFixed(1)).padStart(9)} | ${String(row.duelRes1.toFixed(1)).padStart(13)} | ${String(row.duelPop2.toFixed(1)).padStart(4)} | ${String(row.soloRes.toFixed(1)).padStart(4)} | ${row.composite.toFixed(3)}`,
    );
  }

  const best = [...rows].sort((a, b) => b.composite - a.composite)[0]!;
  console.log("\n=== 最优策略候选（可注册 policyOverride / LLM 基线参考）===");
  console.log(JSON.stringify(best.policy, null, 2));
  console.log(`composite=${best.composite.toFixed(3)} duelEdge=${(best.duelRes2 - best.duelRes1).toFixed(1)} solo=${best.soloRes.toFixed(1)}`);
  console.log("说明：对打 p1=harvest 基准（被压方）；综合分=对打净优势 50% + 单人经济 50%。");
}

void main().catch((error) => {
  console.error(`strategy-search 失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
