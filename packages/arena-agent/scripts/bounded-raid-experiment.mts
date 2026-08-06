/**
 * boundedRaid A/B 实验（2026-08-07，B6 竞品 "exceeds the bounded mission
 * distance" 对照）：
 * 场景 = p1 aggressive Vanguard 远征到敌 Core 旁（[48,0] 距 p2 Core
 * [52,0] 4 格——记忆敌 Core 位置 [52,0] 距 p1 Core 52 > 40 = 超限）；
 * p2 拦截 Vanguard [44,0]（进入 B5 5 格响应半径 → B5 触发返回）。
 * 对照组 p1 { detachedSquadResponse }：B5 返回 8 tick 后恢复记忆推进 →
 * 压回 p2 → 再拦截 → 拉锯消耗（最终被 p2 守军磨死）；
 * 变体组 p1 { detachedSquadResponse, boundedRaid }：B5 返回后 B6 检查
 * 记忆距离 52 > 40 → 不回压（bounded_return）→ 存活。
 * KPI：p1 军事存活、p2 击杀 p1 数、p1 Core 存活。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/bounded-raid-experiment.mts
 */
import { runEpisode } from "../src/sim/harness/episode.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const SEEDS = [1, 2, 3];
const TICKS = 300;

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
          // 远征 Vanguard 在 [48,0]（距 p2 Core [52,0] 4 格 = 可见 → 记忆超限位置）
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [48, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [-8, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 20,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [52, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          // 拦截者（距 v1 [48,0] 4 格 = B5 响应半径内）
          { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [44, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          // p2 Core 守卫（守位不动）
          { id: "55555555-5555-5555-5555-555555555504", owner: "p2", position: [53, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555505", owner: "p2", position: [51, -1], hp: 4, unitType: "VANGUARD", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[-8, 0], [55, 0], [53, 1]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

function runVariant(boundedRaid: boolean, seed: number): { p1Military: number; p2Kills: number; p1CoreAlive: boolean } {
  const result = runEpisode({
    scenario: scenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      {
        id: "p1",
        planner: "safety",
        plannerConfig: { aggression: "aggressive", detachedSquadResponse: true, boundedRaid },
        policy: { posture: "aggressive", workerTarget: 4, militaryRatio: 0.5, focusRegion: null, attackPriority: "core" },
      },
      { id: "p2", planner: "safety", plannerConfig: {}, policy: { posture: "balanced", workerTarget: 4, militaryRatio: 0.4, focusRegion: null, attackPriority: null } },
    ],
  });
  let p2Kills = 0;
  let p1CoreAlive = true;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "UNIT_DESTROYED") {
        const values = (event as { values?: Record<string, unknown> }).values ?? {};
        if (String(values.owner ?? "") === "p1") p2Kills += 1;
      }
      if (event.eventType === "CORE_DESTROYED" && String(event.targetId ?? "").startsWith("1111")) p1CoreAlive = false;
    }
  }
  const p1 = result.finalWorld.players.get("p1")!;
  return {
    p1Military: p1.units.filter((u) => u.unitType !== "WORKER").length,
    p2Kills,
    p1CoreAlive,
  };
}

console.log(`boundedRaid A/B（${TICKS} ticks × ${SEEDS.length} seeds，B5 拦截后拉锯 vs B6 阻止再压，v0.14）`);
console.log("=".repeat(88));
for (const [label, boundedRaid] of [["boundedRaid=false（仅B5）", false], ["boundedRaid=true （B5+B6）", true]] as const) {
  const outcomes = SEEDS.map((seed) => runVariant(boundedRaid, seed));
  const avgMil = (outcomes.reduce((s, o) => s + o.p1Military, 0) / outcomes.length).toFixed(1);
  const avgKills = (outcomes.reduce((s, o) => s + o.p2Kills, 0) / outcomes.length).toFixed(1);
  const alive = outcomes.filter((o) => o.p1CoreAlive).length;
  console.log(`${label} | 均p1军事存活=${avgMil}/1 | 均被杀=${avgKills} | p1core存活=${alive}/${SEEDS.length}`);
  for (const [i, o] of outcomes.entries()) {
    console.log(`  seed ${i + 1}: 存活=${o.p1Military} 被杀=${o.p2Kills} core=${o.p1CoreAlive ? "活" : "毁"}`);
  }
}
