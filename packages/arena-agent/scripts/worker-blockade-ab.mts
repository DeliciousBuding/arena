/**
 * 锁阵 A/B（2026-08-08，worker-blockade-v1 候选验证）：
 * t2 日志实证 669 次 MOVE_CONTESTED 全是我方被动挨卡——本场景把互卡变成
 * 主动：敌方满载回程 worker 朝敌核心移动，我方巡逻 worker 站桩锁点
 * （WAIT 占格）→ 敌方 MOVE_DESTINATION_OCCUPIED 进不来，脚本对手无
 * MOVE_FAILED 反馈无限重试（reference farmer 实证）。
 *
 * 收尾修复（2026-08-08）：拦截点选择（锁手追不上 → 选敌方路径前方格/
 * 敌核心入口）+ 预测断链保持（敌方被锁原地差分消失 → 保留配对）+ 入口锁
 * 放宽锁龄（30 tick）——A/B 实证敌方回程 17→48 tick（锁龄上限 30 + 基线
 * 路径差）。
 *
 * 场景：p1（我方，10 worker 巡逻）vs p2（敌方，1 worker 朝其核心移动）。
 * KPI：p2 worker 到达其核心格前的延迟（敌方回程被锁 tick 数）、p1 deposit
 * 曲线（锁阵不伤我方经济）、我方 worker 静止时长（锁位手闲置）。
 * 用法：cd packages/arena-agent && npx tsx scripts/worker-blockade-ab.mts
 */
import { runEpisode } from "../src/sim/harness/episode.ts";
import type { SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";
import { DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";

/** 敌方核心位置（p2 worker 的回程目标）。 */
const ENEMY_CORE: [number, number] = [20, 0];
/** 敌方 worker 起点（离敌核心 15 格，走直线回程；路径全程在我方 worker
 *  视野内，形成连续观察 → prevPosition 差分 → 回程预测）。 */
const ENEMY_WORKER_START: [number, number] = [5, 0];

function blockadeScenario(seed: number) {
  return {
    rulesVersion: "v0.14" as const,
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 20,
        core: {
          id: "11111111-1111-1111-1111-111111111111", position: [0, 0],
          hp: 5, shield: 5, state: "NORMAL",
          moveDirection: null, moveProgress: null, moveRequiredTicks: null, destination: null,
        },
        units: Array.from({ length: 10 }, (_, i) => {
          // 我方 worker 直接站在敌方回程路径前方（x=6..15, y=0）——
          // 敌方接近时锁点 = 敌方下一步格，已有我方 worker 站桩 → OCCUPIED
          return {
            id: `22222222-2222-2222-2222-22222222${String(i + 1).padStart(4, "0")}`,
            owner: "p1",
            position: [6 + i, 0] as [number, number],
            hp: 2, unitType: "WORKER", cargo: 0,
          };
        }),
      },
      {
        id: "p2", username: "p2", resources: 10,
        core: {
          id: "33333333-3333-3333-3333-333333333333", position: ENEMY_CORE,
          hp: 5, shield: 5, state: "NORMAL",
          moveDirection: null, moveProgress: null, moveRequiredTicks: null, destination: null,
        },
        units: [
          { id: "44444444-4444-4444-4444-444444444401", owner: "p2", position: ENEMY_WORKER_START, hp: 2, unitType: "WORKER", cargo: 1 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[3, 0], [0, 3], [-3, 0], [0, -3], [5, 0], [0, 5], [3, 3], [-3, -3]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

const SEEDS = [1, 2, 3];
const TICKS = 60;

function runVariant(overrides: Partial<SafetyPlannerConfig>, seed: number) {
  const result = runEpisode({
    scenario: blockadeScenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      {
        id: "p1", planner: "safety",
        plannerConfig: { ...DEFAULT_SAFETY_CONFIG, ...overrides },
        policy: { posture: "balanced", workerTarget: 8, militaryRatio: 0, focusRegion: null, attackPriority: null },
      },
      // p2 用最简 planner（每 tick 朝核心走一步）——模拟脚本对手
      {
        id: "p2", planner: "deterministic",
        plannerConfig: { ...DEFAULT_SAFETY_CONFIG },
        policy: { posture: "balanced", workerTarget: 1, militaryRatio: 0, focusRegion: null, attackPriority: null },
      },
    ],
  } as never);
  // 用 UNIT_MOVE_SUCCEEDED 事件跟踪 p2 worker 到达敌核心格的时间
  let arrivalTick = -1;
  for (const record of result.records) {
    for (const event of (record.events ?? []) as { eventType?: string; actorId?: string; position?: [number, number] }[]) {
      if (
        event.eventType === "UNIT_MOVE_SUCCEEDED" &&
        event.actorId?.startsWith("44444444") &&
        event.position !== undefined &&
        event.position[0] === ENEMY_CORE[0] &&
        event.position[1] === ENEMY_CORE[1]
      ) {
        arrivalTick = record.tick;
        break;
      }
    }
    if (arrivalTick >= 0) break;
  }
  const p1 = result.finalWorld.players.get("p1");
  return {
    arrivalTick,
    p1Resources: p1?.resources ?? 20,
    p1Workers: p1?.units.length ?? 10,
  };
}

console.log(`v0.14 锁阵 A/B（${TICKS} ticks × ${SEEDS.length} seeds，敌方满载 worker 回程 + 我方 10 worker）`);
console.log("=".repeat(90));
for (const [label, cfg] of [
  ["baseline（无锁阵）", {}],
  ["workerBlockade（锁阵）", { workerBlockade: true }],
] as const) {
  const outcomes = SEEDS.map((seed) => runVariant(cfg as Partial<SafetyPlannerConfig>, seed));
  const arrivals = outcomes.filter((o) => o.arrivalTick >= 0);
  const avgArrival = arrivals.length > 0
    ? arrivals.reduce((s, o) => s + o.arrivalTick, 0) / arrivals.length
    : -1;
  const avgRes = outcomes.reduce((s, o) => s + o.p1Resources, 0) / outcomes.length;
  console.log(`${label.padEnd(26)} | 敌方回程到达tick(avg)=${avgArrival} | 我方res=${avgRes.toFixed(1)} | 到达率=${arrivals.length}/${outcomes.length}`);
  for (const [i, o] of outcomes.entries()) {
    console.log(`  seed ${i + 1}: arrival=${o.arrivalTick} p1res=${o.p1Resources} p1workers=${o.p1Workers}`);
  }
}
