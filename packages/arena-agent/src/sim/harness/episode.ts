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
import { settleTick, type SettlementContext } from "../engine/settlement.ts";
import { privateEventsForPlayer } from "../visibility/private-events.ts";
import { simTurnLike } from "../visibility/visibility.ts";
import { worldHash } from "../world/canonical.ts";
import { worldFromScenario } from "../world/loaders.ts";
import type { SimFeature, SimWorld } from "../world/types.ts";
import { assertWorldInvariants } from "../world/world.ts";

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
   * 近似 refill（实验可选；默认 undefined = 不实现官方 refill，保持
   * unknown-by-design）：按规则 cadence 把原始资源格补回，模拟真实节奏的
   * 持续供给（官方 refill 是 server-secret，本配置只是近似，unknown note
   * 明确标注 approximate）。
   */
  readonly refill?: { readonly everyTicks?: number };
  readonly validatePlans?: boolean;
  /** 测试/实验注入；默认复用线上 DeterministicPlanner/SafetyPlanner。 */
  readonly plannerFactory?: (tenant: EpisodeTenant) => PlanProvider;
  /** Optional read-only performance observer; never participates in simulation semantics. */
  readonly onTickSettled?: (measurement: EpisodeTickMeasurement) => void;
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
  };
}

function createPlanner(kind: PlannerKind, tenant: EpisodeTenant): PlanProvider {
  if (kind === "deterministic") {
    return new DeterministicPlanner(undefined, undefined, undefined, tenant.plannerConfig?.vanguardRatio);
  }
  return new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, ...tenant.plannerConfig });
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

function validateConfig(config: EpisodeConfig, world: SimWorld, rules: RulesManifest): EpisodeTenant[] {
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

/** 运行一个确定性 episode。wallMs 是唯一非确定字段，不参与 replay 等价。 */
export function runEpisode(config: EpisodeConfig): EpisodeResult {
  const started = performance.now();
  const rules = loadRulesManifest(config.rulesPath);
  const loaded = worldFromScenario(config.scenario);
  const tenants = validateConfig(config, loaded, rules);
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
            cells: [...loaded.terrain.resources.keys()].sort(compareCodeUnit),
            everyTicks: config.refill.everyTicks ?? rules.rules.economy.refillEveryTicks,
          },
        }),
  };
  const validate = config.validatePlans ?? true;
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

  for (let step = 0; step < config.ticks; step += 1) {
    const tickStarted = performance.now();
    const before = world;
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

      settlementPlans.set(tenant.id, finalPlan);
      plans[tenant.id] = finalPlan;
      planHashes[tenant.id] = hashPlan(finalPlan);
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
    },
  };
}
