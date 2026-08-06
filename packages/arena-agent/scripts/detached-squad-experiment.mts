/**
 * detachedSquadResponse A/B 实验（2026-08-07，B5 竞品 detached squad
 * response 对照）：
 * 场景 = p1（aggressive）2 Vanguard 已出发突击 p2 Core [30,0]（[26,0]/
 * [27,0]，距 p2 守位守卫 [29,0] 2-3 格 → 开局可见 + 拦截触发）；p2
 * （defensive）3 守卫守 p2 Core 四邻（[29,0]/[30,-1]/[32,0]）——拦截
 * 力量强于突击组（3v2）。
 * 对照（detachedSquadResponse=false）：突击组无视拦截继续压任务——
 * 2v3 被守位守卫磨死（同血同速数量劣势必死）；
 * 变体（detachedSquadResponse=true）：接近触发拦截 → 释放任务回 Core
 * 守位 8 tick（守卫守位不动、返回路径无阻挡）——存活保兵。
 * 实测结论（2026-08-07 四轮场景迭代）：B5 收益随力量对比翻转——
 * ①拦截者 aggressive 追击：变体返回途中被追 + 8 tick 后恢复前压反复
 * 拉锯消耗（更差）；②突击组视野外无目标：回自家 Core 巡逻零接触；
 * ③2 守卫：p1 2v2 先手打赢并拆掉 p2 Core（t14 CORE_DESTROYED）——
 * 变体错失进攻机会（负收益）；④3 守卫：交战仍发生（SWEEP 结算先手
 * 优势下 p1 依然占优）。模拟器同速同血先手必胜，无法构造"拦截力量
 * 占优"的稳定场景 → B5 净收益无一致证据，变体保持候选不启用。
 * 注：先前场景迭代——①aggressive 拦截者追击：变体返回途中被追、8 tick
 * 后恢复前压反复拉锯消耗（更差）；②p1 突击组 [15,0] 出发：视野外无目标
 * 回自家 Core 巡逻，双方永不接触（零差异）。竞品语义是守位拦截
 * （defenders do not chase），且突击组必须已进入敌视野——故 p1 起始
 * [26,0]/[27,0]、p2 defensive。
 * KPI：p1 军事单位存活、p2 击杀 p1 数、p1 Core 存活、p2 Core 受击次数。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/detached-squad-experiment.mts
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
        id: "p1", username: "p1", resources: 20,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [26, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [27, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [-8, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 20,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [30, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          // 三守卫守 p2 Core 四邻（守位不动）
          { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [29, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555505", owner: "p2", position: [30, -1], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555506", owner: "p2", position: [32, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555502", owner: "p2", position: [24, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[-8, 0], [24, 0], [25, 1]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const SEEDS = [1, 2, 3];
const TICKS = 400;

function runVariant(detachedSquadResponse: boolean, seed: number): {
  p1Military: number;
  p2Kills: number;
  p1CoreAlive: boolean;
  p2CoreHits: number;
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
        plannerConfig: { aggression: "aggressive", detachedSquadResponse },
        policy: { posture: "aggressive", workerTarget: 4, militaryRatio: 0.5, focusRegion: null, attackPriority: "core" },
      } as EpisodeTenant,
      {
        id: "p2",
        planner: "safety",
        plannerConfig: {},
        policy: { posture: "balanced", workerTarget: 4, militaryRatio: 0.4, focusRegion: null, attackPriority: null },
      } as EpisodeTenant,
    ],
  };
  const result = runEpisode(config);
  let p2Kills = 0;
  let p1CoreAlive = true;
  let p2CoreHits = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "UNIT_DESTROYED") {
        const values = (event as { values?: Record<string, unknown> }).values ?? {};
        if (String(values.owner ?? "") === "p1") p2Kills += 1;
      }
      if (event.eventType === "CORE_DESTROYED" && (event as { actorId?: string }).actorId?.startsWith("11111111")) {
        p1CoreAlive = false;
      }
      if (event.eventType === "CORE_DAMAGED" && (event as { actorId?: string }).actorId?.startsWith("44444444")) {
        p2CoreHits += 1;
      }
    }
  }
  const p1 = result.finalWorld.players.get("p1")!;
  return {
    p1Military: p1.units.filter((u) => u.unitType !== "WORKER").length,
    p2Kills,
    p1CoreAlive,
    p2CoreHits,
  };
}

const rows: string[] = [];
rows.push(`detachedSquadResponse A/B（${TICKS} ticks × ${SEEDS.length} seeds，p2 3 守位守卫拦截突击组，v0.14）`);
rows.push("=".repeat(92));
for (const variant of [false, true]) {
  let milSum = 0;
  let killsSum = 0;
  let hitsSum = 0;
  let coreAlive = 0;
  const details: string[] = [];
  for (const seed of SEEDS) {
    const o = runVariant(variant, seed);
    milSum += o.p1Military;
    killsSum += o.p2Kills;
    hitsSum += o.p2CoreHits;
    if (o.p1CoreAlive) coreAlive += 1;
    details.push(`seed ${seed}: p1军事存活=${o.p1Military}/2 被杀=${o.p2Kills} p2Core受击=${o.p2CoreHits} p1core=${o.p1CoreAlive ? "活" : "毁"}`);
  }
  rows.push(
    `detachedSquadResponse=${variant}: 均p1军事存活=${(milSum / SEEDS.length).toFixed(1)}/2 均被杀=${(killsSum / SEEDS.length).toFixed(1)} 均p2Core受击=${(hitsSum / SEEDS.length).toFixed(1)} p1core存活=${coreAlive}/${SEEDS.length}`,
  );
  for (const d of details) rows.push(`  ${d}`);
}
const output = rows.join("\n");
console.log(output);
