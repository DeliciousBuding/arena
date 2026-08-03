/**
 * SimWorld 构造、occupancy 索引与不变量（S2）。
 *
 * 不变量（invariant）在构造后与每次结算提交前检查；任一失败抛错且
 * 不返回半更新 world（配合 settlement 的 atomic commit）。
 */

import { cellKey, type Position } from "../../domain/model.ts";
import { assertSafeCoordinate } from "../deterministic/coordinate.ts";
import { assertCanonicalUuid } from "../deterministic/uuid.ts";
import type { SimPlayer, SimUnit, SimWorld } from "./types.ts";

export const CELL_ENTITY_CAPACITY = 2;

export class WorldInvariantError extends Error {
  constructor(message: string) {
    super(`sim world invariant: ${message}`);
    this.name = "WorldInvariantError";
  }
}

/** 重建 occupancy 索引（cellKey → 占位实体数）。 */
export function buildOccupancy(world: SimWorld): Map<string, number> {
  const cells = new Map<string, number>();
  const inc = (position: Position): void => {
    const key = cellKey(position);
    cells.set(key, (cells.get(key) ?? 0) + 1);
  };
  for (const player of world.players.values()) {
    if (player.core !== null) inc(player.core.position);
    for (const unit of player.units) inc(unit.position);
  }
  return cells;
}

/**
 * 校验全部不变量。返回问题列表（空 = 通过）。
 * 位置/ID 校验 fail fast（抛错）；跨实体校验收集全部问题。
 */
export function validateWorld(world: SimWorld): string[] {
  const problems: string[] = [];

  // 1. tick / resolvedTickCount 单调合法
  if (!Number.isInteger(world.tick) || world.tick < 1) {
    problems.push(`invalid tick: ${world.tick}`);
  }
  if (!Number.isInteger(world.resolvedTickCount) || world.resolvedTickCount < 0) {
    problems.push(`invalid resolvedTickCount: ${world.resolvedTickCount}`);
  }
  if (world.resolvedTickCount > world.tick) {
    problems.push(`resolvedTickCount (${world.resolvedTickCount}) exceeds tick (${world.tick})`);
  }

  // 2. 坐标全部 safe integer
  for (const player of world.players.values()) {
    if (player.core !== null) {
      try {
        assertSafeCoordinate(player.core.position);
      } catch (error) {
        problems.push((error as Error).message);
      }
      for (const unit of player.units) {
        try {
          assertSafeCoordinate(unit.position);
        } catch (error) {
          problems.push((error as Error).message);
        }
      }
    }
  }
  for (const key of world.terrain.obstacles) {
    const [x, y] = key.split(",").map(Number);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
      problems.push(`terrain obstacle unsafe coordinate: ${key}`);
    }
  }

  // 3. id 全局唯一（units + cores）
  const seenIds = new Set<string>();
  for (const player of world.players.values()) {
    if (player.core !== null) {
      try {
        assertCanonicalUuid(player.core.id);
      } catch (error) {
        problems.push((error as Error).message);
      }
      if (seenIds.has(player.core.id)) problems.push(`duplicate core id: ${player.core.id}`);
      seenIds.add(player.core.id);
    }
    for (const unit of player.units) {
      try {
        assertCanonicalUuid(unit.id);
      } catch (error) {
        problems.push((error as Error).message);
      }
      if (seenIds.has(unit.id)) problems.push(`duplicate unit id: ${unit.id}`);
      seenIds.add(unit.id);
    }
  }

  // 4. owner 引用有效
  for (const player of world.players.values()) {
    for (const unit of player.units) {
      if (unit.owner !== player.id) {
        problems.push(`unit ${unit.id} owner ${unit.owner} not in player ${player.id}`);
      }
    }
  }

  // 5. 资源/cargo/hp/shield 非负且不超上限
  const HP_MAX: Record<string, number> = { WORKER: 2, VANGUARD: 4, RANGER: 2 };
  for (const player of world.players.values()) {
    if (player.resources < 0) problems.push(`player ${player.id} negative resources`);
    if (player.core !== null) {
      if (player.core.hp < 0 || player.core.hp > 5) problems.push(`core ${player.core.id} hp out of range`);
      if (player.core.shield < 0 || player.core.shield > 5) {
        problems.push(`core ${player.core.id} shield out of range`);
      }
    }
    for (const unit of player.units) {
      const max = HP_MAX[unit.unitType];
      if (unit.hp < 0 || unit.hp > max) problems.push(`unit ${unit.id} hp out of range`);
      if (unit.cargo < 0 || unit.cargo > 2) problems.push(`unit ${unit.id} cargo out of range`);
    }
  }
  // 5b. 资源堆非负
  for (const [key, pile] of world.terrain.piles) {
    if (pile.amount < 0) problems.push(`pile ${key} negative amount`);
  }

  // 6. occupancy 与对象位置一致 + 每格容量 + 敌我（跨玩家）不共格
  const occupancy = new Map<string, string[]>();
  for (const player of world.players.values()) {
    if (player.core !== null) {
      const key = cellKey(player.core.position);
      occupancy.set(key, [...(occupancy.get(key) ?? []), `core:${player.core.id}`]);
    }
    for (const unit of player.units) {
      const key = cellKey(unit.position);
      occupancy.set(key, [...(occupancy.get(key) ?? []), `unit:${unit.id}`]);
    }
  }
  for (const [key, occupants] of occupancy) {
    if (occupants.length > CELL_ENTITY_CAPACITY) {
      problems.push(`cell ${key} occupancy ${occupants.length} exceeds ${CELL_ENTITY_CAPACITY}`);
    }
    // 跨玩家共格检查：同格内实体属于多个 player → 敌我不共格
    const playersInCell = new Set<string>();
    for (const player of world.players.values()) {
      if (player.core !== null && cellKey(player.core.position) === key) playersInCell.add(player.id);
      for (const unit of player.units) {
        if (cellKey(unit.position) === key) playersInCell.add(unit.owner);
      }
    }
    if (playersInCell.size > 1) {
      problems.push(`cell ${key} shared by players [${[...playersInCell].join(",")}]`);
    }
  }

  return problems;
}

/** 校验不变量，失败抛 WorldInvariantError（全部问题列出）。 */
export function assertWorldInvariants(world: SimWorld): void {
  const problems = validateWorld(world);
  if (problems.length > 0) {
    throw new WorldInvariantError(problems.join("; "));
  }
}

/** 便利函数：收集某玩家全部活单位（含 Core 占位视为 0 人口）。 */
export function livingUnits(player: SimPlayer): readonly SimUnit[] {
  return player.units;
}
