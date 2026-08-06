/**
 * scoutEvade A/B 实验（2026-08-07，B10 竞品 "Scout And Observer Response"
 * 对照）：
 * 场景 = p1 worker [8,0] 在远处资源格采集；p2 aggressive Vanguard [8,3]
 * （距 worker 3 格 = worker 视野内 → 变体触发撤离）压向 worker 击杀。
 * p1 守卫 [1,0]（真实对局 Core 有守卫）：v 追 worker 到 Core 门口被
 * 守卫拦截（1v1 互砍同归于尽）。
 * 对照（scoutEvade=false）：worker 原地 harvest → v 逼近邻接 SWEEP 击杀
 * （经济单位白送——守卫远在 7 格外救不了）；
 * 变体（scoutEvade=true）：worker 见战斗单位 3 格内 → 撤离回 Core
 * （persistent return → 3 格内冷却 → 恢复）→ 存活（v 追到 Core 门口
 * 被守卫拦截）。
 * 实测（3 seeds）：变体与对照 worker 均 0/3 存活（v 追到 Core 门口
 * 击杀冷却中停驻的 worker——守卫守位不追（竞品 defenders do not
 * chase，且我们守卫无 confirmed pursuer 迎击），v 绕过守卫防线）；
 * 变体均 deposits=0.0 vs 对照 1.0——撤离丢采集且同样被杀（净负）。
 * 撤离价值依赖守卫拦截追击者（竞品 Fight 条件 "confirmed pursuer"），
 * 我们守卫无该响应 → B10 无净收益证据，变体保持候选不启用。
 * KPI：p1 worker 存活、p1 deposits（经济）、p1 单位被杀数。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/scout-evade-experiment.mts
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
        id: "p1", username: "p1", resources: 20,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          // Core 守卫（真实对局防御；v 追到门口时拦截）
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [1, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          // 远处资源格上的采集 worker（距 Core 8 格）
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [8, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 20,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [20, 3], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          // 猎杀者：距 worker [8,0] 3 格（worker 视野内）——aggressive 压向 worker
          { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [8, 3], hp: 4, unitType: "VANGUARD", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[8, 0], [20, 3]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

function runVariant(scoutEvade: boolean, seed: number): { workerAlive: boolean; deposits: number; p1Killed: number } {
  const result = runEpisode({
    scenario: scenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      {
        id: "p1",
        planner: "safety",
        plannerConfig: { scoutEvade },
        policy: { posture: "defensive", workerTarget: 4, militaryRatio: 0.2, focusRegion: null, attackPriority: null },
      },
      {
        id: "p2",
        planner: "safety",
        plannerConfig: { aggression: "aggressive" },
        policy: { posture: "aggressive", workerTarget: 4, militaryRatio: 0.6, focusRegion: null, attackPriority: "core" },
      },
    ],
  });
  let deposits = 0;
  let p1Killed = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "DEPOSIT_SUCCEEDED" && String(event.actorId ?? "").startsWith("22222222")) deposits += 1;
      if (event.eventType === "UNIT_DESTROYED") {
        const values = (event as { values?: Record<string, unknown> }).values ?? {};
        if (String(values.owner ?? "") === "p1") p1Killed += 1;
      }
    }
  }
  const p1 = result.finalWorld.players.get("p1")!;
  const worker = p1.units.find((u) => u.id === "22222222-2222-2222-2222-222222222202");
  return { workerAlive: worker !== undefined, deposits, p1Killed };
}

console.log(`scoutEvade A/B（${TICKS} ticks × ${SEEDS.length} seeds，p2 Vanguard 猎杀远处采集 worker，v0.14）`);
console.log("=".repeat(88));
for (const [label, scoutEvade] of [["scoutEvade=false（历史行为）", false], ["scoutEvade=true （B10 撤离）", true]] as const) {
  const outcomes = SEEDS.map((seed) => runVariant(scoutEvade, seed));
  const alive = outcomes.filter((o) => o.workerAlive).length;
  const avgDeposits = (outcomes.reduce((s, o) => s + o.deposits, 0) / outcomes.length).toFixed(1);
  const avgKilled = (outcomes.reduce((s, o) => s + o.p1Killed, 0) / outcomes.length).toFixed(1);
  console.log(`${label} | worker存活=${alive}/${SEEDS.length} | 均deposits=${avgDeposits} | 均被杀=${avgKilled}`);
  for (const [i, o] of outcomes.entries()) {
    console.log(`  seed ${i + 1}: worker=${o.workerAlive ? "活" : "死"} deposits=${o.deposits} 被杀=${o.p1Killed}`);
  }
}
