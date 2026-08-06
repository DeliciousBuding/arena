/**
 * 最小有效军事规模实验（2026-08-06，第二十八轮）：
 * 生产 t1 掠夺 ROI 为负（掠夺 7 < 军事扩编 12）——军事化净收益依赖"拆 CORE
 * 频率"或"压制价值"。本实验找拆 CORE 的最小有效军事规模：
 * p1 有 N 个 Vanguard（1/2/3）vs 无守卫敌 CORE（22 格）——拆 CORE 耗时、
 * 掠夺次数（400 tick 内）、军事 ROI（掠夺收益 - 军事成本）。
 * KPI：p1 掠夺次数、拆 CORE 用时、p1 res（掠夺收益体现）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/min-military-experiment.mts
 */
import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "min-military-result.txt";

function scenario(seed: number, vanguardCount: number) {
  return {
    rulesVersion: "v0.11",
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 50,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          // 驻军开局（生产 t1 形态：Vanguard 驻在敌 CORE 附近 13-22 格）——
          // 第二十八轮 0 拆根因：守家开局 Vanguard 杀近敌后无可见目标停止
          // （视野 4 看不到 22 格 CORE）；驻军开局 CORE 在视野内直接拆。
          ...Array.from({ length: vanguardCount }, (_, i) => ({
            id: `22222222-2222-2222-2222-2222222222${String(i + 1).padStart(2, "0")}`,
            owner: "p1", position: [18 + i, 0] as [number, number], hp: 4, unitType: "VANGUARD", cargo: 0,
          })),
          { id: "22222222-2222-2222-2222-222222222299", owner: "p1", position: [5, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 50,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [22, 0], hp: 5, shield: 5, state: "NORMAL" },
        // 有库存 + 无 worker：p2 planner 每 tick 修盾（REPAIR_SHIELD 耗 1 资源回 1 盾）
        // ——第三十轮：修盾抵消单 Vanguard 1 伤害（N=1 拆不掉），N≥2 伤害>修盾破盾；
        // 拆家掠夺 = min(被拆方库存, capacity)（combat.ts applyCoreCaptures）
        units: [],
      },
    ],
    terrain: { obstacles: [], resources: [[3, 0], [4, 0], [20, 0], [21, 0]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const SEEDS = [1, 2];
const TICKS = 400;

function runVariant(vanguardCount: number, seed: number): { caps: number; destroyedRounds: number; res1: number; firstDestroyTick: number | null } {
  const config: EpisodeConfig = {
    scenario: scenario(seed, vanguardCount),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    refill: { everyTicks: 300 },
    tenants: [
      {
        id: "p1",
        planner: "safety",
        plannerConfig: { aggression: "aggressive" },
        // 生产 t1 形态：aggressive + attackPriority=core（LLM 策略输出）——
        // 只有 aggressive 会打最近敌（worker），拆 CORE 需要 attackPriority
        policy: { posture: "aggressive", workerTarget: 6, militaryRatio: 0.4, focusRegion: null, attackPriority: "core" },
      } as EpisodeTenant,
      { id: "p2", planner: "safety" } as EpisodeTenant,
    ],
  };
  const result = runEpisode(config);
  let caps = 0;
  let destroyedRounds = 0;
  let firstDestroyTick: number | null = null;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "CORE_RESOURCES_CAPTURED") {
        caps += 1;
      } else if (event.eventType === "CORE_DESTROYED") {
        destroyedRounds += 1;
        if (firstDestroyTick === null) firstDestroyTick = record.tick;
      }
    }
  }
  const p1 = result.finalWorld.players.get("p1")!;
  return { caps, destroyedRounds, res1: p1.resources, firstDestroyTick };
}

const rows: string[] = [];
rows.push(`最小有效军事规模（${TICKS} ticks × ${SEEDS.length} seeds，N Vanguard vs 无守卫敌 CORE 22 格，refill 300）`);
rows.push("=".repeat(88));
for (const count of [1, 2, 3]) {
  let capsSum = 0; let resSum = 0; let destroyed = 0; let destroyTickSum = 0; let destroyCount = 0;
  const details: string[] = [];
  for (const seed of SEEDS) {
    const o = runVariant(count, seed);
    capsSum += o.caps; resSum += o.res1;
    destroyed += o.destroyedRounds;
    if (o.firstDestroyTick !== null) { destroyTickSum += o.firstDestroyTick; destroyCount += 1; }
    details.push(`seed ${seed}: caps=${o.caps} 拆CORE轮次=${o.destroyedRounds} 首拆tick=${o.firstDestroyTick} p1res=${o.res1}`);
  }
  const militaryCost = count * 10;
  const roi = (capsSum / SEEDS.length) * 7 - militaryCost;
  rows.push(
    `Vanguard=${count}（成本${militaryCost}）: 均掠夺=${(capsSum / SEEDS.length).toFixed(1)} 拆CORE轮次=${destroyed}/2 均首拆耗时=${destroyCount ? (destroyTickSum / destroyCount).toFixed(0) : "—"} 均res=${(resSum / SEEDS.length).toFixed(1)} ROI=${roi.toFixed(1)}`,
  );
  for (const d of details) rows.push(`  ${d}`);
}
const output = rows.join("\n");
console.log(output);
writeFileSync(RESULT_FILE, output + "\n");
