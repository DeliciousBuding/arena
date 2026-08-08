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

import type { Plan } from "../../domain/model.ts";
import { runEpisode, type EpisodeTenant } from "../../sim/harness/episode.ts";
import type { SimWorld } from "../../sim/world/types.ts";
import {
  DEFAULT_PROCEDURAL_PARAMS,
  makeProceduralMatchScenario,
  makeProceduralScenarioN,
  type ProceduralWorldParams,
} from "../world/procedural.ts";
import type { PlanProvider } from "../../runtime/decision-types.ts";
import { SafetyPlanner, DEFAULT_SAFETY_CONFIG, type SafetyPlannerConfig } from "../../strategies/safety-planner.ts";
import { createEpisodeRecorder } from "./recorder.ts";

/** Re-export 程序化生成旋钮（调用方无需直接 import world/procedural）。 */
export { DEFAULT_PROCEDURAL_PARAMS } from "../world/procedural.ts";
export type { ProceduralWorldParams } from "../world/procedural.ts";

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

/** 资源盘变体池：不同 seed 取不同布局（确定性——同 seed 恒同场景）。
 *  每个变体围绕双方核心（[0,0] / [30,0]）对称放置资源，保证公平对打。 */
const RESOURCE_LAYOUTS: readonly (readonly (readonly [number, number])[])[] = [
  [[5, 0], [0, 3], [-3, 0], [0, -3]],
  [[6, 0], [0, 4], [-4, 0], [0, -4], [3, 2]],
  [[5, 1], [1, 4], [-4, 1], [-1, -3], [2, -3]],
  [[7, 0], [0, 5], [-5, 0], [0, -5], [35, 2], [28, 3]],
  [[5, 0], [3, 3], [-3, 3], [0, -3], [32, 0], [27, -3]],
  [[4, 2], [-2, 4], [-4, -2], [2, -4], [33, 2], [27, 4]],
];

/** 1v1 合成地图障碍集（M4-4）：与 RESOURCE_LAYOUTS 同源（seed % 变体数），
 *  每个变体 4 个 1×2/2×1 块（8 格，绝对坐标），布局规则（主轴 [0,0]→[30,0]）：
 *  - 全部位于双方核心之间偏侧（x∈[8,21]、y∈{±3..±6}），y=0 主轴线全程无
 *    障碍——主轴通路不被封死、包抄通道保留；
 *  - 距任一核心 Manhattan > 3（核心周围 3 格无阻碍）；
 *  - 与本变体资源盘格零重叠（逐变体核对 6 个布局）；不压信标 [15,0]
 *    （y≠0 自动满足）与初始 worker（x∈[1,29] 的 y=0 格）。
 *  目的：Ranger LOS 遮挡与包抄地形有可复现样本，但不改变"对称公平"评测前提。 */
const OBSTACLE_LAYOUTS: readonly (readonly (readonly [number, number])[])[] = [
  [[9, 4], [10, 4], [14, -4], [14, -3], [18, 5], [19, 5], [12, -6], [13, -6]],
  [[8, 3], [9, 3], [15, -5], [15, -4], [20, 4], [21, 4], [11, 6], [12, 6]],
  [[10, -5], [10, -4], [16, 3], [17, 3], [13, -6], [14, -6], [19, 5], [20, 5]],
  [[9, 4], [10, 4], [14, -4], [15, -4], [17, 5], [18, 5], [12, -5], [13, -5]],
  [[8, 4], [9, 4], [13, -5], [13, -4], [16, 6], [17, 6], [19, -4], [20, -4]],
  [[10, -5], [10, -4], [15, 3], [16, 3], [18, -6], [19, -6], [12, 5], [13, 5]],
];

/** FFA 合成地图障碍集（M4-4）：核心均匀分布半径 18 圆周、信标在圆心 [0,0]。
 *  障碍取圆心附近（|x|+|y| ≤ 10）4 个 1×2/2×1 块：
 *  - 距任一核心（距圆心 ≥ 18）Manhattan ≥ 8 > 3——核心周围 3 格无阻碍；
 *  - 距圆心 ≥ 4，不压信标 [0,0]；与任意核心的资源盘格（盘格距圆心 ≥ 13）
 *    零重叠（任何布局/核心数下成立）；对核连线主轴（x=0 或 y=0 轴）无阻碍。 */
