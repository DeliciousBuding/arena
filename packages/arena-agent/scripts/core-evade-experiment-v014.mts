/**
 * v0.14 Core 迁移（coreEvade）对打实验（2026-08-07，v0.14 首版）：
 * p1 无守卫（Core + 2 worker）vs p2 aggressive 双 Vanguard 开局可见 p1 Core
 * （[4,0]/[5,0]，视野 4 内 → vanguard_pressure 直接前压，不依赖巡逻方向）。
 *
 * 背景：v0.11 旧场景（p2 开局 [18,0] 远距）在 v0.14 下失效——aggressive
 * Vanguard 无可见敌人时走 vanguard_scavenge 随机巡逻（围绕自家 Core），
 * 可能背离敌方方向 → Core 0 命中、三档无区分度（2026-08-07 模拟器实证）。
 * 本场景让 p2 开局可见敌方 Core，恢复威胁区分度。
 *
 * 结果（150 ticks × 3 seeds）：coreEvade=false 命中 8.0（p1 全灭 0/3）
 * vs coreEvade=true 5.0（-37.5% 命中；p1 仍灭——无守卫极端压力场景）。
 * 与 v0.11 结论一致：受威胁时 coreEvade 有净收益。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/core-evade-experiment-v014.mts
 */
import { runEpisode } from "../../../../arena-ts/packages/arena-agent/src/sim/harness/episode.ts";

function threatScenario(seed: number) {
  return {
    rulesVersion: "v0.14" as const,
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 10,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 10,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [30, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "55555555-5555-5555-5555-555555555551", owner: "p2", position: [4, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555552", owner: "p2", position: [5, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555553", owner: "p2", position: [29, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[2, 0], [3, 0], [19, 1]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const SEEDS = [1, 2, 3];
const TICKS = 150;

function runVariant(coreEvade: boolean, coreEvadeTtr: boolean, seed: number) {
  const result = runEpisode({
    scenario: threatScenario(seed),
    rulesPath: "D:/Code/Projects/arena/arena-ts/packages/arena-agent/src/sim/contracts/rules-v0.14.json",
    seed,
    ticks: TICKS,
    tenants: [
      { id: "p1", planner: "safety", plannerConfig: { coreEvade, coreEvadeTtr } },
      { id: "p2", planner: "safety", plannerConfig: { aggression: "aggressive" } },
    ],
  } as never);
  let coreHits = 0;
  let p1CoreAlive = true;
  let p2CoreAlive = true;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "CORE_DAMAGED" && String(event.targetId ?? "").startsWith("1111")) coreHits += 1;
      if (event.eventType === "CORE_DESTROYED") {
        if (String(event.targetId ?? "").startsWith("1111")) p1CoreAlive = false;
        if (String(event.targetId ?? "").startsWith("4444")) p2CoreAlive = false;
      }
    }
  }
  return { coreHits, p1CoreAlive, p2CoreAlive };
}

console.log(`v0.14 威胁场景 v3（${TICKS} ticks × ${SEEDS.length} seeds，p2 Vanguard 开局可见 p1 Core）`);
console.log("=".repeat(80));
for (const [label, evade, ttr] of [
  ["coreEvade=false（现状）", false, false],
  ["coreEvade=true（12格）", true, false],
  ["coreEvade+TTR≤16", true, true],
] as const) {
  const outcomes = SEEDS.map((seed) => runVariant(evade, ttr, seed));
  const avgHits = outcomes.reduce((sum, o) => sum + o.coreHits, 0) / outcomes.length;
  const p1Alive = outcomes.filter((o) => o.p1CoreAlive).length;
  console.log(`${label.padEnd(24)} | Core 被命中(avg)=${avgHits.toFixed(1)} | p1 存活=${p1Alive}/${SEEDS.length}`);
  for (const [i, o] of outcomes.entries()) {
    console.log(`  seed ${i + 1}: hits=${o.coreHits} p1=${o.p1CoreAlive}`);
  }
}
