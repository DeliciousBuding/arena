/**
 * 目标租户接应（receive-mode，migration-system-v1 §5.4，评审 P1 数据模型定稿，
 * 纯函数模块）。
 *
 * 一份 operationId 关联两份 tenant plan：执行方 `mode=migrate`、接应方
 * `mode=receive`（接应主体：军事东向侦察/清障、alliance-no-fire 防互打、
 * 核心不动）；runtime 只读自己的 tenant view（`migration/<tenant>.json`）。
 *
 * 找不到完整配对 → null（"无对应 tenant plan = 零影响"，不产生任何动作）。
 */

export interface PartnerPlanRef {
  readonly tenant: string;
  readonly operationId: string;
  readonly mode: string;
}

/**
 * 按 operationId 在全部 tenant plan 中寻找 "migrate + receive" 精确配对，
 * 返回接应方（receive）plan。
 * 配对缺失 / 仅一份 / 超过两份 / 模式不符（如两份都是 migrate）→ null（fail-closed）。
 */
export function receivePartnerPlan(
  operationId: string,
  plans: readonly PartnerPlanRef[],
): PartnerPlanRef | null {
  const matched = plans.filter((plan) => plan.operationId === operationId);
  if (matched.length !== 2) return null;

  const receiveSide = matched.find((plan) => plan.mode === "receive");
  const migrateSide = matched.find((plan) => plan.mode === "migrate");
  if (receiveSide === undefined || migrateSide === undefined) return null;
  return receiveSide;
}

/** 判定该 plan 是否为 receive-mode（undefined 或非 receive → false，fail-closed）。 */
export function isReceiveMode(plan: { readonly mode: string } | undefined): boolean {
  return plan !== undefined && plan.mode === "receive";
}
