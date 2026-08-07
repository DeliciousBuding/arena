/**
 * B9 迁移取消候选实验（2026-08-07）：core-evade-danger 场景（p2 Vanguard
 * 逼近 + RANGER 堵退路）——对比 off / coreEvade / coreEvade+cancel。
 * KPI：Core 最终 hp、被攻击 tick 数、迁移 START 次数、取消次数。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runEpisode } from "../src/sim/harness/episode.ts";

const SCENARIO_PATH = resolve("scripts/scenarios/core-evade-danger.json");
const OUT_DIR = resolve("ARENA_REPO_ROOT/data/runs/sim/b9-experiment-20260807");
mkdirSync(OUT_DIR, { recursive: true });
const RULES_PATH = "src/sim/contracts/rules-v0.14.json";

const scenario = JSON.parse(
  (await import("node:fs")).readFileSync(SCENARIO_PATH, "utf-8"),
);

function countEvents(events: readonly { readonly eventType: string }[], type: string): number {
  return events.filter((e) => e.eventType === type).length;
}

for (const [name, plannerConfig] of [
  ["off", {}],
  ["coreEvade", { coreEvade: true }],
  ["coreEvadeCancel", { coreEvade: true, coreMigrationCancel: true }],
  ["evadeScoringCancel", { coreEvade: true, coreEvadeScoring: true, coreMigrationCancel: true }],
] as const) {
  const result = runEpisode({
    scenario,
    rulesPath: RULES_PATH,
    seed: scenario.seed ?? 1,
    ticks: 400,
    tenants: [
      { id: "p1", planner: "safety", policy: { posture: "aggressive", workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: "core" }, plannerConfig: { ...plannerConfig } },
      { id: "p2", planner: "safety", policy: { posture: "harvest", workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: "balanced" } },
    ],
  });
  const allEvents = result.records.flatMap((r) => r.events);
  const coreAttacked = countEvents(allEvents, "CORE_DAMAGED");
  const movesStarted = countEvents(allEvents, "CORE_MOVE_STARTED");
  const movesCancelled = countEvents(allEvents, "CORE_MOVE_CANCELLED");
  const movesSucceeded = countEvents(allEvents, "CORE_MOVE_SUCCEEDED");
  const last = result.records.at(-1)!;
  const p1 = last.plans.p1;
  const line = `${name}: CORE_DAMAGED=${coreAttacked} START=${movesStarted} CANCEL=${movesCancelled} SUCCEEDED=${movesSucceeded}`;
  console.log(line);
  writeFileSync(join(OUT_DIR, `result-${name}.txt`), line + "\n", "utf-8");
}
