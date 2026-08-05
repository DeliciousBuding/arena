/**
 * 策略搜索引擎 v2（2026-08-06 优化算法设计）：
 * 两阶段搜索——单人经济场景（毫秒级，refill 下长期经济可测）全网格扫描，
 * top 候选再做双人对打验证（慢但少）。
 *
 * 网格：posture × militaryRatio × workerTarget（18 组合）——
 * 覆盖生产 A/B 观察到的变量（t2 濒死：0.5/12 vs t1 存活：0.5/7，
 * 模拟器结论 0.3 拐点；workerTarget 高低对经济的影响待测）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/strategy-search.mts
 */

import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "strategy-search-result.txt";

/** 单人经济场景：10 格资源 + refill（长期经济可测）。 */
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
      resources: [[2, 0], [3, 0], [4, 0], [5, 0], [0, 2], [0, 3], [0, 4], [6, 6], [7, 7], [8, 8]],
    },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

/** 对打场景（p1=harvest/6/0 基准，p2 候选）。 */
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

/** 生产基准（v0.2.2 被压方形态）。 */
const BASE_POLICY: MacroPolicy = { posture: "harvest", workerTarget: 6, militaryRatio: 0, focusRegion: null, attackPriority: null };

/** 网格：posture × militaryRatio × workerTarget（27 组合，含 8-worker 平衡点）。 */
const GRID: readonly MacroPolicy[] = (["harvest", "balanced", "aggressive"] as const).flatMap((posture) =>
  [0, 0.3, 0.5].flatMap((militaryRatio) =>
    [6, 8, 10].map((workerTarget) => ({
      posture,
      workerTarget,
      militaryRatio,
      focusRegion: null,
      attackPriority: posture === "aggressive" ? ("core" as const) : (null as const),
    })),
  ),
);

const SOLO_SEEDS = [1, 2];
const SOLO_TICKS = 150;
const DUEL_SEEDS = [1, 2];
const DUEL_TICKS = 300;

const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;

function runSolo(policy: MacroPolicy, seed: number): number {
  const result = runEpisode({
    scenario: soloScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: SOLO_TICKS,
    refill: {},
    tenants: [{ id: "p1", planner: "deterministic", policy }],
  });
  return result.finalWorld.players.get("p1")!.resources;
}

interface DuelOutcome {
  readonly res2: number;
  readonly res1: number;
  readonly pop2: number;
}

function runDuel(policy: MacroPolicy, seed: number): DuelOutcome {
  const config: EpisodeConfig = {
    scenario: duelScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: DUEL_TICKS,
    refill: {},
    tenants: [
      { id: "p1", planner: "deterministic", policy: BASE_POLICY } as EpisodeTenant,
      { id: "p2", planner: "deterministic", policy } as EpisodeTenant,
    ],
  };
  const result = runEpisode(config);
  const p1 = result.finalWorld.players.get("p1");
  const p2 = result.finalWorld.players.get("p2");
  if (!p1 || !p2) throw new Error(`missing player seed=${seed}`);
  return { res1: p1.resources, res2: p2.resources, pop2: p2.units.length };
}

interface Row {
  readonly policy: MacroPolicy;
  readonly soloRes: number;
  readonly duelRes2: number;
  readonly duelRes1: number;
  readonly duelPop2: number;
  readonly composite: number;
}

async function main(): Promise<void> {
  // 阶段 1：单人经济全网格（毫秒级）
  const soloRows = await Promise.all(GRID.map(async (policy) => {
    const solos = await Promise.all(SOLO_SEEDS.map((seed) => runSolo(policy, seed)));
    return { policy, soloRes: mean(solos) };
  }));
  soloRows.sort((a, b) => b.soloRes - a.soloRes);

  const lines: string[] = [
    "=== 策略搜索 v2（单人 300 ticks × 3 seeds + refill；top4 对打 300 ticks × 2 seeds）===",
    "单人经济排名：",
    "posture   | milRatio | workers | solo res",
  ];
  for (const row of soloRows) {
    lines.push(
      `${String(row.policy.posture).padStart(9)} | ${String(row.policy.militaryRatio).padStart(8)} | ${String(row.policy.workerTarget).padStart(7)} | ${String(row.soloRes.toFixed(1)).padStart(8)}`,
    );
  }

  // 阶段 2：top 4 对打验证（慢但少）
  const top = soloRows.slice(0, 4);
  lines.push("", "对打验证（p1=harvest/6/0 基准）：", "posture   | milRatio | workers | p2 res | p1 res | p2 pop");
  const duelRows: Row[] = [];
  for (const { policy } of top) {
    const duels = await Promise.all(DUEL_SEEDS.map((seed) => runDuel(policy, seed)));
    const row: Row = {
      policy,
      soloRes: soloRows.find((r) => r.policy === policy)!.soloRes,
      duelRes2: mean(duels.map((d) => d.res2)),
      duelRes1: mean(duels.map((d) => d.res1)),
      duelPop2: mean(duels.map((d) => d.pop2)),
      composite: 0,
    };
    duelRows.push(row);
    lines.push(
      `${String(policy.posture).padStart(9)} | ${String(policy.militaryRatio).padStart(8)} | ${String(policy.workerTarget).padStart(7)} | ${String(row.duelRes2.toFixed(1)).padStart(6)} | ${String(row.duelRes1.toFixed(1)).padStart(6)} | ${String(row.duelPop2.toFixed(1)).padStart(6)}`,
    );
  }
  const bestSolo = soloRows[0]!.soloRes;
  const bestDuel = Math.max(...duelRows.map((r) => r.duelRes2 - r.duelRes1));
  for (const row of duelRows) {
    row.composite = 0.5 * (row.soloRes / bestSolo) + 0.5 * ((row.duelRes2 - row.duelRes1) / bestDuel);
  }
  duelRows.sort((a, b) => b.composite - a.composite);
  const best = duelRows[0]!;
  lines.push("", "=== 最优策略候选 ===", JSON.stringify(best.policy, null, 2));
  lines.push(`composite=${best.composite.toFixed(3)} solo=${best.soloRes.toFixed(1)} duelEdge=${(best.duelRes2 - best.duelRes1).toFixed(1)}`);
  writeFileSync(RESULT_FILE, lines.join("\n") + "\n", "utf-8");
  console.log(lines.join("\n"));
}

void main().catch((error) => {
  console.error(`strategy-search 失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
