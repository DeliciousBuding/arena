/**
 * 锁阵扩展 A/B（2026-08-08，worker-blockade-v1 收尾验证）：
 * 三个新场景验证锁阵在多目标/环境锁/协同配置下的稳定性：
 *
 * 场景 A（并发双锁）：2 个敌方满载 worker 同时回程，我方 10 worker 巡逻——
 *   验证 pairBlockadeTargets 并发配对两个目标、锁手不互抢锁点；
 * 场景 B（入口锁）：敌方从东侧回程（[24,0]→[20,0]），我方 worker 目击敌核心
 *   建立 intel——验证回程预测把锁点推到敌核心入口格，敌方被锁死在核心外；
 * 场景 C（协同）：spawnYield + workerBlockade 同开——满载 worker 让位卸货
 *   与空 worker 锁阵共存，验证两变体不打架（spawn 不失败 + 敌方回程仍被锁）。
 *
 * KPI：敌方到达核心格 tick（无锁 = 路径长度）、我方资源曲线、CORE_SPAWN_FAILED。
 * 用法：cd packages/arena-agent && npx tsx scripts/blockade-ab-ext.mts
 */
import { runEpisode } from "../src/sim/harness/episode.ts";
import type { SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";
import { DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const TICKS = 90;
const SEEDS = [1, 2, 3, 4, 5, 6];

/** 敌方核心位置。 */
const ENEMY_CORE: [number, number] = [20, 0];

interface WorkerSpec {
  position: [number, number];
  cargo?: number;
}

interface ScenarioSpec {
  name: string;
  /** 敌方 worker 起点列表（cargo=1 满载回程）。 */
  enemyWorkers: [number, number][];
  /** 我方 worker 位置列表（空 cargo 巡逻/锁阵）。 */
  myWorkers: WorkerSpec[];
  /** 我方初始资源（场景 C 需要够产兵）。 */
  myResources: number;
  overrides: Partial<SafetyPlannerConfig>;
  policyWorkerTarget: number;
}

function buildScenario(spec: ScenarioSpec, seed: number) {
  return {
    rulesVersion: "v0.14" as const,
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: spec.myResources,
        core: {
          id: "11111111-1111-1111-1111-111111111111", position: [0, 0],
          hp: 5, shield: 5, state: "NORMAL",
          moveDirection: null, moveProgress: null, moveRequiredTicks: null, destination: null,
        },
        units: spec.myWorkers.map((worker, i) => ({
          id: `22222222-2222-2222-2222-22222222${String(i + 1).padStart(4, "0")}`,
          owner: "p1",
          position: worker.position,
          hp: 2, unitType: "WORKER", cargo: worker.cargo ?? 0,
        })),
      },
      {
        id: "p2", username: "p2", resources: 10,
        core: {
          id: "33333333-3333-3333-3333-333333333333", position: ENEMY_CORE,
          hp: 5, shield: 5, state: "NORMAL",
          moveDirection: null, moveProgress: null, moveRequiredTicks: null, destination: null,
        },
        units: spec.enemyWorkers.map((position, i) => ({
          id: `44444444-4444-4444-4444-4444444444${String(i + 1).padStart(2, "0")}`,
          owner: "p2", position, hp: 2, unitType: "WORKER", cargo: 1,
        })),
      },
    ],
    terrain: { obstacles: [], resources: [[3, 0], [0, 3], [-3, 0], [0, -3], [5, 0], [0, 5], [3, 3], [-3, -3]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

interface Outcome {
  /** 每个敌方 worker 到达核心格的 tick（未到 = null）。 */
  arrivals: (number | null)[];
  myResources: number;
  myWorkers: number;
  spawnFailed: number;
}

function runVariant(spec: ScenarioSpec, seed: number): Outcome {
  const result = runEpisode({
    scenario: buildScenario(spec, seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      {
        id: "p1", planner: "safety",
        plannerConfig: { ...DEFAULT_SAFETY_CONFIG, ...spec.overrides },
        policy: {
          posture: "balanced", workerTarget: spec.policyWorkerTarget, militaryRatio: 0,
          focusRegion: null, attackPriority: null,
        },
      },
      {
        id: "p2", planner: "deterministic",
        plannerConfig: { ...DEFAULT_SAFETY_CONFIG },
        policy: { posture: "balanced", workerTarget: spec.enemyWorkers.length, militaryRatio: 0, focusRegion: null, attackPriority: null },
      },
    ],
  } as never);
  const arrivals: (number | null)[] = spec.enemyWorkers.map(() => null);
  let spawnFailed = 0;
  for (const record of result.records) {
    for (const event of (record.events ?? []) as {
      eventType?: string; actorId?: string; position?: [number, number]; reasonCode?: string;
    }[]) {
      if (event.eventType === "CORE_SPAWN_FAILED") spawnFailed += 1;
      if (event.eventType !== "UNIT_MOVE_SUCCEEDED" || event.position === undefined) continue;
      if (event.position[0] !== ENEMY_CORE[0] || event.position[1] !== ENEMY_CORE[1]) continue;
      const actorId = event.actorId ?? "";
      const idx = spec.enemyWorkers.findIndex((_, i) => actorId.endsWith(String(i + 1).padStart(2, "0")));
      if (idx >= 0 && arrivals[idx] === null) arrivals[idx] = record.tick;
    }
  }
  const p1 = result.finalWorld.players.get("p1");
  return {
    arrivals,
    myResources: p1?.resources ?? spec.myResources,
    myWorkers: p1?.units.length ?? spec.myWorkers.length,
    spawnFailed,
  };
}

function avg(values: number[]): number {
  return values.length === 0 ? -1 : values.reduce((s, v) => s + v, 0) / values.length;
}

const SCENARIOS: ScenarioSpec[] = [
  {
    // 场景 A：两路并发回程（x=5 与 x=5,y=3 两路），10 worker 巡逻在回程路径上
    name: "A 并发双锁（2 敌方回程）",
    enemyWorkers: [[5, 0], [5, 3]],
    myWorkers: Array.from({ length: 10 }, (_, i) => ({
      position: (i < 5 ? [6 + i, 0] : [6 + (i - 5), 3]) as [number, number],
    })),
    myResources: 20,
    overrides: { workerBlockade: true },
    policyWorkerTarget: 8,
  },
  {
    // 场景 B：入口锁——敌方从东侧回程（[24,0]→[20,0]），我方 worker
    // 在 [18,0] 目击敌核心（视野 3 内）建立 coreHuntTargets；敌方最后一段
    // 回程被预测锁点挡在核心外（入口格被占 → 永远到不了核心卸货）
    name: "B 入口锁（敌核心外封锁）",
    enemyWorkers: [[24, 0]],
    myWorkers: [
      ...Array.from({ length: 7 }, (_, i) => ({
        position: [6 + i, 0] as [number, number],
      })),
      { position: [18, 0] as [number, number] },
    ],
    myResources: 20,
    overrides: { workerBlockade: true },
    policyWorkerTarget: 8,
  },
  {
    // 场景 C：协同——spawnYield + workerBlockade 同开；满载 worker 回核心卸货
    // + 空 worker 锁敌方回程。满载回程 worker 与让位场景同构
    name: "C 协同（让位+锁阵同开）",
    enemyWorkers: [[5, 0]],
    myWorkers: [
      // 3 个满载回核心卸货（让位场景核心格+邻格），7 个空 worker 巡逻锁阵
      { position: [0, 0] as [number, number], cargo: 1 },
      { position: [0, 1] as [number, number], cargo: 1 },
      { position: [1, 0] as [number, number], cargo: 1 },
    ].map((w, i) => ({ ...w, id: `22222222-2222-2222-2222-22222222${String(i + 1).padStart(4, "0")}`, owner: "p1", hp: 2, unitType: "WORKER" as const }))
      .concat(Array.from({ length: 7 }, (_, i) => ({
        id: `22222222-2222-2222-2222-22222222${String(i + 4).padStart(4, "0")}`,
        owner: "p1", position: [6 + i, 0] as [number, number], hp: 2, unitType: "WORKER" as const, cargo: 0,
      }))),
    myResources: 30,
    overrides: { spawnYield: true, workerBlockade: true },
    policyWorkerTarget: 10,
  },
];

console.log(`v0.14 锁阵扩展 A/B（${TICKS} ticks × ${SEEDS.length} seeds）`);
console.log("=".repeat(100));
for (const spec of SCENARIOS) {
  const baseline = SEEDS.map((seed) => runVariant({ ...spec, overrides: {} }, seed));
  const treated = SEEDS.map((seed) => runVariant({ ...spec, overrides: spec.overrides }, seed));

  const baseArrivals = baseline.flatMap((o) => o.arrivals.filter((a): a is number => a !== null));
  const treatArrivals = treated.flatMap((o) => o.arrivals.filter((a): a is number => a !== null));
  const baseArrivalRate = baseArrivals.length / (baseline.length * spec.enemyWorkers.length);
  const treatArrivalRate = treatArrivals.length / (treated.length * spec.enemyWorkers.length);
  const baseDelay = avg(baseArrivals);
  const treatDelay = avg(treatArrivals);
  const baseRes = avg(baseline.map((o) => o.myResources));
  const treatRes = avg(treated.map((o) => o.myResources));
  const baseSpawn = baseline.reduce((s, o) => s + o.spawnFailed, 0);
  const treatSpawn = treated.reduce((s, o) => s + o.spawnFailed, 0);

  console.log(`\n${spec.name}`);
  console.log(
    `  baseline: 到达tick=${baseDelay.toFixed(1)} 到达率=${(baseArrivalRate * 100).toFixed(0)}% res=${baseRes.toFixed(1)} spawnFail=${baseSpawn}`,
  );
  console.log(
    `  变体启用: 到达tick=${treatDelay.toFixed(1)} 到达率=${(treatArrivalRate * 100).toFixed(0)}% res=${treatRes.toFixed(1)} spawnFail=${treatSpawn} 延迟差=${(treatDelay - baseDelay).toFixed(1)}`,
  );
  for (const [i, seed] of SEEDS.entries()) {
    const b = baseline[i]!;
    const t = treated[i]!;
    console.log(
      `    seed${seed}: base=[${b.arrivals.join(",")}] treat=[${t.arrivals.join(",")}] | res ${b.myResources.toFixed(0)}→${t.myResources.toFixed(0)} pop ${b.myWorkers}→${t.myWorkers}`,
    );
  }
}