const OBSTACLE_LAYOUTS_FFA: readonly (readonly (readonly [number, number])[])[] = [
  [[-4, 4], [-4, 5], [4, 4], [4, 5], [-5, -4], [-4, -4], [5, -3], [4, -3]],
  [[4, -4], [4, -5], [-4, -4], [-4, -5], [-5, 4], [-4, 4], [5, 3], [4, 3]],
  [[-5, 3], [-5, 4], [5, -4], [5, -5], [3, 5], [4, 5], [-3, -5], [-4, -5]],
  [[3, -4], [4, -4], [-3, 4], [-4, 4], [-5, -5], [-4, -5], [5, 5], [4, 5]],
  [[-4, 3], [-4, 4], [4, -3], [4, -4], [-3, -4], [-3, -5], [3, 4], [3, 5]],
  [[3, 3], [4, 3], [-3, -3], [-4, -3], [-4, 5], [-5, 5], [4, -5], [5, -5]],
];

/** 1v1 信标位置（M4-2）：官方信标恒在 [0,0]；合成场景双方核心
 *  [0,0]/[30,0] 在 [0,0] 上，信标取圆周几何中心 [15,0]（距两核各 15，
 *  > 视野 5，开局双方均不可见），保持"全场唯一战略目标"语义。 */
const BEACON_POSITION_1V1: readonly [number, number] = [15, 0];

/** 为一方玩家生成初始 worker（id 确定性派生，跨 seed 稳定，满足 canonical UUID）。
 *  playerIndex 参与 id 尾部派生——多玩家场景下同前缀组（worker 前缀仅 5 个）也不会撞。 */
function initialWorkers(
  ownerId: string,
  idPrefix: string,
  playerIndex: number,
  ...positions: readonly (readonly [number, number])[]
): readonly { id: string; position: [number, number]; hp: number; unitType: "WORKER"; cargo: number }[] {
  const base = idPrefix.slice(0, 8);
  return positions.map((position, workerIndex) => {
    const tail = `${String(playerIndex).padStart(6, "0")}${String(workerIndex).padStart(6, "0")}`;
    return {
      id: `${base}-0000-0000-0000-${tail}`,
      position: [position[0], position[1]] as [number, number],
      hp: 2,
      unitType: "WORKER" as const,
      cargo: 0,
    };
  });
}

/** 由一个"玩家位置 + seed 派生资源盘/障碍集"构造 1v1 场景（确定性）。
 *  M4-2：beacon 归位圆周几何中心 [15,0]；M4-4：seed 同源派生障碍集。 */
export function makeArenaScenario(
  playerA: ScenarioPlayerSeed,
  playerB: ScenarioPlayerSeed,
  seed = 1,
): unknown {
  const layoutIndex = Math.abs(seed) % RESOURCE_LAYOUTS.length;
  const layout = RESOURCE_LAYOUTS[layoutIndex];
  return {
    rulesVersion: "v0.14",
    tick: 1,
    seed,
    players: [playerA, playerB],
    terrain: { obstacles: [...OBSTACLE_LAYOUTS[layoutIndex]], resources: [...layout] },
    beacon: { position: [...BEACON_POSITION_1V1], status: "GROUND", carrierId: null },
  };
}

/** 各参与者的核心 id 前缀（第 i 家）——与 runMatch 的 mine/对手 id 保持同族。 */
const CORE_ID_PREFIXES = [
  "491977e4-d3db-417b-8d82-2f5f3b5c8000",
  "9fe0ca6d-53cb-4dd5-a8f8-2e6925f19e70",
  "1c8a4b2e-7f6d-4a3e-9c1b-5d2e8f4a6b7c",
  "6a3f9c1e-2b4d-4e8a-9f3c-7d1e5a8b2c4d",
];

