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
import {
  runEpisode,
  type EpisodeRecord,
  type EpisodeTenant,
  type EpisodeTickMeasurement,
  type PlayerCostLedger,
} from "../../sim/harness/episode.ts";
import { createSeededRng } from "../../sim/deterministic/rng.ts";
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
import { OpponentAdapter } from "./opponent-adapter.ts";
import { BRIDGE_PROJECTION_AUDITED_AGENTS } from "./protocol-bridge.ts";

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
  /** 每玩家五维 cost ledger（arena-bench 评测画像用；无 ledger 场景下可能缺省）。 */
  readonly perPlayerLedgers?: Readonly<Record<string, PlayerCostLedger>>;
  /** 每玩家击杀数（playerId → CORE_DESTROYED 归属数；arena-bench 用，可选）。
   *  归属语义：CORE_DESTROYED 无 actorId，击杀记在 values.destroyed_by
   *  （最终贡献伤害的玩家 username 列表；合成场景 username=playerId，
   *  多贡献者同记一杀）。 */
  readonly perPlayerKills?: Readonly<Record<string, number>>;
  /** 每玩家首杀 tick（playerId → 首个被归属击杀的 tick；无击杀缺省）。 */
  readonly perPlayerFirstKillTicks?: Readonly<Record<string, number>>;
  /** 逐击杀事件（tick 升序；arena-bench v3.1 击杀时序可视化用，可选）。
   *  语义同 perPlayerKills 的 destroyed_by 归属。 */
  readonly killEvents?: readonly KillEvent[];
  /** per-tick 资源/人口采样（每 50 tick 一点；arena-bench v3.1 效率曲线可视化用，可选）。
   *  数据来自 episode onTickSettled 回调（resources = 玩家当前资源，population = 全部单位数）。 */
  readonly perTickSamples?: readonly PerTickSample[];
}

/** 单个 per-tick 采样点（效率曲线数据源）。 */
export interface PerTickSample {
  readonly tick: number;
  /** playerId → 该 tick 的资源 + 人口快照。 */
  readonly players: Readonly<Record<string, { readonly resources: number; readonly population: number }>>;
}

/** 单次核心摧毁事件（击杀时序图数据源）。 */
export interface KillEvent {
  readonly tick: number;
  readonly destroyedBy: readonly string[];
  /** 被摧毁核心的归属玩家 id（core id 尾部参与序反推；无法解析时缺省）。 */
  readonly victim?: string;
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

/**
 * 对抗平台唯一 refill 解析口：默认严格跟随官方 v0.14 的 4 resolved ticks。
 * null 仅用于显式关闭的诊断实验；其他值必须为正整数。
 */
export function resolveTournamentRefillConfig(
  everyTicks: number | null | undefined,
): Readonly<{ everyTicks: number }> | null {
  if (everyTicks === null) return null;
  const resolved = everyTicks ?? 4;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`refillEveryTicks must be a positive safe integer or null (got ${String(everyTicks)})`);
  }
  return Object.freeze({ everyTicks: resolved });
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

/** 计算一个 match 的胜者：核心存活优先；都活 → 击杀多（v3：与榜单排名判定
 *  统一，审计 bench-fairness-audit §1.4）；再 → 累计存款 deposited（v3 排名
 *  链同款 tie-break，审计 §6.4）；再 → 资源多；再 → 人口多；仍平 → null。 */
