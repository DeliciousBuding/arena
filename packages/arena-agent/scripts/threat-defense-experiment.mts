/**
 * 威胁防御产兵实验（2026-08-07，竞品 _control_core 对照验证）：
 * p2 双 Vanguard 逼近 p1 Core（射程内威胁）；p1 资源 15、2 workers
 * （< target 4）。
 * 原行为：敌人打到门口仍产 WORKER 补员（workers<target 优先）——防御
 * 空虚被拆；
 * 新行为（威胁防御产兵）：敌距 Core <=5（预警带）时优先产 VANGUARD。
 * KPI：p1 Core 存活 tick、p1 拆毁延迟、p1 军事存活。
 *
 * 结论（2026-08-07，120 ticks × 3 seeds，最终场景 [5,0] 起始威胁）：
 * 对照组（不产兵、res 留存治疗）被拆 25 tick vs 变体（产兵、res 花
 * 光无法治疗）17 tick——**威胁产兵更差**（1v1 必同归于尽挡不住 + 挤占
 * 治疗资源）。官方有 heal/repair/迁移多重防御垫底，我们只有治疗。
 * 未证明净收益 → selectDeterministicCoreAction 的 threatDefenseSpawn
 * 默认关闭（候选），生产零回归。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/threat-defense-experiment.mts
 */
