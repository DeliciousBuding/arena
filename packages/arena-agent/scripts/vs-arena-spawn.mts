/**
 * vs-arena-spawn — W54 spawn-profile + slot 轮换 runner（2026-08-09）
 *
 * 模拟线上真实开局（reference arena-evolve/evolve/fitness.py）：被测新号
 * 1 Worker + 5 资源开局；老玩家带兵出生（7W/6R/6V）；弃坑残骸挂机死 Core；
 * 新生弱号。被测者每局轮换出生站点（P0#16 消除固定 slot 结构性偏差）。
 *
 * 与 vs-arena 的区别：vs-arena 用合成对称布局（makeArenaScenario），
 * vs-arena-spawn 用真实世界风格 spawn profile（far-flung SPAWN_SITES +
 * 分层对手角色），评估更贴近线上。
 *
 * 用法（cd packages/arena-agent）：
 *   npx tsx scripts/vs-arena-spawn.mts \
 *     [--me aggressive|defensive|balanced] \
 *     [--players 6|8]（默认 6；≤8） \
 *     [--seeds 1-8] [--ticks 200] \
 *     [--refill off|65|16|4|N]（默认 off——线上老玩家局不依赖 refill） \
 *     [--record-dir <path>]
 *
 * 输出：每 seed 被测者（SUBJECT）的存活/资源/人口 + 多 seed 聚合胜率
 * （被测者核心存活 = 胜；否则负）。
 */
