/**
 * MacroPolicy（低频战略参数）：per-tick LLM 不作为生产主线（MASTER.md 明确关闭），
 * 低频 MacroPolicy 只异步输出有限战略参数。
 *
 * - 纯数据结构 + 确定性序列化（canonical JSON，同输入同输出）；
 * - 默认策略 = 保守均衡（harvest 经济优先，安全兜底语义）；
 * - 策略值全部可枚举/数值，执行层（SafetyPlanner）直接消费，不解析自然语言；
 * - 不 import pi 运行时、无 IO——产出由 MacroPolicyOrchestrator 负责。
 */

/** 战略姿态：决定执行层 aggression 映射与生产优先级。 */
export type PolicyPosture = "harvest" | "balanced" | "aggressive";

/** 攻击优先级：Ranger 射击目标排序与 Vanguard 攻坚目标的策略覆盖。 */
export type AttackPriority = "core" | "workers" | null;

export interface MacroPolicy {
  /** 战略姿态（缺省 balanced——与历史 SafetyPlanner defensive 行为对齐）。 */
  readonly posture: PolicyPosture;
  /** 目标 Worker 数量（生产线投入；决定 spawn 优先级）。 */
  readonly workerTarget: number;
  /** 军事占比 0-1（Vanguard+Ranger 占总人口目标；0 表示不设军事目标）。 */
  readonly militaryRatio: number;
  /** 探索/攻坚聚焦区（null = 不聚焦，沿用巡逻逻辑）。 */
  readonly focusRegion: readonly [number, number] | null;
  /** 攻击优先级（null = 不主动攻击）。 */
  readonly attackPriority: AttackPriority;
}

/** 默认策略：均衡姿态、经济优先、不主动攻击（历史行为等价）。 */
export const DEFAULT_MACRO_POLICY: MacroPolicy = Object.freeze({
  posture: "balanced",
  workerTarget: 8,
  militaryRatio: 0.4,
  focusRegion: null,
  attackPriority: null,
});

/** 策略值域校验（orchestrator 解析 LLM 输出与测试共用；非法 → 拒绝整份策略）。 */
export function isValidMacroPolicy(value: unknown): value is MacroPolicy {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.posture !== "harvest" && candidate.posture !== "balanced" && candidate.posture !== "aggressive") {
    return false;
  }
  if (!Number.isInteger(candidate.workerTarget) || (candidate.workerTarget as number) < 1) return false;
  if (typeof candidate.militaryRatio !== "number" || candidate.militaryRatio < 0 || candidate.militaryRatio > 1) return false;
  if (candidate.focusRegion !== null) {
    const region = candidate.focusRegion as unknown;
    if (
      !Array.isArray(region) ||
      region.length !== 2 ||
      // 2026-08-06 修正：允许负坐标（生产 t1 Core 在 [-619,-154] 负坐标区域，
      // 模型按枯竭告警输出真实负坐标焦点被"非负校验"误拒 → 3 次 policy_error +
      // 退化无焦点）。远点防呆依赖 maxFocusDistance（Chebyshev 距 Core ≤32），
      // 坐标符号校验是历史遗留（[1500,1500] 事故是正坐标，maxFocusDistance
      // 已覆盖）。
      !region.every((value) => Number.isInteger(value))
    ) {
      return false;
    }
  }
  if (candidate.attackPriority !== "core" && candidate.attackPriority !== "workers" && candidate.attackPriority !== null) {
    return false;
  }
  return true;
}

/** 规范化（未知字段剔除 + 确定性字段序；或缺失时回退默认值）。 */
export function normalizeMacroPolicy(raw: Record<string, unknown>): MacroPolicy {
  const posture = raw.posture === "aggressive" ? "aggressive" : raw.posture === "harvest" ? "harvest" : "balanced";
  const workerTarget = Number.isInteger(raw.workerTarget) && (raw.workerTarget as number) >= 1 ? (raw.workerTarget as number) : DEFAULT_MACRO_POLICY.workerTarget;
  const militaryRatio = typeof raw.militaryRatio === "number" && raw.militaryRatio >= 0 && raw.militaryRatio <= 1
    ? raw.militaryRatio
    : DEFAULT_MACRO_POLICY.militaryRatio;
  let focusRegion: readonly [number, number] | null = null;
  if (
    Array.isArray(raw.focusRegion) &&
    raw.focusRegion.length === 2 &&
    // 允许负坐标（2026-08-06：生产地图含负坐标区域，t1 Core 在 [-619,-154]）
    raw.focusRegion.every((value) => Number.isInteger(value))
  ) {
    focusRegion = [raw.focusRegion[0], raw.focusRegion[1]] as const;
  }
  const attackPriority = raw.attackPriority === "core" || raw.attackPriority === "workers" ? raw.attackPriority : null;
  return Object.freeze({ posture, workerTarget, militaryRatio, focusRegion, attackPriority });
}

/** 确定性序列化（canonical 键序，供 telemetry 落盘与测试比对）。 */
export function serializeMacroPolicy(policy: MacroPolicy): string {
  const region = policy.focusRegion === null ? null : [policy.focusRegion[0], policy.focusRegion[1]];
  return JSON.stringify({
    posture: policy.posture,
    workerTarget: policy.workerTarget,
    militaryRatio: policy.militaryRatio,
    focusRegion: region,
    attackPriority: policy.attackPriority,
  });
}

/** 从 policy 推导执行层 aggression（posture 映射；harvest/balanced 不改变历史行为）。 */
export function aggressionOf(policy: MacroPolicy): "defensive" | "aggressive" {
  return policy.posture === "aggressive" ? "aggressive" : "defensive";
}
