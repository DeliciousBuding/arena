/**
 * SWEEP 同时结算验证（2026-08-07，官方 combat.md "Nothing grants
 * initiative" / "mutual destruction is a normal outcome" 对照）：
 * 双方 Vanguard hp=1 互邻互砍（SWEEP 对面）——官方语义 = 同时结算，
 * 双方都死（同归于尽）；若引擎顺序结算（先手必胜）则一方存活。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/sweep-simultaneity-check.mts
 */
import { runEpisode } from "../src/sim/harness/episode.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";

const scenario = {
  rulesVersion: "v0.14" as const,
  tick: 1,
  seed: 1,
  players: [
    {
      id: "p1", username: "p1", resources: 20,
      core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
      units: [
        { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [0, 1], hp: 1, unitType: "VANGUARD", cargo: 0 },
      ],
    },
    {
      id: "p2", username: "p2", resources: 20,
      core: { id: "44444444-4444-4444-4444-444444444444", position: [10, 0], hp: 5, shield: 5, state: "NORMAL" },
      units: [
        { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [1, 1], hp: 1, unitType: "VANGUARD", cargo: 0 },
      ],
    },
  ],
  terrain: { obstacles: [], resources: [] },
  beacon: { position: [100, 100], status: "GROUND", carrierId: null },
};

const result = runEpisode({
  scenario,
  rulesPath: MANIFEST_PATH,
  seed: 1,
  ticks: 2,
  tenants: [
    { id: "p1", planner: "safety", plannerConfig: { aggression: "aggressive" }, policy: { posture: "aggressive", workerTarget: 4, militaryRatio: 0.5, focusRegion: null, attackPriority: "core" } },
    { id: "p2", planner: "safety", plannerConfig: {}, policy: { posture: "balanced", workerTarget: 4, militaryRatio: 0.4, focusRegion: null, attackPriority: null } },
  ],
});

const tick1 = result.records[0];
const damaged = tick1.events.filter((e) => e.eventType === "UNIT_DAMAGED");
const sweeps = tick1.events.filter((e) => e.eventType === "SWEEP_RESOLVED");
console.log(`tick1: SWEEP_RESOLVED=${sweeps.length} UNIT_DAMAGED=${damaged.length}`);
for (const s of sweeps) console.log(`  SWEEP ${s.actorId?.slice(-4)} → ${JSON.stringify(s.position)} targets_hit=${(s.values ?? {}).targets_hit}`);
for (const d of damaged) console.log(`  DAMAGED ${d.targetId?.slice(-4)} hp=${(d.values ?? {}).hp} (damage=${(d.values ?? {}).damage})`);

const finalP1 = result.finalWorld.players.get("p1")!;
const finalP2 = result.finalWorld.players.get("p2")!;
const p1Alive = finalP1.units.some((u) => u.id === "22222222-2222-2222-2222-222222222201");
const p2Alive = finalP2.units.some((u) => u.id === "55555555-5555-5555-5555-555555555501");
console.log(`final: p1 v1 ${p1Alive ? "存活" : "死亡"} | p2 v1 ${p2Alive ? "存活" : "死亡"}`);
if (!p1Alive && !p2Alive) {
  console.log("VERDICT: 同归于尽 = 同时结算 ✓（官方 combat.md 语义，无先手优势）");
} else if (p1Alive !== p2Alive) {
  console.log(`VERDICT: 单方存活 = 顺序结算 ✗（存在先手优势，与官方 "Nothing grants initiative" 矛盾）`);
} else {
  console.log("VERDICT: 双方都存活（未互砍？）——检查 SWEEP 方向");
}
