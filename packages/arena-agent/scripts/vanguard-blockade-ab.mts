/**
 * VANGUARD 预判拦截 A/B（2026-08-08，vanguard-blockade-v1）：
 * 手操实战（t1 5198c451 锁敌方 worker f81a3352）算法化验证——敌方满载
 * worker 直线回程，我方 VANGUARD：
 * - baseline：vanguard-prey-worker-v1（追击：追着打，敌方边逃边挨打）
 * - 变体：vanguard-blockade-v1（预判路径/终点站桩：敌方撞上被卡 + SWEEP）
 * KPI：敌方 worker 被击杀 tick、VANGUARD 移动总格数（拦截效率）、
 * 敌方累计推进格数（越少 = 拦得越早）。
 * 用法：cd packages/arena-agent && npx tsx scripts/vanguard-blockade-ab.mts
 */
import { runEpisode } from "../src/sim/harness/episode.ts";
import type { SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";
import { DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const TICKS = 60;
const SEEDS = [1, 2, 3, 4, 5, 6];

/** 敌方核心（敌方 worker 回程目标）。 */
const ENEMY_CORE: [number, number] = [20, 0];
/** 敌方 worker 起点（资源格 [5,0] 旁——采集循环，伏击兜底触发条件）。 */
const ENEMY_WORKER_START: [number, number] = [6, 0];
/** 我方 VANGUARD 起点（敌方采集点旁——到位即邻接 SWEEP）。 */
const MY_VANGUARD_START: [number, number] = [5, 1];

function scenario(seed: number) {
  return {
    rulesVersion: "v0.14" as const,
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 20,
        core: {
          id: "11111111-1111-1111-1111-111111111111", position: [30, 30],
          hp: 5, shield: 5, state: "NORMAL",
          moveDirection: null, moveProgress: null, moveRequiredTicks: null, destination: null,
        },
        units: [
          { id: "22222222-2222-2222-2222-222222220001", owner: "p1", position: MY_VANGUARD_START, hp: 4, unitType: "VANGUARD" },
        ],
      },
      {
        id: "p2", username: "p2", resources: 10,
        core: {
          id: "33333333-3333-3333-3333-333333333333", position: ENEMY_CORE,
          hp: 5, shield: 5, state: "NORMAL",
          moveDirection: null, moveProgress: null, moveRequiredTicks: null, destination: null,
        },
        units: [
          { id: "44444444-4444-4444-4444-444444444401", owner: "p2", position: ENEMY_WORKER_START, hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [[3, 0], [0, 3], [-3, 0], [0, -3], [5, 0], [0, 5], [3, 3], [-3, -3]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

interface Outcome {
  /** 敌方 worker 被击杀 tick（未杀 = null）。 */
  killTick: number | null;
  /** 敌方 worker 累计推进格数（距核心初始 15 格 - 终局距离）。 */
  enemyProgress: number;
  /** 我方 VANGUARD 移动总格数。 */
  vanguardMoves: number;
  vanguardAlive: boolean;
}

function runVariant(overrides: Partial<SafetyPlannerConfig>, seed: number): Outcome {
  const result = runEpisode({
    scenario: scenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      {
        id: "p1", planner: "safety",
        plannerConfig: { ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive", ...overrides },
        policy: { posture: "aggressive", workerTarget: 0, militaryRatio: 0, focusRegion: null, attackPriority: null },
      },
      {
        id: "p2", planner: "deterministic",
        plannerConfig: { ...DEFAULT_SAFETY_CONFIG },
        policy: { posture: "balanced", workerTarget: 1, militaryRatio: 0, focusRegion: null, attackPriority: null },
      },
    ],
  } as never);
  let killTick: number | null = null;
  let vanguardMoves = 0;
  const enemyTrail: { tick: number; pos: [number, number] }[] = [];
  for (const record of result.records) {
    for (const event of (record.events ?? []) as { eventType?: string; actorId?: string; position?: [number, number] }[]) {
      if (event.eventType === "UNIT_DESTROYED" && event.actorId?.startsWith("44444444")) {
        killTick = record.tick;
      }
      if (event.eventType === "UNIT_MOVE_SUCCEEDED" && event.actorId?.startsWith("22222222")) {
        vanguardMoves += 1;
      }
      if (event.eventType === "UNIT_MOVE_SUCCEEDED" && event.actorId?.startsWith("44444444") && event.position) {
        enemyTrail.push({ tick: record.tick, pos: event.position });
      }
    }
  }
  const p1 = result.finalWorld.players.get("p1");
  const vanguard = p1?.units.find((u) => u.unitType === "VANGUARD");
  const finalEnemy = result.finalWorld.players.get("p2")?.units.find((u) => u.unitType === "WORKER");
  const enemyProgress = finalEnemy
    ? 15 - (Math.abs(finalEnemy.position[0] - ENEMY_CORE[0]) + Math.abs(finalEnemy.position[1] - ENEMY_CORE[1]))
    : 15;
  return {
    killTick,
    enemyProgress,
    vanguardMoves,
    vanguardAlive: vanguard !== undefined && vanguard.hp > 0,
  };
}

function avg(values: number[]): number {
  return values.length === 0 ? -1 : values.reduce((s, v) => s + v, 0) / values.length;
}

console.log(`v0.14 VANGUARD 预判拦截 A/B（${TICKS} ticks × ${SEEDS.length} seeds，敌方满载 worker 直线回程）`);
console.log("=".repeat(100));
for (const [label, cfg] of [
  ["baseline（prey 追击）", { vanguardPreyWorker: true }],
  ["vanguardBlockade（预判拦截）", { vanguardBlockade: true }],
] as const) {
  const outcomes = SEEDS.map((seed) => runVariant(cfg, seed));
  const kills = outcomes.filter((o) => o.killTick !== null);
  const killRate = kills.length / outcomes.length;
  const avgKill = avg(kills.map((o) => o.killTick ?? 0));
  const avgProgress = avg(outcomes.map((o) => o.enemyProgress));
  const avgMoves = avg(outcomes.map((o) => o.vanguardMoves));
  const aliveRate = outcomes.filter((o) => o.vanguardAlive).length / outcomes.length;
  console.log(`${label.padEnd(30)} | 击杀率=${(killRate * 100).toFixed(0)}% 击杀tick(avg)=${avgKill.toFixed(1)} | 敌方推进=${avgProgress.toFixed(1)}格 | Vanguard移动=${avgMoves.toFixed(1)}格 | 存活率=${(aliveRate * 100).toFixed(0)}%`);
  for (const [i, o] of outcomes.entries()) {
    console.log(`  seed${i + 1}: kill=${o.killTick ?? "-"} 敌方推进=${o.enemyProgress} Vanguard移动=${o.vanguardMoves} 存活=${o.vanguardAlive}`);
  }
}
