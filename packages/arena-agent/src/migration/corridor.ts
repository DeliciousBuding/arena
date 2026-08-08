/**
 * 迁移走廊审计（migration-system-v1 §4，评审 P0-1 核心）。
 *
 * 与 auditMigrationTarget（目标点审计）的区别：本模块对**整条实际路径**
 * 做 swept corridor 采样——路径每格 ± corridorWidth（Chebyshev，含边界）
 * 内所有已知资源/敌核合并去重后统计。150 格腿 + 60 格敌核半径下只查
 * leg 终点会把走廊中段完全漏掉（生产实证 t1 迁移教训）；
 * "段中活跃敌核拒"是 P0-1 必测用例。
 *
 * 纯函数、无副作用：给定计划路径 + 测绘事实（survey）输出审计结论，
 * 供 conductor 计划审批、运行中滚动前瞻（auditCorridorLookahead）
 * 与偏离检测（pathDeviation → REPLAN/HOLD）复用同一事实。
 */

import type { KnownResource, EnemyCoreMemory } from "../domain/migration-audit.ts";
import {
  MIGRATION_RESOURCE_FRESH_WINDOW,
  MIGRATION_MIN_FRESH_RESOURCES,
  MIGRATION_ENEMY_ACTIVE_WINDOW,
} from "../domain/migration-audit.ts";
import type { MigrationPosition } from "./plan.ts";

/** 走廊审计宽度默认值（设计 §7：路径 ± 8 格）。 */
export const CORRIDOR_DEFAULT_WIDTH = 8;
/** 滚动前瞻默认格数（设计 §7：20-40 区间中值）。 */
export const CORRIDOR_DEFAULT_LOOKAHEAD = 30;

export interface CorridorSurvey {
  readonly resources: readonly KnownResource[];
  readonly enemyCores: readonly EnemyCoreMemory[];
}

export interface CorridorAuditOptions {
  /** 走廊半宽（Chebyshev，含边界格）。 */
  readonly corridorWidth?: number;
  readonly minFreshResources?: number;
  readonly freshWindowTicks?: number;
  readonly enemyActiveWindowTicks?: number;
}

export interface CorridorAudit {
  readonly ok: boolean;
  /** 拒绝/警告原因（用户可读，中文）。 */
  readonly reasons: readonly string[];
  readonly freshResourceCount: number;
  readonly activeEnemyCoreCount: number;
  /** 实际采样的路径格数（lookahead 为窗口内格数）。 */
  readonly sampledCells: number;
}

export interface PathDeviation {
  readonly deviated: boolean;
  /** 距实际位置最近的路径格下标（并列取先者；空路径为 -1）。 */
  readonly nearestPathIndex: number;
  /** 到最近路径格的 Chebyshev 距离（空路径为 Infinity）。 */
  readonly distance: number;
}

interface Sighted {
  readonly x: number;
  readonly y: number;
  readonly lastSeenTick: number;
}

const chebyshev = (first: MigrationPosition, second: MigrationPosition): number =>
  Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y));

const cellKey = (x: number, y: number): string => `${x},${y}`;

/** 半径内采样并合并去重：同格多次目击只留最新（lastSeenTick 最大者）。 */
function mergeWithinRadius(
  items: readonly Sighted[],
  cells: readonly MigrationPosition[],
  radius: number,
): Map<string, Sighted> {
  const merged = new Map<string, Sighted>();
  for (const cell of cells) {
    for (const item of items) {
      if (chebyshev(cell, item) <= radius) {
        const key = cellKey(item.x, item.y);
        const existing = merged.get(key);
        if (existing === undefined || item.lastSeenTick > existing.lastSeenTick) {
          merged.set(key, item);
        }
      }
    }
  }
  return merged;
}

