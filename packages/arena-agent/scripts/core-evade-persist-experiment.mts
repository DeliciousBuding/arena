/**
 * coreEvadePersist A/B 实验（2026-08-07，B9 竞品 "approach memory expires"
 * 对照）：
 * 场景 = p1（coreEvade）Core [0,0] + 守卫 [1,0]；p2 Vanguard [4,0]
 * 逼近（closing 触发 Core 迁移）→ 守卫拦截交战 → p2 死亡（敌人消失）：
 * 对照（coreEvade 仅 2 tick persist）：敌人死后 2 tick 恢复生产；
 * 变体（+coreEvadePersist）：approach 记忆（6 tick）内仍迁移 → 白迁移
 * 至记忆过期（迁移中不生产/heal）。
 * 实测（3 seeds）：对照均迁移 6 tick vs 变体 9 tick——B9 代价面 = 敌人
 * 死亡（不再回来）场景白迁移 +3 tick；SPAWN 因场景人口上限（limit 2）
 * 两行均为 0（对称，不影响对比）。
 * 注：模拟器无法构造"敌人消失后折返"场景（策略不可控）——本实验验证
 * B9 的代价面（敌人死亡 = 不再回来 → 白迁移）；正收益面（防折返抖动）
 * 由单测钉定（core-evade-persist.test.ts）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/core-evade-persist-experiment.mts
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
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [1, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [-6, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 20,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [20, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          // 逼近者：距 p1 Core 4 格（Core 视野 5 内可见 + 12 格 closing 半径内）
          { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [4, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555502", owner: "p2", position: [18, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[-6, 0], [18, 0]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

function runVariant(persist: boolean, seed: number): { moves: number; spawns: number; p1CoreAlive: boolean } {
  const result = runEpisode({
    scenario: scenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      {
        id: "p1",
        planner: "safety",
        plannerConfig: { coreEvade: true, coreEvadePersist: persist },
        policy: { posture: "defensive", workerTarget: 4, militaryRatio: 0.4, focusRegion: null, attackPriority: null },
      },
      { id: "p2", planner: "safety", plannerConfig: {}, policy: { posture: "balanced", workerTarget: 4, militaryRatio: 0.4, focusRegion: null, attackPriority: null } },
    ],
  });
  let moves = 0;
  let spawns = 0;
  let p1CoreAlive = true;
  for (const record of result.records) {
    for (const event of record.events) {
      // Core 迁移事件：CORE_MOVE_STARTED（发起）+ CORE_MOVE_PROGRESS（推进）；
      // Core 生产事件：CORE_SPAWN_SUCCEEDED（actorId=Core id）
      const actorId = String(event.actorId ?? "");
      if (
        (event.eventType === "CORE_MOVE_STARTED" || event.eventType === "CORE_MOVE_PROGRESS") &&
        actorId.startsWith("11111111")
      ) moves += 1;
      if (event.eventType === "CORE_SPAWN_SUCCEEDED" && actorId.startsWith("11111111")) spawns += 1;
      if (event.eventType === "CORE_DESTROYED" && String((event as { targetId?: string }).targetId ?? "").startsWith("11111111")) p1CoreAlive = false;
    }
  }
  return { moves, spawns, p1CoreAlive };
}

console.log(`coreEvadePersist A/B（${TICKS} ticks × ${SEEDS.length} seeds，逼近者被守卫击杀后消失，v0.14）`);
console.log("=".repeat(88));
for (const [label, persist] of [["coreEvade（仅2tick persist）", false], ["coreEvade+persist（approach记忆）", true]] as const) {
  const outcomes = SEEDS.map((seed) => runVariant(persist, seed));
  const avgMoves = (outcomes.reduce((s, o) => s + o.moves, 0) / outcomes.length).toFixed(1);
  const avgSpawns = (outcomes.reduce((s, o) => s + o.spawns, 0) / outcomes.length).toFixed(1);
  const alive = outcomes.filter((o) => o.p1CoreAlive).length;
  console.log(`${label} | 均迁移tick=${avgMoves} | 均SPAWN=${avgSpawns} | p1core存活=${alive}/${SEEDS.length}`);
  for (const [i, o] of outcomes.entries()) {
    console.log(`  seed ${i + 1}: 迁移=${o.moves} SPAWN=${o.spawns} core=${o.p1CoreAlive ? "活" : "毁"}`);
  }
}
