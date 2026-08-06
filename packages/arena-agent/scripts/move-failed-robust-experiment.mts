/**
 * moveFailedAvoidance 稳健性重验（2026-08-06，第三十二轮）：
 * A/B（false vs true）× 4 场景：
 * A 复现正收益（2 Vanguard vs 敌守军 CORE——争格卡死场景）
 * B 富供给无争格（无守军 CORE + refill 65——正常推进不应被绕行破坏/抖动）
 * C 枯竭经济（生产校准形态经济长跑——无 MOVE_FAILED 时输出应一致）
 * D worker 满载回仓被争格卡死（评估 worker 分支缺口——本轮未接线，预期均卡）
 * KPI：CORE_DESTROYED 轮次、首拆 tick、p1res。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/move-failed-robust-experiment.mts
 */
import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "move-failed-robust-result.txt";

interface ScenarioSpec {
  name: string;
  refill: { everyTicks: number } | undefined;
  p1Units: Record<string, unknown>[];
  p2Units: Record<string, unknown>[];
  p2Resources: number;
  resources: [number, number][];
  ticks: number;
}

const scenarios: ScenarioSpec[] = [
  {
    name: "A-敌守军争格",
    refill: { everyTicks: 300 },
    p1Units: [
      { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [18, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
      { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [19, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
      { id: "22222222-2222-2222-2222-222222222299", owner: "p1", position: [5, 0], hp: 2, unitType: "WORKER", cargo: 0 },
    ],
    p2Units: [],
    p2Resources: 50,
    resources: [[3, 0], [4, 0], [20, 0], [21, 0]],
    ticks: 400,
  },
  {
    name: "B-富供给无守军",
    refill: { everyTicks: 65 },
    p1Units: [
      { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [18, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
      { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [19, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
      { id: "22222222-2222-2222-2222-222222222299", owner: "p1", position: [5, 0], hp: 2, unitType: "WORKER", cargo: 0 },
    ],
    p2Units: [],
    p2Resources: 0,
    resources: [[3, 0], [4, 0], [20, 0], [21, 0]],
    ticks: 400,
  },
  {
    name: "C-枯竭经济",
    refill: { everyTicks: 300 },
    p1Units: [
      { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [1, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
      { id: "22222222-2222-2222-2222-222222222299", owner: "p1", position: [5, 0], hp: 2, unitType: "WORKER", cargo: 0 },
      { id: "22222222-2222-2222-2222-222222222298", owner: "p1", position: [6, 0], hp: 2, unitType: "WORKER", cargo: 0 },
      { id: "22222222-2222-2222-2222-222222222297", owner: "p1", position: [7, 0], hp: 2, unitType: "WORKER", cargo: 0 },
    ],
    p2Units: [],
    p2Resources: 0,
    resources: [[3, 0], [4, 0], [8, 0], [9, 0]],
    ticks: 400,
  },
  {
    name: "D-worker回仓被争",
    refill: { everyTicks: 300 },
    p1Units: [
      { id: "22222222-2222-2222-2222-222222222299", owner: "p1", position: [18, 0], hp: 2, unitType: "WORKER", cargo: 2 },
      { id: "22222222-2222-2222-2222-222222222298", owner: "p1", position: [19, 0], hp: 2, unitType: "WORKER", cargo: 0 },
      { id: "22222222-2222-2222-2222-222222222297", owner: "p1", position: [20, 0], hp: 2, unitType: "WORKER", cargo: 0 },
    ],
    p2Units: [
      { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [19, 1], hp: 4, unitType: "VANGUARD", cargo: 0 },
      { id: "55555555-5555-5555-5555-555555555502", owner: "p2", position: [20, 1], hp: 4, unitType: "VANGUARD", cargo: 0 },
    ],
    p2Resources: 50,
    resources: [[3, 0], [4, 0], [18, 1], [20, 1]],
    ticks: 400,
  },
];

function scenario(spec: ScenarioSpec, seed: number) {
  return {
    rulesVersion: "v0.11",
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 50,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: spec.p1Units.map((u) => ({ ...u })),
      },
      {
        id: "p2", username: "p2", resources: spec.p2Resources,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [22, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: spec.p2Units.map((u) => ({ ...u })),
      },
    ],
    terrain: { obstacles: [], resources: spec.resources.map(([x, y]) => [x, y]) },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const SEEDS = [1, 2];

function runVariant(spec: ScenarioSpec, moveFailedAvoidance: boolean, seed: number): { destroyedRounds: number; firstDestroyTick: number | null; res1: number } {
  const config: EpisodeConfig = {
    scenario: scenario(spec, seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: spec.ticks,
    refill: spec.refill,
    tenants: [
      {
        id: "p1",
        planner: "safety",
        plannerConfig: { aggression: "aggressive", moveFailedAvoidance },
        policy: { posture: "aggressive", workerTarget: 6, militaryRatio: 0.4, focusRegion: null, attackPriority: "core" },
      } as EpisodeTenant,
      { id: "p2", planner: "safety" } as EpisodeTenant,
    ],
  };
  const result = runEpisode(config);
  let destroyedRounds = 0;
  let firstDestroyTick: number | null = null;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "CORE_DESTROYED") {
        destroyedRounds += 1;
        if (firstDestroyTick === null) firstDestroyTick = record.tick;
      }
    }
  }
  const p1 = result.finalWorld.players.get("p1")!;
  return { destroyedRounds, firstDestroyTick, res1: p1.resources };
}

const rows: string[] = [];
rows.push(`moveFailedAvoidance 稳健性重验（2 seeds × 4 场景 × A/B，refill 按场景）`);
rows.push("=".repeat(96));
for (const spec of scenarios) {
  rows.push(`[${spec.name}]`);
  for (const variant of [false, true]) {
    let destroyed = 0;
    let destroyTickSum = 0;
    let destroyCount = 0;
    let resSum = 0;
    const details: string[] = [];
    for (const seed of SEEDS) {
      const o = runVariant(spec, variant, seed);
      destroyed += o.destroyedRounds;
      resSum += o.res1;
      if (o.firstDestroyTick !== null) { destroyTickSum += o.firstDestroyTick; destroyCount += 1; }
      details.push(`seed ${seed}: 拆=${o.destroyedRounds} 首拆=${o.firstDestroyTick} res=${o.res1}`);
    }
    rows.push(
      `  avoidance=${variant}: 拆CORE=${destroyed}/2 均首拆=${destroyCount ? (destroyTickSum / destroyCount).toFixed(0) : "—"} 均res=${(resSum / SEEDS.length).toFixed(1)}`,
    );
    for (const d of details) rows.push(`    ${d}`);
  }
}
const output = rows.join("\n");
console.log(output);
writeFileSync(RESULT_FILE, output + "\n");