function auditCells(
  cells: readonly MigrationPosition[],
  survey: CorridorSurvey,
  currentTick: number,
  options: CorridorAuditOptions,
): CorridorAudit {
  if (cells.length === 0) {
    return {
      ok: false,
      reasons: ["路径为空：没有可采样的走廊格"],
      freshResourceCount: 0,
      activeEnemyCoreCount: 0,
      sampledCells: 0,
    };
  }

  const corridorWidth = options.corridorWidth ?? CORRIDOR_DEFAULT_WIDTH;
  const minFreshResources = options.minFreshResources ?? MIGRATION_MIN_FRESH_RESOURCES;
  const freshWindowTicks = options.freshWindowTicks ?? MIGRATION_RESOURCE_FRESH_WINDOW;
  const enemyActiveWindowTicks = options.enemyActiveWindowTicks ?? MIGRATION_ENEMY_ACTIVE_WINDOW;

  const resources = mergeWithinRadius(survey.resources, cells, corridorWidth);
  const enemyCores = mergeWithinRadius(survey.enemyCores, cells, corridorWidth);

  let freshResourceCount = 0;
  for (const resource of resources.values()) {
    if (currentTick - resource.lastSeenTick <= freshWindowTicks) freshResourceCount += 1;
  }
  let activeEnemyCoreCount = 0;
  for (const enemy of enemyCores.values()) {
    if (currentTick - enemy.lastSeenTick <= enemyActiveWindowTicks) activeEnemyCoreCount += 1;
  }

  const reasons: string[] = [];
  if (freshResourceCount < minFreshResources) {
    reasons.push(
      `走廊 ${corridorWidth} 格内新鲜资源 ${freshResourceCount} < ${minFreshResources}（已知 ${resources.size}）——资源不足`,
    );
  }
  if (activeEnemyCoreCount > 0) {
    reasons.push(
      `走廊内有 ${activeEnemyCoreCount} 个活跃敌核记忆（已知 ${enemyCores.size}）——段中敌核风险`,
    );
  }
  return {
    ok: reasons.length === 0,
    reasons,
    freshResourceCount,
    activeEnemyCoreCount,
    sampledCells: cells.length,
  };
}

/** 整条路径的走廊审计（swept corridor，段中活跃敌核即拒）。 */
export function auditCorridor(
  path: readonly MigrationPosition[],
  survey: CorridorSurvey,
  currentTick: number,
  options: CorridorAuditOptions = {},
): CorridorAudit {
  return auditCells(path, survey, currentTick, options);
}

/**
 * 滚动前瞻：只审计 [progressCells, progressCells+lookaheadCells) 窗口
 * （半开区间，越界截断到路径终点）。运行中每 tick 增量调用，
 * 走廊前段出现新活跃敌核 → HOLD/REPLAN。
 */
export function auditCorridorLookahead(
  path: readonly MigrationPosition[],
  progressCells: number,
  lookaheadCells: number = CORRIDOR_DEFAULT_LOOKAHEAD,
  survey: CorridorSurvey,
  currentTick: number,
  options: CorridorAuditOptions = {},
): CorridorAudit {
  const start = Math.min(Math.max(0, progressCells), path.length);
  const end = Math.min(path.length, start + Math.max(0, lookaheadCells));
  const window = path.slice(start, end);
  if (window.length === 0) {
    return {
      ok: false,
      reasons: [`前瞻窗口为空：progressCells=${progressCells} 已到路径终点（长度 ${path.length}）`],
      freshResourceCount: 0,
      activeEnemyCoreCount: 0,
      sampledCells: 0,
    };
  }
  return auditCells(window, survey, currentTick, options);
}

/**
 * 偏离检测：实际位置（如核心当前位置）离最近路径格 Chebyshev 距离
 * > corridorWidth → 已偏离已审走廊 → 触发 REPLAN/HOLD（设计 §4）。
 */
export function pathDeviation(
  plannedPath: readonly MigrationPosition[],
  actualPosition: MigrationPosition,
  corridorWidth: number,
): PathDeviation {
  let nearestPathIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  plannedPath.forEach((cell, index) => {
    const distance = chebyshev(cell, actualPosition);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestPathIndex = index;
    }
  });
  if (nearestPathIndex < 0) {
    return { deviated: true, nearestPathIndex: -1, distance: Number.POSITIVE_INFINITY };
  }
  return {
    deviated: nearestDistance > corridorWidth,
    nearestPathIndex,
    distance: nearestDistance,
  };
}
