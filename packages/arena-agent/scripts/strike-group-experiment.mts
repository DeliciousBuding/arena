/**
 * 守卫预留 A/B（2026-08-07，B7 候选——竞品 _strike_group_ids 对照）：
 * 换家战场景——p1（3 Vanguard）拆 p2，p2（2 Vanguard）同时拆 p1。
 * 对照组：p1 全压（家空防——p2 换家得手）；
 * 变体：p1 留 1 Vanguard 守家（vanguard_home_guard）——p2 拆家被拦。
 * KPI：p1 Core 存活、p2 Core 被拆时间、p1 守卫击杀。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/strike-group-experiment.mts
 */
import { runEpisode, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { PlanProvider } from "../src/runtime/decision-types.ts";
import { SafetyPlanner } from "../src/strategies/safety-planner.ts";
import { DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const SEEDS = [1, 2, 3];
const TICKS = 150;

function scenario(seed: number) {
  return {
    rulesVersion: "v0.14" as const,
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 20,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222211", owner: "p1", position: [4, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222212", owner: "p1", position: [4, 1], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222213", owner: "p1", position: [4, 2], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [3, 3], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [3, 4], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 20,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [12, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "55555555-5555-5555-5555-555555555511", owner: "p2", position: [8, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555512", owner: "p2", position: [8, 1], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [9, 3], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555502", owner: "p2", position: [9, 4], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[3, 0], [3, 1], [9, 0], [9, 1]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

function runVariant(reserve: boolean, seed: number): { p1CoreAlive: boolean; p2CoreAlive: boolean; p2DestroyedAt: number; p1VanguardDeaths: number } {
  const makeP1Planner = (useReserve: boolean) => (tenant: EpisodeTenant): PlanProvider => {
    if (tenant.id !== "p1" || !useReserve) return new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" });
    return new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive", strikeGroupReserve: true });
  };
  const result = runEpisode({
    scenario: scenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    plannerFactory: makeP1Planner(reserve),
    tenants: [
      { id: "p1", planner: "safety", policy: { posture: "aggressive", workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: "core" } },
      { id: "p2", planner: "safety", policy: { posture: "aggressive", workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: "core" } },
    ],
  });
  let p1CoreAlive = true;
  let p2CoreAlive = true;
  let p2DestroyedAt = -1;
  let p1VanguardDeaths = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      const actor = String(event.actorId ?? "");
      if (event.eventType === "CORE_DESTROYED") {
        const target = String(event.targetId ?? "");
        if (target.startsWith("1111")) p1CoreAlive = false;
        if (target.startsWith("4444")) { p2CoreAlive = false; p2DestroyedAt = record.tick; }
      }
      if (event.eventType === "UNIT_DAMAGED" && actor.startsWith("2222") && event.values?.hp === 0) {
        p1VanguardDeaths += 1;
      }
    }
  }
  return { p1CoreAlive, p2CoreAlive, p2DestroyedAt, p1VanguardDeaths };
}

console.log(`strike-group A/B（${TICKS} ticks × ${SEEDS.length} seeds，换家战：p1 3v vs p2 2v）`);
console.log("=".repeat(80));
console.log(`对照组（全压——家空防）`);
const control = SEEDS.map((seed) => runVariant(false, seed));
const cAlive = control.filter((o) => o.p1CoreAlive).length;
const cDestroyed = control.filter((o) => !o.p2CoreAlive).length;
const cAvg = control.filter((o) => o.p2DestroyedAt > 0).reduce((s, o) => s + o.p2DestroyedAt, 0) / Math.max(1, control.filter((o) => o.p2DestroyedAt > 0).length);
console.log(`  p1 Core 存活=${cAlive}/${SEEDS.length} | p2 被拆=${cDestroyed}/${SEEDS.length} (avg t${cAvg.toFixed(0)})`);
for (const [i, o] of control.entries()) console.log(`  seed ${i + 1}: p1=${o.p1CoreAlive ? "活" : "毁"} p2=${o.p2CoreAlive ? "活" : "毁"} destroyed_at=${o.p2DestroyedAt} p1v死=${o.p1VanguardDeaths}`);
console.log(`变体（守卫预留——1 Vanguard 守家）`);
const variant = SEEDS.map((seed) => runVariant(true, seed));
const vAlive = variant.filter((o) => o.p1CoreAlive).length;
const vDestroyed = variant.filter((o) => !o.p2CoreAlive).length;
const vAvg = variant.filter((o) => o.p2DestroyedAt > 0).reduce((s, o) => s + o.p2DestroyedAt, 0) / Math.max(1, variant.filter((o) => o.p2DestroyedAt > 0).length);
console.log(`  p1 Core 存活=${vAlive}/${SEEDS.length} | p2 被拆=${vDestroyed}/${SEEDS.length} (avg t${vAvg.toFixed(0)})`);
for (const [i, o] of variant.entries()) console.log(`  seed ${i + 1}: p1=${o.p1CoreAlive ? "活" : "毁"} p2=${o.p2CoreAlive ? "活" : "毁"} destroyed_at=${o.p2DestroyedAt} p1v死=${o.p1VanguardDeaths}`);