import { performance } from "node:perf_hooks";
import { runEpisode, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import {
  buildSpawnScenario,
  findSubjectSlot,
  NoOpPlanner,
  rolesFor,
  SPAWN_SITES,
  type SpawnParticipant,
  type SpawnRole,
} from "../src/sim/opponent/spawn-profile.ts";
import { decideWinner, type MatchResult } from "../src/sim/opponent/tournament.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner, type SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";
import type { PlanProvider } from "../src/runtime/decision-types.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";

function argValue(flag: string): string | undefined {
  const equals = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (equals !== undefined) return equals.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  return undefined;
}

const ME = argValue("--me") ?? "aggressive";
const NUM_PLAYERS = Number(argValue("--players") ?? 6);
const TICKS = Number(argValue("--ticks") ?? 200);
const REFILL_RAW = argValue("--refill") ?? "off";
const REFILL_EVERY_TICKS: number | null =
  REFILL_RAW === "off" ? null : Number(REFILL_RAW);
const SEEDS_ARG = argValue("--seeds") ?? "1-8";
const SEEDS: number[] = (() => {
  const out: number[] = [];
  for (const part of SEEDS_ARG.split(",")) {
    const range = part.split("-").map(Number);
    if (range.length === 2) {
      for (let seed = range[0]; seed <= range[1]; seed += 1) out.push(seed);
    } else {
      out.push(range[0]);
    }
  }
  return out;
})();

if (SEEDS.length === 0) {
  console.error(`--seeds ${SEEDS_ARG} 解析为空（例：1-8 / 1,3,5）`);
  process.exit(1);
}
if (!Number.isInteger(NUM_PLAYERS) || NUM_PLAYERS < 2 || NUM_PLAYERS > SPAWN_SITES.length) {
  console.error(`--players 必须为 2..${SPAWN_SITES.length} 的整数，得到 ${NUM_PLAYERS}`);
  process.exit(1);
}

const aggressionLevel = ME === "defensive" ? "defensive" : ME === "balanced" ? "balanced" : "aggressive";
const subjectConfig: SafetyPlannerConfig = { ...DEFAULT_SAFETY_CONFIG };
if (aggressionLevel === "defensive") {
  subjectConfig.aggression = "defensive";
  subjectConfig.attackForce = 0;
} else if (aggressionLevel === "balanced") {
  subjectConfig.aggression = "balanced";
  subjectConfig.attackForce = 1;
} else {
  subjectConfig.aggression = "aggressive";
  subjectConfig.attackForce = 2;
}

/** 构造被测者 PlanProvider（SafetyPlanner + 配置档）。 */
function buildSubjectPlanner(): PlanProvider {
  return new SafetyPlanner(subjectConfig);
}

/** 构造对手 PlanProvider（角色 → planner）：
 *  - STATIC / NEW_WEAK → NoOpPlanner（挂机死 Core / 弱号不发育）；
 *  - OLD_BALANCED / OLD_AGGRESSIVE → SafetyPlanner（aggressive 配置，
 *    近似 reference HeuristicStrategy 的对打强度）。 */
function buildOpponentPlanner(role: SpawnRole): PlanProvider {
  if (role === "STATIC" || role === "NEW_WEAK") {
    return new NoOpPlanner();
  }
  return new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive", attackForce: 2 });
}

/** 构造参与者列表：被测者（SUBJECT）+ 对手（按 rolesFor 分配角色）。
 *  被测者 id = "subject"；对手 id = `opp-${role}-${index}`（distinct + 稳定）。
 *  participants[0] = SUBJECT（mySlot=0），其余按 rolesFor 顺序。 */
function buildParticipants(numPlayers: number): SpawnParticipant[] {
  const roles = rolesFor(numPlayers);
  const participants: SpawnParticipant[] = [
    { id: "subject", username: "subject (me)", role: "SUBJECT" },
  ];
  for (let i = 0; i < roles.length; i += 1) {
    const role = roles[i]!;
    participants.push({
      id: `opp-${role.toLowerCase()}-${i}`,
      username: `opp ${role} #${i}`,
      role,
    });
  }
  return participants;
}

/** 构造 tenants（按 participants 顺序，id 与 scenario players 对齐）。
 *  策略注入走 plannerFactory（按 tenant.id 查回 role → planner），这里
 *  tenant.planner 只是个 placeholder（plannerFactory 覆盖）。 */
function buildTenants(participants: readonly SpawnParticipant[]): EpisodeTenant[] {
  return participants.map((participant) => ({
    id: participant.id,
    planner: "safety" as const,
    plannerConfig: {},
    policy: {
      posture: "aggressive",
      workerTarget: 8,
      militaryRatio: 0.4,
      focusRegion: null,
      attackPriority: "core",
    },
  }));
}

function plannerFactoryFor(
  participants: readonly SpawnParticipant[],
  subjectPlanner: PlanProvider,
  opponentPlannerByRole: ReadonlyMap<string, PlanProvider>,
): (tenant: EpisodeTenant) => PlanProvider {
  const roleById = new Map(participants.map((p) => [p.id, p.role]));
  return (tenant: EpisodeTenant): PlanProvider => {
    const role = roleById.get(tenant.id);
    if (role === "SUBJECT") return subjectPlanner;
    if (role === undefined) throw new Error(`plannerFactory: no role for tenant ${tenant.id}`);
    const planner = opponentPlannerByRole.get(role);
    if (planner === undefined) throw new Error(`plannerFactory: no planner for role ${role}`);
    return planner;
  };
}

console.log(
  `vs-arena-spawn：我方=subject(${aggressionLevel}) 玩家数=${NUM_PLAYERS} ` +
    `seeds[${SEEDS_ARG}] ticks=${TICKS} refill=${REFILL_RAW}`,
);
console.log(`出生站点（${NUM_PLAYERS}/${SPAWN_SITES.length}）：${SPAWN_SITES.slice(0, NUM_PLAYERS).map((s) => `[${s[0]},${s[1]}]`).join(" ")}`);
console.log("=".repeat(96));

const participants = buildParticipants(NUM_PLAYERS);
const mySlot = findSubjectSlot(participants);
const subjectPlanner = buildSubjectPlanner();
const roles = rolesFor(NUM_PLAYERS);
const opponentPlannerByRole = new Map<string, PlanProvider>(
  roles.map((role) => [role, buildOpponentPlanner(role)]),
);
const tenants = buildTenants(participants);
const plannerFactory = plannerFactoryFor(participants, subjectPlanner, opponentPlannerByRole);

const refillConfig =
  REFILL_EVERY_TICKS === null ? null : { everyTicks: REFILL_EVERY_TICKS };

const wallStart = performance.now();
const results: MatchResult[] = [];
const subjectRotations: number[] = [];

for (const seed of SEEDS) {
  const { scenario, rotatedSlot } = buildSpawnScenario(participants, mySlot, seed);
  subjectRotations.push(rotatedSlot);
  const ids = participants.map((p) => p.id);
  const providers: PlanProvider[] = [];
  try {
    for (const participant of participants) {
      if (participant.role === "SUBJECT") providers.push(subjectPlanner);
      else {
        const planner = opponentPlannerByRole.get(participant.role as SpawnRole);
        if (planner === undefined) throw new Error(`no planner for ${participant.role}`);
        providers.push(planner);
      }
    }
    const result = runEpisode({
      scenario,
      rulesPath: MANIFEST_PATH,
      seed,
      ticks: TICKS,
      ...(refillConfig === null ? {} : { refill: refillConfig }),
      tenants,
      // 关键：注入按角色构造的 provider，而非内置 safety
      plannerFactory,
      // W54 slot 轮换：被测者在站点 rotatedSlot，tenants 顺序与 scenario
      // players[]（站点序）对齐——plans.values() 与 world.players.values()
      // 迭代顺序一致，消除固定 slot 结构性偏差。
      rotateSlot: true,
      mySlot,
      validatePlans: true,
    } as never);
    const { winner, coreAlive, finalResources, finalPopulation } = decideWinner(
      ids,
      undefined as never,
      result.finalWorld,
    );
    const subjectAlive = coreAlive["subject"] ?? false;
    const match: MatchResult = {
      players: ids,
      winner: subjectAlive ? "subject" : winner,
      tick: 0,
      tickCount: TICKS,
      coreAlive,
      finalResources,
      finalPopulation,
      eventCount: result.records.reduce((n, r) => n + r.events.length, 0),
    };
    results.push(match);
    const aliveLabel = subjectAlive ? "存活" : "阵亡";
    console.log(
      `seed=${String(seed).padStart(3)} site=${rotatedSlot} ` +
        `subject=${aliveLabel} res=${String(finalResources["subject"] ?? 0).padStart(4)} ` +
        `pop=${String(finalPopulation["subject"] ?? 0).padStart(3)} ` +
        `winner=${winner ?? "-"} events=${match.eventCount}`,
    );
  } finally {
    for (const provider of providers) {
      const closer = (provider as { close?: () => void }).close;
      if (typeof closer === "function") closer.call(provider);
    }
  }
}

const wallElapsed = performance.now() - wallStart;
const wins = results.filter((r) => r.winner === "subject").length;
const winRate = results.length === 0 ? 0 : wins / results.length;
const avgRes = results.length === 0
  ? 0
  : Math.round(results.reduce((sum, r) => sum + (r.finalResources["subject"] ?? 0), 0) / results.length);
const avgPop = results.length === 0
  ? 0
  : Math.round(results.reduce((sum, r) => sum + (r.finalPopulation["subject"] ?? 0), 0) / results.length);

console.log("=".repeat(96));
console.log(
  `聚合：${wins}/${results.length} 胜（winRate=${(winRate * 100).toFixed(1)}%） ` +
    `avgRes=${avgRes} avgPop=${avgPop} ` +
    `site轮换=${subjectRotations.join(",")} ` +
    `wall=${(wallElapsed / 1000).toFixed(2)}s`,
);
console.log(`（site 序列=被测者每 seed 所占 SPAWN_SITES 下标；全遍历=消除固定 slot 偏差）`);
