/**
 * TS-004 命名 Planner variant registry（TS-008 扩展：基线/候选/别名模块化）。
 *
 * 语义约定（2026-08-05 生产事故后校准）：
 * - deterministic-v0.2.15 = 冻结基线：**v0.2.15 发布时的原始行为**（无 focusRegion
 *   防呆——生产 t1 7000+ tick 经济冻结事故暴露的语义）。所有离线提升相对它衡量。
 * - deterministic-v0.2.17 = 当前生产语义候选：maxFocusDistance=32 防呆 +
 *   WorkerTaskPlanner 完整分配（TS-008 首候选，事故根因修复的模拟可验证形态）。
 * - deterministic = 生产默认别名（= deterministic-v0.2.17）。
 *
 * 变体只复用已冻结的 PlanProvider 接口与 episode.plannerFactory 注入点，
 * 不创建第二套 Planner 接口（同策略对局语义不变）。
 */

import type { PlanProvider } from "../../runtime/decision-types.ts";
import type { PlannerKind } from "../harness/episode.ts";
import { DeterministicPlanner } from "../../planning/deterministic-planner.ts";
import { WorkerTaskPlanner } from "../../planning/worker-task-planner.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../../strategies/safety-planner.ts";

export interface PlannerVariant {
  readonly id: string;
  readonly description: string;
  /** 变体构造器：A/B 的 plannerFactory 注入点（tenantId 仅用于诊断，无状态构造）。 */
  readonly create: (tenantId: string) => PlanProvider;
  /** 兼容别名：映射到 PlannerKind 的旧 id（safety/deterministic）。 */
  readonly aliasOf?: PlannerKind;
}

/** v0.2.15 冻结基线：无 focusRegion 防呆（当时发布行为，A/B 对照的真实旧语义）。 */
function legacyDeterministicPlanner(): DeterministicPlanner {
  const legacyConfig = { ...DEFAULT_SAFETY_CONFIG, maxFocusDistance: Number.POSITIVE_INFINITY };
  return new DeterministicPlanner(
    new WorkerTaskPlanner(),
    new SafetyPlanner(legacyConfig),
    new SafetyPlanner(legacyConfig),
  );
}

/** 内置变体。新候选（TS-009 clear-path-v1 等）在后续提交注册。 */
export const PLANNER_VARIANTS: readonly PlannerVariant[] = Object.freeze([
  Object.freeze({
    id: "deterministic-v0.2.15",
    description:
      "冻结基线：v0.2.15 语义（无 focusRegion 防呆——生产 t1 经济冻结事故暴露的原始行为）",
    create: () => legacyDeterministicPlanner(),
  }),
  Object.freeze({
    id: "deterministic-v0.2.17",
    description:
      "TS-008 候选：当前生产语义（maxFocusDistance=32 防呆 + WorkerTaskPlanner 完整分配）",
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
    description: "生产默认别名（= deterministic-v0.2.17 当前语义）",
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
