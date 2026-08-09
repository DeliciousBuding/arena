/**
 * Planner 闭环 harness（S7）：现有 deterministic/safety Planner 在模拟器上连续运行。
 *
 * SimWorld → private observation → reduceTurn → Planner.decide → validatePlan →
 * settleTick → per-tenant previous-tick events → next observation。
 */

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Plan, TickState } from "../../domain/model.ts";
import { validatePlan, type ValidationResult } from "../../domain/plan-validator.ts";
import { reduceTurn, type TurnLike } from "../../domain/state-reducer.ts";
import { DeterministicPlanner } from "../../planning/deterministic-planner.ts";
import type { PlanProvider } from "../../runtime/decision-types.ts";
import type { MacroPolicy } from "../../runtime/macro-policy.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner, type SafetyPlannerConfig } from "../../strategies/safety-planner.ts";
import { loadRulesManifest, type RulesManifest } from "../contracts/rules-manifest.ts";
import { createSeededRng } from "../deterministic/rng.ts";
import { compareCodeUnit } from "../deterministic/uuid.ts";
import { EVENT_CATEGORY_TYPES } from "../engine/phase.ts";
import type { EventCategoryId, EventType, ResolutionEvent, UnknownEffect } from "../engine/phase.ts";
import { initialChunkKeys } from "../engine/refill.ts";
import { settleTick, type SettlementContext } from "../engine/settlement.ts";
import { privateEventsForPlayer } from "../visibility/private-events.ts";
import { simTurnLike } from "../visibility/visibility.ts";
import { worldHash } from "../world/canonical.ts";
import { worldFromScenario } from "../world/loaders.ts";
import type { SimFeature, SimWorld } from "../world/types.ts";
import { assertWorldInvariants } from "../world/world.ts";
import type { SimTelemetrySink } from "../telemetry.ts";

export type PlannerKind = "deterministic" | "safety";

export interface EpisodeTenant {
  readonly id: string;
  readonly planner: PlannerKind;
  /** 低频 MacroPolicy（策略扫描/实验用）：注入后 planner.decide 携带 policy，
   *  支持 militaryRatio/workerTarget 网格的离线验证（v0.2.12）。缺省不传，
   *  与旧行为逐字节一致。 */
  readonly policy?: MacroPolicy;
  /** SafetyPlanner 配置覆盖（实验用，如 vanguardRatio 配比；缺省 = DEFAULT_SAFETY_CONFIG）。 */
  readonly plannerConfig?: Partial<SafetyPlannerConfig>;
}

export interface EpisodeTickPlayerMeasurement {
  readonly playerId: string;
  readonly resources: number;
  readonly population: number;
}

/**
 * W51 per-player cost ledger：从 settlement 事件流累计的经济/战斗账本。
 * 字段对齐 arena-evolve fitness._detail_of / _agg_from 的 key 集合，使
 * fitness.ts 可直接从 EpisodeResult.metrics.perPlayer 派生 detail dict。
 *
 * 累计来源（events + per-tick world 快照）：
 * - harvested   ← HARVEST_SUCCEEDED.amount + BEACON_HARVEST_BONUS.amount
 * - deposited   ← DEPOSIT_SUCCEEDED.amount
 * - damageDealt ← SHOT_HIT.damage（attacker 归属；sweep 不计，baseline 限制）
 * - beaconTicks ← 每 tick after.beacon.status==CARRIED 且 carrierId 属本玩家
 * - respawnCount← CORE_RESPAWNED.targetId 属本玩家
 * - unitsLost   ← UNIT_DAMAGED(hp==0) + UNIT_SELF_DESTRUCTED（targetId/actorId 归属）
 * - healCost    ← CORE_HEAL_SUCCEEDED.cost + UNIT_HEAL_SUCCEEDED.cost
 * - repairCost  ← CORE_REPAIR_SUCCEEDED.cost
 * - spawnCost   ← CORE_SPAWN_SUCCEEDED.cost
 * - overflowDestroyed ← CORE_RESOURCE_OVERFLOW_DESTROYED.amount
 * - resourcesLost    ← CORE_RESOURCES_CAPTURED.available + CORE_RESOURCES_DESTROYED.amount
 * - finalPopulation  ← finalWorld 玩家单位数
 * - finalResources   ← finalWorld 玩家资源
 * - aliveTicks  ← 每 tick after.core!==null 计 1（与 reference ticks_alive 同语义）
 * - populationPeak   ← 每 tick after 玩家单位数的最大值（arena-bench 扩张力指标）
 *
 * 默认追加：不破坏现有 metrics 字段；现有消费者读 ticks/illegalPlans 等不受影响。
 */
export interface PlayerCostLedger {
  readonly harvested: number;
  readonly deposited: number;
  readonly damageDealt: number;
  readonly beaconTicks: number;
  readonly respawnCount: number;
  readonly unitsLost: number;
  readonly healCost: number;
  readonly repairCost: number;
  readonly spawnCost: number;
  readonly overflowDestroyed: number;
  readonly resourcesLost: number;
  readonly finalPopulation: number;
  readonly finalResources: number;
  readonly aliveTicks: number;
  /** 每 tick 玩家单位数的最大值（arena-bench 扩张力指标；恒 ≥ 0）。 */
  readonly populationPeak: number;
  /** 注册表类别聚合计数（movement/combat/economy/beacon/respawn）；
   *  新增事件类型加入 EVENT_CATEGORY_TYPES 后自动被统计（P4h）。 */
  readonly eventCounts: Readonly<Record<EventCategoryId, number>>;
  /** 未识别事件计数（事件类型不在注册表内；eventOf 已校验，正常恒为 0）。 */
  readonly unrecognizedEventCount: number;
  /** P4e 决策超时次数（每 tick 超预算被丢弃的 decide 次数；未启用恒 0）。 */
  readonly decisionTimeouts: number;
}

export interface EpisodeTickMeasurement {
  /** Tick that was just settled. */
  readonly tick: number;
  /** Decision + validation + settlement wall time; observer callback time is excluded. */
  readonly wallMs: number;
  readonly players: readonly EpisodeTickPlayerMeasurement[];
}

