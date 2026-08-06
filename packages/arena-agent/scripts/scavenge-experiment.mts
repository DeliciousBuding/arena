/**
 * 军事打野触发条件修复实验（2026-08-06）：
 * 场景 = 单人 aggressive + 无敌人 + 资源枯竭（近矿 2 格采完 + 远矿 40 格 3 个）。
 * 修复前：打野条件要求 samePosition(unit, target)——无敌人时 target=Core 格，
 * Vanguard 守家锚点在途永远到不了 Core 格 → 打野永不触发（S7 debug 实证行为链）。
 * 修复后：无可见敌人 + 资源枯竭 → 直接巡逻外扩（vanguard_scavenge）。
 * KPI：Vanguard 最大 Chebyshev 距 Core（外扩深度）、vanguard_scavenge 意图计数。
 *
 * 用法（对照需要先跑旧代码）：
 *   cd packages/arena-agent && npx tsx scripts/scavenge-experiment.mts
 */
import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.11.json";
const RESULT_FILE = "scavenge-experiment-result.txt";

function scarcityScenario(seed: number) {
  return {
    rulesVersion: "v0.11",
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 10,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "22222222-2222-2222-2222-222222222200", owner: "p1", position: [1, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [2, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: {
      obstacles: [],
      resources: [[3, 0], [4, 0], [40, 0], [41, 0], [42, 0]],
    },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const POLICY: MacroPolicy = {
  posture: "aggressive",
  workerTarget: 8,
  militaryRatio: 0.3,
  focusRegion: null,
  attackPriority: null,
};

const SEEDS = [1, 2];
const TICKS = 300;

function runVariant(seed: number): { vgMaxDist: number; scavengeCount: number; vgFinal: [number, number] } {
  const config: EpisodeConfig = {
    scenario: scarcityScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [{ id: "p1", planner: "deterministic", policy: POLICY } as EpisodeTenant],
  };
  const result = runEpisode(config);
  const p1 = result.finalWorld.players.get("p1")!;
  const vg = p1.units.find((u) => u.unitType === "VANGUARD");
  const maxDist = Math.max(0, ...p1.units.map((u) => Math.abs(u.position[0]) + Math.abs(u.position[1])));
  let scavengeCount = 0;
  for (const record of result.records) {
    for (const intent of Object.values(record.plans["p1"]?.intents ?? {})) {
      if (intent === "vanguard_scavenge") scavengeCount += 1;
    }
  }
  return { vgMaxDist: maxDist, scavengeCount, vgFinal: vg?.position ?? [0, 0] };
}

const rows: string[] = [];
rows.push(`军事打野触发条件修复实验（${TICKS} ticks × ${SEEDS.length} seeds，枯竭 + 远矿 40 格）`);
rows.push("=".repeat(80));
for (const seed of SEEDS) {
  const o = runVariant(seed);
  rows.push(`seed ${seed}: Vanguard 末位=${JSON.stringify(o.vgFinal)} maxDist=${o.vgMaxDist} scavenge 意图=${o.scavengeCount}`);
}
const output = rows.join("\n");
console.log(output);
writeFileSync(RESULT_FILE, output + "\n");
