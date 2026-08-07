/**
 * Mission 纯函数助手（Phase 0 contract freeze）。
 *
 * 所有函数严格 deterministic、无 I/O、无副作用。
 * 最后更新：2026-08-08
 */

import type { Mission, MissionStatus } from "./control-types.ts";

/** 默认 stale 阈值（tick）：超过此值未更新视为过期。 */
export const DEFAULT_MISSION_STALE_TICKS = 16;

/** 终态 status 集合——这些状态的 mission 不会再发生变化。 */
const TERMINAL_STATUSES: ReadonlySet<MissionStatus> = new Set([
  "SATISFIED",
  "CANCELLED",
  "EXPIRED",
  "FAILED",
]);

/**
 * 判断 mission 是否已过期（当前 tick > expiresAtTick）。
 * 过期 mission 必须被忽略（fail-open：回到现有 tenant planner）。
 */
export function isMissionExpired(mission: Mission, currentTick: number): boolean {
  return currentTick > mission.expiresAtTick;
}

/**
 * 判断 mission 是否处于终态（SATISFIED/CANCELLED/EXPIRED/FAILED）。
 * 终态 mission 不应再被分配给 Fleet。
 */
export function isMissionTerminal(mission: Mission): boolean {
  return TERMINAL_STATUSES.has(mission.status);
}

/**
 * 判断 mission 是否活跃（可被 Fleet 执行）。
 * 活跃状态 = ASSIGNED 或 ACTIVE，且未过期。
 */
export function isMissionActive(mission: Mission, currentTick: number): boolean {
  if (isMissionExpired(mission, currentTick)) return false;
  return mission.status === "ASSIGNED" || mission.status === "ACTIVE";
}

/**
 * 判断 mission 是否 stale——正在执行（ASSIGNED/ACTIVE）但超过 maxStaleTicks
 * 未推进（如 Fleet 集结不齐、目标不可达）。用于 Director 检测需要 replan 的
 * 卡住任务。
 *
 * 语义：
 * - 终结态（SATISFIED/CANCELLED/EXPIRED/FAILED）不算 stale；
 * - 已 hard-expire（currentTick > expiresAtTick）不算 stale——走过期路径，
 *   过期是更明确的状态；
 * - 仅 ASSIGNED/ACTIVE 且 issued 后超时才算 stale——PROPOSED 是尚未分配，
 *   由 Director 正常 replan 处理，不在此处报告卡住。
 */
export function isMissionStale(
  mission: Mission,
  currentTick: number,
  maxStaleTicks: number = DEFAULT_MISSION_STALE_TICKS,
): boolean {
  if (isMissionTerminal(mission)) return false;
  if (isMissionExpired(mission, currentTick)) return false;
  if (mission.status !== "ASSIGNED" && mission.status !== "ACTIVE") return false;
  return currentTick - mission.issuedAtTick > maxStaleTicks;
}

/**
 * revision 比较：a 是否比 b 更新（revision 数值更大）。
 * 严格大于才算新——相同 revision 视为重复，不覆盖。
 */
export function isNewerMissionRevision(a: { readonly revision: number }, b: { readonly revision: number }): boolean {
  return a.revision > b.revision;
}

/**
 * 比较两个 mission 的 revision——返回 -1/0/1（可用于 sort）。
 */
export function compareMissionRevision(
  a: { readonly revision: number },
  b: { readonly revision: number },
): -1 | 0 | 1 {
  if (a.revision < b.revision) return -1;
  if (a.revision > b.revision) return 1;
  return 0;
}

/**
 * 按 revision 取最新 mission（revision 最大者）。
 * ties 时返回第一个（确定性：输入顺序决定）。
 */
export function latestMission<T extends { readonly revision: number }>(missions: readonly T[]): T | undefined {
  if (missions.length === 0) return undefined;
  let best = missions[0];
  for (let i = 1; i < missions.length; i++) {
    if (missions[i].revision > best.revision) best = missions[i];
  }
  return best;
}

