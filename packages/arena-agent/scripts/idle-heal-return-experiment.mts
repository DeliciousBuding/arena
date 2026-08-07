/**
 * worker 空闲回血候选实验（2026-08-07，B13 idleHealReturn）：在 worker
 * 磨损场景（worker-hunt / threat-defense-raid / strike-defense-*）上对比
 * 基线 vs 候选——衡量 worker 死亡率、p1 Core 存活与经济（最终资源/人口）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/idle-heal-return-experiment.mts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runEpisode } from "../src/sim/harness/episode.ts";
import type { EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { PlanProvider } from "../src/runtime/decision-types.ts";
import { SafetyPlanner, DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";
import type { SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const SCENARIO_DIR = "scripts/scenarios";
const SEEDS = [1, 2, 3];
const TICKS = 150;

const VARIANTS: ReadonlyArray<{ readonly name: string; readonly config: Partial<SafetyPlannerConfig> }> = [
  { name: "baseline", config: {} },
  { name: "idleHealReturn", config: { idleHealReturn: true } },
];

interface Outcome {
  p1CoreAlive: boolean;
  workerDeaths: number;
  p1Resources: number;
  p1Population: number;
}

function runScenario(scenarioPath: string, variant: (typeof VARIANTS)[number], seed: number): Outcome {
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf-8"));
  const initialWorkers = new Set(
    (scenario.players?.[0]?.units ?? [])
      .filter((u: { unitType: string }) => u.unitType === "WORKER")
      .map((u: { id: string }) => u.id),
  );
  const evaluation = scenario.evaluation as { p1Posture?: string; p1AttackPriority?: string | null } | undefined;
  const p1Posture = evaluation?.p1Posture === "aggressive" ? "aggressive" : "balanced";
  const p1Priority = evaluation?.p1AttackPriority ?? null;
  const makePlanner = (tenant: EpisodeTenant): PlanProvider => {
    if (tenant.id !== "p1") return new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG });
    return new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, ...variant.config });
  };
  const result = runEpisode({
    scenario: { ...scenario, seed },
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    plannerFactory: makePlanner,
    tenants: [
      { id: "p1", planner: "safety", policy: { posture: p1Posture, workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: p1Priority } },
      { id: "p2", planner: "safety", policy: { posture: "aggressive", workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: "core" } },
    ],
  });
  const deaths = new Set<string>();
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "UNIT_DAMAGED" && event.values?.hp === 0 && initialWorkers.has(String(event.targetId ?? ""))) {
        deaths.add(String(event.targetId));
      }
    }
  }
  const p1 = result.finalWorld.players.get("p1")!;
  return {
    p1CoreAlive: p1.core !== null,
    workerDeaths: deaths.size,
    p1Resources: p1.resources,
    p1Population: p1.units.length,
  };
}

const scenarios = ["worker-hunt", "threat-defense-raid", "strike-defense-2-ranger", "strike-defense-4", "strike-defense-6"];
console.log(`idleHealReturn 候选实验（${TICKS} ticks × ${SEEDS.length} seeds × ${VARIANTS.length} 变体，场景 ${scenarios.length} 个）`);
console.log("=".repeat(120));
for (const name of scenarios) {
  const path = join(SCENARIO_DIR, `${name}.json`);
  const rows: Array<{ variant: string; deaths: number; coreAlive: number; res: number; pop: number }> = [];
  for (const variant of VARIANTS) {
    const outcomes = SEEDS.map((seed) => runScenario(path, variant, seed));
    rows.push({
      variant: variant.name,
      deaths: outcomes.reduce((s, o) => s + o.workerDeaths, 0),
      coreAlive: outcomes.filter((o) => o.p1CoreAlive).length,
      res: outcomes.reduce((s, o) => s + o.p1Resources, 0) / outcomes.length,
      pop: outcomes.reduce((s, o) => s + o.p1Population, 0) / outcomes.length,
    });
  }
  for (const row of rows) {
    console.log(
      `${name.padEnd(28)} | ${row.variant.padEnd(16)} | workerDeaths=${row.deaths} | coreAlive=${row.coreAlive}/3 | avgRes=${row.res.toFixed(0)} | avgPop=${row.pop.toFixed(1)}`,
    );
  }
}
console.log("图例: workerDeaths = 初始 worker 中被击杀数（3 seeds 合计）；coreAlive = p1 Core 存活数；avgRes/avgPop = 最终资源/人口均值");
