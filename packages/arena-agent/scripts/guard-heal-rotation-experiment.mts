/**
 * guardHealRotation A/B 实验（2026-08-07，B8 竞品 healing rotation 对照）：
 * 场景 = p2（aggressive）1 Vanguard（hp 3，场景参数）前压与 p1 守卫 g1 [3,0]
 * 1v1 互换（3 tick 互砍后 v 死、g1 剩 1hp——击杀后产生战斗间隙）；p1 2
 * Vanguard 在 Core 两侧守位，2 worker 采集。2v1 黏身场景无间隙（轮换无机会），
 * 故单波。p1 无 worker/无资源格（Core 格干净——避免 worker 回仓卸货长期占
 * Core 格挡守卫回修路径，模拟器实测：Core 格被占时回修 MOVE 每 tick 失败卡
 * 死）；p1 资源 4（HEAL 每点 1 资源——修满 3 点需 3 资源，且 <5 不产兵——
 * 资源 0 时 HEAL 结算失败修不满、资源 ≥5 时产兵占 Core 格，均模拟器实测）。
 * 对照（guardHealRotation=false）：g1 1hp 带伤值守（但守卫回守位路径经过
 * Core 格 → 主循环 HEAL 分支顺路修满——对照也满血，A/B 无法隔离差异）；
 * 变体（guardHealRotation=true）：g1 1hp 无反击压力 → 回 Core 补血满血回守位。
 * 2026-08-07 场景迭代记录（隔离差异的三重干扰，均为引擎/行为实测）：
 * 1) Core 格被 worker（回仓卸货/新产）长期占 → 回修 MOVE 每 tick 失败卡死；
 * 2) HEAL 每点 1 资源 → 资源 0 时 HEAL 结算失败修不满；
 * 3) 守卫守位 homeCell 在 Core 四邻 → 回守位直线路径经过 Core 格 → 主循环
 *    "在 Core 格 + 受伤"自动 HEAL → 对照也修满。
 * 结论：回修决策逻辑由单测（guard-heal-rotation.test.ts）验证；本场景无法
 * 在模拟器中隔离净收益，变体保持候选（未证明净收益不启用）。
 * KPI：p1 守卫存活、守卫均 HP、p1 res。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/guard-heal-rotation-experiment.mts
 */
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";

function scenario(seed: number) {
  return {
    rulesVersion: "v0.14",
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 4,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [3, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [-3, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 50,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [30, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [5, 0], hp: 3, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555502", owner: "p2", position: [20, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555503", owner: "p2", position: [35, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: {
      obstacles: [],
      resources: [[20, 0], [35, 0], [32, 0]],
    },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const SEEDS = [1, 2, 3];
const TICKS = 400;

function runVariant(guardHealRotation: boolean, seed: number): {
  p1Guards: number;
  p2Kills: number;
  res1: number;
  p1CoreAlive: boolean;
  guardHpAvg: number;
} {
  const config: EpisodeConfig = {
    scenario: scenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      {
        id: "p1",
        planner: "safety",
        plannerConfig: { guardHealRotation },
        policy: { posture: "balanced", workerTarget: 6, militaryRatio: 0.2, focusRegion: null, attackPriority: null },
      } as EpisodeTenant,
      {
        id: "p2",
        planner: "safety",
        plannerConfig: { aggression: "aggressive" },
        policy: { posture: "aggressive", workerTarget: 4, militaryRatio: 0.5, focusRegion: null, attackPriority: "core" },
      } as EpisodeTenant,
    ],
  };
  const result = runEpisode(config);
  let p2Kills = 0;
  let p1CoreAlive = true;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "UNIT_DESTROYED") {
        const values = (event as { values?: Record<string, unknown> }).values ?? {};
        if (String(values.owner ?? "") === "p1") p2Kills += 1;
      }
      if (event.eventType === "CORE_DESTROYED" && (event as { actorId?: string }).actorId?.startsWith("11111111")) {
        p1CoreAlive = false;
      }
    }
  }
  const p1 = result.finalWorld.players.get("p1")!;
  const guards = p1.units.filter((u) => u.unitType === "VANGUARD");
  return {
    p1Guards: guards.length,
    p2Kills,
    res1: p1.resources,
    p1CoreAlive,
    guardHpAvg: guards.length > 0 ? guards.reduce((sum, u) => sum + u.hp, 0) / guards.length : 0,
  };
}

const rows: string[] = [];
rows.push(`guardHealRotation A/B（${TICKS} ticks × ${SEEDS.length} seeds，p2 1 Vanguard 1v1 互换 p1 守卫，v0.14）`);
rows.push("=".repeat(92));
for (const variant of [false, true]) {
  let guardsSum = 0;
  let killsSum = 0;
  let resSum = 0;
  let hpSum = 0;
  let hpCount = 0;
  let coreAlive = 0;
  const details: string[] = [];
  for (const seed of SEEDS) {
    const o = runVariant(variant, seed);
    guardsSum += o.p1Guards;
    killsSum += o.p2Kills;
    resSum += o.res1;
    hpSum += o.guardHpAvg;
    if (o.guardHpAvg > 0) hpCount += 1;
    if (o.p1CoreAlive) coreAlive += 1;
    details.push(`seed ${seed}: 守卫存活=${o.p1Guards}/2 均HP=${o.guardHpAvg.toFixed(1)} 被杀=${o.p2Kills} res=${o.res1} core=${o.p1CoreAlive ? "活" : "毁"}`);
  }
  rows.push(
    `guardHealRotation=${variant}: 均守卫存活=${(guardsSum / SEEDS.length).toFixed(1)}/2 均守卫HP=${(hpSum / Math.max(hpCount, 1)).toFixed(1)} 均被杀=${(killsSum / SEEDS.length).toFixed(1)} 均res=${(resSum / SEEDS.length).toFixed(1)} core存活=${coreAlive}/${SEEDS.length}`,
  );
  for (const d of details) rows.push(`  ${d}`);
}
const output = rows.join("\n");
console.log(output);
