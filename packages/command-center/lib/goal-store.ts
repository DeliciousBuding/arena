/**
 * 指挥 goal 写入治理（2026-08-08）：防抖/去重规则纯函数。
 *
 * 背景（生产实证）：human-commands 的 goal 被每 ~20s 重发同目标（面板重放/
 * live 校正），导致核心持续收到 START_MOVE（每 tick CORE_MOVE_STARTED，
 * MOVING 期间引擎拒 DEPOSIT）——满载 worker 持货冻结、res 62 卡死。
 * 本模块把"同单位同目标的重复写入"在窗口内归并为同一条：不重写文件、
 * 不刷审计（治理在写者侧，执行侧 human-override 只读）。
 *
 * 归位：写者侧（command-center），与 store.ts 同层；执行侧（agent）不依赖。
 */
export interface GoalEntry {
  readonly id: string;
  readonly unitId: string;
  readonly kind: "mine" | "goto";
  readonly target: readonly [number, number];
  readonly note?: string;
  readonly createdAt: string;
}

export interface GoalMutationInput {
  readonly unitId: string;
  readonly kind: "mine" | "goto";
  readonly target: readonly [number, number];
  readonly note?: string;
}

export interface GoalMutationPolicy {
  /** 同单位同 kind 同目标去重窗口（ms）：窗口内重复提交视为同一条。 */
  readonly dedupeWindowMs: number;
}

export const DEFAULT_GOAL_POLICY: GoalMutationPolicy = Object.freeze({
  dedupeWindowMs: 30_000,
});

export type GoalMutationOutcome =
  | { readonly applied: true; readonly goalId: string; readonly replaced: boolean }
  | { readonly applied: false; readonly reason: "deduped"; readonly goalId: string };

export interface GoalMutationResult {
  readonly outcome: GoalMutationOutcome;
  /** 应用后的 goals 数组（dedupe 时 = 原数组，不重写文件）。 */
  readonly goals: readonly GoalEntry[];
}

/** 应用 goal 写入：同单位同 kind 同目标在去重窗口内 → dedupe（原样返回，
 *  调用方应跳过写盘与"goal"审计）；否则覆盖该单位旧 goal（filter+concat）。
 *  纯函数：不修改入参，返回新数组。 */
export function applyGoalMutation(
  store: { readonly goals: readonly GoalEntry[] },
  input: GoalMutationInput,
  nowMs: number,
  policy: GoalMutationPolicy = DEFAULT_GOAL_POLICY,
): GoalMutationResult {
  const existing = store.goals.find((goal) => goal.unitId === input.unitId);
  if (
    existing !== undefined
    && existing.kind === input.kind
    && existing.target[0] === input.target[0]
    && existing.target[1] === input.target[1]
  ) {
    const ageMs = nowMs - Date.parse(existing.createdAt);
    if (!Number.isNaN(ageMs) && ageMs >= 0 && ageMs < policy.dedupeWindowMs) {
      return { outcome: { applied: false, reason: "deduped", goalId: existing.id }, goals: store.goals };
    }
  }
  const goal: GoalEntry = {
    id: `goal-${nowMs}-${Math.random().toString(36).slice(2, 8)}`,
    unitId: input.unitId,
    kind: input.kind,
    target: [input.target[0], input.target[1]],
    note: input.note,
    createdAt: new Date(nowMs).toISOString(),
  };
  const goals = store.goals.filter((goalEntry) => goalEntry.unitId !== input.unitId).concat([goal]);
  return { outcome: { applied: true, goalId: goal.id, replaced: existing !== undefined }, goals };
}