export interface EpisodeConfig {
  /** worldFromScenario 输入；config.seed 会覆盖 scenario.seed，避免双 seed 语义。 */
  readonly scenario: unknown;
  readonly rulesPath: string;
  readonly seed: number;
  readonly ticks: number;
  /** 必须与 scenario players 一一对应；缺失/重复/额外 tenant 均 fail closed。 */
  readonly tenants: readonly EpisodeTenant[];
  /** 每 tick 策略决策器（模拟 LLM 低频决策/坏焦点模式；返回 null = 保持上次）。
   *  缺省用 tenant.policy 固定值。recovery/discipline 链由调用方在 provider 内组装
   *  （模拟级验证生产指挥机制）。tick 为游戏 tick（1-based）。 */
  readonly policyProvider?: (tenantId: string, tick: number, state: TickState) => MacroPolicy | null;
  /**
   * refill（实验可选；默认 undefined = 不实现官方 refill，保持
   * unknown-by-design）：按 cadence 执行官方 chunk-quota 空槽模型
   * （逆向实证定案，2026-08-08——官方 refill placement seed 是
   * server-secret，本配置用自洽确定性随机空槽，行为等价；unknown note
   * 保留 unknown 标注，不混淆为 MATCH）。
   */
  readonly refill?: { readonly everyTicks?: number };
  readonly validatePlans?: boolean;
  /** 测试/实验注入；默认复用线上 DeterministicPlanner/SafetyPlanner。 */
  readonly plannerFactory?: (tenant: EpisodeTenant) => PlanProvider;
  /**
   * 手操覆盖注入（2026-08-07）：模拟服务器侧 Manual > Agent 合并——人类
   * 玩家在同一租户槽位手操时，其 MANUAL 命令按单位覆盖本机 AGENT 计划，
   * 本机 planner 看不到覆盖结果，只能从下一 tick 的权威状态自动对齐。
   * 返回的计划直接送入 settlement（即"合并后的真实执行计划"）；返回
   * null/undefined = 不覆盖（与服务器纯 AGENT 提交等价）。
   */
  readonly manualOverrideProvider?: (
    tenantId: string,
    tick: number,
    state: TickState,
    proposed: Plan,
  ) => Plan | null | undefined;
  /** Optional read-only performance observer; never participates in simulation semantics. */
  readonly onTickSettled?: (measurement: EpisodeTickMeasurement) => void;
  /**
   * Alliance 前置钩子（2026-08-08）：在每 tick 的 per-tenant planner 循环前调用，
   * 传入 settling 前的完整 SimWorld。供 alliance 层采集 member reports 和
   * 触发 director replan（director 必须在 tenant planner 前运行以注入 directive）。
   * 只读回调，不参与模拟语义。
   */
  readonly onBeforePlanners?: (args: {
    readonly tick: number;
    readonly world: SimWorld;
    readonly rules: RulesManifest;
  }) => void;
  /** 模拟器遥测（2026-08-09，agent-telemetry-bridge-v1 §3.4）：每 tick
   *  per-tenant 结算后上报 tick_summary（复用 SDK tickSummary 契约，经调用方
   *  run-sim 注入的 sink 走同一 ingest 端点）。返回 null = 该 tenant 不上报。
   *  只读，不参与模拟语义。 */
  readonly telemetrySinkFor?: (tenantId: string) => SimTelemetrySink | null;
  /** Synthetic calibration 记录钩子（2026-08-07）：每 tick 结算后回调
   *  before/after 世界 + plans + events——synthetic 对打数据管道用
   *  （projectPlayerState 生成官方格式 calibration case）。只读，不参与
   *  模拟语义。 */
  readonly onTickRecorded?: (args: {
    readonly tick: number;
    readonly before: SimWorld;
    readonly after: SimWorld;
    readonly plans: Readonly<Record<string, Plan>>;
    readonly events: readonly ResolutionEvent[];
  }) => void;
  /** Slot 轮换（W54，2026-08-09）：缺省 false = 历史行为零回归。true 时
   *  按 rotatedSlot = (mySlot + seed) % numPlayers 循环移位 id-sorted tenants，
   *  使被测者（mySlot 指向 id-sorted tenants 中被测者的 index）移到 array
   *  index rotatedSlot，对齐 scenario players[] 的站点序（site 0..n-1）。
   *  不变量保持：id 集合不变（validateConfig 仍过）；privateEventsForPlayer
   *  按 playerId 过滤（与 array 顺序无关）。调用方需把 scenario players[]
   *  按站点序构造（被测者在 site rotatedSlot）。 */
  readonly rotateSlot?: boolean;
  /** 被测者在 id-sorted tenants 中的 index（slot 轮换用）。缺省 0。
   *  仅当 rotateSlot=true 时读取。 */
  readonly mySlot?: number;
  /**
   * P4e per-tick 决策预算护栏（agent-ecosystem P4e，2026-08-09）：
   * 单 tick 决策预算（ms）。planner.decide 耗时超过预算时丢弃本次结果，
   * 本 tick 重放该 tenant 上次执行计划（lastPlan 语义；无上次计划用空计划
   * WAIT），并计入 per-player 指标 decisionTimeouts（EpisodeRecord +
   * PlayerCostLedger + summarizeEpisode）。连续超时达 decisionBudgetStrikes
   * 次后跳过该 tenant 后续 decide（直接空计划，记录在
   * EpisodeRecord.decisionTimeoutSkipped）。
   *
   * JS 无法强杀同步函数——护栏语义 = 丢弃 + 降级 + 指标，不中断循环；
   * 慢 planner 仍会占满本 tick 的墙钟时间，只是结果不再进入 settlement。
   * 缺省 undefined = 不启用（与历史行为逐字节一致）；sim-server 服务模式
   * 启用时传 200。
   */
  readonly decisionBudgetMs?: number;
  /** P4e 连续超时阈值（缺省 3）：连续超预算 N 次后跳过该 tenant 后续 decide。 */
  readonly decisionBudgetStrikes?: number;
  /**
   * P4f early-stop 护栏（agent-ecosystem P4f，2026-08-09）：缺省 false =
   * 历史行为零回归（固定跑满 config.ticks）。true 时每 tick 结算后检查存活
   * 玩家数（有 Core/单位/ACTIVE 者），存活数为 0 → 提前终止
   * （metrics.endedEarly/endReason/endedAtTick），后续 tick 不跑。
   * 只省资源，不判胜负（官方"无终局"语义保持）。
   */
  readonly earlyStop?: boolean;
  /**
   * P4g 决策流水线（2026-08-09，性能优化）：缺省 false = 现有行为逐字节不变
   * （主线程每 tick 同步等待每个 tenant 的桥决策，Atomics.wait 空闲）。
   * true 时：tick N 结算完成后用结算后世界（= tick N+1 的 before 世界）提前
   * 发起每个 tenant 的观察+决策（PlanProvider.prefetch 异步不阻塞——持久桥
   * 在 worker 线程/独立 Python 进程并行决策，主线程继续做记录/账本），
   * tick N+1 开始时 decideCached 取结果（桥已完成时等待≈0；未完成则等待——
   * 保底逻辑）→ validatePlan → settleTick → 记录。决策与结算重叠，消除主
   * 线程每 tick 同步等待桥决策的空闲。
   *
   * 语义：决策基于结算后世界（与串行模式同一观察，逐字节同结果——对
   * 持久桥请求序列不变、对内置 planner 调用序列不变）；时间点前移一个
   * tick 窗口，对启发式策略几乎无感。不实现 prefetch/decideCached 的
   * provider 在本模式下退回同步 decide（混合流水线，行为不变）。
   */
  readonly pipeline?: boolean;
}

