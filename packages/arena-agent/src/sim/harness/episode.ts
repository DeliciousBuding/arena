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
import type { ResolutionEvent, UnknownEffect } from "../engine/phase.ts";
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
}

export interface EpisodeResult {
  readonly finalWorld: SimWorld;
  readonly finalWorldHash: string;
  readonly records: readonly EpisodeRecord[];
  readonly metrics: {
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
  };
}

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
    const actorOwner = event.actorId !== null ? owners.get(event.actorId) ?? null : null;
    const targetOwner = event.targetId !== null ? owners.get(event.targetId) ?? null : null;
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
  }
}

type LoadedEpisodeConfig = Omit<EpisodeConfig, "scenario">;

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

  for (let step = 0; step < config.ticks; step += 1) {
    const tickStarted = performance.now();
    const before = world;

    // Alliance 前置钩子：在 per-tenant planner 前提供全景 SimWorld
    config.onBeforePlanners?.({ tick: before.tick, world: before, rules });

    const settlementPlans = new Map<string, Plan>();
    const plans: Record<string, Plan> = {};
    const planHashes: Record<string, string> = {};
    const validations: Record<string, ValidationSummary> = {};

    for (const tenant of tenants) {
      const planner = planners.get(tenant.id)!;
      const turn: TurnLike = simTurnLike(
        world,
        tenant.id,
        rules,
        previousEvents.get(tenant.id) ?? [],
      );
      const state: TickState = reduceTurn(turn);
      config.telemetrySinkFor?.(tenant.id)?.emitTick(before.tick, state);
      if (config.policyProvider !== undefined) {
        const next = config.policyProvider(tenant.id, before.tick, state);
        if (next !== null) lastPolicy.set(tenant.id, next);
      }
      const policy = lastPolicy.get(tenant.id) ?? tenant.policy;
      const proposed = planner.decide({ state, policy });
      let finalPlan = proposed;
      let summary: ValidationSummary = { valid: true, repaired: false, issueCount: 0 };

      if (validate) {
        const result: ValidationResult = validatePlan(state, proposed);
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
      settlementPlans.set(tenant.id, settledPlan);
      plans[tenant.id] = settledPlan;
      planHashes[tenant.id] = hashPlan(settledPlan);
      validations[tenant.id] = summary;
    }

    const result = settleTick(world, settlementPlans, context);
    world = result.world;
    for (const tenant of tenants) {
      previousEvents.set(
        tenant.id,
        privateEventsForPlayer(before, world, tenant.id, result.events),
      );
    }
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

  return {
    finalWorld: world,
    finalWorldHash: worldHash(world),
    records,
    metrics: {
      ticks: config.ticks,
      illegalPlans,
      repairedPlans,
      unsupported: [...seenUnsupported].sort(compareCodeUnit),
      totalEvents,
      wallMs: performance.now() - started,
      perPlayer: Object.freeze(perPlayer),
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
