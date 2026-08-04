/** W4 最终计划合成：合法 Agent 动作 > Safety 动作 > 无动作（PlanArbiter）。
 *
 * Agent 候选可能部分非法。不能"非法动作删掉就结束"（局部错误让单位无动作），
 * 因此按单位逐条按优先级合成最终计划：
 * - 该单位 Agent 动作合法（过 validatePlan 语义校验）→ 采用 Agent 动作；
 * - Agent 动作非法或未提议 → 采用 Safety 动作；
 * - Safety 也无该单位动作 → 无动作。
 *
 * source 判定（DecisionSource，见 decision-types.ts 冻结契约）：
 * - agentCandidate 为 null 或未提议任何动作 → 完整 safety；
 * - Agent 提议动作全部合法 → agent；
 * - 非法比例 ≥ invalidRatioThreshold（默认 0.5，构造参数可调）→ 整单降级完整 safety；
 * - 其余（0 < 非法 < 阈值）→ hybrid；
 * - safetyPlan 为 null（SafetyPlanner 异常）→ emergency（最小合法计划）。
 *
 * 最终计划无论来源都必须再过一次 validatePlan（修复后输出）。
 */

import type { CoreAction, Plan, TickState, UnitAction } from "../domain/model.ts";
import { validatePlan, type ValidationResult } from "../domain/plan-validator.ts";
import type { DecisionSource } from "./decision-types.ts";

export interface PlanArbiterConfig {
  /** Agent 非法动作比例 ≥ 此阈值 → 整单降级为完整 safety（默认 0.5，可调）。 */
  readonly invalidRatioThreshold: number;
  /** 语义校验器注入（测试替身用）；默认 validatePlan。 */
  readonly validate?: (
    state: TickState,
    plan: Plan,
    obstacles?: ReadonlySet<string>,
  ) => ValidationResult;
}

export const DEFAULT_ARBITER_CONFIG: PlanArbiterConfig = Object.freeze({
  invalidRatioThreshold: 0.5,
});

export interface ArbitrateInput {
  /** 展示用 tick；合成计划 tick 一律以 state.tick 为准（validatePlan 契约）。 */
  readonly tick: number;
  readonly state: TickState;
  /** Safety 计划；null 表示 SafetyPlanner 异常 → 走 emergency 最小合法计划。 */
  readonly safetyPlan: Plan | null;
  readonly agentCandidate: Plan | null;
}

export interface ArbitrateResult {
  readonly plan: Plan;
  readonly source: DecisionSource;
  /** 最终计划中被采用的 Agent 动作数（单位 + core）。 */
  readonly agentActionCount: number;
  /** 用 Safety 动作替换/补齐的动作数（非法 Agent 动作的替换 + Agent 未提议单位的补齐）。 */
  readonly safetyReplacementCount: number;
  /** Agent 提议中非法动作数（含 unknown_unit 与 tick_mismatch 的整体作废）。 */
  readonly invalidAgentActionCount: number;
  /** 最终计划过 validator 的 issue 数（修复后输出，正常为 0）。 */
  readonly repairCount: number;
}

export class PlanArbiter {
  readonly config: PlanArbiterConfig;

  constructor(config: PlanArbiterConfig = DEFAULT_ARBITER_CONFIG) {
    this.config = config;
  }

  arbitrate(input: ArbitrateInput): ArbitrateResult {
    const { state, agentCandidate } = input;
    if (input.safetyPlan === null) return this.arbitrateEmergency(state);
    const safetyPlan = input.safetyPlan;

    // 1) 无 Agent（或 Agent 完全不可用）→ 完整 safety
    if (agentCandidate === null || proposedActionCount(agentCandidate) === 0) {
      return this.takeSafety(state, safetyPlan, "safety");
    }

    // 2) 语义校验 Agent 提议，统计非法动作
    const validation = this.validate(state, agentCandidate);
    const invalidCount = this.countInvalid(state, agentCandidate, validation);
    const ratio = invalidCount / proposedActionCount(agentCandidate);
    if (ratio >= this.config.invalidRatioThreshold) {
      // 非法比例过高 → Agent 整体不可信 → 整单降级完整 safety
      return this.takeSafety(state, safetyPlan, "safety", invalidCount);
    }

    // 3) 逐单位合成（合法 Agent > Safety > 无动作）
    return this.synthesize(state, safetyPlan, agentCandidate, validation, invalidCount);
  }