/**
 * Arbitrary-state rollout entrypoint for counterfactual evaluation.
 * Callers provide a complete SimWorld; private-observation completion stays a
 * separate explicit adapter whose assumptions are recorded in q-sample provenance.
 */
export interface EpisodeFromWorldConfig extends Omit<EpisodeConfig, "scenario"> {
  readonly initialWorld: SimWorld;
}

export interface ValidationSummary {
  readonly valid: boolean;
  readonly repaired: boolean;
  readonly issueCount: number;
}

export interface EpisodeRecord {
  readonly tick: number;
  /** tenantId → 实际送入 settlement 的完整计划。 */
  readonly plans: Readonly<Record<string, Plan>>;
  readonly planHashes: Readonly<Record<string, string>>;
  readonly validations: Readonly<Record<string, ValidationSummary>>;
  readonly aggregatePlanHash: string;
  readonly events: readonly ResolutionEvent[];
  readonly unsupported: readonly SimFeature[];
  readonly unknownEffects: readonly UnknownEffect[];
  /** P4e 本 tick 决策超时次数（tenantId → 次数，0/1 per tenant per tick；
   *  未启用决策预算时恒为空对象）。 */
  readonly decisionTimeouts: Readonly<Record<string, number>>;
  /** P4e 本 tick 因连续超时达标被跳过 decide 的 tenant（直接提交空计划 WAIT）。
   *  未启用决策预算时恒为空数组。 */
  readonly decisionTimeoutSkipped: readonly string[];
  /** 2026-08-10 sim 死锁检测：本 tick 失败事件按 eventType 计数。
   *  失败事件 = SHOT_MISSED/UNIT_MOVE_FAILED/CELL_UNIT_LIMIT/
   *  CORE_SPAWN_FAILED/CORE_MOVE_START_FAILED/DEPOSIT_FAILED 等。
   *  供 episode 级多 tick 失败连续计数（maxFailureStreak）检测死锁模式。 */
  readonly failedEventCounts: Readonly<Record<string, number>>;
}

export interface EpisodeResult {
  readonly finalWorld: SimWorld;
  readonly finalWorldHash: string;
  readonly records: readonly EpisodeRecord[];
  readonly metrics: {
    /** 实际结算 tick 数（early-stop 触发时 < config.ticks；否则 === config.ticks）。 */
    readonly ticks: number;
    readonly illegalPlans: number;
    readonly repairedPlans: number;
    readonly unsupported: readonly string[];
    readonly totalEvents: number;
    readonly wallMs: number;
    /**
     * W51 per-player cost ledger（追加字段，不破坏现有字段）。从 settlement
     * 事件流 + per-tick world 快照累计，供 fitness.ts 派生 fitness detail。
     * 现有消费者读 ticks/illegalPlans 等不受影响（默认关 = 仅追加，不改既有语义）。
     */
    readonly perPlayer: Readonly<Record<string, PlayerCostLedger>>;
    /** P4f 是否提前终止（early-stop；缺省 earlyStop=false 恒 false）。 */
    readonly endedEarly: boolean;
    /** P4f 提前终止原因（null = 未提前终止；当前只有 "all-dead"）。 */
    readonly endReason: "all-dead" | null;
    /** P4f 提前终止时的最后结算 tick（null = 未提前终止）。 */
    readonly endedAtTick: number | null;
  };
}

function createPlanner(kind: PlannerKind, tenant: EpisodeTenant): PlanProvider {
  const safetyConfig = { ...DEFAULT_SAFETY_CONFIG, ...tenant.plannerConfig };
  if (kind === "deterministic") {
    return new DeterministicPlanner(
      undefined,
      new SafetyPlanner(safetyConfig),
      new SafetyPlanner(safetyConfig),
      tenant.plannerConfig?.vanguardRatio,
      tenant.plannerConfig?.accumulateThreshold ?? 0,
    );
  }
  return new SafetyPlanner(safetyConfig);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(compareCodeUnit)) {
    output[key] = canonicalize(source[key]);
  }
  return output;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashPlan(plan: Plan): string {
  return createHash("sha256").update(canonicalJson(plan)).digest("hex");
}

function hashPlanSet(plans: Readonly<Record<string, Plan>>): string {
  return createHash("sha256").update(canonicalJson(plans)).digest("hex");
}

/** 2026-08-10 sim 死锁检测：失败事件类型集合（从 EVENT_CATEGORY_TYPES
 *  的各类别 *_FAILED + SHOT_MISSED 提取）。这些是生产 outcome.jsonl 中
 *  反复出现的浪费动作/死锁信号——sim episode 级多 tick 连续计数
 *  （maxFailureStreak）可检测生产实证的死锁模式。 */
const FAILED_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  "SHOT_MISSED",
  "UNIT_MOVE_FAILED",
  "CORE_MOVE_FAILED",
  "CORE_MOVE_START_FAILED",
  "CORE_ACTION_FAILED",
  "HARVEST_FAILED",
  "DEPOSIT_FAILED",
  "CORE_SPAWN_FAILED",
  "UNIT_HEAL_FAILED",
  "CORE_HEAL_FAILED",
]);

/** 从结算事件流提取失败事件计数（eventType → count）。
 *  纯函数，供 EpisodeRecord.failedEventCounts 消费 + sim-server 复用。 */
export function countFailedEvents(events: readonly ResolutionEvent[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (!FAILED_EVENT_TYPES.has(event.eventType)) continue;
    counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
  }
  return counts;
}

/** Episode 级多 tick 失败连续计数：返回每个失败事件类型的最大连续 tick 数。
 *  用途：sim 测试断言"某失败类型连续不超过 N tick"——检测死锁模式
 *  （如 SHOT_MISSED 连续 16+ tick = 空枪螺旋；CELL_UNIT_LIMIT 连续 16+ = 互堵）。
 *  纯函数，供测试/分析消费。 */
export function maxFailureStreak(
  records: readonly EpisodeRecord[],
): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  const current: Record<string, number> = {};
  for (const record of records) {
    const failedTypes = new Set(Object.keys(record.failedEventCounts));
    for (const eventType of Object.keys(current)) {
      if (!failedTypes.has(eventType)) {
        result[eventType] = Math.max(result[eventType] ?? 0, current[eventType] ?? 0);
        delete current[eventType];
      }
    }
    for (const [eventType, count] of Object.entries(record.failedEventCounts)) {
      if (count === 0) continue;
      current[eventType] = (current[eventType] ?? 0) + 1;
      result[eventType] = Math.max(result[eventType] ?? 0, current[eventType] ?? 0);
    }
  }
  for (const [eventType, streak] of Object.entries(current)) {
    result[eventType] = Math.max(result[eventType] ?? 0, streak);
  }
  return result;
}

