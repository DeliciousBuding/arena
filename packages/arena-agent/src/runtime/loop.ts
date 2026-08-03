/** TS 编排层主循环：turns() → reduceTurn → 决策（agent/safety）→ lease 校验 → submit。
 *
 * Python 版 arena_bot/main.py 的 TS 等价物（minimal viable loop）。
 * P0-1：submissionMode=disabled 只观察不提交（差分验证用）；decisionMode 两轴拆分，
 * 不再用单一 shadow:boolean 同时表达"谁掌权"与"是否提交"。
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
  type DecisionSource,
  type Plan,
  type TickState,
  type UnitAction,
} from "../domain/model.ts";
import { reduceTurn, type TurnLike } from "../domain/state-reducer.ts";
import { validatePlan } from "../domain/plan-validator.ts";
import { DecisionLease } from "./decision-lease.ts";
import { DecisionCoordinator } from "./decision-coordinator.ts";
import { hashTickState } from "./state-hash.ts";
import { SafetyPlanner, DEFAULT_SAFETY_CONFIG, type SafetyPlannerConfig } from "../strategies/safety-planner.ts";
import type { DecisionModeName, SubmissionModeName } from "./decision-types.ts";

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

export interface TickOutcome {
  readonly tick: number;
  /** 最终来源（repair 只提升 agent 计划；safety 计划被修复仍记 safety）。 */
  readonly source: DecisionSource;
  /** 决策最初来源（agent / safety），repair 前的值。 */
  readonly originalSource: DecisionSource;
  /** validator 报告的 issue 数（修复/警告）。 */
  readonly repairCount: number;
  readonly plan: Plan;
  readonly accepted: boolean;
  /** 是否实际调用过 turn.submit()。shadow/startup sync 为 false。 */
  readonly submitAttempted: boolean;
  readonly notSubmittedReason?: "disabled" | "startup_sync";
  readonly leaseCode?: string;
  readonly error?: string;
  /** 决策时点 state（outcome trace 资源对比用；loop 始终持有，透传零成本）。 */
  readonly state: TickState;
  /** coordinator 路径的完整 DecisionResult（遥测三流素材；旧 bridge 无）。 */
  readonly decision?: import("./decision-types.ts").DecisionResult;
}

export interface TenantLoopOptions {
  readonly client: ArenaHeroClient;
  /** 确定性 planner（默认 SafetyPlanner；decisionMode=deterministic 时注入 ResourcePlanner）。 */
  readonly planner?: SafetyPlanner;
  /** W4 决策核心（可选）：提供后走 coordinator 时序（Safety 预计算 + deadline race）。
   *   loop 不再理解 Agent/abort 细节。 */
  readonly coordinator?: DecisionCoordinator;
  /** 旧决策桥（Pi 嵌入，可选，coordinator 未提供时使用）：返回 null/抛错 → 回退 safety。 */
  readonly decide?: (state: TickState, lease: DecisionLease) => Promise<DecisionCandidate | null>;
  /** 每 tick 回调（遥测/日志）。 */
  readonly onTick?: (outcome: TickOutcome) => void;
  /** P0-1：提交模式（缺省 "disabled"=只观察不提交）。替代旧 shadow:boolean。 */
  readonly submissionMode?: SubmissionModeName;
  /** P0-1：决策模式（缺省 "hybrid"）；传递到 coordinator。
   *  deterministic：loop 层注入 ResourcePlanner 为 planner，coordinator 保持 hybrid 语义。 */
  readonly decisionMode?: DecisionModeName;
  /** 决策 deadline（ms），默认 8000（15s 游戏窗口内留提交余量）。 */
  readonly deadlineMs?: number;
  /** live 启动后先观察 N 个 Turn 再提交，避免接入已关窗的当前 Tick。 */
  readonly startupSyncTurns?: number;
}