export function decideWinner(
  players: readonly string[],
  before: SimWorld,
  after: SimWorld,
  kills?: Readonly<Record<string, number>>,
  deposited?: Readonly<Record<string, number>>,
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
    // 多存活（含全员存活）：存活者内击杀多优先；平 → 累计存款；平 → 资源；
    // 平 → 人口；全平 → null（与 run-arena-report rankMatchPlayers 同链）。
    const killOf = (player: string): number => kills?.[player] ?? 0;
    const depositedOf = (player: string): number => deposited?.[player] ?? 0;
    const sorted = [...alive].sort(
      (a, b) =>
        killOf(b) - killOf(a) ||
        depositedOf(b) - depositedOf(a) ||
        finalResources[b] - finalResources[a] ||
        finalPopulation[b] - finalPopulation[a],
    );
    const top = sorted[0];
    const second = sorted[1];
    if (
      killOf(top) !== killOf(second) ||
      depositedOf(top) !== depositedOf(second) ||
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
    /** P4g 决策流水线（2026-08-09）：透传到 episode（默认关 = 现有行为）。 */
    pipeline?: boolean;
  },
): MatchResult {
  const refillConfig = resolveTournamentRefillConfig(opts?.refillEveryTicks);
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
      pipeline: opts?.pipeline === true,
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
      // arena-bench 五维画像：从 EpisodeResult.metrics.perPlayer 透传（可选字段，向后兼容）
      perPlayerLedgers: result.metrics.perPlayer,
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

/** makeArenaScenarioN 布局旋钮（全部可选；缺省 = 既有 FFA 布局，逐字节不变）。 */
export interface ArenaScenarioNOptions {
  /** 核心圆周半径；缺省 18（既有 FFA 布局）。大地图：30/40（8+ 玩家）。
   *  信标恒在圆心 [0,0]；资源盘/障碍集按 radius/18 同源缩放（radius 18 恒等）。 */
  readonly radius?: number;
  /** 显式指定资源盘/障碍集变体序号（0-based，与 seed 派生同源）；缺省 seed % 变体数。 */
  readonly resourceLayoutIndex?: number;
  /** 随机投放：seed 派生起始角旋转 + 参与序洗牌（确定性——同 seed 恒同场景）。
   *  缺省不启用——保持固定 -π/2 起始角、按参与序落位的既有确定性布局。 */
  readonly randomDrop?: { readonly seed: number };
}

/** 按半径缩放 FFA 障碍块（保持 1×2/2×1 块结构：每对首格取整、尾格 = 首格 +
 *  原始单位增量，任意 scale 下块内相邻性不破）。scale=1（radius 18）时恒等。
 *  障碍块始终留在圆心附近（|x|+|y| ≤ 10·scale+1），核心在半径 18·scale 圆周
 *  ——任何 scale 下距核心 Manhattan ≥ 8·scale-1 > 3，不压核心。 */
function scaleObstacleBlocks(
  cells: readonly (readonly [number, number])[],
  scale: number,
): [number, number][] {
  const scaled: [number, number][] = [];
  for (let i = 0; i < cells.length; i += 2) {
    const anchor = cells[i];
    const partner = cells[i + 1];
    const sx = Math.round(anchor[0] * scale);
    const sy = Math.round(anchor[1] * scale);
    scaled.push([sx, sy], [sx + partner[0] - anchor[0], sy + partner[1] - anchor[1]]);
  }
  return scaled;
}

/** 随机投放布局：无 randomDrop 时返回恒等序 + 零旋转（与既有布局逐字节一致）；
 *  启用时用 randomDrop.seed 派生全局旋转角 + Fisher–Yates 参与序洗牌
 *  （createSeededRng/mulberry32——同 seed 恒同场景）。 */
function resolveDropArrangement(
  randomDropSeed: number | undefined,
  n: number,
): { readonly angleOffset: number; readonly order: readonly number[] } {
  const order = Array.from({ length: n }, (_, i) => i);
  if (randomDropSeed === undefined) {
    return { angleOffset: 0, order };
  }
  const rng = createSeededRng(randomDropSeed);
  const angleOffset = rng.next() * 2 * Math.PI;
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(rng.next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { angleOffset, order };
}

/** N 玩家混战场景：核心均匀分布在圆周（radius 参数化，缺省 18），各自 1 worker
 *  （官方起点 5 资源 + 1 worker，M4-3）+ 近距资源盘（随 radius 缩放）。每核资源盘
 *  取 RESOURCE_LAYOUTS 前 4 个近距点（radius 18 时 ±7 内），圆周间距（3 人 ~31、
 *  4 人 ~25）远大于盘半径，无跨核重叠；id 按参与序派生（CORE/WORKER 前缀表 +
 *  尾部 index——任意 n 全图唯一）。M4-2：信标归位圆周圆心 [0,0]（所有核心距圆心
 *  = radius > 视野 5）；M4-4：seed 同源派生圆心附近障碍集（OBSTACLE_LAYOUTS_FFA，
 *  随 radius 缩放、保持 1×2/2×1 块结构，永不压核心）。randomDrop 启用时起始角与
 *  参与序由 seed 派生（随机投放，确定性）。 */
export function makeArenaScenarioN(
  entries: readonly TournEntry[],
  seed = 1,
  options?: ArenaScenarioNOptions,
): unknown {
  const n = Math.max(2, entries.length);
  // radius 缺省 18 = 既有布局；障碍/资源盘按 radius/18 同源缩放（radius 18 时恒等）
  const radius = options?.radius ?? 18;
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new Error(`makeArenaScenarioN radius must be a positive finite number (got ${String(radius)})`);
  }
  const scale = radius / 18;
  const rawLayoutIndex = options?.resourceLayoutIndex ?? Math.abs(seed) % RESOURCE_LAYOUTS.length;
  const layoutIndex = ((rawLayoutIndex % RESOURCE_LAYOUTS.length) + RESOURCE_LAYOUTS.length) % RESOURCE_LAYOUTS.length;
  const layout = RESOURCE_LAYOUTS[layoutIndex].slice(0, 4);
  const obstacles = scaleObstacleBlocks(OBSTACLE_LAYOUTS_FFA[layoutIndex], scale);
  const { angleOffset, order } = resolveDropArrangement(options?.randomDrop?.seed, n);
  const players = order.map((entryIndex, slot) => {
    const entry = entries[entryIndex];
    const angle = (2 * Math.PI * slot) / n - Math.PI / 2 + angleOffset;
    const cx = Math.round(radius * Math.cos(angle));
    const cy = Math.round(radius * Math.sin(angle));
    const workers = initialWorkers(
      entry.id,
      `${WORKER_ID_PREFIXES[entryIndex % WORKER_ID_PREFIXES.length]}-0000-0000-0000-000000000000`,
      entryIndex,
      [cx + 1, cy],
    );
    return {
      id: entry.id,
      username: entry.id,
      resources: 5,
      core: {
        // 前缀表仅 4 项——尾部按参与序 12 位派生，任意 n（<10^12）也保证全图唯一
        id: `${CORE_ID_PREFIXES[entryIndex % CORE_ID_PREFIXES.length].slice(0, 23)}-${String(entryIndex).padStart(12, "0")}`,
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
    return layout.map(([dx, dy]) => [
      corePosition[0] + Math.round(dx * scale),
      corePosition[1] + Math.round(dy * scale),
    ] as [number, number]);
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
 * 从 EpisodeResult.records 事件统计 CORE_DESTROYED 击杀归属。
 *
 * CORE_DESTROYED 事件结构（sim/engine/combat.ts）：无 actorId——击杀归属
 * 在 values.destroyed_by（最终贡献伤害的玩家 username 列表）。合成场景
 * username=playerId（makeArenaScenarioN/makeArenaMatchScenario 均如此），
 * 故按 destroyed_by 直接归到玩家 id；多贡献者同记一杀，无贡献者不记
 * （perPlayerKills 之和可能小于全场 CORE_DESTROYED 数，调用方按需注明）。
 */
function computePerPlayerKills(
  records: readonly EpisodeRecord[],
  playerIds: readonly string[],
): { readonly kills: Readonly<Record<string, number>>; readonly firstKillTicks: Readonly<Record<string, number>> } {
  const playerSet = new Set(playerIds);
  const kills: Record<string, number> = {};
  const firstKillTicks: Record<string, number> = {};
  for (const playerId of playerIds) {
    kills[playerId] = 0;
  }
  for (const record of records) {
    for (const event of record.events) {
      if (event.eventType !== "CORE_DESTROYED") continue;
      const destroyedBy = event.values?.destroyed_by;
      if (!Array.isArray(destroyedBy)) continue;
      for (const rawUsername of destroyedBy) {
        if (typeof rawUsername !== "string" || !playerSet.has(rawUsername)) continue;        kills[rawUsername] += 1;
        if (firstKillTicks[rawUsername] === undefined) {
          firstKillTicks[rawUsername] = record.tick;
        }
      }
    }
  }
  return { kills, firstKillTicks };
}

/**
 * 跑一场 N 玩家混战（N≥2），返回规范化结果。同一场次内所有 entry 共享世界，
 * 多计划同时结算（引擎原生支持）；胜负判定复用 decideWinner（最后存活核心
 * 胜；都存活 → 资源/人口排序）。
 */
function collectKillEvents(
  records: readonly EpisodeRecord[],
  playerIds: readonly string[],
  coreIdToPlayer?: ReadonlyMap<string, string>,
): readonly KillEvent[] {
  const playerSet = new Set(playerIds);
  const events: KillEvent[] = [];
  for (const record of records) {
    for (const event of record.events) {
      if (event.eventType !== "CORE_DESTROYED") continue;
      const destroyedBy = event.values?.destroyed_by;
      if (!Array.isArray(destroyedBy)) continue;
      const contributors = destroyedBy.filter(
        (raw): raw is string => typeof raw === "string" && playerSet.has(raw),
      );
      if (contributors.length === 0) continue;
      const targetId = typeof event.targetId === "string" ? event.targetId : null;
      const victim =
        targetId !== null && coreIdToPlayer !== undefined ? coreIdToPlayer.get(targetId) : undefined;
      events.push({
        tick: record.tick,
        destroyedBy: contributors,
        ...(victim !== undefined ? { victim } : {}),
      });
    }
  }
  return events;
}

export function runFreeForAll(
  entries: readonly TournEntry[],
  seed: number,
  ticks: number,
  rulesPath: string,
  opts?: {
    validatePlans?: boolean;
    recordTo?: string;
    /** refill 节奏（同 runMatch）：undefined=4（官方 v0.14 节奏）；null=关闭；N=每 N tick。 */
    refillEveryTicks?: number | null;
    /** 自定义场景；缺省用 makeArenaScenarioN 圆周布局。场景 players 必须与 entries id 一致。 */
    scenario?: unknown;
    /** 程序化场景（W53）：提供即启用——用 makeProceduralScenarioN 替换
     *  默认圆周布局。true = 用 DEFAULT_PROCEDURAL_PARAMS；传入 params 覆盖。
     *  默认关；与 scenario 互斥（scenario 优先）。 */
    procedural?: boolean | ProceduralWorldParams;
    /** makeArenaScenarioN 布局旋钮（radius / resourceLayoutIndex / randomDrop）；
     *  仅缺省合成场景路径（未给 scenario/procedural 时）生效。 */
    arenaScenarioOptions?: ArenaScenarioNOptions;
    /** P4g 决策流水线（2026-08-09）：透传到 episode（默认关 = 现有行为）。 */
    pipeline?: boolean;
    /** R2 桥状态投影（2026-08-09）：对字段读取已审计的 Python 对手逐 agent
     *  启用状态投影（只序列化并集字段的非空值；默认关 = 现状逐字节一致）。
     *  白名单见 BRIDGE_PROJECTION_AUDITED_AGENTS——未审计的第三方/HTTP 端点
     *  与审计中发现动态读字段的 agent 不投影。 */
    bridgeProjection?: boolean;
  },
): MatchResult {
  const refillConfig = resolveTournamentRefillConfig(opts?.refillEveryTicks);
  // scenario 优先；否则按 procedural 启用程序化场景；缺省 makeArenaScenarioN。
  const scenario =
    opts?.scenario ??
    (opts?.procedural !== undefined
      ? makeProceduralScenarioN(
          entries.map((entry) => entry.id),
          seed,
          typeof opts.procedural === "boolean" ? DEFAULT_PROCEDURAL_PARAMS : opts.procedural,
        )
      : makeArenaScenarioN(entries, seed, opts?.arenaScenarioOptions));
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
    // R2 桥状态投影：只对白名单内（字段读取已审计）的 OpponentAdapter 启用；
    // 未审计第三方/HTTP 端点与审计中动态读字段的 agent 不投影（默认关）。
    if (opts?.bridgeProjection === true) {
      for (const provider of providers) {
        if (
          provider instanceof OpponentAdapter &&
          BRIDGE_PROJECTION_AUDITED_AGENTS.has(provider.label)
        ) {
          provider.setProjection(true);
        }
      }
    }
    const perTickSamples: PerTickSample[] = [];
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
      // arena-bench v3.1 可观测性：每 50 tick 采样 per-player 资源/人口（效率曲线数据源）
      onTickSettled: (measurement: EpisodeTickMeasurement) => {
        if (measurement.tick > 0 && measurement.tick % 50 === 0) {
          const players: Record<string, { resources: number; population: number }> = {};
          for (const player of measurement.players) {
            players[player.playerId] = { resources: player.resources, population: player.population };
          }
          perTickSamples.push(Object.freeze({ tick: measurement.tick, players: Object.freeze(players) }));
        }
      },
      pipeline: opts?.pipeline === true,
    } as never);
    const { kills, firstKillTicks } = computePerPlayerKills(result.records, ids);
    // deposited tie-break 与排名链同款（v3 §2/审计 §6.4）：metrics.perPlayer 为
    // per-player cost ledger（含 deposited 累计存款）
    const depositedByPlayer = Object.fromEntries(
      Object.entries(result.metrics.perPlayer).map(([playerId, ledger]) => [
        playerId,
        ledger.deposited,
      ]),
    );
    const { winner, coreAlive, finalResources, finalPopulation } = decideWinner(
      ids,
      undefined as never,
      result.finalWorld,
      kills,
      depositedByPlayer,
    );
    // core id → player id 映射（合成场景 core id 尾部 = 参与序，username = playerId）
    const scenarioPlayers = (scenario as { readonly players?: readonly { readonly core?: { readonly id?: string }; readonly username?: string }[] }).players ?? [];
    const coreIdToPlayer = new Map<string, string>();
    for (const player of scenarioPlayers) {
      if (typeof player.core?.id === "string" && typeof player.username === "string") {
        coreIdToPlayer.set(player.core.id, player.username);
      }
    }
    return {
      players: ids,
      winner,
      tick: 0,
      tickCount: ticks,
      coreAlive,
      finalResources,
      finalPopulation,
      eventCount: result.records.reduce((n, r) => n + r.events.length, 0),
      // arena-bench 五维画像：从 EpisodeResult.metrics.perPlayer 透传（可选字段，向后兼容）
      perPlayerLedgers: result.metrics.perPlayer,
      // arena-bench 击杀归属：CORE_DESTROYED values.destroyed_by（可选字段，向后兼容）
      perPlayerKills: kills,
      perPlayerFirstKillTicks: firstKillTicks,
      // arena-bench v3.1 击杀时序：逐事件（tick + 归属者 + victim），可视化用（可选字段）
      killEvents: collectKillEvents(result.records, ids, coreIdToPlayer),
      // arena-bench v3.1 效率曲线：每 50 tick 采样 per-player 资源/人口（可选字段）
      perTickSamples: perTickSamples.length > 0 ? perTickSamples : undefined,
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