/** 第 i 家初始 worker 的 id 前缀（8 位 hex，跨玩家唯一）。 */
const WORKER_ID_PREFIXES = [
  "22222222", "33333333", "44444444", "55555555",
];

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
  } else if (alive.length > 1) {
    // 多存活（含全员存活）：存活者内资源多优先；平 → 人口多；平 → null。
    // FFA 中间态（部分核心被拆、未到唯一存活）同样按存活阵营资源定胜。
    const sorted = [...alive].sort(
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

/** 1v1 对打默认场景（M4-3：官方起点 5 资源 + 1 初始 worker——rules-v0.14
 *  startingResources=5 / startingWorkerCount=1；worker 位置取原 3 位置首格
 *  [1,0]/[29,0]）。场景 players 与 a/b 的 id 精确一致。 */
export function makeArenaMatchScenario(a: TournEntry, b: TournEntry, seed: number): unknown {
  return makeArenaScenario(
    {
      id: a.id,
      username: a.id,
      resources: 5,
      core: {
        id: "491977e4-d3db-417b-8d82-2f5f3b5c8006",
        position: [0, 0],
        hp: 5,
        shield: 5,
        state: "NORMAL",
        moveDirection: null,
        moveProgress: null,
        moveRequiredTicks: null,
        destination: null,
      },
      units: initialWorkers(a.id, "22222222-2222-2222-2222-2222222222", 0, [1, 0]),
    },
    {
      id: b.id,
      username: b.id,
      resources: 5,
      core: {
        id: "9fe0ca6d-53cb-4dd5-a8f8-2e6925f19e72",
        position: [30, 0],
        hp: 5,
        shield: 5,
        state: "NORMAL",
        moveDirection: null,
        moveProgress: null,
        moveRequiredTicks: null,
        destination: null,
      },
      units: initialWorkers(b.id, "33333333-3333-3333-3333-3333333333", 1, [29, 0]),
    },
    seed,
  );
}

/**
 * 跑一场 1v1 对打，返回规范化结果。内部用 runEpisode + 提供的 PlanProviders。
 * 第三方对手需能 feed 同一 rules/manifest。
 * 场景给双方 1 初始 worker（官方起点 5/1，M4-3）+ refill（4 ticks 官方节奏），
 * 保证对局能发育、有区分度。
 */
export function runMatch(
  a: TournEntry,
  b: TournEntry,
  seed: number,
  ticks: number,
  rulesPath: string,
  opts?: {
    validatePlans?: boolean;
    recordTo?: string;
    /** refill 节奏（近似再生，见 episode.ts）：undefined=4（官方节奏，用户裁决）；
     *  null=关闭；N=每 N tick 补回采空原格。 */
    refillEveryTicks?: number | null;
    /** 自定义场景（真实测绘窗口等）；缺省用 makeArenaScenario 合成布局。
     *  场景 players 必须与 a/b 的 id 一致。 */
    scenario?: unknown;
    /** 程序化场景（W53）：提供即启用——用 makeProceduralMatchScenario 替换
     *  默认手写布局。true = 用 DEFAULT_PROCEDURAL_PARAMS；传入 params 覆盖。
     *  默认关（不改变现有场景行为）；与 scenario 互斥（scenario 优先）。 */
    procedural?: boolean | ProceduralWorldParams;
  },
): MatchResult {
  const refillConfig =
    opts?.refillEveryTicks === undefined
      ? { everyTicks: 4 }
      : opts.refillEveryTicks === null
        ? null
        : { everyTicks: opts.refillEveryTicks };
  // scenario 优先；否则按 procedural 启用程序化场景；缺省 makeArenaMatchScenario。
  const scenario =
    opts?.scenario ??
    (opts?.procedural !== undefined
      ? makeProceduralMatchScenario(
          a.id,
          b.id,
          seed,
          typeof opts.procedural === "boolean" ? DEFAULT_PROCEDURAL_PARAMS : opts.procedural,
        )
      : makeArenaMatchScenario(a, b, seed));
  // build 移入 try：中途抛错时已建 provider 也走 finally close（卫生项，
  // 防 worker/state-slot 泄漏导致进程无法退出）。
  const providers: PlanProvider[] = [];
  const recorder =
    opts?.recordTo === undefined
      ? null
      : createEpisodeRecorder(opts.recordTo, {
          seed,
          rulesVersion: "v0.14",
          rulesPath,
          ticks,
          players: [a.id, b.id],
          descs: { [a.id]: a.desc, [b.id]: b.desc },
          refill: refillConfig ?? undefined,
        });
  try {
    providers.push(a.build(), b.build());
    const result = runEpisode({
      scenario,
      rulesPath,
      seed,
      ticks,
      ...(refillConfig === null ? {} : { refill: refillConfig }),
      tenants: [
        { id: a.id, planner: "safety", plannerConfig: {}, policy: { posture: "aggressive", workerTarget: 8, militaryRatio: 0.4, focusRegion: null, attackPriority: "core" } },
        { id: b.id, planner: "safety", plannerConfig: {}, policy: { posture: "aggressive", workerTarget: 8, militaryRatio: 0.4, focusRegion: null, attackPriority: "core" } },
      ],
      // 关键：注入我们两个条目的 provider，而不是用内置 deterministic/safety
      plannerFactory: (tenant: EpisodeTenant): PlanProvider => (tenant.id === a.id ? providers[0] : providers[1]),
      validatePlans: opts?.validatePlans ?? true,
      onTickRecorded: recorder?.onTickRecorded,
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
  } finally {
    recorder?.close();
    // 对局结束必须释放对手资源（常驻子进程桥：close worker + 清 state-slot），
    // 否则 worker 线程泄漏导致进程无法退出（鸭子类型：非子进程 provider 无 close）。
    for (const provider of providers) {
      const closer = (provider as { close?: () => void }).close;
      if (typeof closer === "function") {
        closer.call(provider);
      }
    }
  }
}

/** N 玩家混战场景：核心均匀分布在圆周（半径 18），各自 1 worker（官方起点
 *  5 资源 + 1 worker，M4-3）+ 近距资源盘。每核资源盘取 RESOURCE_LAYOUTS 前
 *  4 个近距点（±7 内），圆周间距（3 人 ~31、4 人 ~25）远大于盘半径，无跨核
 *  重叠；id 按参与序派生（CORE/WORKER 前缀表）。M4-2：信标归位圆周圆心
 *  [0,0]（半径 18 圆周上所有核心距圆心 18 > 视野 5）；M4-4：seed 同源派生
 *  圆心附近障碍集（OBSTACLE_LAYOUTS_FFA）。 */
export function makeArenaScenarioN(entries: readonly TournEntry[], seed = 1): unknown {
  const n = Math.max(2, entries.length);
  const radius = 18;
  const layoutIndex = Math.abs(seed) % RESOURCE_LAYOUTS.length;
  const layout = RESOURCE_LAYOUTS[layoutIndex].slice(0, 4);
  const obstacles = [...OBSTACLE_LAYOUTS_FFA[layoutIndex]];
  const players = entries.map((entry, index) => {
    const angle = (2 * Math.PI * index) / n - Math.PI / 2;
    const cx = Math.round(radius * Math.cos(angle));
    const cy = Math.round(radius * Math.sin(angle));
    const workers = initialWorkers(
      entry.id,
      `${WORKER_ID_PREFIXES[index % WORKER_ID_PREFIXES.length]}-0000-0000-0000-000000000000`,
      index,
      [cx + 1, cy],
    );
    return {
      id: entry.id,
      username: entry.id,
      resources: 5,
      core: {
        // 前缀表仅 4 项——尾部按参与序派生，n≥5 时也保证全图唯一（防静默覆盖）
        id: `${CORE_ID_PREFIXES[index % CORE_ID_PREFIXES.length].slice(0, 23)}-${String(index).padStart(12, "0")}`,
        position: [cx, cy],
        hp: 5,
        shield: 5,
        state: "NORMAL" as const,
        moveDirection: null,
        moveProgress: null,
        moveRequiredTicks: null,
        destination: null,
      },
      units: workers,
    };
  });
  const resources = players.flatMap((player) => {
    const corePosition = player.core.position as [number, number];
    return layout.map(([dx, dy]) => [corePosition[0] + dx, corePosition[1] + dy] as [number, number]);
  });
  return {
    rulesVersion: "v0.14",
    tick: 1,
    seed,
    players,
    terrain: { obstacles, resources },
    beacon: { position: [0, 0], status: "GROUND", carrierId: null },
  };
}

/**
 * 跑一场 N 玩家混战（N≥2），返回规范化结果。同一场次内所有 entry 共享世界，
 * 多计划同时结算（引擎原生支持）；胜负判定复用 decideWinner（最后存活核心
 * 胜；都存活 → 资源/人口排序）。
 */
export function runFreeForAll(
  entries: readonly TournEntry[],
  seed: number,
  ticks: number,
  rulesPath: string,
  opts?: {
    validatePlans?: boolean;
    recordTo?: string;
    /** refill 节奏（同 runMatch）：undefined=65；null=关闭；N=每 N tick。 */
    refillEveryTicks?: number | null;
    /** 自定义场景；缺省用 makeArenaScenarioN 圆周布局。场景 players 必须与 entries id 一致。 */
    scenario?: unknown;
    /** 程序化场景（W53）：提供即启用——用 makeProceduralScenarioN 替换
     *  默认圆周布局。true = 用 DEFAULT_PROCEDURAL_PARAMS；传入 params 覆盖。
     *  默认关；与 scenario 互斥（scenario 优先）。 */
    procedural?: boolean | ProceduralWorldParams;
  },
): MatchResult {
  const refillConfig =
    opts?.refillEveryTicks === undefined
      ? { everyTicks: 65 }
      : opts.refillEveryTicks === null
        ? null
        : { everyTicks: opts.refillEveryTicks };
  // scenario 优先；否则按 procedural 启用程序化场景；缺省 makeArenaScenarioN。
  const scenario =
    opts?.scenario ??
    (opts?.procedural !== undefined
      ? makeProceduralScenarioN(
          entries.map((entry) => entry.id),
          seed,
          typeof opts.procedural === "boolean" ? DEFAULT_PROCEDURAL_PARAMS : opts.procedural,
        )
      : makeArenaScenarioN(entries, seed));
  const ids = entries.map((entry) => entry.id);
  // build 移入 try：中途抛错时已建 provider 也走 finally close（卫生项同 runMatch）。
  const providers: PlanProvider[] = [];
  const recorder =
    opts?.recordTo === undefined
      ? null
      : createEpisodeRecorder(opts.recordTo, {
          seed,
          rulesVersion: "v0.14",
          rulesPath,
          ticks,
          players: ids,
          descs: Object.fromEntries(entries.map((entry) => [entry.id, entry.desc])),
          refill: refillConfig ?? undefined,
        });
  try {
    for (const entry of entries) providers.push(entry.build());
    const result = runEpisode({
      scenario,
      rulesPath,
      seed,
      ticks,
      ...(refillConfig === null ? {} : { refill: refillConfig }),
      tenants: ids.map((id) => ({
        id,
        planner: "safety" as const,
        plannerConfig: {},
        policy: { posture: "aggressive", workerTarget: 8, militaryRatio: 0.4, focusRegion: null, attackPriority: "core" },
      })),
      // 注入各条目的 provider（按参与序对齐 id）
      plannerFactory: (tenant: EpisodeTenant): PlanProvider => providers[ids.indexOf(tenant.id)],
      validatePlans: opts?.validatePlans ?? true,
      onTickRecorded: recorder?.onTickRecorded,
    } as never);
    const { winner, coreAlive, finalResources, finalPopulation } = decideWinner(
      ids,
      undefined as never,
      result.finalWorld,
    );
    return {
      players: ids,
      winner,
      tick: 0,
      tickCount: ticks,
      coreAlive,
      finalResources,
      finalPopulation,
      eventCount: result.records.reduce((n, r) => n + r.events.length, 0),
    };
  } finally {
    recorder?.close();
    for (const provider of providers) {
      const closer = (provider as { close?: () => void }).close;
      if (typeof closer === "function") {
        closer.call(provider);
      }
    }
  }
}