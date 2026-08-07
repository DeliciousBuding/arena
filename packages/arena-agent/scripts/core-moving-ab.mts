/**
 * v0.14 核心迁移中交仓 A/B（2026-08-07，core-moving-hold-v1 候选验证）：
 * 生产实测 t2/t3 手操迁移时 150 tick 内 DEPOSIT_FAILED 17/11 次
 * （CORE_MOVING/CORE_NOT_PRESENT）——cargo worker 追着移动核心交仓空跑。
 *
 * 引擎模型：一次迁移 = 向相邻格移动，耗时 moveRequiredTicks（官方 Four-Tick
 * migration）；迁移期间核心停留在原格（state=MOVING），到期 tick 才跳到
 * destination。手操长距离迁移 = 连续多次迁移，核心在旅途全程几乎一直 MOVING。
 * 本场景用 moveRequiredTicks=20 的单次长迁移近似手操长途迁移（等效 ~5 次
 * 4-tick 连迁），对比：
 *   baseline（追交）：cargo worker 在核心格 DEPOSIT → 引擎 CORE_MOVING 拒绝；
 *                     在目的地格等 → CORE_NOT_PRESENT 拒绝，全程空跑。
 *   coreMovingHold（持货待命）：MOVING 期间 WAIT，核心回 NORMAL 后交仓。
 * KPI：DEPOSIT_FAILED 数（按 reasonCode 分解）、DEPOSIT_SUCCEEDED 数、最终资源。
 * 用法：cd packages/arena-agent && npx tsx scripts/core-moving-ab.mts
 */
import { runEpisode } from "../src/sim/harness/episode.ts";
import type { SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";
import { DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";

/** 迁移总时长：手操长途迁移 ≈ 连续多次 4-tick 迁移，核心旅途全程 MOVING。 */
const MIGRATION_TICKS = 20;

function migrationScenario(seed: number) {
  return {
    rulesVersion: "v0.14" as const,
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 10,
        core: {
          id: "11111111-1111-1111-1111-111111111111", position: [0, 0],
          hp: 5, shield: 5, state: "MOVING",
          // 单步迁移语义：destination = position + moveDirection 一步相邻格；
          // 迁移期间核心滞留 [0,0]（MOVING），到期 tick 才到 [0,1]。
          moveDirection: "DOWN", moveProgress: 1, moveRequiredTicks: MIGRATION_TICKS, destination: [0, 1],
        },
        units: [
          { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [0, 0], hp: 2, unitType: "WORKER", cargo: 1 },
          { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 1 },
          { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 1 },
          { id: "22222222-2222-2222-2222-222222222204", owner: "p1", position: [-1, 0], hp: 2, unitType: "WORKER", cargo: 1 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[3, 0], [0, 3], [-3, 0], [0, -3], [5, 0], [0, 5]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const SEEDS = [1, 2, 3];
const TICKS = 60;

type PlannerKind = "safety" | "deterministic";

function runVariant(overrides: Partial<SafetyPlannerConfig>, seed: number, plannerKind: PlannerKind = "safety") {
  const result = runEpisode({
    scenario: migrationScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      {
        id: "p1", planner: plannerKind,
        plannerConfig: { ...DEFAULT_SAFETY_CONFIG, ...overrides },
        policy: { posture: "balanced", workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: null },
      },
    ],
  } as never);
  let depositFailed = 0;
  const failedByReason = new Map<string, number>();
  let depositOk = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "DEPOSIT_FAILED") {
        depositFailed += 1;
        const reason = (event as { reasonCode?: string }).reasonCode ?? "?";
        failedByReason.set(reason, (failedByReason.get(reason) ?? 0) + 1);
      } else if (event.eventType === "DEPOSIT_SUCCEEDED") {
        depositOk += 1;
      }
    }
  }
  const resources = result.finalWorld.players.get("p1")?.resources ?? 10;
  const reasonText = [...failedByReason.entries()].map(([r, n]) => `${r}=${n}`).join(" ");
  return { depositFailed, depositOk, resources, reasonText };
}

console.log(`v0.14 核心迁移交仓 A/B（${TICKS} ticks × ${SEEDS.length} seeds，Core [0,0]→[0,1] MOVING×${MIGRATION_TICKS}tick）`);
console.log("=".repeat(80));
for (const plannerKind of ["safety", "deterministic"] as const) {
  console.log(`\n[planner=${plannerKind}]`);
for (const [label, cfg] of [
  ["baseline（追交）", {}],
  ["coreMovingHold（持货待命）", { coreMovingHold: true }],
] as const) {
  const outcomes = SEEDS.map((seed) => runVariant(cfg as Partial<SafetyPlannerConfig>, seed, plannerKind));
  const avgFail = outcomes.reduce((s, o) => s + o.depositFailed, 0) / outcomes.length;
  const avgOk = outcomes.reduce((s, o) => s + o.depositOk, 0) / outcomes.length;
  const avgRes = outcomes.reduce((s, o) => s + o.resources, 0) / outcomes.length;
  console.log(`${label.padEnd(22)} | DEPOSIT_FAILED(avg)=${avgFail.toFixed(1)} | DEPOSIT_OK(avg)=${avgOk.toFixed(1)} | 最终res=${avgRes.toFixed(1)}`);
  for (const [i, o] of outcomes.entries()) {
    console.log(`  seed ${i + 1}: fail=${o.depositFailed} ok=${o.depositOk} res=${o.resources} | ${o.reasonText}`);
  }
}
}