import { runEpisode, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { PlanProvider } from "../src/runtime/decision-types.ts";
import { DeterministicPlanner } from "../src/planning/deterministic-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const SEEDS = [1, 2, 3];
const TICKS = 120;

function scenario(seed: number) {
  return {
    rulesVersion: "v0.14" as const,
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 10,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        // 初始 10 = 容量上限（max(10, 2×pop)=10）——不溢出；威胁产兵（10）
        // 恰好可负担，且产 worker（5）后剩 5——威胁到来前靠采集积累。
        // 2 workers 在资源脚下（无 emergency 竞争）：对照组（威胁分支移
        // 除）产 worker 补员不防御；变体威胁产兵（10 初始资源恰好够）
        // 迎击。干净对照。
        units: [
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [2, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [2, 1], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 20,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [12, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          // 逼近 p1 Core 的单 VANGUARD：起始 [5,0] = p1 Core 视野边缘
          // （5 格）——n=core 攻坚目标可见立即生效；同时正好在威胁预警
          // 带内（<=5）——变体 t1 即触发防御产兵。
          { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [5, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[2, 0], [2, 1]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

function runVariant(defenseSpawn: boolean, seed: number): { p1CoreAlive: boolean; p1CoreDestroyedAt: number; p2Vanguards: number; p1SpawnWorkers: number; p1SpawnVanguards: number; p1SpawnTicks: string[] } {
  // 对照组注入：把威胁防御产兵（spawn_vanguard_defense）替换回 worker
  // 补员——模拟旧行为（敌人打到门口仍产 worker）。
  const makeP1Planner = (defense: boolean) => (tenant: EpisodeTenant): PlanProvider => {
    if (tenant.id !== "p1") return new DeterministicPlanner();
    const inner = new DeterministicPlanner();
    return {
      decide(input) {
        if (defenseSpawn && seed === 1 && input.state.tick <= 12) {
          const distances = input.state.visibleEnemies.map((e) =>
            `${e.unitType}@${Math.abs(e.position[0]) + Math.abs(e.position[1])}`
          );
          console.log(`    t${input.state.tick} vis=[${distances.join(",")}] core=${input.state.core?.state} workers=${input.state.workers.length} res=${input.state.resources}`);
        }
        const plan = inner.decide(input);
        if (!defense && plan.intents?.core === "spawn_vanguard_defense") {
          // 对照组：移除威胁产兵分支——旧代码（无威胁感知）在 ratio 0 时
          // workers 达标 + 无 needMilitary → Core 不产兵（纯等死）。
          return { ...plan, coreAction: null };
        }
        return plan;
      },
    };
  };
  const result = runEpisode({
    scenario: scenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    plannerFactory: makeP1Planner(defenseSpawn),
    tenants: [
      { id: "p1", planner: "deterministic", policy: { posture: "balanced", workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: null } },
      { id: "p2", planner: "safety", policy: { posture: "aggressive", workerTarget: 4, militaryRatio: 0.5, focusRegion: null, n: "core" } },
    ],
  });
  let p1CoreAlive = true;
  let p1CoreDestroyedAt = -1;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "CORE_DESTROYED" && String(event.targetId ?? "").startsWith("1111")) {
        p1CoreAlive = false;
        p1CoreDestroyedAt = record.tick;
      }
    }
  }
  if (defenseSpawn && seed === 1) {
    for (const record of result.records.slice(0, 3)) {
      console.log(`    -- t${record.tick} p1 events: ${JSON.stringify(record.events.filter((e) => String(e.actorId ?? "").startsWith("1111") || String(e.targetId ?? "").startsWith("1111")))}`);
    }
  }
  // 决策 trace：p1 Core 的威胁距离与决策 intent（仅 seed 1 变体）
  if (defenseSpawn && seed === 1) {
    const traces = result.decisionTraces?.["p1"] ?? [];
    for (const t of traces.slice(0, 40)) {
      const nearestEnemy = t.state.visibleEnemies.length > 0
        ? Math.min(...t.state.visibleEnemies.map((e: { position: [number, number] }) => Math.abs(e.position[0] - 0) + Math.abs(e.position[1] - 0)))
        : -1;
      console.log(`    trace t${t.tick} enemies=${t.state.visibleEnemies.length} nearest=${nearestEnemy} core=${t.plan.intents?.core ?? "?"}`);
    }
  }
  const p2 = result.finalWorld.players.get("p2")!;
  const p2Ranger = p2.units.filter((u) => u.unitType === "RANGER").length;
  if (!defenseSpawn && seed === 1) {
    // p2 RANGER 动作轨迹（对照组——诊断 RANGER 为何不拆 Core）
    const moves: string[] = [];
    for (const record of result.records) {
      for (const event of record.events) {
        if (String(event.actorId ?? "").startsWith("5555")) {
          const kind = event.eventType;
          if (kind === "UNIT_MOVE_SUCCEEDED" || kind === "SHOOT_SUCCEEDED" || kind === "SWEEP_SUCCEEDED" || kind === "UNIT_MOVE_FAILED" || kind === "UNIT_MOVE_BLOCKED") {
            moves.push(`t${record.tick}:${kind}@${JSON.stringify(event.values ?? event.position)}`);
          }
        }
      }
      if (moves.length >= 30) break;
    }
    console.log(`    p2RANGER act: ${moves.join(" ")}`);
  }
  let p1SpawnWorkers = 0;
  let p1SpawnVanguards = 0;
  const p1SpawnTicks: string[] = [];
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "CORE_SPAWN_SUCCEEDED" && String(event.actorId ?? "").startsWith("1111")) {
        const unitType = event.values?.unit_type ?? "?";
        if (unitType === "WORKER") p1SpawnWorkers += 1;
        if (unitType === "VANGUARD") p1SpawnVanguards += 1;
        p1SpawnTicks.push(`t${record.tick}:${unitType}`);
      }
    }
  }
  return { p1CoreAlive, p1CoreDestroyedAt, p2Vanguards: p2Ranger, p1SpawnWorkers, p1SpawnVanguards, p1SpawnTicks };
}

console.log(`threat-defense A/B（${TICKS} ticks × ${SEEDS.length} seeds，威胁产兵 vs 产 worker，v0.14）`);
console.log("=".repeat(88));
console.log(`对照组（产 worker）：威胁时仍 worker 补员`);
const control = SEEDS.map((seed) => runVariant(false, seed));
const controlAlive = control.filter((o) => o.p1CoreAlive).length;
const controlAvg = control.filter((o) => !o.p1CoreAlive).reduce((sum, o) => sum + o.p1CoreDestroyedAt, 0) / Math.max(1, control.filter((o) => !o.p1CoreAlive).length);
console.log(`  Core 存活=${controlAlive}/${SEEDS.length} | 被拆平均 tick=${controlAvg.toFixed(1)}`);
for (const [i, o] of control.entries()) console.log(`  seed ${i + 1}: core=${o.p1CoreAlive ? "活" : "毁"} destroyed_at=${o.p1CoreDestroyedAt} spawns w=${o.p1SpawnWorkers} v=${o.p1SpawnVanguards} [${o.p1SpawnTicks.join(",")}]`);
console.log(`变体（威胁产兵）：`);
const outcomes = SEEDS.map((seed) => runVariant(true, seed));
const alive = outcomes.filter((o) => o.p1CoreAlive).length;
const avgDestroyedAt = outcomes.filter((o) => !o.p1CoreAlive)
  .reduce((sum, o) => sum + o.p1CoreDestroyedAt, 0) / Math.max(1, outcomes.filter((o) => !o.p1CoreAlive).length);
const avgP2Vanguards = outcomes.reduce((s, o) => s + o.p2Vanguards, 0) / outcomes.length;
console.log(`  Core 存活=${alive}/${SEEDS.length} | 被拆平均 tick=${avgDestroyedAt.toFixed(1)} | p2 存留 Vanguard=${avgP2Vanguards.toFixed(1)}`);
for (const [i, o] of outcomes.entries()) {
  console.log(`  seed ${i + 1}: core=${o.p1CoreAlive ? "活" : "毁"} destroyed_at=${o.p1CoreDestroyedAt} p2v=${o.p2Vanguards} spawns w=${o.p1SpawnWorkers} v=${o.p1SpawnVanguards} [${o.p1SpawnTicks.join(",")}]`);
}
