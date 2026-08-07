/** 敌情狩猎复现（2026-08-07，持久敌情测绘）：t1 生产实证——敌 Core 迁移后
 *  军队在旧位置空转，16 方位环搜射线距迁移后 Core 仍 ~6 格 > 视野 4，几何
 *  近失永不接敌。本实验验证：启动播种"最后已知敌 Core 位置"（从历史
 *  calibration 提取）后，军事回访并拆毁远距敌 Core（home [-619,-154] →
 *  [-658,-128]，~65 曼哈顿），对照组（无播种）环搜在相同 tick 预算内找不到。 */
import { runEpisode } from "../src/sim/harness/episode.ts";
import { DeterministicPlanner } from "../src/planning/deterministic-planner.ts";
import { WorkerTaskPlanner } from "../src/planning/worker-task-planner.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import { VARIANT_SAFETY_CONFIG } from "../src/strategies/variant-registry.ts";
import type { CoreHuntTarget } from "../src/domain/world.ts";
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
      { id: "p2", username: "p2", resources: 0, core: { id: "44444444-4444-4444-4444-444444444444", position: [-658, -128], hp: 5, shield: 5, state: "NORMAL" }, units: [] },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: { position: [-50, -223], status: "GROUND", carrierId: null },
  };
}

function run(seeded: boolean, seed: number) {
  const safetyConfig = { ...DEFAULT_SAFETY_CONFIG, ...VARIANT_SAFETY_CONFIG["strike-core-v1"] };
  const seeds: readonly CoreHuntTarget[] = seeded
    ? [{ position: [-658, -128], lastSeenTick: 1, source: "CORE" }]
    : [];
  const result = runEpisode({
    scenario: scenario(seed), rulesPath: MANIFEST_PATH, seed, ticks: 300, tenants: [
      { id: "p1", planner: "deterministic", policy: AGGRESSIVE_POLICY },
      { id: "p2", planner: "deterministic", policy: AGGRESSIVE_POLICY },
    ],
    plannerFactory: (tenant) =>
      tenant.id === "p1"
        ? new DeterministicPlanner(
            new WorkerTaskPlanner(),
            new SafetyPlanner(safetyConfig),
            new SafetyPlanner(safetyConfig),
            0.5, 30, undefined, seeds,
          )
        : new DeterministicPlanner(),
  });
  let p2Down = -1;
  let minCoreHp = 5;
  let huntIntents = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      const target = String(event.targetId ?? "");
      if (event.eventType === "CORE_DESTROYED" && target.startsWith("4444")) p2Down = record.tick;
      if (event.eventType === "CORE_DAMAGED" && target.startsWith("4444")) {
        minCoreHp = Math.min(minCoreHp, Number(event.values?.hp ?? minCoreHp));
      }
    }
    for (const intent of Object.values(record.plans?.["p1"]?.intents ?? {})) {
      if (intent === "vanguard_hunt") huntIntents += 1;
    }
  }
  return { p2Down, minCoreHp, huntIntents };
}

for (const seed of [1, 2, 3]) {
  const base = run(false, seed);
  const seeded = run(true, seed);
  console.log(`seed=${seed} 无播种: p2Down=${base.p2Down} minHp=${base.minCoreHp} hunt=${base.huntIntents} | 有播种: p2Down=${seeded.p2Down} minHp=${seeded.minCoreHp} hunt=${seeded.huntIntents}`);
}
