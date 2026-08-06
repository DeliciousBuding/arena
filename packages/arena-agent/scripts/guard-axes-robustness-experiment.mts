/**
 * guardAxes 多场景稳健性 A/B（2026-08-07，B4 候选变体启用前评估）：
 * 单场景净收益（双轴夹击 -31% Core 命中）不足以启用——本脚本在 4 个
 * 场景上复跑验证稳健性（正收益或至少不劣化才考虑启用）：
 *  A. 双轴夹击（原场景）：p2 3 Vanguard 东西双轴 → -31% 命中（基线）；
 *  B. 单轴多敌：p2 3 Vanguard 全东侧单轴 → 守卫应集中东轴拦截；
 *  C. Ranger 守卫：p1 1 Vanguard + 1 Ranger（Ranger 内层 2 格屏）；
 *  D. p2 带 Ranger：p2 2 Vanguard + 1 Ranger 远程射击。
 * KPI：p1 Core 命中、worker 损失、deposits、p1 Core 存活。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/guard-axes-robustness-experiment.mts
 */
import { runEpisode } from "../src/sim/harness/episode.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const SEEDS = [1, 2, 3];
const TICKS = 300;

type ScenarioKind = "A" | "B" | "C" | "D";

function scenario(kind: ScenarioKind, seed: number) {
  const base = {
    rulesVersion: "v0.14" as const,
    tick: 1,
    seed,
    terrain: { obstacles: [], resources: [[2, 0], [3, 1], [0, 2], [12, 0], [-12, 0]] },
    beacon: { position: [100, 100], status: "GROUND" as const, carrierId: null },
  };
  if (kind === "A") {
    return {
      ...base,
      players: [
        {
          id: "p1", username: "p1", resources: 30,
          core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
          units: [
            { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [8, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
            { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [-8, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
            { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
            { id: "22222222-2222-2222-2222-222222222204", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
          ],
        },
        {
          id: "p2", username: "p2", resources: 50,
          core: { id: "44444444-4444-4444-4444-444444444444", position: [30, 0], hp: 5, shield: 5, state: "NORMAL" },
          units: [
            { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [20, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
            { id: "55555555-5555-5555-5555-555555555502", owner: "p2", position: [20, 1], hp: 4, unitType: "VANGUARD", cargo: 0 },
            { id: "55555555-5555-5555-5555-555555555503", owner: "p2", position: [-20, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          ],
        },
      ],
    };
  }
  if (kind === "B") {
    // 单轴多敌：3 Vanguard 全东侧
    return {
      ...base,
      players: [
        {
          id: "p1", username: "p1", resources: 30,
          core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
          units: [
            { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [8, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
            { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [-8, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
            { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
            { id: "22222222-2222-2222-2222-222222222204", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
          ],
        },
        {
          id: "p2", username: "p2", resources: 50,
          core: { id: "44444444-4444-4444-4444-444444444444", position: [30, 0], hp: 5, shield: 5, state: "NORMAL" },
          units: [
            { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [18, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
            { id: "55555555-5555-5555-5555-555555555502", owner: "p2", position: [18, 1], hp: 4, unitType: "VANGUARD", cargo: 0 },
            { id: "55555555-5555-5555-5555-555555555503", owner: "p2", position: [18, 2], hp: 4, unitType: "VANGUARD", cargo: 0 },
          ],
        },
      ],
    };
  }
  if (kind === "C") {
    // Ranger 守卫：p1 1 Vanguard + 1 Ranger（Ranger 内层 2 格屏）
    return {
      ...base,
      players: [
        {
          id: "p1", username: "p1", resources: 30,
          core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
          units: [
            { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [8, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
            { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [-8, 0], hp: 2, unitType: "RANGER", cargo: 0 },
            { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
            { id: "22222222-2222-2222-2222-222222222204", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
          ],
        },
        {
          id: "p2", username: "p2", resources: 50,
          core: { id: "44444444-4444-4444-4444-444444444444", position: [30, 0], hp: 5, shield: 5, state: "NORMAL" },
          units: [
            { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [20, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
            { id: "55555555-5555-5555-5555-555555555502", owner: "p2", position: [20, 1], hp: 4, unitType: "VANGUARD", cargo: 0 },
            { id: "55555555-5555-5555-5555-555555555503", owner: "p2", position: [-20, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          ],
        },
      ],
    };
  }
  // D：p2 带 Ranger（2 Vanguard + 1 Ranger 远程射击）
  return {
    ...base,
    players: [
      {
        id: "p1", username: "p1", resources: 30,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [8, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [-8, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222204", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 50,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [30, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [20, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555502", owner: "p2", position: [-20, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555506", owner: "p2", position: [20, 2], hp: 2, unitType: "RANGER", cargo: 0 },
        ],
      },
    ],
  };
}

function runVariant(kind: ScenarioKind, guardAxes: boolean, seed: number) {
  const result = runEpisode({
    scenario: scenario(kind, seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      { id: "p1", planner: "safety", plannerConfig: { guardAxes } },
      { id: "p2", planner: "safety", plannerConfig: { aggression: "aggressive" } },
    ],
  });
  let coreHits = 0;
  let workerLosses = 0;
  let deposits = 0;
  let p1CoreAlive = true;
  const p1Workers = new Set(["22222222-2222-2222-2222-222222222203", "22222222-2222-2222-2222-222222222204"]);
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "CORE_DAMAGED" && String(event.targetId ?? "").startsWith("1111")) coreHits += 1;
      if (event.eventType === "CORE_DESTROYED" && String(event.targetId ?? "").startsWith("1111")) p1CoreAlive = false;
      if (event.eventType === "UNIT_DAMAGED" && p1Workers.has(String(event.targetId ?? "")) && (event.values?.hp ?? 1) <= 0) workerLosses += 1;
      if (event.eventType === "DEPOSIT_SUCCEEDED" && String(event.actorId ?? "").startsWith("2222")) deposits += 1;
    }
  }
  return { coreHits, workerLosses, deposits, p1CoreAlive };
}

const SCENARIO_LABELS: Record<ScenarioKind, string> = {
  A: "A 双轴夹击（原场景）",
  B: "B 单轴多敌（全东侧）",
  C: "C Ranger 守卫（V+R）",
  D: "D p2 带 Ranger",
};

console.log(`guardAxes 稳健性 A/B（${TICKS} ticks × ${SEEDS.length} seeds × 4 场景，v0.14）`);
console.log("=".repeat(96));
for (const kind of ["A", "B", "C", "D"] as const) {
  const rows: string[] = [];
  for (const [label, guardAxes] of [["guardAxes=false", false], ["guardAxes=true ", true]] as const) {
    const outcomes = SEEDS.map((seed) => runVariant(kind, guardAxes, seed));
    const avg = (key: "coreHits" | "workerLosses" | "deposits") =>
      (outcomes.reduce((sum, o) => sum + o[key], 0) / outcomes.length).toFixed(1);
    const alive = outcomes.filter((o) => o.p1CoreAlive).length;
    rows.push(
      `${label} | 命中=${avg("coreHits")} | worker损=${avg("workerLosses")} | deposits=${avg("deposits")} | p1存活=${alive}/${SEEDS.length}`,
    );
  }
  console.log(SCENARIO_LABELS[kind]);
  for (const row of rows) console.log("  " + row);
}
