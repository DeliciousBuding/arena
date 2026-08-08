/**
 * 核心迁移目标军事审计（2026-08-08，migration-audit-v1）：
 * 生产实证 t1 危险迁移——并行 driver 将 t1 从富矿区 [-619,-154]（227 资源/25 格）
 * 迁往 [-565,-95]（1 资源/25 格 + 21 个敌核记忆 ≤80 格）。系统允许任何
 * "目标资源贫瘠/迁入敌区"的迁移被随意发起，无军事层审计。
 *
 * 本模块纯函数、无副作用：给定迁移目标与测绘事实（已知资源 + 敌核记忆），
 * 输出"资源密度"与"敌核密度"两个审计维度 + 通过/拒绝结论。供核心迁移
 * driver 预检、指挥面板展示、以及未来 decideCore 资源性迁移复用同一事实。
 * 资源贫瘠 = 弃富投贫（经济自杀）；活跃敌核贴脸 = 迁入战区（核心无防御纵深）。
 */

import type { Position } from "./model.ts";

/** 已知资源（survey.resources 行）。 */
export interface KnownResource {
  readonly x: number;
  readonly y: number;
  readonly lastSeenTick: number;
}

/** 敌核记忆（survey.core_hunts 行）。 */
export interface EnemyCoreMemory {
  readonly x: number;
  readonly y: number;
  readonly lastSeenTick: number;
}

export interface MigrationAuditOptions {
  /** 资源统计半径（Chebyshev）：worker 采集带核心 32 格外环 → 30 为保守核区口径。 */
  readonly resourceRadius?: number;
  /** 资源"新鲜"窗口（tick）：lastSeenTick 距今 ≤ 该值 = 近期确认存在。
   *  资源动态消失（t4 实证 2-6 tick 蒸发），旧记录不可信。 */
  readonly resourceFreshWindow?: number;
  /** 核心区最低新鲜资源数：低于该值判定为资源贫瘠。 */
  readonly minFreshResources?: number;
  /** 敌核统计半径（Chebyshev）：该半径内敌核构成站立威胁（raid-risk 24 格
   *  守家半径的军事纵深放大到 60）。 */
  readonly enemyRadius?: number;
  /** 敌核"活跃"窗口（tick）：lastSeenTick 距今 ≤ 该值 = 可能仍存活。 */
  readonly enemyActiveWindow?: number;
}

export interface MigrationAudit {
  /** 是否通过（资源达标 且 无活跃敌核贴脸）。 */
  readonly ok: boolean;
  /** 拒绝/警告原因（用户可读，中文）。 */
  readonly reasons: readonly string[];
  /** 资源半径内已知资源总数（含陈旧）。 */
  readonly resourceCount: number;
  /** 资源半径内新鲜资源数（近期确认存在）。 */
  readonly freshResourceCount: number;
  /** 敌核半径内敌核记忆总数。 */
  readonly enemyCoreCount: number;
  /** 敌核半径内活跃敌核数（近期目击，可能存活）。 */
  readonly activeEnemyCoreCount: number;
  /** 迁移距离（Chebyshev from→to）。 */
  readonly distance: number;
}

export const MIGRATION_RESOURCE_RADIUS = 30;
export const MIGRATION_RESOURCE_FRESH_WINDOW = 4000;
export const MIGRATION_MIN_FRESH_RESOURCES = 8;
export const MIGRATION_ENEMY_RADIUS = 60;
export const MIGRATION_ENEMY_ACTIVE_WINDOW = 3000;

/** 核心迁移目标军事审计（确定性级联，保守优先）。 */
export function auditMigrationTarget(
  from: Position,
  to: Position,
  resources: readonly KnownResource[],
  enemyCores: readonly EnemyCoreMemory[],
  currentTick: number,
  options: MigrationAuditOptions = {},
): MigrationAudit {
  const resourceRadius = options.resourceRadius ?? MIGRATION_RESOURCE_RADIUS;
  const resourceFreshWindow = options.resourceFreshWindow ?? MIGRATION_RESOURCE_FRESH_WINDOW;
  const minFreshResources = options.minFreshResources ?? MIGRATION_MIN_FRESH_RESOURCES;
  const enemyRadius = options.enemyRadius ?? MIGRATION_ENEMY_RADIUS;
  const enemyActiveWindow = options.enemyActiveWindow ?? MIGRATION_ENEMY_ACTIVE_WINDOW;

  const inRadius = (p: { readonly x: number; readonly y: number }, r: number): boolean =>
    Math.max(Math.abs(p.x - to[0]), Math.abs(p.y - to[1])) <= r;

  const nearResources = resources.filter((r) => inRadius(r, resourceRadius));
  const freshResourceCount = nearResources.filter(
    (r) => currentTick - r.lastSeenTick <= resourceFreshWindow,
  ).length;
  const nearEnemies = enemyCores.filter((e) => inRadius(e, enemyRadius));
  const activeEnemyCoreCount = nearEnemies.filter(
    (e) => currentTick - e.lastSeenTick <= enemyActiveWindow,
  ).length;

  const reasons: string[] = [];
  if (freshResourceCount < minFreshResources) {
    reasons.push(
      `目标区资源贫瘠：${resourceRadius} 格内新鲜资源 ${freshResourceCount} < ${minFreshResources}（已知 ${nearResources.length}）——弃富投贫`,
    );
  }
  if (activeEnemyCoreCount > 0) {
    reasons.push(
      `目标区 ${enemyRadius} 格内有 ${activeEnemyCoreCount} 个活跃敌核记忆（总 ${nearEnemies.length}）——迁入战区风险`,
    );
  }

  return {
    ok: reasons.length === 0,
    reasons,
    resourceCount: nearResources.length,
    freshResourceCount,
    enemyCoreCount: nearEnemies.length,
    activeEnemyCoreCount,
    distance: Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1])),
  };
}
