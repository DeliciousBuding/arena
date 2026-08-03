/**
 * Visibility 与 observation adapter（S6）：SimWorld → PlayerState（wire 等价）。
 *
 * 规则（game-rules.md §219）：Manhattan 视野并集 + integer supercover 遮挡；
 * 障碍格自身可见；己方对象恒全量（含视野外）；敌方/terrain 仅当前可见；
 * 完整 state 替换（非增量 patch）。
 */

import type { PlayerState, WorldObject } from "@arena/arena-hero-ts";
import { cellKey, type Position, type UnitType } from "../../domain/model.ts";
import type { TurnLike } from "../../domain/state-reducer.ts";
import { compareCodeUnit } from "../deterministic/uuid.ts";
import type { SimWorld } from "../world/types.ts";

/* ---------------- integer supercover ---------------- */

/**
 * from→to 的 supercover 格子集合（含 from、to 与过角时的两侧邻格）。
 * 纯整数运算（无浮点）；与官方 "corner-touch 两侧都算、任一侧障碍阻挡" 一致。
 */
export function supercoverLine(from: Position, to: Position): Position[] {
  const cells: Position[] = [[from[0], from[1]]];
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const nx = Math.abs(dx);
  const ny = Math.abs(dy);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  let x = from[0];
  let y = from[1];
  let ix = 0;
  let iy = 0;
  while (ix < nx || iy < ny) {
    const cross = nx * (iy + 1) - ny * (ix + 1);
    if (cross > 0) {
      x += sx;
      ix += 1;
      cells.push([x, y]);
    } else if (cross < 0) {
      y += sy;
      iy += 1;
      cells.push([x, y]);
    } else {
      // 精确过角：两侧格都计入
      cells.push([x + sx, y], [x, y + sy]);
      x += sx;
      y += sy;
      ix += 1;
      iy += 1;
      cells.push([x, y]);
    }
  }
  // 去重（过角路径可能重复）
  const seen = new Set<string>();
  const unique: Position[] = [];
  for (const cell of cells) {
    const key = `${cell[0]},${cell[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(cell);
    }
  }
  return unique;
}

/* ---------------- 视野计算 ---------------- */

const VISION_RADIUS: Readonly<Record<string, number>> = {
  CORE: 5,
  WORKER: 3,
  VANGUARD: 4,
  RANGER: 5,
};

function observerRadius(unitType: UnitType | "CORE"): number {
  return VISION_RADIUS[unitType] ?? 0;
}

/** 玩家当前可见格集合（Manhattan 并集 + supercover 遮挡）。 */
export function visibleCellSet(world: SimWorld, playerId: string): Set<string> {
  const player = world.players.get(playerId);
  if (player === undefined) return new Set();
  const obstacles = world.terrain.obstacles;
  const seen = new Set<string>();

  const observe = (origin: Position, radius: number): void => {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.abs(dx) + Math.abs(dy) > radius) continue;
        const target: Position = [origin[0] + dx, origin[1] + dy];
        const key = cellKey(target);
        if (seen.has(key)) continue;
        const line = supercoverLine(origin, target);
        // 除 target 自身外线上有障碍 → 遮挡；障碍格自身可见
        const blocked = line.some((c, i) => i < line.length - 1 && obstacles.has(cellKey(c)));
        if (!blocked) {
          seen.add(key);
        }
      }
    }
  };

  if (player.core !== null) {
    observe(player.core.position, observerRadius("CORE"));
  }
  for (const unit of player.units) {
    observe(unit.position, observerRadius(unit.unitType));
  }
  return seen;
}

/* ---------------- PlayerState 投影 ---------------- */

/** 投影当前玩家的私有视图（与线上 PlayerState 同构；完整替换语义）。 */
export function projectPlayerState(
  world: SimWorld,
  playerId: string,
  events: readonly unknown[] = [],
): PlayerState {
  const player = world.players.get(playerId);
  if (player === undefined) {
    throw new Error(`projectPlayerState: unknown player ${playerId}`);
  }
  const visible = visibleCellSet(world, playerId);
  const population = player.units.length;
  const tier = Math.floor(population / 20);
  const upkeepNext = (tier * (tier + 1)) / 2;

  // terrain batching（canonical：positions 排序）
  const visibleObstacles: Position[] = [];
  const visibleResources: Position[] = [];
  for (const key of visible) {
    if (world.terrain.obstacles.has(key)) {
      visibleObstacles.push(parseKey(key));
    }
    if (world.terrain.resources.has(key)) {
      visibleResources.push(parseKey(key));
    }
  }
  const sortPositions = (a: Position, b: Position): number =>
    a[0] - b[0] || a[1] - b[1];

  const objects: WorldObject[] = [];
  if (visibleObstacles.length > 0) {
    objects.push({
      kind: "OBSTACLE",
      positions: visibleObstacles.sort(sortPositions),
    } as WorldObject);
  }
  if (visibleResources.length > 0) {
    objects.push({
      kind: "RESOURCE",
      positions: visibleResources.sort(sortPositions),
    } as WorldObject);
  }

  // 己方 Core/Units：恒全量（含视野外）
  if (player.core !== null) {
    objects.push({
      kind: "CORE",
      id: player.core.id,
      controlled: true,
      owner_username: player.username,
      position: player.core.position,
      hp: player.core.hp,
      shield: player.core.shield,
      state: player.core.state,
      move_direction: null,
      move_progress: null,
      move_required_ticks: null,
      destination: null,
    } as WorldObject);
  }
  const sortedUnits = [...player.units].sort((a, b) => compareCodeUnit(a.id, b.id));
  for (const unit of sortedUnits) {
    objects.push({
      kind: "UNIT",
      id: unit.id,
      controlled: true,
      position: unit.position,
      hp: unit.hp,
      unit_type: unit.unitType,
      cargo: unit.unitType === "WORKER" ? unit.cargo : undefined,
    } as WorldObject);
  }

  // 敌方：仅可见格
  const enemies: WorldObject[] = [];
  for (const [enemyId, enemy] of world.players) {
    if (enemyId === playerId) continue;
    if (enemy.core !== null && visible.has(cellKey(enemy.core.position))) {
      enemies.push({
        kind: "CORE",
        id: enemy.core.id,
        controlled: false,
        owner_username: enemy.username,
        position: enemy.core.position,
        hp: enemy.core.hp,
        shield: enemy.core.shield,
        state: enemy.core.state,
        move_direction: null,
        move_progress: null,
        move_required_ticks: null,
        destination: null,
      } as WorldObject);
    }
    for (const unit of enemy.units) {
      if (visible.has(cellKey(unit.position))) {
        enemies.push({
          kind: "UNIT",
          id: unit.id,
          controlled: false,
          position: unit.position,
          hp: unit.hp,
          unit_type: unit.unitType,
        } as WorldObject);
      }
    }
  }
  objects.push(...enemies.sort((a, b) => compareCodeUnit((a as { id?: string }).id ?? "", (b as { id?: string }).id ?? "")));

  return {
    status: player.status,
    respawn_at_tick: null,
    resources: player.resources,
    population,
    population_tier: tier,
    upkeep_next_tick: upkeepNext,
    champion_beacon: {
      position: world.beacon?.position ?? [0, 0],
      status: null,
      carrier_id: null,
    },
    objects,
    events: [...events] as unknown as PlayerState["events"],
  };
}

function parseKey(key: string): Position {
  const [x, y] = key.split(",").map(Number);
  return [x, y];
}

/* ---------------- TurnLike 适配（复用 domain/state-reducer） ---------------- */

/** SimWorld → TurnLike（鸭子类型，可直接喂 reduceTurn）。 */
export function simTurnLike(world: SimWorld, playerId: string, events: readonly unknown[] = []): TurnLike {
  const player = world.players.get(playerId);
  if (player === undefined) {
    throw new Error(`simTurnLike: unknown player ${playerId}`);
  }
  const state = projectPlayerState(world, playerId, events);
  const core = player.core;
  return {
    tick: world.tick,
    resources: player.resources,
    resourceCapacity: Math.max(10, player.units.length * 5),
    resourceSpace: Math.max(0, Math.max(10, player.units.length * 5) - player.resources),
    units: player.units.map((u) => ({
      id: u.id,
      position: u.position,
      hp: u.hp,
      unitType: u.unitType,
      cargo: u.cargo,
    })),
    workers: player.units.filter((u) => u.unitType === "WORKER").map((u) => ({ ...u })),
    vanguards: player.units.filter((u) => u.unitType === "VANGUARD").map((u) => ({ ...u })),
    rangers: player.units.filter((u) => u.unitType === "RANGER").map((u) => ({ ...u })),
    core: core === null ? null : { ...core, ownerUsername: player.username },
    visibleEnemies: state.objects
      .filter((o) => o.kind === "UNIT" || o.kind === "CORE")
      .filter((o) => "controlled" in o && o.controlled === false)
      .map((o) => ({
        id: o.id ?? "",
        kind: o.kind as "UNIT" | "CORE",
        position: o.position ?? ([0, 0] as Position),
        hp: o.hp ?? 0,
        unit_type: o.kind === "UNIT" ? (o as { unit_type?: UnitType }).unit_type : undefined,
        owner_username: o.kind === "CORE" ? (o as { owner_username?: string }).owner_username : undefined,
      })),
    obstacleCells: new Set(
      state.objects
        .filter((o) => o.kind === "OBSTACLE")
        .flatMap((o) => (o as { positions: readonly Position[] }).positions.map((p) => cellKey(p))),
    ),
    resourceCells: new Set(
      state.objects
        .filter((o) => o.kind === "RESOURCE")
        .flatMap((o) => (o as { positions: readonly Position[] }).positions.map((p) => cellKey(p))),
    ),
    beacon: {
      position: world.beacon?.position ?? ([0, 0] as Position),
      status: "GROUND",
      carrier_id: null,
    },
    events: [...events] as unknown as TurnLike["events"],
    state: {
      status: player.status,
      population: player.units.length,
      objects: state.objects as unknown[],
    },
  };
}
