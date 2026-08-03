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
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../../strategies/safety-planner.ts";
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

function createPlanner(kind: PlannerKind): PlanProvider {
  return kind === "deterministic"
    ? new DeterministicPlanner()
    : new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
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
  const context: SettlementContext = { rules, rng: () => rng.next() };
  const validate = config.validatePlans ?? true;
  const planners = new Map(
    tenants.map((tenant) => [
      tenant.id,
      config.plannerFactory?.(tenant) ?? createPlanner(tenant.planner),
    ]),
  );
  const previousEvents = new Map<string, readonly ResolutionEvent[]>();
  const records: EpisodeRecord[] = [];
  const seenUnsupported = new Set<string>();
  let illegalPlans = 0;
  let repairedPlans = 0;
  let totalEvents = 0;

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
      const proposed = planner.decide({ state });
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