function validateConfig(
  config: Pick<EpisodeConfig, "seed" | "ticks" | "tenants">,
  world: SimWorld,
  rules: RulesManifest,
): EpisodeTenant[] {
  if (!Number.isSafeInteger(config.seed)) throw new Error(`episode: invalid seed ${config.seed}`);
  if (!Number.isSafeInteger(config.ticks) || config.ticks < 1) {
    throw new Error(`episode: ticks must be a positive safe integer, got ${config.ticks}`);
  }
  if (world.rulesVersion !== rules.rulesVersion) {
    throw new Error(`episode: scenario rules ${world.rulesVersion} != manifest ${rules.rulesVersion}`);
  }

  const tenants = [...config.tenants].sort((a, b) => compareCodeUnit(a.id, b.id));
  const tenantIds = tenants.map((tenant) => tenant.id);
  if (new Set(tenantIds).size !== tenantIds.length) throw new Error("episode: duplicate tenant id");
  const playerIds = [...world.players.keys()].sort(compareCodeUnit);
  if (canonicalJson(tenantIds) !== canonicalJson(playerIds)) {
    throw new Error(`episode: tenants must exactly match players (${tenantIds.join(",")} != ${playerIds.join(",")})`);
  }
  return tenants;
}

/**
 * Slot 轮换（W54，2026-08-09）：把 id-sorted tenants 循环移位，使被测者
 * （位于 id-sorted index `mySlot`）移到 array index `rotatedSlot`。
 * rotatedSlot = (mySlot + seed) % numPlayers（reference P0#16 公式）。
 *
 * 不变量：返回数组的 id 集合与输入相同（仅顺序变化）→ validateConfig 的
 * id-sorted 比较仍过；privateEventsForPlayer 按 playerId 过滤（与顺序无关）。
 * 调用方需把 scenario players[] 按站点序构造（被测者在 site rotatedSlot），
 * 这样 scenario players[] 顺序与 tenants 循环后顺序对齐，settlement 内
 * plans.values() 与 world.players.values() 的迭代顺序一致。
 *
 * rotateSlot=false 或 numPlayers<2 时原样返回（零回归）。
 */
export function rotateTenantsForSlot(
  tenants: readonly EpisodeTenant[],
  mySlot: number,
  seed: number,
  rotate: boolean,
): EpisodeTenant[] {
  if (!rotate || tenants.length < 2) return [...tenants];
  const numPlayers = tenants.length;
  if (!Number.isInteger(mySlot) || mySlot < 0 || mySlot >= numPlayers) {
    throw new Error(`episode: mySlot out of range [0,${numPlayers}): ${mySlot}`);
  }
  const rotatedSlot = ((mySlot + seed) % numPlayers + numPlayers) % numPlayers;
  if (rotatedSlot === mySlot) return [...tenants];
  const shift = (rotatedSlot - mySlot + numPlayers) % numPlayers;
  // ordered[i] = tenants[(i - shift + numPlayers) % numPlayers]
  // 验证：ordered[rotatedSlot] = tenants[(rotatedSlot - shift) % numPlayers] = tenants[mySlot] ✓
  return Array.from({ length: numPlayers }, (_, index) => tenants[(index - shift + numPlayers) % numPlayers]!);
}

interface MutableCostLedger {
  harvested: number;
  deposited: number;
  damageDealt: number;
  beaconTicks: number;
  respawnCount: number;
  unitsLost: number;
  healCost: number;
  repairCost: number;
  spawnCost: number;
  overflowDestroyed: number;
  resourcesLost: number;
  finalPopulation: number;
  finalResources: number;
  aliveTicks: number;
  populationPeak: number;
  /** 注册表类别聚合计数（movement/combat/economy/beacon/respawn）。
   *  新增事件类型加入 EVENT_CATEGORY_TYPES 后自动被统计（P4h）。 */
  eventCounts: Record<EventCategoryId, number>;
  /** 未识别事件计数（事件类型不在注册表内；eventOf 已校验，正常恒为 0，
   *  直接构造 ResolutionEvent 的旁路在此拦截，防静默漏计）。 */
  unrecognizedEventCount: number;
  /** P4e 决策超时次数（每 tick 超预算被丢弃的 decide 次数；未启用恒 0）。 */
  decisionTimeouts: number;
}

function emptyEventCounts(): Record<EventCategoryId, number> {
  return Object.fromEntries(
    Object.keys(EVENT_CATEGORY_TYPES).map((category) => [category, 0]),
  ) as Record<EventCategoryId, number>;
}

function createEmptyLedger(): MutableCostLedger {
  return {
    harvested: 0,
    deposited: 0,
    damageDealt: 0,
    beaconTicks: 0,
    respawnCount: 0,
    unitsLost: 0,
    healCost: 0,
    repairCost: 0,
    spawnCost: 0,
    overflowDestroyed: 0,
    resourcesLost: 0,
    finalPopulation: 0,
    finalResources: 0,
    aliveTicks: 0,
    populationPeak: 0,
    eventCounts: emptyEventCounts(),
    unrecognizedEventCount: 0,
    decisionTimeouts: 0,
  };
}

/** 事件类型 → 类别反查表（注册表推导；ledger 按类别聚合统计用）。 */
const EVENT_TYPE_TO_CATEGORY: ReadonlyMap<EventType, EventCategoryId> = new Map(
  (Object.entries(EVENT_CATEGORY_TYPES) as Array<[EventCategoryId, readonly EventType[]]>).flatMap(
    ([category, types]) => types.map((type) => [type, category] as const),
  ),
);

/**
 * 构造 entityId → playerId 反查表（core.id / unit.id → owner playerId）。
 * W51 cost ledger 用：把 settlement 事件的 actorId/targetId 归属到玩家。
 * 同时合并 before + after 两个快照——before 覆盖本 tick 内被摧毁的实体
 * （victim core/unit），after 覆盖本 tick 内新生的实体（spawned unit /
 * respawned core）。
 */
function buildEntityOwnerMap(...worlds: readonly SimWorld[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const world of worlds) {
    for (const [playerId, player] of world.players) {
      if (player.core !== null) map.set(player.core.id, playerId);
      for (const unit of player.units) map.set(unit.id, playerId);
    }
  }
  return map;
}

