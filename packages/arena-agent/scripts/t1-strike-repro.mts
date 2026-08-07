/** t1 类似攻坚复现（2026-08-07）：home [-619,-154]，敌 Core [-611,-169]（NE 15 格），
 *  5 VANGUARD + 4 RANGER 满编在 Core 附近、无可见资源、资源枯竭——strike-core-v1
 *  是否会让军事外扩接敌拆 Core。 */
import { runEpisode } from "../src/sim/harness/episode.ts";
import { resolvePlannerVariant } from "../src/sim/tools/planner-variants.ts";
import { DeterministicPlanner } from "../src/planning/deterministic-planner.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const AGGRESSIVE_POLICY: MacroPolicy = {
  posture: "aggressive", workerTarget: 12, militaryRatio: 0.4, focusRegion: null, attackPriority: "core",
};

function scenario(seed: number) {
  const units = [];
  for (let i = 0; i < 5; i++) {
    units.push({ id: `22222222-2222-2222-2222-2222222222${String(i).padStart(2, "0")}`, owner: "p1", position: [-619 + i, -150], hp: 4, unitType: "VANGUARD", cargo: 0 });
  }
  for (let i = 0; i < 4; i++) {
    units.push({ id: `22222222-2222-2222-2222-2222222223${String(i).padStart(2, "0")}`, owner: "p1", position: [-622 + i, -152], hp: 2, unitType: "RANGER", cargo: 0 });
  }
  for (let i = 0; i < 12; i++) {
    units.push({ id: `22222222-2222-2222-2222-2222222224${String(i).padStart(2, "0")}`, owner: "p1", position: [-615 - i, -156], hp: 2, unitType: "WORKER", cargo: 0 });
  }
  return {
    rulesVersion: "v0.14", tick: 1, seed,
    players: [
      { id: "p1", username: "p1", resources: 41, core: { id: "11111111-1111-1111-1111-111111111111", position: [-619, -154], hp: 5, shield: 5, state: "NORMAL" }, units },
      { id: "p2", username: "p2", resources: 0, core: { id: "44444444-4444-4444-4444-444444444444", position: [-611, -169], hp: 5, shield: 5, state: "NORMAL" }, units: [
        { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [-610, -168], hp: 4, unitType: "VANGUARD", cargo: 0 },
        { id: "55555555-5555-5555-5555-555555555502", owner: "p2", position: [-612, -170], hp: 4, unitType: "VANGUARD", cargo: 0 },
      ] },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: { position: [-50, -223], status: "GROUND", carrierId: null },
  };
}

function run(strike: boolean, seed: number) {
  const result = runEpisode({
    scenario: scenario(seed), rulesPath: MANIFEST_PATH, seed, ticks: 200, tenants: [
      { id: "p1", planner: "deterministic", policy: AGGRESSIVE_POLICY },
      { id: "p2", planner: "deterministic", policy: AGGRESSIVE_POLICY },
    ],
    plannerFactory: (tenant) =>
      tenant.id === "p1"
        ? strike ? resolvePlannerVariant("strike-core-v1").create("p1") : new DeterministicPlanner()
        : new DeterministicPlanner(),
  });
  let p2Down = -1;
  let p2CoreHp = 5;
  let shots = 0, sweeps = 0, maxMilDist = 0;
  const home = [-619, -154];
  for (const record of result.records) {
    for (const event of record.events) {
      const target = String(event.targetId ?? "");
      const actor = String(event.actorId ?? "");
      if (event.eventType === "CORE_DESTROYED" && target.startsWith("4444")) p2Down = record.tick;
      if (event.eventType === "CORE_DAMAGED" && target.startsWith("4444")) p2CoreHp = Math.min(p2CoreHp, Number(event.values?.hp ?? p2CoreHp));
      if (actor.startsWith("2222")) {
        if (event.eventType === "SHOT_HIT" || event.eventType === "SHOT_MISSED") shots += 1;
        if (event.eventType === "SWEEP_RESOLVED") sweeps += 1;
      }
    }
    for (const unit of record.after?.units ?? []) {
      if (unit.owner === "p1" && (unit.unitType === "VANGUARD" || unit.unitType === "RANGER")) {
        const d = Math.max(Math.abs(unit.position[0] - home[0]), Math.abs(unit.position[1] - home[1]));
        if (d > maxMilDist) maxMilDist = d;
      }
    }
  }
  return { p2Down, p2CoreHp, shots, sweeps, maxMilDist };
}

for (const seed of [1, 2, 3]) {
  const base = run(false, seed);
  const strike = run(true, seed);
  console.log(`seed=${seed} base: p2Down=${base.p2Down} minHp=${base.p2CoreHp} shots=${base.shots} sweeps=${base.sweeps} maxMilDist=${base.maxMilDist} | strike: p2Down=${strike.p2Down} minHp=${strike.p2CoreHp} shots=${strike.shots} sweeps=${strike.sweeps} maxMilDist=${strike.maxMilDist}`);
}
