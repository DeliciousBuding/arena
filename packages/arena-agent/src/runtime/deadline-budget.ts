/** Deadline 预算：把收到决策请求的时刻切成四段绝对单调截止点。
 *  所有时刻均为单调时间（performance.now() 域，测试注入 FakeClock）。
 *  边界语义：now >= deadline 即过期。
 *  类型 DeadlineBudget 定义在 decision-types.ts（冻结契约），本文件提供构造/查询/校验。 */

import { type DeadlineBudget } from "./decision-types.ts";

/** 各段时长配置（毫秒，都相对 receivedAtMonotonic 的偏移）。 */
export interface DeadlineConfig {
  /** 停止等待 Agent 候选。 */
  readonly agentSoftMs: number;
  /** 最终计划必须固定。 */
  readonly selectionMs: number;
  /** 必须开始/完成提交。 */
  readonly submitMs: number;
  /** 游戏窗口结束。 */
  readonly hardMs: number;
}

export type DeadlineStage = "agentSoft" | "selection" | "submit" | "hard";

const STAGE_FIELDS: Readonly<Record<DeadlineStage, keyof DeadlineBudget>> = {
  agentSoft: "agentSoftDeadline",
  selection: "selectionDeadline",
  submit: "submitDeadline",
  hard: "hardDeadline",
};

/** 由 received 时刻 + 各段偏移构造预算。顺序约束（严格递增）：soft < selection < submit < hard；
 *  负值/NaN/Infinity 拒绝（抛 RangeError）。默认时长由 coordinator 集成时决定，本层只提供机制。 */
export function createDeadlineBudget(
  receivedAtMonotonic: number,
  config: DeadlineConfig,
): DeadlineBudget {
  if (!Number.isFinite(receivedAtMonotonic)) {
    throw new RangeError(
      `createDeadlineBudget: receivedAtMonotonic must be a finite number, got ${receivedAtMonotonic}`,
    );
  }
  const offsets: ReadonlyArray<readonly [string, number]> = [
    ["agentSoftMs", config.agentSoftMs],
    ["selectionMs", config.selectionMs],
    ["submitMs", config.submitMs],
    ["hardMs", config.hardMs],
  ];
  for (const [name, value] of offsets) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(
        `createDeadlineBudget: ${name} must be a finite non-negative number, got ${value}`,
      );
    }
  }
  if (!(config.agentSoftMs < config.selectionMs)) {
    throw new RangeError(
      "createDeadlineBudget: must satisfy agentSoftMs < selectionMs < submitMs < hardMs " +
        `(got agentSoft=${config.agentSoftMs}, selection=${config.selectionMs})`,
    );
  }
  if (!(config.selectionMs < config.submitMs)) {
    throw new RangeError(
      "createDeadlineBudget: must satisfy agentSoftMs < selectionMs < submitMs < hardMs " +
        `(got selection=${config.selectionMs}, submit=${config.submitMs})`,
    );
  }
  if (!(config.submitMs < config.hardMs)) {
    throw new RangeError(
      "createDeadlineBudget: must satisfy agentSoftMs < selectionMs < submitMs < hardMs " +
        `(got submit=${config.submitMs}, hard=${config.hardMs})`,
    );
  }
  return {
    receivedAtMonotonic,
    agentSoftDeadline: receivedAtMonotonic + config.agentSoftMs,
    selectionDeadline: receivedAtMonotonic + config.selectionMs,
    submitDeadline: receivedAtMonotonic + config.submitMs,
    hardDeadline: receivedAtMonotonic + config.hardMs,
  };
}

/** 某阶段的绝对截止时刻。 */
export function deadlineOf(budget: DeadlineBudget, stage: DeadlineStage): number {
  return budget[STAGE_FIELDS[stage]];
}

/** now >= deadline 即过期（边界语义：恰好等于截止时刻算已过期）。 */
export function isExpired(budget: DeadlineBudget, now: number, stage: DeadlineStage): boolean {
  return now >= deadlineOf(budget, stage);
}

/** 距截止的剩余毫秒（可为负，负 = 已过期）。 */
export function timeUntil(budget: DeadlineBudget, now: number, stage: DeadlineStage): number {
  return deadlineOf(budget, stage) - now;
}

export interface BudgetValidation {
  readonly valid: boolean;
  readonly reason?: string;
}

/** 完整合法性校验：全部字段有限 + 顺序 received <= soft < selection < submit < hard。 */
export function validateBudget(budget: DeadlineBudget): BudgetValidation {
  const fields: ReadonlyArray<readonly [string, number]> = [
    ["receivedAtMonotonic", budget.receivedAtMonotonic],
    ["agentSoftDeadline", budget.agentSoftDeadline],
    ["selectionDeadline", budget.selectionDeadline],
    ["submitDeadline", budget.submitDeadline],
    ["hardDeadline", budget.hardDeadline],
  ];
  for (const [name, value] of fields) {
    if (!Number.isFinite(value)) {
      return { valid: false, reason: `validateBudget: ${name} must be a finite number, got ${value}` };
    }
  }
  if (!(budget.receivedAtMonotonic <= budget.agentSoftDeadline)) {
    return {
      valid: false,
      reason:
        "validateBudget: must satisfy receivedAtMonotonic <= agentSoftDeadline < selectionDeadline < " +
        "submitDeadline < hardDeadline",
    };
  }
  if (!(budget.agentSoftDeadline < budget.selectionDeadline)) {
    return {
      valid: false,
      reason:
        "validateBudget: must satisfy receivedAtMonotonic <= agentSoftDeadline < selectionDeadline < " +
        "submitDeadline < hardDeadline",
    };
  }
  if (!(budget.selectionDeadline < budget.submitDeadline)) {
    return {
      valid: false,
      reason:
        "validateBudget: must satisfy receivedAtMonotonic <= agentSoftDeadline < selectionDeadline < " +
        "submitDeadline < hardDeadline",
    };
  }
  if (!(budget.submitDeadline < budget.hardDeadline)) {
    return {
      valid: false,
      reason:
        "validateBudget: must satisfy receivedAtMonotonic <= agentSoftDeadline < selectionDeadline < " +
        "submitDeadline < hardDeadline",
    };
  }
  return { valid: true };
}