function numberValue(values: Readonly<Record<string, unknown>> | null, key: string): number {
  if (values === null) return 0;
  const raw = values[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

/**
 * 把一个 tick 的 settlement 事件流累计进 per-player cost ledger。
 * 纯累计函数，无副作用除累加器外。归属解析失败的事件静默跳过
 * （边缘情况：实体在 before/after 都查不到——理论上不应发生，因
 * 事件引用的实体必然在某个快照中存在）。
 */
function accumulateEventsIntoLedger(
  ledgers: Map<string, MutableCostLedger>,
  events: readonly ResolutionEvent[],
  owners: Map<string, string>,
): void {
  for (const event of events) {
    // 类别聚合统计（注册表驱动）：新增事件类型进 EVENT_CATEGORY_TYPES 即被统计。
    const category = EVENT_TYPE_TO_CATEGORY.get(event.eventType);
    const actorOwner = event.actorId !== null ? owners.get(event.actorId) ?? null : null;
    const targetOwner = event.targetId !== null ? owners.get(event.targetId) ?? null : null;
    if (category === undefined) {
      // 未识别事件防漏：类型不在注册表内（eventOf 创建入口已校验，正常
      // 恒为 0；直接构造 ResolutionEvent 的旁路在此拦截，不再静默跳过）。
      if (actorOwner !== null) ledgers.get(actorOwner)!.unrecognizedEventCount += 1;
      else if (targetOwner !== null) ledgers.get(targetOwner)!.unrecognizedEventCount += 1;
      continue;
    }
    if (actorOwner !== null) ledgers.get(actorOwner)!.eventCounts[category] += 1;
    else if (targetOwner !== null) ledgers.get(targetOwner)!.eventCounts[category] += 1;
    switch (event.eventType) {
      case "HARVEST_SUCCEEDED":
      case "BEACON_HARVEST_BONUS": {
        if (actorOwner !== null) {
          ledgers.get(actorOwner)!.harvested += numberValue(event.values, "amount");
        }
        break;
      }
      case "DEPOSIT_SUCCEEDED": {
        if (actorOwner !== null) {
          ledgers.get(actorOwner)!.deposited += numberValue(event.values, "amount");
        }
        break;
      }
      case "SHOT_HIT": {
        if (actorOwner !== null) {
          ledgers.get(actorOwner)!.damageDealt += numberValue(event.values, "damage");
        }
        break;
      }
      case "CORE_SPAWN_SUCCEEDED": {
        if (actorOwner !== null) {
          ledgers.get(actorOwner)!.spawnCost += numberValue(event.values, "cost");
        }
        break;
      }
      case "CORE_HEAL_SUCCEEDED":
      case "UNIT_HEAL_SUCCEEDED": {
        if (actorOwner !== null) {
          ledgers.get(actorOwner)!.healCost += numberValue(event.values, "cost");
        }
        break;
      }
      case "CORE_REPAIR_SUCCEEDED": {
        if (actorOwner !== null) {
          ledgers.get(actorOwner)!.repairCost += numberValue(event.values, "cost");
        }
        break;
      }
      case "CORE_RESOURCE_OVERFLOW_DESTROYED": {
        if (actorOwner !== null) {
          ledgers.get(actorOwner)!.overflowDestroyed += numberValue(event.values, "amount");
        }
        break;
      }
      case "CORE_RESOURCES_CAPTURED": {
        // victim = targetId owner；victim 损失 values.available（其中 amount 被赢家捕获，
        // destroyed 浪费——对 victim 而言整笔 available 都是 lost）。
        if (targetOwner !== null) {
          ledgers.get(targetOwner)!.resourcesLost += numberValue(event.values, "available");
        }
        break;
      }
      case "CORE_RESOURCES_DESTROYED": {
        if (targetOwner !== null) {
          ledgers.get(targetOwner)!.resourcesLost += numberValue(event.values, "amount");
        }
        break;
      }
      case "CORE_RESPAWNED": {
        if (targetOwner !== null) {
          ledgers.get(targetOwner)!.respawnCount += 1;
        }
        break;
      }
      case "UNIT_DAMAGED": {
        // values.hp === 0 → 单位死亡（combat upkeep/attack 共用此事件）。
        if (targetOwner !== null && numberValue(event.values, "hp") === 0) {
          ledgers.get(targetOwner)!.unitsLost += 1;
        }
        break;
      }
      case "UNIT_SELF_DESTRUCTED": {
        if (actorOwner !== null) {
          ledgers.get(actorOwner)!.unitsLost += 1;
        }
        break;
      }
      default:
        // 其余事件（MOVE/FAILED/SWEEP_RESOLVED 等）与 cost ledger 无关，跳过。
        break;
    }
  }
}

/** 每 tick 后从 after 世界快照累计 aliveTicks / beaconTicks。 */
function accumulateTickStateIntoLedger(
  ledgers: Map<string, MutableCostLedger>,
  after: SimWorld,
): void {
  const beacon = after.beacon;
  let beaconOwner: string | null = null;
  if (beacon !== null && beacon.status === "CARRIED" && beacon.carrierId !== null) {
    for (const [playerId, player] of after.players) {
      if (player.core !== null && player.core.id === beacon.carrierId) {
        beaconOwner = playerId;
        break;
      }
      if (player.units.some((unit) => unit.id === beacon.carrierId)) {
        beaconOwner = playerId;
        break;
      }
    }
  }
  for (const [playerId, player] of after.players) {
    const ledger = ledgers.get(playerId);
    if (ledger === undefined) continue;
    if (player.core !== null) ledger.aliveTicks += 1;
    if (beaconOwner === playerId) ledger.beaconTicks += 1;
    if (player.units.length > ledger.populationPeak) {
      ledger.populationPeak = player.units.length;
    }
  }
}

type LoadedEpisodeConfig = Omit<EpisodeConfig, "scenario">;

/** 空计划（全 WAIT）：P4e 超时无上次计划 / 连续超时跳过 decide 时的降级计划。 */
function emptyPlanFor(tick: number): Plan {
  return { tick, unitActions: {}, coreAction: null, intents: {} };
}

/**
 * P4f 存活玩家数：存活 = status ACTIVE 或有 Core/有单位。
 *
 * RESPAWNING（core=null, units=[]）玩家不算存活——但只有全员无 Core/无单位
 * 时才触发 early-stop：多人对局中任一玩家存活时，RESPAWNING 玩家不会终止
 * episode（且其重生依赖活 Core 的 20-30 曼哈顿环带，稍后即可重生回 ACTIVE）；
 * 而全员 RESPAWNING 时重生不可能（无活 Core 即无 spawn 候选格），等同于
 * 全员死亡。语义上只省资源，不判胜负（官方"无终局"保持）。
 */
function alivePlayerCount(world: SimWorld): number {
  let alive = 0;
  for (const player of world.players.values()) {
    if (player.status === "ACTIVE" || player.core !== null || player.units.length > 0) {
      alive += 1;
    }
  }
  return alive;
}

/** 单 tenant 的观察 + 策略解析（P4g 流水线预取与串行路径共用）：simTurnLike →
 *  reduceTurn → 遥测上报 → policyProvider 更新。纯观察（无世界副作用）；
 *  telemetry/policyProvider 每 (tenant, tick) 恰好调用一次——串行在 tick 迭代内
 *  调用，流水线在上一轮迭代末尾的 prefetch 处调用（同一 world/events → 同结果）。
 */
function observeAndPolicy(
  world: SimWorld,
  tenant: EpisodeTenant,
  rules: RulesManifest,
  events: readonly ResolutionEvent[],
  config: LoadedEpisodeConfig,
  lastPolicy: Map<string, MacroPolicy | undefined>,
): { readonly state: TickState; readonly policy: MacroPolicy | undefined } {
  const turn: TurnLike = simTurnLike(world, tenant.id, rules, events);
  const state: TickState = reduceTurn(turn);
  config.telemetrySinkFor?.(tenant.id)?.emitTick(world.tick, state);
  if (config.policyProvider !== undefined) {
    const next = config.policyProvider(tenant.id, world.tick, state);
    if (next !== null) lastPolicy.set(tenant.id, next);
  }
  const policy = lastPolicy.get(tenant.id) ?? tenant.policy;
  return { state, policy };
}

/** 共享确定性 runner：初始世界已解析。wallMs 是唯一非确定字段。 */
function runLoadedEpisode(config: LoadedEpisodeConfig, loaded: SimWorld): EpisodeResult {
  const started = performance.now();
  const rules = loadRulesManifest(config.rulesPath);
  const sortedTenants = validateConfig(config, loaded, rules);
  let world: SimWorld = { ...loaded, seed: config.seed };
  assertWorldInvariants(world);

  const rng = createSeededRng(config.seed);
  const context: SettlementContext = {
    rules,
    rng: () => rng.next(),
    ...(config.refill === undefined
      ? {}
      : {
          refill: {
            // 世界载入时含自然点的 chunk（refill 只作用于这些 chunk；
            // chunk 计数在 refill 阶段即时计算，terrain 平铺表达不变）。
            chunks: initialChunkKeys(loaded),
            everyTicks: config.refill.everyTicks ?? rules.rules.economy.refillEveryTicks,
          },
        }),
  };
  const validate = config.validatePlans ?? true;
  // 临时分阶段计时（ARENA_EPISODE_TIMING=1 时按 tick 输出摘要；默认关 = 零行为变化）。
  const phaseTiming = process.env.ARENA_EPISODE_TIMING === "1";
  let timingSum = { decision: 0, settlement: 0, record: 0, prefetch: 0, tick: 0 };
  let timingTicks = 0;
  // Slot 轮换（W54）：id-sorted tenants → 按站点序循环移位。id 集合不变，
  // validateConfig 已过；privateEventsForPlayer 按 playerId 过滤（顺序无关）。
  // 调用方需把 scenario players[] 按站点序构造（被测者在 site rotatedSlot）。
  const tenants = rotateTenantsForSlot(
    sortedTenants,
    config.mySlot ?? 0,
    config.seed,
    config.rotateSlot === true,
  );
  const planners = new Map(
    tenants.map((tenant) => [
      tenant.id,
      config.plannerFactory?.(tenant) ?? createPlanner(tenant.planner, tenant),
    ]),
  );
  const previousEvents = new Map<string, readonly ResolutionEvent[]>();
  const records: EpisodeRecord[] = [];
  const seenUnsupported = new Set<string>();
  let illegalPlans = 0;
  let repairedPlans = 0;
  let totalEvents = 0;
  // policyProvider 形态：每 tick 可能产出新 policy；null = 保持上次（模拟 LLM 低频决策）
  const lastPolicy = new Map<string, MacroPolicy | undefined>(
    tenants.map((tenant) => [tenant.id, tenant.policy]),
  );
  // W51 per-player cost ledger 累加器（默认关 = 仅追加，不改既有 metrics 语义）。
  const costLedgers = new Map<string, MutableCostLedger>(
    [...world.players.keys()].map((playerId) => [playerId, createEmptyLedger()]),
  );
  // P4e 决策预算护栏状态：上次执行计划（超时重放源，lastPlan 语义）、
  // 连续超时 strike 计数、已跳过 decide 的 tenant 集合。
  const decisionBudgetMs = config.decisionBudgetMs;
  const strikesBeforeSkip = config.decisionBudgetStrikes ?? 3;
  const lastExecutedPlan = new Map<string, Plan>();
  const decisionTimeoutStrikes = new Map<string, number>();
  const decisionTimeoutSkipped = new Set<string>();
  // P4f early-stop 记录（未触发时确定性 false/null/null）。
  let endedEarly = false;
  let endReason: "all-dead" | null = null;
  let endedAtTick: number | null = null;
  // P4g 决策流水线（pipeline=true）：tick N 结算后 prefetch tick N+1 决策，
  // tick N+1 开始时 decideCached 取。仅 provider 同时实现 prefetch/decideCached
  // 的 tenant 走流水线；其余 tenant 退回同步 decide（混合流水线，行为不变）。
  const pipeline = config.pipeline === true;
  const pipelineTenantIds = new Set(
    pipeline
      ? tenants
          .filter((tenant) => {
            const planner = planners.get(tenant.id)!;
            return (
              typeof planner.prefetch === "function" &&
              typeof planner.decideCached === "function"
            );
          })
          .map((tenant) => tenant.id)
      : [],
  );
  /** P4g+（2026-08-09）：prefetch 提交顺序——parallelPrefetch（真异步桥）在先，
   *  同步计算（内置 planner）在后：桥请求先发出 → Python 决策与主线程后续的
   *  同步 prefetch 计算重叠（waaiging 等长尾决策等待显著缩短）。只影响调度
   *  顺序，每个 tenant 的请求内容/序列不变 → 逐字节一致。 */
  const pipelinePrefetchOrder = pipeline
    ? tenants
        .filter((tenant) => pipelineTenantIds.has(tenant.id))
        .sort((a, b) => {
          const aAsync = planners.get(a.id)?.parallelPrefetch === true ? 0 : 1;
          const bAsync = planners.get(b.id)?.parallelPrefetch === true ? 0 : 1;
          return aAsync - bAsync;
        })
    : [];
  /** tenantId → 预取上下文（state/policy）：prefetch 时计算并缓存，decideCached
   *  后 validatePlan/manualOverride 使用（同一观察，串行模式每 tick 一次）。 */
  const prefetchedContext = new Map<string, { readonly state: TickState; readonly policy: MacroPolicy | undefined }>();

  /** 用给定世界（= 下一 tick 的 before 世界）发起所有流水线 tenant 的 prefetch。
   *  观察 + 策略与串行路径同一实现（observeAndPolicy），逐字节同结果；跳过
   *  （decisionTimeoutSkipped）tenant 不发起（其 pending 请求为空，迭代处重算
   *  观察走空计划降级——请求/响应交替不破）。提交顺序走
   *  pipelinePrefetchOrder（真异步桥先发，同步计算排后——P4g+ 调度）。 */
  const prefetchNextTick = (nextWorld: SimWorld): void => {
    for (const tenant of pipelinePrefetchOrder) {
      if (decisionTimeoutSkipped.has(tenant.id)) continue;
      // 临时 per-tenant 计时（ARENA_EPISODE_TIMING=1）。
      const tenantStartedAt = phaseTiming ? performance.now() : 0;
      const observed = observeAndPolicy(
        nextWorld,
        tenant,
        rules,
        previousEvents.get(tenant.id) ?? [],
        config,
        lastPolicy,
      );
      prefetchedContext.set(tenant.id, observed);
      planners.get(tenant.id)!.prefetch!({ state: observed.state, policy: observed.policy });
      if (phaseTiming) {
        console.error(
          `[episode timing] prefetch tenant=${tenant.id} ms=${(performance.now() - tenantStartedAt).toFixed(2)}`,
        );
      }
    }
  };

  // 流水线：循环外先跑 tick 1 的 Alliance 钩子 + 预取（钩子必须先于决策发起——
  // 与串行模式"迭代开头钩子 → tenant planner"的相对顺序一致）。
  if (pipeline) {
    config.onBeforePlanners?.({ tick: world.tick, world, rules });
    prefetchNextTick(world);
  }

  for (let step = 0; step < config.ticks; step += 1) {
    const tickStarted = performance.now();
    const before = world;

    // Alliance 前置钩子：在 per-tenant planner 前提供全景 SimWorld。
    // 流水线模式下本 tick 的钩子在上一轮迭代末尾（prefetch 前）已调用
    // （tick 1 在循环外预取前调用）——保证 director 注入先于决策发起。
    if (!pipeline) {
      config.onBeforePlanners?.({ tick: before.tick, world: before, rules });
    }

    const decisionStarted = performance.now();
    const settlementPlans = new Map<string, Plan>();
    const plans: Record<string, Plan> = {};
    const planHashes: Record<string, string> = {};
    const validations: Record<string, ValidationSummary> = {};
    const tickDecisionTimeouts: Record<string, number> = {};
    const tickDecisionSkipped: string[] = [];

    for (const tenant of tenants) {
      const planner = planners.get(tenant.id)!;
      const pipelineTenant = pipelineTenantIds.has(tenant.id);
      // 临时 per-tenant 计时（ARENA_EPISODE_TIMING=1）。
      const tenantStartedAt = phaseTiming ? performance.now() : 0;
      let state: TickState;
      let policy: MacroPolicy | undefined;
      let proposed: Plan;
      if (pipelineTenant) {
        // 流水线：本 tick 决策已在上一轮迭代末尾 prefetch（观察基于结算后
        // 世界 = 本 tick 的 before 世界，与串行同一观察）。decideCached 取
        // 结果——桥已完成时等待≈0；未完成则等待（保底逻辑）。
        // 被跳过 tenant 未发起 prefetch——重算观察（telemetry/policy 每
        // tick 恰好一次，与串行一致），走空计划降级。
        const observed = prefetchedContext.get(tenant.id);
        if (observed !== undefined) {
          state = observed.state;
          policy = observed.policy;
        } else {
          const recomputed = observeAndPolicy(
            world,
            tenant,
            rules,
            previousEvents.get(tenant.id) ?? [],
            config,
            lastPolicy,
          );
          state = recomputed.state;
          policy = recomputed.policy;
        }
        if (decisionTimeoutSkipped.has(tenant.id)) {
          proposed = emptyPlanFor(state.tick);
          tickDecisionSkipped.push(tenant.id);
        } else {
          const decidedAt = performance.now();
          proposed = planner.decideCached!();
          if (phaseTiming) {
            console.error(
              `[episode timing] tenant ${tenant.id} decideCachedMs=${(performance.now() - decidedAt).toFixed(2)}`,
            );
          }
          if (decisionBudgetMs !== undefined && performance.now() - decidedAt > decisionBudgetMs) {
            const strikes = (decisionTimeoutStrikes.get(tenant.id) ?? 0) + 1;
            decisionTimeoutStrikes.set(tenant.id, strikes);
            if (strikes >= strikesBeforeSkip) decisionTimeoutSkipped.add(tenant.id);
            const last = lastExecutedPlan.get(tenant.id);
            proposed = last === undefined ? emptyPlanFor(state.tick) : { ...last, tick: state.tick };
            tickDecisionTimeouts[tenant.id] = (tickDecisionTimeouts[tenant.id] ?? 0) + 1;
            const ledger = costLedgers.get(tenant.id);
            if (ledger !== undefined) ledger.decisionTimeouts += 1;
          } else {
            decisionTimeoutStrikes.set(tenant.id, 0);
          }
        }
      } else {
        const observed = observeAndPolicy(
          world,
          tenant,
          rules,
          previousEvents.get(tenant.id) ?? [],
          config,
          lastPolicy,
        );
        state = observed.state;
        policy = observed.policy;

        // P4e 决策预算护栏（同步循环内无强杀；语义 = 丢弃 + 降级 + 指标）：
        // - 超预算 → 丢弃本次结果，重放上次执行计划（lastPlan 语义；无上次
        //   计划用空计划 WAIT），计 1 次超时（tickDecisionTimeouts + ledger）；
        // - 连续超时达 strikesBeforeSkip → 跳过该 tenant 后续 decide（直接
        //   空计划），记录在 tickDecisionSkipped（DECISION_TIMEOUT_SKIPPED）。
        const skipDecision = decisionTimeoutSkipped.has(tenant.id);
        if (skipDecision) {
          proposed = emptyPlanFor(state.tick);
          tickDecisionSkipped.push(tenant.id);
        } else {
          const decidedAt = performance.now();
          proposed = planner.decide({ state, policy });
          if (decisionBudgetMs !== undefined && performance.now() - decidedAt > decisionBudgetMs) {
            const strikes = (decisionTimeoutStrikes.get(tenant.id) ?? 0) + 1;
            decisionTimeoutStrikes.set(tenant.id, strikes);
            if (strikes >= strikesBeforeSkip) decisionTimeoutSkipped.add(tenant.id);
            const last = lastExecutedPlan.get(tenant.id);
            proposed = last === undefined ? emptyPlanFor(state.tick) : { ...last, tick: state.tick };
            tickDecisionTimeouts[tenant.id] = (tickDecisionTimeouts[tenant.id] ?? 0) + 1;
            const ledger = costLedgers.get(tenant.id);
            if (ledger !== undefined) ledger.decisionTimeouts += 1;
          } else {
            decisionTimeoutStrikes.set(tenant.id, 0);
          }
        }
      }

      let finalPlan = proposed;
      let summary: ValidationSummary = { valid: true, repaired: false, issueCount: 0 };

      if (validate) {
        const validateStartedAt = phaseTiming ? performance.now() : 0;
        const result: ValidationResult = validatePlan(state, proposed);
        if (phaseTiming) {
          console.error(
            `[episode timing] tenant ${tenant.id} validateMs=${(performance.now() - validateStartedAt).toFixed(2)}`,
          );
        }
        summary = {
          valid: result.valid,
          repaired: result.repaired,
          issueCount: result.issues.length,
        };
        if (!result.valid) {
          illegalPlans += 1;
          if (!result.repaired) throw new Error(`episode: invalid unrepaired plan for ${tenant.id}`);
          repairedPlans += 1;
          finalPlan = result.plan;
        }
      }

      const settledPlan =
        config.manualOverrideProvider?.(tenant.id, before.tick, state, finalPlan) ?? finalPlan;
      lastExecutedPlan.set(tenant.id, settledPlan);
      settlementPlans.set(tenant.id, settledPlan);
      plans[tenant.id] = settledPlan;
      planHashes[tenant.id] = hashPlan(settledPlan);
      validations[tenant.id] = summary;
      // 临时 per-tenant 计时（ARENA_EPISODE_TIMING=1）。
      if (phaseTiming) {
        console.error(
          `[episode timing] tenant ${tenant.id} total=${(performance.now() - tenantStartedAt).toFixed(2)}ms ` +
            `pipeline=${String(pipelineTenant)}`,
        );
      }
    }

    const decisionEnded = performance.now();
    const result = settleTick(world, settlementPlans, context);
    const settlementEnded = performance.now();
    if (phaseTiming) {
      timingSum.decision += decisionEnded - decisionStarted;
      timingSum.settlement += settlementEnded - decisionEnded;
    }
    world = result.world;
    for (const tenant of tenants) {
      previousEvents.set(
        tenant.id,
        privateEventsForPlayer(before, world, tenant.id, result.events),
      );
    }
    const prefetchStarted = performance.now();
    // P4g 决策流水线：结算完成后立即发起 tick N+1 的观察+决策（prefetch 异步
    // 不阻塞——持久桥在 worker 线程/独立 Python 进程并行决策），把本 tick 剩余
    // 的 ledger/记录/observer 工作叠在 Python 决策之下；tick N+1 开始时
    // decideCached 取结果（等待≈0，未完成则等待保底）。末 tick 不预取。
    if (pipeline && step + 1 < config.ticks) {
      // 先跑下一 tick 的 Alliance 钩子（director 注入先于决策发起——与串行
      // 模式"迭代开头钩子 → planner 决策"的相对顺序一致；此时 world = 结算后
      // 世界 = 下一 tick 的 before 世界，tick = world.tick）。
      config.onBeforePlanners?.({ tick: world.tick, world, rules });
      prefetchNextTick(world);
    }
    const prefetchEnded = performance.now();
    if (phaseTiming) timingSum.prefetch += prefetchEnded - prefetchStarted;
    for (const feature of result.unsupported) seenUnsupported.add(feature);
    totalEvents += result.events.length;
    // W51: 累计 per-player cost ledger（before+after 合并覆盖被摧毁/新生实体）。
    const entityOwners = buildEntityOwnerMap(before, world);
    accumulateEventsIntoLedger(costLedgers, result.events, entityOwners);
    accumulateTickStateIntoLedger(costLedgers, world);
    records.push({
      tick: before.tick,
      plans,
      planHashes,
      validations,
      aggregatePlanHash: hashPlanSet(plans),
      events: result.events,
      unsupported: result.unsupported,
      unknownEffects: result.unknownEffects,
      decisionTimeouts: tickDecisionTimeouts,
      decisionTimeoutSkipped: tickDecisionSkipped,
      failedEventCounts: countFailedEvents(result.events),
    });
    if (config.onTickRecorded !== undefined) {
      config.onTickRecorded({
        tick: before.tick,
        before,
        after: world,
        plans,
        events: result.events,
      });
    }
    if (config.onTickSettled !== undefined) {
      const players = [...world.players.values()]
        .sort((a, b) => compareCodeUnit(a.id, b.id))
        .map((player) => Object.freeze({
          playerId: player.id,
          resources: player.resources,
          population: player.units.length,
        }));
      config.onTickSettled(Object.freeze({
        tick: before.tick,
        wallMs: performance.now() - tickStarted,
        players: Object.freeze(players),
      }));
    }

    // 临时分阶段计时：tick 级摘要（ARENA_EPISODE_TIMING=1）。
    if (phaseTiming) {
      timingSum.record += performance.now() - prefetchEnded;
      timingSum.tick += performance.now() - tickStarted;
      timingTicks += 1;
      if (timingTicks % 100 === 0) {
        const t = timingSum;
        console.error(
          `[episode timing] ticks=${timingTicks} avg_tick=${(t.tick / timingTicks).toFixed(1)}ms ` +
            `decision=${(t.decision / timingTicks).toFixed(1)}ms ` +
            `settlement=${(t.settlement / timingTicks).toFixed(1)}ms ` +
            `prefetch=${(t.prefetch / timingTicks).toFixed(1)}ms ` +
            `record=${(t.record / timingTicks).toFixed(1)}ms`,
        );
      }
    }

    // P4f early-stop：全员无存活（无 Core/无单位）→ 提前终止，后续 tick 不跑。
    // 只省资源，不判胜负（官方"无终局"语义保持）。
    if (config.earlyStop === true && alivePlayerCount(world) === 0) {
      endedEarly = true;
      endReason = "all-dead";
      endedAtTick = before.tick;
      break;
    }
  }

  // W51: 快照终局 finalPopulation/finalResources 到 ledger。
  for (const [playerId, player] of world.players) {
    const ledger = costLedgers.get(playerId);
    if (ledger === undefined) continue;
    ledger.finalPopulation = player.units.length;
    ledger.finalResources = player.resources;
  }
  const perPlayer: Record<string, PlayerCostLedger> = {};
  for (const [playerId, ledger] of costLedgers) {
    perPlayer[playerId] = Object.freeze({ ...ledger });
  }

  // 临时分阶段计时汇总（ARENA_EPISODE_TIMING=1）。
  if (phaseTiming && timingTicks > 0) {
    const t = timingSum;
    console.error(
      `[episode timing] TOTAL ticks=${timingTicks} avg_tick=${(t.tick / timingTicks).toFixed(1)}ms ` +
        `decision=${(t.decision / timingTicks).toFixed(1)}ms ` +
        `settlement=${(t.settlement / timingTicks).toFixed(1)}ms ` +
        `prefetch=${(t.prefetch / timingTicks).toFixed(1)}ms ` +
        `record=${(t.record / timingTicks).toFixed(1)}ms ` +
        `sum=${((t.decision + t.settlement + t.prefetch + t.record) / timingTicks).toFixed(1)}ms`,
    );
  }

  return {
    finalWorld: world,
    finalWorldHash: worldHash(world),
    records,
    metrics: {
      ticks: records.length,
      illegalPlans,
      repairedPlans,
      unsupported: [...seenUnsupported].sort(compareCodeUnit),
      totalEvents,
      wallMs: performance.now() - started,
      perPlayer: Object.freeze(perPlayer),
      endedEarly,
      endReason,
      endedAtTick,
    },
  };
}

/** Scenario-backed deterministic episode. */
export function runEpisode(config: EpisodeConfig): EpisodeResult {
  const loaded = worldFromScenario(config.scenario);
  const { scenario: _scenario, ...rest } = config;
  return runLoadedEpisode(rest, loaded);
}

/**
 * Run from an already materialized SimWorld (P4 counterfactual foundation).
 * settleTick clones before mutation, so the caller's initialWorld remains immutable;
 * invariants are checked before entering the rollout.
 */
export function runEpisodeFromWorld(config: EpisodeFromWorldConfig): EpisodeResult {
  assertWorldInvariants(config.initialWorld);
  const { initialWorld, ...rest } = config;
  return runLoadedEpisode(rest, initialWorld);
}
