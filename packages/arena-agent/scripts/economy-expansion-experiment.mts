/**
 * 扩编主动性对照实验（2026-08-06）：榜二对照发现"我方无 policy 时 workerTarget=2
 * （恢复地板），3 worker 起步即永不补员 → res 闲置不扩编；榜二 worker_target=12
 * 主动扩编 deposits +80%。本实验用管线 policy 注入控制 workerTarget 梯度
 * （2 现状 / 8 平衡区 / 12 榜二），量化扩编价值，为"无 policy 默认目标"决策取证。
 *
 * 用法：cd packages/arena-agent && bun run scripts/economy-expansion-experiment.mts
 */
import { runExperiment } from "../src/sim/tools/experiment-pipeline.ts";
import type { EpisodeResult } from "../src/sim/harness/episode.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

function soloScenario(seed: number) {
  return {
    rulesVersion: "v0.11",
    tick: 1,
    seed,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 10,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [2, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[3, 0], [4, 0], [12, 0], [13, 0], [14, 0]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

function economyKpis(result: EpisodeResult): Record<string, number> {
  const player = result.finalWorld.players.get("p1")!;
  let deposits = 0;
  let harvests = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "DEPOSIT_SUCCEEDED") deposits += 1;
      if (event.eventType === "HARVEST_SUCCEEDED") harvests += 1;
    }
  }
  return { deposits, harvests, finalResources: player.resources, finalPopulation: player.units.length };
}

function policyWith(workerTarget: number): MacroPolicy {
  return { posture: "balanced", workerTarget, militaryRatio: 0, focusRegion: null, attackPriority: null };
}

const report = runExperiment({
  id: "economy-expansion",
  title: "扩编主动性对照（workerTarget 梯度，solo 3w/5 矿，refill 65，300 ticks）",
  scenario: (seed) => soloScenario(seed),
  variants: [
    { id: "wt-2", label: "workerTarget=2（现状：无 policy 恢复地板）", policy: policyWith(2) },
    { id: "wt-4", label: "workerTarget=4（温和扩编）", policy: policyWith(4) },
    { id: "wt-8", label: "workerTarget=8（平衡区）", policy: policyWith(8) },
    { id: "wt-12", label: "workerTarget=12（榜二目标）", policy: policyWith(12) },
  ],
  seeds: [1, 2, 3],
  ticks: 300,
  refill: { everyTicks: 65 },
  players: ["p1"],
  extendedMetrics: economyKpis,
  outputPath: "economy-expansion-result.txt",
});

console.log(report.text);
