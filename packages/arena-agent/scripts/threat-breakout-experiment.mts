/**
 * threatBreakout A/B 实验（2026-08-06 第三十五轮 / 2026-08-07 C5 语义修订重跑）：
 * C5 对齐后 BREAKOUT 前提 = 当前格投影伤害 >0（敌已进入射程）——旧"4 格远包围"
 * 场景（Vanguard 射程 1 打不到 Core）不再触发 BREAKOUT，作废。
 * 场景 = 贴脸四向包围（p2 4 Vanguard 邻接 p1 Core [0,0]，无逃逸 + 投影伤害 4
 *  → BREAKOUT）
 * + p1 3 worker 在守家圈外巡逻/采集——p2 aggressive 猎杀 p1 worker。
 * 对照（threatBreakout=false）：worker 照常外出被围猎（存活低）；
 * 变体（threatBreakout=true）：BREAKOUT 期间 worker 全面缩守家圈（存活高）。
 * KPI：worker 存活数（400 tick 末）、p1 worker 被击杀数、p1res、p2 worker 击杀数。
 * C5 后注意：贴脸包围下 Core 每 tick 受击速爆（v0.11 盾无自回），BREAKOUT
 * 窗口 = Core 被拆前的数个 tick——收缩价值窗口极短，结论需按新语义重读。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/threat-breakout-experiment.mts
 */
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";

function scenario(seed: number) {
  return {
    rulesVersion: "v0.11",
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 20,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [10, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [0, 10], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [3, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 50,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [40, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          // C5 贴脸四向包围（1 格邻接——投影伤害 4 触发 BREAKOUT）
          { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [1, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555502", owner: "p2", position: [-1, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555503", owner: "p2", position: [0, 1], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555504", owner: "p2", position: [0, -1], hp: 4, unitType: "VANGUARD", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[2, 0], [3, 1], [0, 2], [10, 0], [0, 10]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const SEEDS = [1, 2];
const TICKS = 400;

function runVariant(threatBreakout: boolean, seed: number): { p1Workers: number; p2Kills: number; res1: number; p1CoreAlive: boolean } {
  const config: EpisodeConfig = {
    scenario: scenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    refill: { everyTicks: 65 },
    tenants: [
      {
        id: "p1",
        planner: "safety",
        plannerConfig: { threatBreakout },
        policy: { posture: "balanced", workerTarget: 6, militaryRatio: 0.1, focusRegion: null, attackPriority: null },
      } as EpisodeTenant,
      {
        id: "p2",
        planner: "safety",
        plannerConfig: { aggression: "aggressive" },
        policy: { posture: "aggressive", workerTarget: 4, militaryRatio: 0.4, focusRegion: null, attackPriority: "workers" },
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
  return { p1Workers: p1.units.filter((u) => u.unitType === "WORKER").length, p2Kills, res1: p1.resources, p1CoreAlive };
}

const rows: string[] = [];
rows.push(`threatBreakout A/B（${TICKS} ticks × ${SEEDS.length} seeds，C5 贴脸四向包围 p1 3 worker，refill 65）`);
rows.push("=".repeat(88));
for (const variant of [false, true]) {
  let workersSum = 0;
  let killsSum = 0;
  let resSum = 0;
  let coreAlive = 0;
  const details: string[] = [];
  for (const seed of SEEDS) {
    const o = runVariant(variant, seed);
    workersSum += o.p1Workers;
    killsSum += o.p2Kills;
    resSum += o.res1;
    if (o.p1CoreAlive) coreAlive += 1;
    details.push(`seed ${seed}: p1worker存活=${o.p1Workers}/3 被杀=${o.p2Kills} res=${o.res1} p1core=${o.p1CoreAlive ? "活" : "毁"}`);
  }
  rows.push(
    `threatBreakout=${variant}: 均worker存活=${(workersSum / SEEDS.length).toFixed(1)}/3 均被杀=${(killsSum / SEEDS.length).toFixed(1)} 均res=${(resSum / SEEDS.length).toFixed(1)} core存活=${coreAlive}/${SEEDS.length}`,
  );
  for (const d of details) rows.push(`  ${d}`);
}
const output = rows.join("\n");
console.log(output);
