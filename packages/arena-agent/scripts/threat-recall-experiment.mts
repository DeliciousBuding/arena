/**
 * 威胁召回（threatRecall）对打实验（2026-08-06，第十三轮，管线化重写）：
 * p1 守方（3 worker + 1 Vanguard，refill 校准 cadence 65）vs p2 aggressive
 * 前压方（2 Vanguard 从 15 格外推进打 p1 Core）。
 * 对照：p1 threatRecall=false（worker 照常巡逻，远 worker 被 p2 Vanguard 截杀）
 * vs true（12 格内敌确认 → worker 巡逻/探索缩到守家圈 4 格）。
 *
 * 管线化说明：场景工厂与 KPI 之外的全部样板（EpisodeConfig 组装、多 seed 聚合、
 * txt 输出）由 sim/tools/experiment-pipeline.ts 承担——脚本只剩声明。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/threat-recall-experiment.mts
 */
import { runExperiment } from "../src/sim/tools/experiment-pipeline.ts";
import type { EpisodeResult } from "../src/sim/harness/episode.ts";

/** p1 worker 前缀（KPI 归属判定用，与历史脚本一致）。 */
const P1_WORKER_PREFIX = "22222222";

function scenario(seed: number, rich: boolean) {
  const p1Units = rich
    ? [
        { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [1, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
        { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [0, 1], hp: 4, unitType: "VANGUARD", cargo: 0 },
        ...Array.from({ length: 8 }, (_, i) => ({
          id: `22222222-2222-2222-2222-2222222223${String(i).padStart(2, "0")}`,
          owner: "p1",
          position: [2 + i, 0] as [number, number],
          hp: 2,
          unitType: "WORKER",
          cargo: 0,
        })),
      ]
    : [
        { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [1, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
        { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [2, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
        // 远处巡逻的 worker（[15,0] 矿点附近，p2 Vanguard 前压路径上）
        { id: "22222222-2222-2222-2222-222222222204", owner: "p1", position: [14, 0], hp: 2, unitType: "WORKER", cargo: 0 },
      ];
  return {
    rulesVersion: "v0.11",
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: rich ? 30 : 8,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: p1Units,
      },
      {
        id: "p2", username: "p2", resources: 10,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [30, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "55555555-5555-5555-5555-555555555551", owner: "p2", position: [15, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555552", owner: "p2", position: [16, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "55555555-5555-5555-5555-555555555553", owner: "p2", position: [29, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[3, 0], [4, 0], [12, 0], [13, 0], [14, 0]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

function p1CombatMetrics(result: EpisodeResult): Record<string, number> {
  let coreHits = 0;
  let workerLosses = 0;
  let harvests = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "CORE_DAMAGED" && event.recipientPlayerId === "p1") coreHits += 1;
      if (event.eventType === "UNIT_DESTROYED" && event.actorId?.startsWith(P1_WORKER_PREFIX)) workerLosses += 1;
      if (event.eventType === "HARVEST_SUCCEEDED" && event.actorId?.startsWith(P1_WORKER_PREFIX)) harvests += 1;
    }
  }
  return { coreHits, workerLosses, harvests };
}

const report = runExperiment({
  id: "threat-recall",
  title: "威胁召回对打（p1 守方 threatRecall on/off vs p2 aggressive，refill 65）",
  scenario: (seed) => scenario(seed, false),
  variants: [
    { id: "recall-off", label: "[3w] p1 threatRecall=false", plannerConfig: { threatRecall: false } },
    { id: "recall-on", label: "[3w] p1 threatRecall=true", plannerConfig: { threatRecall: true } },
    {
      id: "recall-off-rich",
      label: "[8w] p1 threatRecall=false",
      plannerConfig: { threatRecall: false },
      scenarioModifier: (_, seed) => scenario(seed, true),
    },
    {
      id: "recall-on-rich",
      label: "[8w] p1 threatRecall=true",
      plannerConfig: { threatRecall: true },
      scenarioModifier: (_, seed) => scenario(seed, true),
    },
  ],
  seeds: [1, 2, 3],
  ticks: 300,
  refill: { everyTicks: 65 },
  players: ["p1", "p2"],
  extendedMetrics: p1CombatMetrics,
  outputPath: "threat-recall-result.txt",
});

console.log(report.text);
