/**
 * 产兵让位 A/B（2026-08-08，spawn-yield-v1 候选验证）：
 * 生产 t2 实证 112 次 CORE_SPAWN_FAILED/CELL_UNIT_LIMIT——DEPOSIT Phase8
 * 先于 SPAWN Phase10，满载 worker 卸货成功仍占核心格 → 同 tick SPAWN 被
 * 自己人挡掉（74 次本 tick 移入核心格 + 38 次已在核心格）。
 *
 * 场景：核心持续想产兵（人口未满 + 资源充足），满载 worker 持续回核心
 * 卸货——baseline 下 worker 卸货占格挡 SPAWN，产兵被无限拖延；
 * spawnYield 下 worker 让位，核心每 tick 顺利产兵。
 * KPI：CORE_SPAWN_FAILED(CELL_UNIT_LIMIT) 次数、CORE_SPAWN_SUCCEEDED 数、
 * 最终人口、最终资源。
 * 用法：cd packages/arena-agent && npx tsx scripts/spawn-yield-ab.mts
 */
import { runEpisode } from "../src/sim/harness/episode.ts";
import type { SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";
import { DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";

function spawnYieldScenario(seed: number) {
  return {
    rulesVersion: "v0.14" as const,
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 30,
        core: {
          id: "11111111-1111-1111-1111-111111111111", position: [0, 0],
          hp: 5, shield: 5, state: "NORMAL",
          moveDirection: null, moveProgress: null, moveRequiredTicks: null, destination: null,
        },
        units: [
          // 满载 worker 持续回核心卸货（核心格 + 3 邻格）
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [0, 0], hp: 2, unitType: "WORKER", cargo: 1 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 1 },
          { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 1 },
          { id: "22222222-2222-2222-2222-222222222204", owner: "p1", position: [-1, 0], hp: 2, unitType: "WORKER", cargo: 1 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[3, 0], [0, 3], [-3, 0], [0, -3], [5, 0], [0, 5], [3, 3], [-3, -3]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const SEEDS = [1, 2, 3];
const TICKS = 80;

function runVariant(overrides: Partial<SafetyPlannerConfig>, seed: number) {
  const result = runEpisode({
    scenario: spawnYieldScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      {
        id: "p1", planner: "safety",
        plannerConfig: { ...DEFAULT_SAFETY_CONFIG, ...overrides },
        policy: { posture: "balanced", workerTarget: 6, militaryRatio: 0, focusRegion: null, attackPriority: null },
      },
    ],
  } as never);
  let spawnFailed = 0;
  const failedByReason = new Map<string, number>();
  let spawnOk = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "CORE_SPAWN_FAILED") {
        spawnFailed += 1;
        const reason = (event as { reasonCode?: string }).reasonCode ?? "?";
        failedByReason.set(reason, (failedByReason.get(reason) ?? 0) + 1);
      } else if (event.eventType === "CORE_SPAWN_SUCCEEDED") {
        spawnOk += 1;
      }
    }
  }
  const player = result.finalWorld.players.get("p1");
  const resources = player?.resources ?? 30;
  const population = player?.units.length ?? 4;
  const reasonText = [...failedByReason.entries()].map(([r, n]) => `${r}=${n}`).join(" ");
  return { spawnFailed, spawnOk, resources, population, reasonText };
}

console.log(`v0.14 产兵让位 A/B（${TICKS} ticks × ${SEEDS.length} seeds，满载 worker 持续回核心 + 核心持续产兵）`);
console.log("=".repeat(90));
for (const [label, cfg] of [
  ["baseline（卸货优先）", {}],
  ["spawnYield（产兵让位）", { spawnYield: true }],
] as const) {
  const outcomes = SEEDS.map((seed) => runVariant(cfg as Partial<SafetyPlannerConfig>, seed));
  const avgFail = outcomes.reduce((s, o) => s + o.spawnFailed, 0) / outcomes.length;
  const avgOk = outcomes.reduce((s, o) => s + o.spawnOk, 0) / outcomes.length;
  const avgRes = outcomes.reduce((s, o) => s + o.resources, 0) / outcomes.length;
  const avgPop = outcomes.reduce((s, o) => s + o.population, 0) / outcomes.length;
  console.log(`${label.padEnd(26)} | SPAWN_FAILED(avg)=${avgFail.toFixed(1)} | SPAWN_OK(avg)=${avgOk.toFixed(1)} | 终局pop=${avgPop.toFixed(1)} | 终局res=${avgRes.toFixed(1)}`);
  for (const [i, o] of outcomes.entries()) {
    console.log(`  seed ${i + 1}: fail=${o.spawnFailed} ok=${o.spawnOk} pop=${o.population} res=${o.resources} | ${o.reasonText}`);
  }
}
