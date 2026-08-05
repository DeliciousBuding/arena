/**
 * TS-004 命名 Planner variant registry。
 *
 * 生产默认行为完全不变（deterministic-v0.2.15 = 当前 DeterministicPlanner 冻结语义）；
 * 这层只服务于离线候选和 A/B（TS-007 runAB 消费），不创建第二套 Planner 接口——
 * 复用已冻结的 PlanProvider 与 episode.plannerFactory 注入点。
 */

import type { PlanProvider } from "../../runtime/decision-types.ts";
import type { PlannerKind } from "../harness/episode.ts";
import { DeterministicPlanner } from "../../planning/deterministic-planner.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../../strategies/safety-planner.ts";

export interface PlannerVariant {
  readonly id: string;
  readonly description: string;
  /** 变体构造器：A/B 的 plannerFactory 注入点（tenantId 仅用于诊断，无状态构造）。 */
  readonly create: (tenantId: string) => PlanProvider;
  /** 兼容别名：映射到 PlannerKind 的旧 id（safety/deterministic）。 */
  readonly aliasOf?: PlannerKind;
}

/** 内置变体（冻结基线 + 内置对照）。新候选（TS-008 economy-v1 等）在后续提交注册。 */
export const PLANNER_VARIANTS: readonly PlannerVariant[] = Object.freeze([
  Object.freeze({
    id: "deterministic-v0.2.15",
    description: "冻结基线：v0.2.15 的 DeterministicPlanner 默认语义（所有离线提升相对它衡量）",
    create: () => new DeterministicPlanner(),
  }),
  Object.freeze({
    id: "safety",
    description: "内置 SafetyPlanner（默认配置）",
    create: () => new SafetyPlanner(DEFAULT_SAFETY_CONFIG),
    aliasOf: "safety",
  }),
  Object.freeze({
    id: "deterministic",
    description: "内置 DeterministicPlanner 别名（= deterministic-v0.2.15 当前语义）",
    create: () => new DeterministicPlanner(),
    aliasOf: "deterministic",
  }),
]);

const VARIANT_BY_ID: ReadonlyMap<string, PlannerVariant> = new Map(
  PLANNER_VARIANTS.map((variant) => [variant.id, variant]),
);

/** 解析变体 id；未知 id 抛错（fail-fast，防止 A/B 静默跑错策略）。 */
export function resolvePlannerVariant(id: string): PlannerVariant {
  const variant = VARIANT_BY_ID.get(id);
  if (variant === undefined) {
    throw new Error(`unknown planner variant: ${id} (registered: ${PLANNER_VARIANTS.map((v) => v.id).join(", ")})`);
  }
  return variant;
}

/** 判断 id 是否为已注册变体（runAB 校验用）。 */
export function isPlannerVariant(id: string): boolean {
  return VARIANT_BY_ID.has(id);
}
