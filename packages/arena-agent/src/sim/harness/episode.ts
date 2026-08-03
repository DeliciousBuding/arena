/**
 * Planner 闭环 harness（S7）：现有 deterministic/safety Planner 在模拟器上连续运行。
 *
 * 每 Tick 流水线：SimWorld → simTurnLike → reduceTurn → Planner.decide →
 * validatePlan（可选）→ settleTick → 下一 Tick。
 *
 * 约束：
 * - 不复制策略逻辑（现有 planning/strategies 零 fork）；
 * - 依赖方向单向 sim → domain/planning（线上代码不反向 import sim）；
 * - 每个 simulated tenant 独立 planner 实例（跨 Tick 记忆不串扰）；
 * - 不调用 runTenantLoop / Client / Turn.submit。
 */

import { performance } from "node:perf_hooks";
import { reduceTurn, type TurnLike } from "../../domain/state-reducer.ts";
import { validatePlan, type ValidationResult } from "../../domain/plan-validator.ts";
import type { Plan, TickState } from "../../domain/model.ts";
import type { PlanProvider } from "../../runtime/decision-types.ts";
import { DeterministicPlanner } from "../../planning/deterministic-planner.ts";
import { SafetyPlanner, DEFAULT_SAFETY_CONFIG } from "../../strategies/safety-planner.ts";
import { loadRulesManifest, type RulesManifest } from "../contracts/rules-manifest.ts";
import { createSeededRng } from "../deterministic/rng.ts";
import { settleTick, type SettlementContext } from "../engine/settlement.ts";
import type { ResolutionEvent, UnknownEffect } from "../engine/phase.ts";
import { simTurnLike } from "../visibility/visibility.ts";
import { worldFromScenario } from "../world/loaders.ts";
import { worldHash } from "../world/canonical.ts";
import type { SimFeature, SimWorld } from "../world/types.ts";

export type PlannerKind = "deterministic" | "safety";

export interface EpisodeTenant {
  readonly id: string;
  readonly planner: PlannerKind;
}

export interface EpisodeConfig {
  /** 内置 scenario 对象（worldFromScenario 输入）。 */
  readonly scenario: unknown;
  readonly rulesPath: string;
  readonly seed: number;
  readonly ticks: number;
  readonly tenants: readonly EpisodeTenant[];
  /** 每 tick 对 planner 输出做 validatePlan（默认 true）。 */
  readonly validatePlans?: boolean;
}

export interface EpisodeRecord {
  readonly tick: number;
  readonly planHash: string;
  readonly validation: { readonly valid: boolean; readonly repaired: boolean; readonly issueCount: number };
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
  if (kind === "deterministic") {
    return new DeterministicPlanner();
  }
  return new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
}

function hashPlan(plan: Plan): string {
  return JSON.stringify(plan);
}

/**
 * 运行一个 episode：加载 scenario → 每 tick 决策+结算 → 返回最终世界与记录。
 * 确定性：同 config（scenario/seed/ticks/tenants）输出逐字节一致。
 */
export function runEpisode(config: EpisodeConfig): EpisodeResult {
  const started = performance.now();
  const rules: RulesManifest = loadRulesManifest(config.rulesPath);
  const rng = createSeededRng(config.seed);
  const ctx: SettlementContext = { rules, rng: () => rng.next() };
  const validate = config.validatePlans ?? true;

  let world = worldFromScenario(config.scenario);
  const planners = new Map(config.tenants.map((t) => [t.id, createPlanner(t.planner)]));
  const records: EpisodeRecord[] = [];
  const seenUnsupported = new Set<string>();
  let illegalPlans = 0;
  let repairedPlans = 0;
  let totalEvents = 0;

  for (let step = 0; step < config.ticks; step += 1) {
    const plans = new Map<string, Plan>();
    const record: {
      tick: number;
      planHash: string;
      validation: { valid: boolean; repaired: boolean; issueCount: number };
      events: ResolutionEvent[];
      unsupported: SimFeature[];
      unknownEffects: UnknownEffect[];
    } = {
      tick: world.tick,
      planHash: "",
      validation: { valid: true, repaired: false, issueCount: 0 },
      events: [],
      unsupported: [],
      unknownEffects: [],
    };

    for (const tenant of config.tenants) {
      const planner = planners.get(tenant.id)!;
      const turn: TurnLike = simTurnLike(world, tenant.id);
      const state: TickState = reduceTurn(turn);
      const plan = planner.decide({ state });
      let finalPlan = plan;

      if (validate) {
        const result: ValidationResult = validatePlan(state, plan);
        if (!result.valid) {
          illegalPlans += 1;
          record.validation = {
            valid: false,
            repaired: result.repaired,
            issueCount: result.issues.length,
          };
          if (result.repaired) {
            repairedPlans += 1;
            finalPlan = result.plan;
          }
        }
      }
      plans.set(tenant.id, finalPlan);
      record.planHash = hashPlan(finalPlan);
    }

    const result = settleTick(world, plans, ctx);
    world = result.world;
    for (const feature of result.unsupported) seenUnsupported.add(feature);
    totalEvents += result.events.length;
    records.push({
      ...record,
      events: result.events,
      unsupported: result.unsupported,
      unknownEffects: result.unknownEffects,
    });
  }

  return {
    finalWorld: world,
    finalWorldHash: worldHash(world),
    records,
    metrics: {
      ticks: config.ticks,
      illegalPlans,
      repairedPlans,
      unsupported: [...seenUnsupported].sort(),
      totalEvents,
      wallMs: performance.now() - started,
    },
  };
}
