/**
 * t2 停摆诊断脚本（2026-08-07）：读真实 calibration case → 还原
 * TickState → DeterministicPlanner.decide 全链 → 打印预裁决前后
 * 的 unitActions/intents，定位 Ranger ranger_home 被淘汰的机制。
 *
 * 用法：npx tsx scripts/diagnose-t2-stall.mts <case.json>
 */
import { readFileSync } from "node:fs";
import { Turn, type PlayerState } from "@arena/arena-hero-ts";
import { DeterministicPlanner } from "../src/planning/deterministic-planner.ts";
import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";

const casePath = process.argv[2];
if (casePath === undefined) {
  console.error("usage: npx tsx scripts/diagnose-t2-stall.mts <case.json>");
  process.exit(1);
}
const calibrationCase = JSON.parse(readFileSync(casePath, "utf8"));
const before = calibrationCase.before.state as PlayerState & { population_tier?: number; upkeep_next_tick?: number };
const turn = new Turn(
  before.tick ?? 1,
  {
    status: before.status,
    respawn_at_tick: before.respawn_at_tick ?? null,
    resources: before.resources,
    population: before.population,
    population_tier: before.population_tier ?? 0,
    upkeep_next_tick: before.upkeep_next_tick ?? 0,
    champion_beacon: before.champion_beacon,
    objects: before.objects,
    events: before.events,
  },
  (() => {}) as never,
);
const state = reduceTurn(turn as unknown as TurnLike);
console.log("tick:", state.tick, "units:", state.units.length);
console.log("core:", state.core?.position, "resources:", state.resources);

const planner = new DeterministicPlanner();
const plan = planner.decide({ state });
console.log("--- plan output ---");
for (const [id, action] of Object.entries(plan.unitActions)) {
  const unit = state.units.find((u) => u.id === id);
  console.log(
    id.slice(0, 8),
    unit?.unitType ?? "?",
    JSON.stringify(unit?.position),
    "cargo:", unit?.cargo,
    "→", JSON.stringify(action),
    "| intent:", plan.intents[id],
  );
}
