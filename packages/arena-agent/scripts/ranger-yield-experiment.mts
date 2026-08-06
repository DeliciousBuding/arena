/**
 * Ranger 守位让位实验（2026-08-07，生产 t2 实证修复验证）：
 * 场景 = 复现 t2 症状——p1 Core[0,0] + Ranger[0,0]（占 Core 格，
 * cell 容量 2 满）+ 4 个带 cargo Worker 在 Core 四邻（回仓通道被
 * 堵 → 经济停摆）；p2 远在 [30,30] 无威胁。
 * 修复前：Ranger 守位目标 = Core 格 → 永久占格 → worker 无法进入
 * DEPOSIT → 资源恒 5、0 deposits（t2 实证：>600 tick 停摆）。
 * 修复后：Ranger 让位（homeCell 锚点）→ worker 逐个进 Core 格
 * DEPOSIT → 资源增长。
 * KPI：p1 deposits 数、最终资源、worker cargo 归零数、Ranger 不在
 * Core 格。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/ranger-yield-experiment.mts
 */
import { runEpisode } from "../src/sim/harness/episode.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const SEEDS = [1, 2, 3];
const TICKS = 40;

function scenario(seed: number) {
  return {
    rulesVersion: "v0.14" as const,
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 5,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          // Ranger 占 Core 格（回仓通道堵死）
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [0, 0], hp: 2, unitType: "RANGER", cargo: 0 },
          // 4 个带 cargo Worker 在 Core 四邻
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 1 },
          { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [-1, 0], hp: 2, unitType: "WORKER", cargo: 1 },
          { id: "22222222-2222-2222-2222-222222222204", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 1 },
          { id: "22222222-2222-2222-2222-222222222205", owner: "p1", position: [0, -1], hp: 2, unitType: "WORKER", cargo: 1 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 20,
        core: { id: "44444444-4444-4444-4444-444444444444", position: [30, 30], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: "55555555-5555-5555-5555-555555555501", owner: "p2", position: [31, 30], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

function runSeed(seed: number): { deposits: number; resources: number; cargoLeft: number; rangerOnCore: boolean } {
  const result = runEpisode({
    scenario: scenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      { id: "p1", planner: "safety", plannerConfig: { workerTarget: 4, guardForce: 4 }, policy: { posture: "balanced", workerTarget: 4, militaryRatio: 0.4, focusRegion: null, attackPriority: null } },
      { id: "p2", planner: "safety", plannerConfig: {}, policy: { posture: "balanced", workerTarget: 4, militaryRatio: 0.4, focusRegion: null, attackPriority: null } },
    ],
  });
  const final = result.finalWorld.players.get("p1")!;
  const ranger = final.units.find((u) => u.unitType === "RANGER");
  const cargoLeft = final.units.filter((u) => u.unitType === "WORKER" && u.cargo > 0).length;
  let deposits = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "DEPOSIT_SUCCEEDED") deposits += 1;
    }
  }
  return {
    deposits,
    resources: final.resources,
    cargoLeft,
    rangerOnCore: ranger !== undefined && ranger.position[0] === 0 && ranger.position[1] === 0,
  };
}

const results = SEEDS.map((seed) => ({ seed, ...runSeed(seed) }));
for (const r of results) {
  console.log(
    `seed=${r.seed}: deposits=${r.deposits} resources=${r.resources} cargoLeft=${r.cargoLeft} rangerOnCore=${r.rangerOnCore}`,
  );
}
const ok = results.every((r) => r.deposits >= 4 && r.resources > 5 && r.cargoLeft === 0 && !r.rangerOnCore);
console.log(ok ? "PASS: Ranger 让位后经济恢复（全部 cargo 入库、Ranger 离开 Core 格）" : "FAIL");
process.exitCode = ok ? 0 : 1;
