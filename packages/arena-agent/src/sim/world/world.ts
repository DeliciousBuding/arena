/**
 * SimWorld 构造、occupancy 索引与不变量（S2）。
 *
 * 不变量（invariant）在构造后与每次结算提交前检查；任一失败抛错且
 * 不返回半更新 world（配合 settlement 的 atomic commit）。
 */

import { cellKey, type Direction, type Position } from "../../domain/model.ts";
import { assertSafeCoordinate } from "../deterministic/coordinate.ts";
import { assertCanonicalUuid } from "../deterministic/uuid.ts";
import type { SimPlayer, SimUnit, SimWorld } from "./types.ts";

export const CELL_ENTITY_CAPACITY = 2;

const DIRECTION_DELTA: Readonly<Record<Direction, readonly [number, number]>> = {
  UP: [0, -1],
  DOWN: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
};

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
  for (const [key, node] of world.terrain.resources) {
    try {
      assertSafeCoordinate(node.cell);
    } catch (error) {
      problems.push((error as Error).message);
    }
    if (cellKey(node.cell) !== key) problems.push(`resource node key mismatch: ${key}`);
  }
  for (const [key, pile] of world.terrain.piles) {
    try {
      assertSafeCoordinate(pile.cell);
    } catch (error) {
      problems.push((error as Error).message);
    }
    if (cellKey(pile.cell) !== key) problems.push(`resource pile key mismatch: ${key}`);
  }
  if (world.beacon !== null) {
    try {
      assertSafeCoordinate(world.beacon.position);
    } catch (error) {
      problems.push((error as Error).message);
    }
    if (world.beacon.status === "CARRIED" && world.beacon.carrierId === null) {
      problems.push("carried beacon requires carrierId");
    }
    if (world.beacon.status === "GROUND" && world.beacon.carrierId !== null) {
      problems.push("ground beacon cannot have carrierId");
    }
    if (world.beacon.carrierId !== null) {
      let carrierFound = false;
      for (const player of world.players.values()) {
        if (
          world.beacon.carrierId === player.core?.id ||
          player.units.some((unit) => unit.id === world.beacon!.carrierId)
        ) {
          carrierFound = true;
          break;
        }
      }
      if (!carrierFound) problems.push(`beacon carrier not found: ${world.beacon.carrierId}`);
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
    // RESPAWNING = 舰队已移除（combat 摧毁或待重生）；core/units 必须为空
    if (player.status === "RESPAWNING" && (player.core !== null || player.units.length > 0)) {
      problems.push(`player ${player.id} RESPAWNING must have no core or units`);
    }
    if (player.core !== null) {
      if (player.core.hp < 0 || player.core.hp > 5) problems.push(`core ${player.core.id} hp out of range`);
      // 持有 Beacon 的玩家盾上限 10（maxShieldWithBeacon），否则 5
      const beaconShieldCap = world.beacon !== null &&
        world.beacon.status === "CARRIED" &&
        world.beacon.carrierId !== null &&
        (world.beacon.carrierId === player.core.id ||
          player.units.some((unit) => unit.id === world.beacon!.carrierId))
        ? 10
        : 5;
      if (player.core.shield < 0 || player.core.shield > beaconShieldCap) {
        problems.push(`core ${player.core.id} shield out of range`);
      }
    }
    for (const unit of player.units) {
      const max = HP_MAX[unit.unitType];
      if (unit.hp < 0 || unit.hp > max) problems.push(`unit ${unit.id} hp out of range`);
      if (unit.cargo < 0 || unit.cargo > 2) problems.push(`unit ${unit.id} cargo out of range`);
      if (!Number.isInteger(unit.cargo)) problems.push(`unit ${unit.id} cargo must be an integer`);
      if (unit.unitType !== "WORKER" && unit.cargo !== 0) {
        problems.push(`non-worker unit ${unit.id} carries cargo`);
      }
    }
  }
  // 5b. 资源堆必须是正整数；0 数量应删除 key，避免幽灵资源格。
  for (const [key, pile] of world.terrain.piles) {
    if (!Number.isInteger(pile.amount) || pile.amount <= 0) {
      problems.push(`pile ${key} amount must be a positive integer`);
    }
  }

  // 5c. Core 迁移字段一致性（game-rules.md Four-Tick Core migration）：
  //     NORMAL → 四字段全 null；MOVING → 四字段全给且自洽，或全缺（裸 MOVING，
  //     外部快照进度未知，settlement 标记 unsupported）。
  for (const player of world.players.values()) {
    const core = player.core;
    if (core === null) continue;
    const hasAny =
      core.moveDirection !== null ||
      core.moveProgress !== null ||
      core.moveRequiredTicks !== null ||
      core.destination !== null;
    const hasAll =
      core.moveDirection !== null &&
      core.moveProgress !== null &&
      core.moveRequiredTicks !== null &&
      core.destination !== null;
    if (core.state === "NORMAL" && hasAny) {
      problems.push(`core ${core.id} NORMAL but has migration fields`);
    }
    if (core.state === "MOVING" && hasAny && !hasAll) {
      problems.push(`core ${core.id} MOVING with partial migration fields`);
    }
    if (core.state === "MOVING" && hasAll) {
      const direction = core.moveDirection!;
      const [dx, dy] = DIRECTION_DELTA[direction];
      if (cellKey(core.destination!) !== cellKey([core.position[0] + dx, core.position[1] + dy])) {
        problems.push(`core ${core.id} destination does not match direction`);
      }
      if (core.moveRequiredTicks! < 1) {
        problems.push(`core ${core.id} moveRequiredTicks must be at least 1`);
      }
      if (core.moveProgress! < 1 || core.moveProgress! > core.moveRequiredTicks!) {
        problems.push(`core ${core.id} moveProgress out of 1..moveRequiredTicks range`);
      }
    }
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