export async function runTenantLoop(options: TenantLoopOptions): Promise<void> {
  const { client } = options;
  const planner = options.planner ?? new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  const deadlineMs = options.deadlineMs ?? 8000;
  const startupSyncTurns = options.startupSyncTurns ?? 0;
  let observedTurns = 0;

  for await (const turn of client.turns()) {
    const startupSync = options.submissionMode === "live" && observedTurns < startupSyncTurns;
    const outcome = await handleTurn(
      turn,
      planner,
      startupSync ? { ...options, submissionMode: "disabled" } : options,
      deadlineMs,
    );
    observedTurns += 1;
    const recordedOutcome = startupSync
      ? { ...outcome, notSubmittedReason: "startup_sync" as const }
      : outcome;
    options.onTick?.(recordedOutcome);
  }
}

/** 处理单个 Turn：state → 决策 → lease → submit。 */
export async function handleTurn(
  turn: Turn,
  planner: SafetyPlanner,
  options: Pick<TenantLoopOptions, "decide" | "submissionMode" | "onTick" | "coordinator">,
  deadlineMs: number,
): Promise<TickOutcome> {
  const state = reduceTurn(turn as unknown as TurnLike);
  const live = options.submissionMode === "live";

  // W4 路径（唯一正式路径，4D-pre）：coordinator 时序（Safety 预计算 + deadline race + arbiter）。
  // 4D-pre：不再压缩 source（hybrid/emergency 原样保留进遥测）。
  if (options.coordinator) {
    const result = await options.coordinator.decide(state);
    const source = result.execution.source;
    if (!live) {
      return {
        tick: result.tick,
        source,
        originalSource: source,
        repairCount: result.repairCount,
        plan: result.execution.plan,
        accepted: false,
        submitAttempted: false,
        notSubmittedReason: "disabled",
        state,
        decision: result,
      };
    }
    try {
      const wirePlan = planToCommandPlan(result.execution.plan);
      turn.replace(wirePlan);
      const accepted = await turn.submit();
      return {
        tick: result.tick,
        source,
        originalSource: source,
        repairCount: result.repairCount,
        plan: result.execution.plan,
        accepted: accepted.accepted,
        submitAttempted: true,
        state,
        decision: result,
      };
    } catch (exc) {
      return {
        tick: result.tick,
        source,
        originalSource: source,
        repairCount: result.repairCount,
        plan: result.execution.plan,
        accepted: false,
        submitAttempted: true,
        error: exc instanceof Error ? exc.message : String(exc),
        state,
        decision: result,
      };
    }
  }

  // [DEPRECATED 4D-pre] 旧 decide bridge（Date.now + 无 coordinator 时序）：coordinator 是
  // 唯一正式路径；本段仅 shadow 工具与旧调用方使用，切片 6 删除，不再维护。
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

  // 3) 语义校验 + repair（repair 只提升 agent 来源；safety 被修复仍记 safety，见 GPT R2）
  let plan = candidate.plan;
  const validation = validatePlan(state, plan);
  const repairCount = validation.issues.length;
  if (!validation.valid && validation.plan !== plan) {
    plan = validation.plan;
    if (source === "agent") {
      source = "repaired-agent";
    }
  }
  const originalSource = source === "repaired-agent" ? "agent" : source;

  // 4) 只观察不提交（P0-1：submissionMode=disabled）
  if (!live) {
    return {
      tick: state.tick,
      source,
      originalSource,
      repairCount,
      plan,
      accepted: false,
      submitAttempted: false,
      notSubmittedReason: "disabled",
      state,
    };
  }

  // 5) 决策计划注入 Turn 并提交（走 SDK 原提交通道：重试/幂等）
  try {
    const wirePlan = planToCommandPlan(plan);
    turn.replace(wirePlan);
    const accepted = await turn.submit();
    return {
      tick: state.tick,
      source,
      originalSource,
      repairCount,
      plan,
      accepted: accepted.accepted,
      submitAttempted: true,
      state,
    };
  } catch (exc) {
    return {
      tick: state.tick,
      source,
      originalSource,
      repairCount,
      plan,
      accepted: false,
      submitAttempted: true,
      error: exc instanceof Error ? exc.message : String(exc),
      state,
    };
  }
}
