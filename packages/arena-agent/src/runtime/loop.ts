/** TS 编排层主循环：turns() → reduceTurn → 决策（agent/safety）→ lease 校验 → submit。
 *
 * Python 版 arena_bot/main.py 的 TS 等价物（minimal viable loop）。
 * shadow 模式：只观察不提交（差分验证用）。
 */

import {
  type Accepted,
  type ArenaHeroClient,
  type CommandPlan,
  type Turn,
} from "@arena/arena-hero-ts";
import {
  type CoreAction,
  type DecisionCandidate,
  type Plan,
  type TickState,
  type UnitAction,
} from "../domain/model.ts";
import { reduceTurn, type TurnLike } from "../domain/state-reducer.ts";
import { validatePlan } from "../domain/plan-validator.ts";
import { DecisionLease } from "./decision-lease.ts";
import { hashTickState } from "./state-hash.ts";
import { SafetyPlanner, DEFAULT_SAFETY_CONFIG, type SafetyPlannerConfig } from "../strategies/safety-planner.ts";

// ---------- Plan（domain）→ CommandPlan（SDK wire） ----------

function actionToWire(action: UnitAction | CoreAction): Record<string, unknown> {
  switch (action.type) {
    case "MOVE":
      return { type: "MOVE", direction: action.direction };
    case "SWEEP":
      return { type: "SWEEP", direction: action.direction };
    case "SHOOT":
      return { type: "SHOOT", target_id: action.targetId, expected_cell: [...action.expectedCell] };
    case "SPAWN":
      return { type: "SPAWN", unit_type: action.unitType };
    case "START_MOVE":
      return { type: "START_MOVE", direction: action.direction };
    default:
      return { type: action.type };
  }
}

export function planToCommandPlan(plan: Plan): CommandPlan {
  const unit_actions: Record<string, unknown> = {};
  for (const [id, action] of Object.entries(plan.unitActions)) {
    unit_actions[id] = actionToWire(action);
  }
  return {
    tick: plan.tick,
    // wire 格式与 domain 命名不同（target_id vs targetId）——运行时由 SDK 校验
    unit_actions: unit_actions as CommandPlan["unit_actions"],
    core_action: (plan.coreAction ? actionToWire(plan.coreAction) : null) as CommandPlan["core_action"],
  };
}

// ---------- 主循环 ----------

export type DecisionSource = "agent" | "safety" | "repaired-agent";

export interface TickOutcome {
  readonly tick: number;
  readonly source: DecisionSource;
  readonly plan: Plan;
  readonly accepted: boolean;
  readonly leaseCode?: string;
  readonly error?: string;
}

export interface TenantLoopOptions {
  readonly client: ArenaHeroClient;
  /** 确定性 safety planner（默认 DEFAULT_SAFETY_CONFIG）。 */
  readonly planner?: SafetyPlanner;
  /** Agent 决策桥（Pi 嵌入，可选）：返回 null/抛错 → 回退 safety。 */
  readonly decide?: (state: TickState, lease: DecisionLease) => Promise<DecisionCandidate | null>;
  /** 每 tick 回调（遥测/日志）。 */
  readonly onTick?: (outcome: TickOutcome) => void;
  /** shadow 模式：只观察不提交。 */
  readonly shadow?: boolean;
  /** 决策 deadline（ms），默认 8000（15s 游戏窗口内留提交余量）。 */
  readonly deadlineMs?: number;
}

export async function runTenantLoop(options: TenantLoopOptions): Promise<void> {
  const { client } = options;
  const planner = options.planner ?? new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  const deadlineMs = options.deadlineMs ?? 8000;

  for await (const turn of client.turns()) {
    const outcome = await handleTurn(turn, planner, options, deadlineMs);
    options.onTick?.(outcome);
  }
}

/** 处理单个 Turn：state → 决策 → lease → submit。 */
export async function handleTurn(
  turn: Turn,
  planner: SafetyPlanner,
  options: Pick<TenantLoopOptions, "decide" | "shadow" | "onTick">,
  deadlineMs: number,
): Promise<TickOutcome> {
  const state = reduceTurn(turn as unknown as TurnLike);
  const lease = new DecisionLease({
    tick: state.tick,
    stateHash: hashTickState(state),
    deadlineAt: Date.now() + deadlineMs,
  });

  // 1) Agent 决策（可选，带 lease 校验）
  let candidate: DecisionCandidate | null = null;
  let source: DecisionSource = "safety";
  if (options.decide) {
    try {
      candidate = await options.decide(state, lease);
      if (candidate !== null) {
        const submission = lease.submit(candidate);
        if (submission.accepted) {
          source = "agent";
        } else {
          candidate = null; // lease 拒绝（迟到/错 tick/错 state）→ 回退 safety
        }
      }
    } catch {
      candidate = null;
    }
  }

  // 2) safety plan（无 agent 决策或被拒绝时）
  if (candidate === null) {
    const safetyPlan = planner.decide({ state });
    candidate = {
      protocolVersion: "1",
      tick: state.tick,
      stateHash: hashTickState(state),
      plan: safetyPlan,
      reason: "safety fallback",
    };
    source = "safety";
  }

  // 3) 语义校验 + repair
  let plan = candidate.plan;
  const validation = validatePlan(state, plan);
  if (!validation.valid && validation.plan !== plan) {
    plan = validation.plan;
    source = "repaired-agent";
  }

  // 4) shadow：不提交
  if (options.shadow) {
    return { tick: state.tick, source, plan, accepted: false };
  }

  // 5) 提交
  try {
    const accepted = await turn.submit();
    return { tick: state.tick, source, plan, accepted: accepted.accepted };
  } catch (exc) {
    return {
      tick: state.tick,
      source,
      plan,
      accepted: false,
      error: exc instanceof Error ? exc.message : String(exc),
    };
  }
}
