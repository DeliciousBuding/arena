/**
 * 军事单位 Core 格禁区模拟器验证（2026-08-07，生产 t2 实证修复）：
 * t2 场景复现——RANGER 守位回家路径穿 Core 格 → 与同 tick SPAWN 冲突
 * CELL_UNIT_LIMIT → 每 2 tick 一次 spawn 失败循环。
 * 修复后：RANGER 绕行不踩 Core 格 → SPAWN 成功。
 * KPI：CORE_SPAWN_SUCCEEDED / CORE_SPAWN_FAILED 次数、RANGER 是否
 * 长期占用 Core 格。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/military-core-cell-experiment.mts
 */
import { runEpisode } from "../src/sim/harness/episode.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const SEEDS = [1, 2, 3];
const TICKS = 80;

function scenario(seed: number) {
  return {
    rulesVersion: "v0.14" as const,
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 12,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          // RANGER 初始在 Core 格（满血）——t1 让位 → 守位回归
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [0, 0], hp: 2, unitType: "RANGER", cargo: 0 },
          // workers 达标（2 = target）——不产 worker
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [3, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [3, 1], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 10,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [12, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [12, 1], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555502", owner: "p2", position: [12, 2], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[3, 0], [3, 1]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

function runVariant(seed: number): { spawns: number; spawnFails: number; rangerOnCoreTicks: number } {
  const result = runEpisode({
    scenario: scenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      { id: "p1", planner: "safety", policy: { posture: "balanced", workerTarget: 2, militaryRatio: 0.5, focusRegion: null, n: null } },
      { id: "p2", planner: "safety", policy: { posture: "harvest", workerTarget: 2, militaryRatio: 0, focusRegion: null, n: null } },
    ],
  });
  let spawns = 0;
  let spawnFails = 0;
  let rangerOnCoreTicks = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (String(event.actorId ?? "").startsWith("1111")) {
        if (event.eventType === "CORE_SPAWN_SUCCEEDED") spawns += 1;
        if (event.eventType === "CORE_SPAWN_FAILED") spawnFails += 1;
      }
      if (event.eventType === "UNIT_DAMAGED" || event.eventType === "UNIT_MOVE_SUCCEEDED") {
        // 位置轨迹不直接可得——用 finalWorld 统计最后一次位置
      }
    }
  }
  // RANGER 是否在 Core 格（finalWorld）
  const p1 = result.finalWorld.players.get("p1")!;
  const ranger = p1.units.find((u) => u.unitType === "RANGER");
  if (ranger) {
    const [x, y] = ranger.position;
    if (x === 0 && y === 0) rangerOnCoreTicks = 1; // final 时刻在 Core 格
  }
  return { spawns, spawnFails, rangerOnCoreTicks };
}

console.log(`military-core-cell A/B（${TICKS} ticks × ${SEEDS.length} seeds，修复后）`);
console.log("=".repeat(72));
const outcomes = SEEDS.map((seed) => runVariant(seed));
for (const [i, o] of outcomes.entries()) {
  console.log(`  seed ${i + 1}: spawn成功=${o.spawns} spawn失败=${o.spawnFails} ranger终态在Core格=${o.rangerOnCoreTicks === 1}`);
}
const avgSpawns = outcomes.reduce((s, o) => s + o.spawns, 0) / outcomes.length;
const avgFails = outcomes.reduce((s, o) => s + o.spawnFails, 0) / outcomes.length;
console.log(`平均: spawn成功=${avgSpawns.toFixed(1)} spawn失败=${avgFails.toFixed(1)}`);
console.log(`期望：修复后 spawn 失败 ≈ 0（旧行为：每 2 tick 一次失败循环，80 ticks ≈ 30+ 次失败）`);
