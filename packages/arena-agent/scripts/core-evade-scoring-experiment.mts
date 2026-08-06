/**
 * Core 迁移多目标方向评分（coreEvadeScoring）对打实验（2026-08-06，第二十二轮）：
 * 夹击场景——p2 Vanguard 从右侧（[5,0]）逼近 + Ranger 从左侧（[-4,0]）直线
 * 逼近（Ranger 3 格直线射程）。
 * 旧评分（distance）：只取 minEnemyDistance → 退向 LEFT（远离 Vanguard）但
 * 冲进 Ranger 射程被射；新评分（multi）：投影伤害优先 → 退 UP/DOWN 避开两敌。
 * KPI：p1 Core 被命中（CORE_DAMAGED）次数、Core 存活。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/core-evade-scoring-experiment.mts
 */
import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "core-evade-scoring-result.txt";

function scenario(seed: number) {
  return {
    rulesVersion: "v0.11",
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 10,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 10,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [20, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          // Vanguard 右侧逼近（[5,0]）；Ranger 左侧直线（[-4,0]，3 格射程）
          { id: "55555555-5555-5555-5555-555555555551", owner: "p2", position: [5, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555552", owner: "p2", position: [-4, 0], hp: 2, unitType: "RANGER", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555553", owner: "p2", position: [19, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[2, 0], [3, 0], [19, 1]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const SEEDS = [1, 2, 3];
const TICKS = 200;

function runVariant(scoring: boolean, seed: number): { coreHits: number; p1CoreAlive: boolean; p2CoreAlive: boolean } {
  const config: EpisodeConfig = {
    scenario: scenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      { id: "p1", planner: "safety", plannerConfig: { coreEvade: true, coreEvadeScoring: scoring } } as EpisodeTenant,
      { id: "p2", planner: "safety", plannerConfig: { aggression: "aggressive" } } as EpisodeTenant,
    ],
  };
  const result = runEpisode(config);
  let coreHits = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "CORE_DAMAGED" && String(event.targetId).startsWith("1111")) coreHits += 1;
    }
  }
  const p1 = result.finalWorld.players.get("p1")!;
  const p2 = result.finalWorld.players.get("p2")!;
  return { coreHits, p1CoreAlive: p1.core !== null, p2CoreAlive: p2.core !== null };
}

const rows: string[] = [];
rows.push(`Core 迁移方向评分对打（${TICKS} ticks × ${SEEDS.length} seeds，夹击：右侧 Vanguard + 左侧 Ranger）`);
rows.push("=".repeat(80));
for (const [label, scoring] of [
  ["distance（旧：minEnemyDistance）", false],
  ["multi（竞品字典序）", true],
] as const) {
  const outcomes = SEEDS.map((seed) => runVariant(scoring, seed));
  const avgHits = outcomes.reduce((s, o) => s + o.coreHits, 0) / outcomes.length;
  const p1Survive = outcomes.filter((o) => o.p1CoreAlive).length;
  rows.push(
    `${label.padEnd(30)} | Core 被命中(avg)=${avgHits.toFixed(1)} | p1 Core 存活=${p1Survive}/${SEEDS.length}`,
  );
  for (const seed of SEEDS) {
    const o = outcomes[seed - 1]!;
    rows.push(`  seed ${seed}: hits=${o.coreHits} p1存活=${o.p1CoreAlive}`);
  }
}
const output = rows.join("\n");
console.log(output);
writeFileSync(RESULT_FILE, output + "\n");
