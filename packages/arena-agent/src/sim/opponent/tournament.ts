/**
 * Tournament Orchestrator — 批量对抗矩阵 + 策略胜率榜（对抗测试平台层一）
 *
 * 职责：
 *  - 维护"对手池"注册中心（我的 TS 策略 / reference Python / 未来任意 adapter）；
 *  - 跑批量 matrix：对手 A × 对手 B × N seeds，每对自动对打；
 *  - 输出统一 KPI + 胜率榜（含边车 Durations/资源/拆核 tick）。
 *
 * 设计（去耦合）：
 *  - 世界结算完全复用 runEpisode；
 *  - 每个对手都实现同一个 `TournamentDecider` 端口（不走调度器专用逻辑）；
 *  - 这里不 import reference 内部——只依赖 ProtocolBridge + 对手 adapter。
 */

import type { Plan } from "../domain/model.ts";
import { runEpisode, type EpisodeTenant } from "../sim/harness/episode.ts";
import type { SimWorld } from "../sim/world/types.ts";
import type { PlanProvider } from "../runtime/decision-types.ts";
import { SafetyPlanner, DEFAULT_SAFETY_CONFIG, type SafetyPlannerConfig } from "./safety-planner.ts";

/** 比赛结果（规范化，供横向对比）。 */
export interface MatchResult {
  readonly players: readonly string[];
  /** 谁是胜者（null = 平局/未分）。 */
  readonly winner: string | null;
  readonly tick: number;
  /** 双方工期各存多久（tick 数），供策略时长对比。 */
  readonly tickCount: number;
  /** 最终双方存活核心（playerId → 是否存活）。 */
  readonly coreAlive: Readonly<Record<string, boolean>>;
  /** 各 players 最终资源（playerId → resources）。 */
  readonly finalResources: Readonly<Record<string, number>>;
  readonly finalPopulation: Readonly<Record<string, number>>;
  /** 对打当轮事件数（用于常观验证）。 */
  readonly eventCount: number;
}

/** 一种可参赛的策略（我的 TS / reference 提取 / HTTP）。标定 score 由外部提供。 */
export interface TournEntry {
  readonly id: string;
  readonly desc: string;
  /** 构造一个能直接塞进 runEpisode 的 PlanProvider。 */
  build: () => PlanProvider;
}

/** 一个纯协议别的比赛 runner（供"记忆型对手我在多局间保留状态"等可复用场景）。 */
export interface MatchObserver {
  onTick?(args: { tick: number; before: SimWorld; plans: Readonly<Record<string, Plan>> }): void;
}

export interface TournConfig {
  readonly rulesPath: string;
  readonly ticks: number;
  readonly seeds: readonly number[];
  /** 对手池注册（含 "my-ts" 等自身）。 */
  readonly entries: readonly TournEntry[];
  /** 让每个条目能把"观察到 + 生成计划"耦合起来（默认用 provider 决定）。 */
  readonly validatePlans?: boolean;
}

export interface TournamentOptions {
  readonly rulesPath: string;
  readonly ticks: number;
  readonly seeds: readonly number[];
  readonly entries: readonly TournEntry[];
  readonly validatePlans?: boolean;
}

interface ScenarioPlayerSeed {
  readonly id: string;
  readonly username: string;
  resources: number;
  readonly core: {
    id: string;
    position: [number, number];
    hp: number;
    shield: number;
    state: "NORMAL";
    moveDirection: null;
    moveProgress: null;
    moveRequiredTicks: null;
    destination: null;
  };
  readonly units: readonly unknown[];
}

/** 由一个"己方玩家位置 + 一个固定最小资源盘"构造 1v1 场景。 */
export function makeArenaScenario(playerA: ScenarioPlayerSeed, playerB: ScenarioPlayerSeed): unknown {
  return {
    rulesVersion: "v0.14",
    tick: 1,
    seed: 1,
    players: [playerA, playerB],
    terrain: { obstacles: [], resources: [[5, 0], [0, 3], [-3, 0], [0, -3]] },
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
  };
}