  /** SafetyPlanner 异常时的最小合法计划：全部单位不动 + core 无动作。 */
  emergencyPlan(state: TickState): Plan {
    const unitActions: Record<string, UnitAction> = {};
    for (const unit of [...state.units].sort((a, b) => a.id.localeCompare(b.id))) {
      unitActions[unit.id] = { type: "WAIT" };
    }
    return { tick: state.tick, unitActions, coreAction: null, intents: {} };
  }

  /** safetyPlan 为 null（SafetyPlanner 异常）时的入口：最小合法 emergency 计划。 */
  arbitrateEmergency(state: TickState): ArbitrateResult {
    const final = this.validate(state, this.emergencyPlan(state));
    return {
      plan: final.plan,
      source: "emergency",
      agentActionCount: 0,
      safetyReplacementCount: 0,
      invalidAgentActionCount: 0,
      repairCount: final.issues.length,
    };
  }

  private takeSafety(
    state: TickState,
    safetyPlan: Plan,
    source: DecisionSource,
    invalidAgentActionCount = 0,
  ): ArbitrateResult {
    const final = this.validate(state, safetyPlan);
    return {
      plan: final.plan,
      source,
      agentActionCount: 0,
      safetyReplacementCount: 0,
      invalidAgentActionCount,
      repairCount: final.issues.length,
    };
  }

  private synthesize(
    state: TickState,
    safetyPlan: Plan,
    agent: Plan,
    validation: ValidationResult,
    invalidCount: number,
  ): ArbitrateResult {
    const invalidActors = new Set(validation.issues.map((issue) => issue.actorId));
    const unitActions: Record<string, UnitAction> = {};
    const intents: Record<string, string> = {};
    let agentActionCount = 0;
    let safetyReplacementCount = 0;

    for (const unit of [...state.units].sort((a, b) => a.id.localeCompare(b.id))) {
      const agentAction = agent.unitActions[unit.id];
      if (agentAction !== undefined && !invalidActors.has(unit.id)) {
        unitActions[unit.id] = agentAction;
        if (agent.intents[unit.id] !== undefined) intents[unit.id] = agent.intents[unit.id];
        agentActionCount += 1;
        continue;
      }
      const safetyAction = safetyPlan.unitActions[unit.id];
      if (safetyAction !== undefined) {
        unitActions[unit.id] = safetyAction;
        if (safetyPlan.intents[unit.id] !== undefined) intents[unit.id] = safetyPlan.intents[unit.id];
        safetyReplacementCount += 1;
      }
    }

    let coreAction: CoreAction | null = null;
    const coreActorId = state.core?.id ?? "core";
    const agentCoreInvalid =
      agent.coreAction !== null && (invalidActors.has(coreActorId) || invalidActors.has("core"));
    if (agent.coreAction !== null && !agentCoreInvalid) {
      coreAction = agent.coreAction;
      if (agent.intents.core !== undefined) intents.core = agent.intents.core;
      agentActionCount += 1;
    } else if (safetyPlan.coreAction !== null) {
      coreAction = safetyPlan.coreAction;
      if (safetyPlan.intents.core !== undefined) intents.core = safetyPlan.intents.core;
      safetyReplacementCount += 1;
    }

    const synthesized: Plan = { tick: state.tick, unitActions, coreAction, intents };
    const final = this.validate(state, synthesized);
    const source: DecisionSource = invalidCount === 0 ? "agent" : "hybrid";
    return {
      plan: final.plan,
      source,
      agentActionCount,
      safetyReplacementCount,
      invalidAgentActionCount: invalidCount,
      repairCount: final.issues.length,
    };
  }

  private countInvalid(state: TickState, agent: Plan, validation: ValidationResult): number {
    // tick 错 → Agent 计划整体作废：全部提议动作计非法
    if (validation.issues.some((issue) => issue.code === "tick_mismatch")) {
      return proposedActionCount(agent);
    }
    const invalidActors = new Set(validation.issues.map((issue) => issue.actorId));
    let count = 0;
    for (const unitId of Object.keys(agent.unitActions)) {
      if (invalidActors.has(unitId)) count += 1; // 含 unknown_unit
    }
    if (agent.coreAction !== null) {
      const coreActorId = state.core?.id ?? "core";
      if (invalidActors.has(coreActorId) || invalidActors.has("core")) count += 1;
    }
    return count;
  }

  private validate(state: TickState, plan: Plan): ValidationResult {
    const validate = this.config.validate ?? validatePlan;
    return validate(state, plan);
  }
}

function proposedActionCount(plan: Plan): number {
  return Object.keys(plan.unitActions).length + (plan.coreAction === null ? 0 : 1);
}
