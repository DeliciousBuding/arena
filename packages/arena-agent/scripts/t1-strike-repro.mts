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
    terrain: {
      // t1 真实可见障碍（2026-08-07 tick 67587 采样）：验证密集搜索在真实地形下
      // 是否仍能发现/拆毁 off-diagonal 敌 Core（生产未接敌的最可能差异点）。
      obstacles: [
        [-635,-152],[-634,-140],[-633,-153],[-633,-150],[-631,-153],[-630,-151],[-628,-152],
        [-626,-162],[-626,-160],[-625,-158],[-624,-158],[-622,-153],[-621,-162],[-621,-154],
        [-621,-152],[-620,-136],[-619,-162],[-619,-152],[-619,-140],[-619,-139],[-618,-158],
        [-618,-156],[-618,-141],[-618,-137],[-617,-162],[-617,-155],[-617,-152],[-617,-138],
        [-616,-156],[-616,-154],[-616,-152],[-616,-141],[-616,-138],[-616,-136],[-615,-159],
        [-615,-141],[-614,-169],[-614,-168],[-614,-166],[-614,-156],[-614,-137],[-613,-156],
        [-613,-153],[-613,-152],[-612,-170],[-612,-166],[-611,-156],[-607,-155],[-607,-153],
        [-606,-157],[-605,-155],[-605,-153],[-604,-154],
      ],
      resources: [],
    },
    beacon: { position: [-50, -223], status: "GROUND", carrierId: null },
  };
}

const HARVEST_POLICY: MacroPolicy = {
  posture: "harvest", workerTarget: 12, militaryRatio: 0.2, focusRegion: null, attackPriority: null,
};

function run(strike: boolean, seed: number, harvestPolicy = false) {
  const result = runEpisode({
    scenario: scenario(seed), rulesPath: MANIFEST_PATH, seed, ticks: 200, tenants: [
      { id: "p1", planner: "deterministic", policy: harvestPolicy ? HARVEST_POLICY : AGGRESSIVE_POLICY },
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
  const strikeHarvestPolicy = run(true, seed, true);
  console.log(`seed=${seed} base: p2Down=${base.p2Down} minHp=${base.p2CoreHp} shots=${base.shots} sweeps=${base.sweeps} | strike: p2Down=${strike.p2Down} sweeps=${strike.sweeps} | strike+harvestPolicy: p2Down=${strikeHarvestPolicy.p2Down} sweeps=${strikeHarvestPolicy.sweeps}`);
}
