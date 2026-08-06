/**
 * moveFailedAvoidance A/B 实验（2026-08-06，第三十一轮）：
 * 场景 = 2 Vanguard vs 敌 CORE（p2 有资源产兵守家）——敌守军（Vanguard）与
 * 进攻方 2 Vanguard 每 tick 争唯一推进格 [21,0]（容量 2）→ MOVE_CONTESTED
 * 全失败 → 无反馈重试 400 tick 0 拆（对照组）。
 * 变体 = moveFailedAvoidance=true：连续 MOVE_FAILED ≥2 后改走垂直绕行格 →
 * 从 [21,1] 侧面包抄 sweep CORE → 拆成。
 * KPI：CORE_DESTROYED 轮次（400 tick）、首拆 tick、p1res。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/move-failed-experiment.mts
 */
import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "move-failed-result.txt";

function scenario(seed: number) {
  return {
    rulesVersion: "v0.11",
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 50,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [18, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [19, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222299", owner: "p1", position: [5, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 50,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [22, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [],
      },
    ],
    terrain: { obstacles: [], resources: [[3, 0], [4, 0], [20, 0], [21, 0]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const SEEDS = [1, 2];
const TICKS = 400;

function runVariant(moveFailedAvoidance: boolean, seed: number): { destroyedRounds: number; firstDestroyTick: number | null } {
  const config: EpisodeConfig = {
    scenario: scenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    refill: { everyTicks: 300 },
    tenants: [
      {
        id: "p1",
        planner: "safety",
        plannerConfig: { aggression: "aggressive", moveFailedAvoidance },
        policy: { posture: "aggressive", workerTarget: 6, militaryRatio: 0.4, focusRegion: null, attackPriority: "core" },
      } as EpisodeTenant,
      { id: "p2", planner: "safety" } as EpisodeTenant,
    ],
  };
  const result = runEpisode(config);
  let destroyedRounds = 0;
  let firstDestroyTick: number | null = null;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "CORE_DESTROYED") {
        destroyedRounds += 1;
        if (firstDestroyTick === null) firstDestroyTick = record.tick;
      }
    }
  }
  return { destroyedRounds, firstDestroyTick };
}

const rows: string[] = [];
rows.push(`moveFailedAvoidance A/B（${TICKS} ticks × ${SEEDS.length} seeds，2 Vanguard vs 敌守军 CORE，refill 300）`);
rows.push("=".repeat(88));
for (const variant of [false, true]) {
  let destroyed = 0;
  let destroyTickSum = 0;
  let destroyCount = 0;
  const details: string[] = [];
  for (const seed of SEEDS) {
    const o = runVariant(variant, seed);
    destroyed += o.destroyedRounds;
    if (o.firstDestroyTick !== null) { destroyTickSum += o.firstDestroyTick; destroyCount += 1; }
    details.push(`seed ${seed}: 拆CORE轮次=${o.destroyedRounds} 首拆tick=${o.firstDestroyTick}`);
  }
  rows.push(
    `moveFailedAvoidance=${variant}: 拆CORE轮次=${destroyed}/2 均首拆耗时=${destroyCount ? (destroyTickSum / destroyCount).toFixed(0) : "—"}（对照=0 拆/400 tick 卡死）`,
  );
  for (const d of details) rows.push(`  ${d}`);
}
const output = rows.join("\n");
console.log(output);
writeFileSync(RESULT_FILE, output + "\n");