/** 造一个极简我方案略条目（方便单独把它作为"我参与"）。 */
export function makeSafetyEntry(id: string): TournEntry {
  const config: SafetyPlannerConfig = { ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" };
  return {
    id,
    desc: "my safety baseline",
    build: () => new SafetyPlanner(config),
  };
}

/** 计算一个 match 的胜者：核心存活优先；都活 → 资源多；都活且资源平 → 人口多；仍平 → null。 */
export function decideWinner(
  players: readonly string[],
  before: SimWorld,
  after: SimWorld,
): { winner: string | null; coreAlive: Record<string, boolean>; finalResources: Record<string, number>; finalPopulation: Record<string, number> } {
  const coreAlive: Record<string, boolean> = {};
  const finalResources: Record<string, number> = {};
  const finalPopulation: Record<string, number> = {};
  for (const player of players) {
    const p = after.players.get(player);
    coreAlive[player] = p !== undefined && p.core !== null;
    finalResources[player] = p?.resources ?? 0;
    finalPopulation[player] = p?.units.length ?? 0;
  }
  const alive = players.filter((p) => coreAlive[p]);
  let winner: string | null = null;
  if (alive.length === 1) {
    winner = alive[0];
  } else if (alive.length === players.length) {
    // 都活：资源多优先；平 → 人口多；平 → null
    const sorted = [...players].sort(
      (a, b) => finalResources[b] - finalResources[a] || finalPopulation[b] - finalPopulation[a],
    );
    const top = sorted[0];
    const second = sorted[1];
    if (
      finalResources[top] !== finalResources[second] ||
      finalPopulation[top] !== finalPopulation[second]
    ) {
      winner = top;
    }
  }
  return { winner, coreAlive, finalResources, finalPopulation };
}

/**
 * 跑一场 1v1 对打，返回规范化结果。内部用 runEpisode + 提供的 PlanProviders。
 * 第三方对手需能 feed 同一 rules/manifest。
 */
export function runMatch(
  a: TournEntry,
  b: TournEntry,
  seed: number,
  ticks: number,
  rulesPath: string,
  opts?: { validatePlans?: boolean },
): MatchResult {
  const scenario = makeArenaScenario(
    { id: a.id, username: a.id, resources: 20, core: { id: "491977e4-d3db-417b-8d82-2f5f3b5c8006", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", moveDirection: null, moveProgress: null, moveRequiredTicks: null, destination: null }, units: [] },
    { id: b.id, username: b.id, resources: 20, core: { id: "9fe0ca6d-53cb-4dd5-a8f8-2e6925f19e72", position: [30, 0], hp: 5, shield: 5, state: "NORMAL", moveDirection: null, moveProgress: null, moveRequiredTicks: null, destination: null }, units: [] },
  );
  const providerA = a.build();
  const providerB = b.build();
  const result = runEpisode({
    scenario,
    rulesPath,
    seed,
    ticks,
    tenants: [
      { id: a.id, planner: "safety", plannerConfig: {}, policy: { posture: "aggressive", workerTarget: 8, militaryRatio: 0.4, focusRegion: null, attackPriority: "core" } },
      { id: b.id, planner: "safety", plannerConfig: {}, policy: { posture: "aggressive", workerTarget: 8, militaryRatio: 0.4, focusRegion: null, attackPriority: "core" } },
    ],
    // 关键：注入我们两个条目的 provider，而不是用内置 deterministic/safety
    plannerFactory: (tenant: EpisodeTenant): PlanProvider => (tenant.id === a.id ? providerA : providerB),
    validatePlans: opts?.validatePlans ?? true,
  } as never);
  const { winner: w, coreAlive, finalResources, finalPopulation } = decideWinner([a.id, b.id], undefined as never, result.finalWorld);
  return {
    players: [a.id, b.id],
    winner: w,
    tick: 0,
    tickCount: ticks,
    coreAlive,
    finalResources,
    finalPopulation,
    eventCount: result.records.reduce((n, r) => n + r.events.length, 0),
  };
}