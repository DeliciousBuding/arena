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
import type { Plan } from "../../domain/model.ts";
import type { PlannerKind } from "../harness/episode.ts";
import { DeterministicPlanner } from "../../planning/deterministic-planner.ts";
import { WorkerTaskPlanner } from "../../planning/worker-task-planner.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../../strategies/safety-planner.ts";
import { VARIANT_SAFETY_CONFIG } from "../../strategies/variant-registry.ts";

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

/** 实验用静止 planner：全单位 WAIT + Core 无动作——构造"敌人墙"场景
 *  （敌单位占资源格/挡回仓路不动），供 clear-path 等清障 ROI 的 A/B 验证。 */
class IdlePlanner implements PlanProvider {
  decide(): Plan {
    return { tick: 0, unitActions: {}, coreAction: null, intents: {} };
  }
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
    id: "clear-path-v1",
    description:
      "TS-009 候选：清场 ROI——defensive 下 Vanguard 清除满载 Worker 回仓路径上的敌人（生产 A/B：被压方经济 2-4× 差）",
    create: () => new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, ...VARIANT_SAFETY_CONFIG["clear-path-v1"] }),
  }),
  Object.freeze({
    id: "threat-recall-v1",
    description:
      "候选：威胁召回——ALERT 级（12 格内敌确认）时 worker 巡逻缩守家圈 4 格（对打 3 seeds 全改善：存活 0.3→2.0、res 2.3→4.7）",
    create: () => new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, ...VARIANT_SAFETY_CONFIG["threat-recall-v1"] }),
  }),
  Object.freeze({
    id: "move-failed-avoidance-v1",
    description:
      "候选：MOVE_FAILED 反馈规避——连续失败 ≥2 走垂直绕行探路（对照 0 拆 vs 变体 4/2 轮拆 CORE、首拆 t16）",
    create: () => new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, ...VARIANT_SAFETY_CONFIG["move-failed-avoidance-v1"] }),
  }),
  Object.freeze({
    id: "threat-breakout-v1",
    description:
      "候选：BREAKOUT 全面收缩——多轴无逃逸包围时 worker 全面缩家（模拟器 A/B 阴性：场景构造限制非机制无效）",
    create: () => new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, ...VARIANT_SAFETY_CONFIG["threat-breakout-v1"] }),
  }),
  Object.freeze({
    id: "core-evade-v1",
    description:
      "候选：Core 迁移 PRE_EVADE-lite——12 格内可见敌或确认追击时 START_MOVE 远离（对打命中 2.3→0.0，阴性记录：逃不掉时方向无关）",
    create: () => new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, ...VARIANT_SAFETY_CONFIG["core-evade-v1"] }),
  }),
  Object.freeze({
    id: "safety",
    description: "内置 SafetyPlanner（默认配置）",
    create: () => new SafetyPlanner(DEFAULT_SAFETY_CONFIG),
    aliasOf: "safety",
  }),
  Object.freeze({
    id: "idle",
    description: "实验用静止 planner（全 WAIT）：构造敌人墙场景供清障 ROI A/B",
    create: () => new IdlePlanner(),
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
