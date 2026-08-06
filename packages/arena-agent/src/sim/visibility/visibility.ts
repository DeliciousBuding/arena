/**
 * Visibility 与 observation adapter（S6）：SimWorld → PlayerState（wire 等价）。
 *
 * 规则：Manhattan 视野并集 + integer supercover 遮挡；障碍格自身可见；
 * 己方对象恒全量；敌方/terrain 仅当前可见；完整 state 替换。
 */

import type { PlayerState, WorldObject } from "@arena/arena-hero-ts";
import { cellKey, type Position, type UnitType } from "../../domain/model.ts";
import type { TurnLike } from "../../domain/state-reducer.ts";
import type { RulesManifest } from "../contracts/rules-manifest.ts";
import { compareCodeUnit } from "../deterministic/uuid.ts";
import type { ResolutionEvent } from "../engine/phase.ts";
import type { SimCore, SimWorld } from "../world/types.ts";

/**
 * wire CoreView 要求 MOVING 时带全迁移字段（api-state-model.md Moving Core）。
 * 裸 MOVING（缺字段）无法投影——fail closed，禁止伪造 wire 字段。
 */
function assertProjectableCore(core: SimCore): void {
  if (core.state !== "MOVING") return;
  if (
    core.moveDirection === null ||
    core.moveProgress === null ||
    core.moveRequiredTicks === null ||
    core.destination === null
  ) {
    throw new Error(
      "projectPlayerState: MOVING Core without migration fields (unresolvable external state)",
    );
  }
}

/**
 * from→to 的 supercover 格子集合（含端点与过角时的两侧邻格）。
 * 纯整数运算；corner-touch 任一侧障碍均可阻挡。
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
    // Cell-center → cell-center traversal: compare the next half-cell boundary
    // crossing times without floating point. The old whole-cell comparison added
    // a false corner-side cell for slopes such as 2:3.
    const nextX = (2 * ix + 1) * ny;
    const nextY = (2 * iy + 1) * nx;
    if (nextX < nextY) {
      x += sx;
      ix += 1;
      cells.push([x, y]);
    } else if (nextX > nextY) {
      y += sy;
      iy += 1;
      cells.push([x, y]);
    } else {
      cells.push([x + sx, y], [x, y + sy]);
      x += sx;
      y += sy;
      ix += 1;
      iy += 1;
      cells.push([x, y]);
    }
  }

  const seen = new Set<string>();
  const unique: Position[] = [];
  for (const cell of cells) {
    const key = cellKey(cell);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(cell);
    }
  }
  return unique;
}

function observerRadius(rules: RulesManifest, unitType: UnitType | "CORE"): number {
  if (unitType === "CORE") return rules.rules.core.visionRadius;
  if (unitType === "WORKER") return rules.rules.units.workerVisionRadius;
  if (unitType === "VANGUARD") return rules.rules.units.vanguardVisionRadius;
  return rules.rules.units.rangerVisionRadius;
}

/** 玩家当前可见格集合（Manhattan 并集 + supercover 遮挡）。 */
export function visibleCellSet(world: SimWorld, playerId: string, rules: RulesManifest): Set<string> {
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
        const blocked = line.some((cell, index) =>
          index < line.length - 1 && obstacles.has(cellKey(cell)),
        );
        if (!blocked) seen.add(key);
      }
    }
  };

  if (player.core !== null) observe(player.core.position, observerRadius(rules, "CORE"));
  for (const unit of player.units) observe(unit.position, observerRadius(rules, unit.unitType));
  return seen;
}

/** Sim ResolutionEvent → SDK wire event；event_id 由稳定事件顺序派生。 */
export function toWireEvents(events: readonly ResolutionEvent[]): PlayerState["events"] {
  return events.map((event, index) => ({
    event_id: `sim:${event.tick}:${index}:${event.eventType}:${event.actorId ?? event.targetId ?? "none"}`,
    tick: event.tick,
    event_type: event.eventType,
    reason_code: event.reasonCode,
    actor_id: event.actorId,
    target_id: event.targetId,
    position: event.position,
    values: event.values === null ? null : { ...event.values },
  }));
}

/** 投影当前玩家的私有视图（与线上 PlayerState 同构；完整替换语义）。 */
export function projectPlayerState(
  world: SimWorld,
  playerId: string,
  rules: RulesManifest,
  events: readonly ResolutionEvent[] = [],
): PlayerState {
  const player = world.players.get(playerId);
  if (player === undefined) throw new Error(`projectPlayerState: unknown player ${playerId}`);
  if (world.beacon === null) {
    throw new Error("projectPlayerState: beacon state is required for wire-equivalent projection");
  }

  const visible = visibleCellSet(world, playerId, rules);
  const population = player.units.length;
  // v0.14 协议移除 population_tier/upkeep_next_tick 字段 → 投影显式 null
  // （wire nullable 省略 → domain 显式 null 约定）；v0.11 按旧协议公式推导。
  const tier =
    rules.rulesVersion === "v0.14"
      ? null
      : Math.floor(population / rules.rules.upkeep.tierSize);
  const upkeepNext = tier === null ? null : (tier * (tier + 1)) / 2;

  const visibleObstacleKeys = [...visible]
    .filter((key) => world.terrain.obstacles.has(key))
    .sort(compareCodeUnit);
  const visibleResourceKeys = [...visible]
    .filter((key) => world.terrain.resources.has(key) || world.terrain.piles.has(key))
    .sort(compareCodeUnit);

  const objects: WorldObject[] = [];
  if (visibleObstacleKeys.length > 0) {
    objects.push({ kind: "OBSTACLE", positions: visibleObstacleKeys.map(parseKey) });
  }
  if (visibleResourceKeys.length > 0) {
    objects.push({ kind: "RESOURCE", positions: visibleResourceKeys.map(parseKey) });
  }

  if (player.core !== null) {
    assertProjectableCore(player.core);
    objects.push({
      kind: "CORE",
      id: player.core.id,
      controlled: true,
      owner_username: player.username,
      position: player.core.position,
      hp: player.core.hp,
      shield: player.core.shield,
      state: player.core.state,
      move_direction: player.core.moveDirection,
      move_progress: player.core.moveProgress,
      move_required_ticks: player.core.moveRequiredTicks,
      destination: player.core.destination,
    });
  }

  for (const unit of [...player.units].sort((a, b) => compareCodeUnit(a.id, b.id))) {
    objects.push({
      kind: "UNIT",
      id: unit.id,
      controlled: true,
      position: unit.position,
      hp: unit.hp,
      unit_type: unit.unitType,
      cargo: unit.unitType === "WORKER" ? unit.cargo : null,
    });
  }

  const enemies: WorldObject[] = [];
  for (const [enemyId, enemy] of world.players) {
    if (enemyId === playerId) continue;
    if (enemy.core !== null && visible.has(cellKey(enemy.core.position))) {
      assertProjectableCore(enemy.core);
      enemies.push({
        kind: "CORE",
        id: enemy.core.id,
        controlled: false,
        owner_username: enemy.username,
        position: enemy.core.position,
        hp: enemy.core.hp,
        shield: enemy.core.shield,
        state: enemy.core.state,
        move_direction: enemy.core.moveDirection,
        move_progress: enemy.core.moveProgress,
        move_required_ticks: enemy.core.moveRequiredTicks,
        destination: enemy.core.destination,
      });
    }
    for (const unit of enemy.units) {
      if (!visible.has(cellKey(unit.position))) continue;
      enemies.push({
        kind: "UNIT",
        id: unit.id,
        controlled: false,
        position: unit.position,
        hp: unit.hp,
        unit_type: unit.unitType,
        cargo: null,
      });
    }
  }
  enemies.sort((a, b) => compareCodeUnit("id" in a ? a.id : "", "id" in b ? b.id : ""));
  objects.push(...enemies);

  return {
    status: player.status,
    respawn_at_tick: player.respawnAtTick,
    resources: player.resources,
    population,
    population_tier: tier,
    upkeep_next_tick: upkeepNext,
    champion_beacon: {
      position: world.beacon.position,
      status: world.beacon.status,
      carrier_id: world.beacon.carrierId,
    },
    objects,
    events: toWireEvents(events),
  };
}

function parseKey(key: string): Position {
  const [x, y] = key.split(",").map(Number);
  return [x, y];
}

/** SimWorld → TurnLike（可直接喂 reduceTurn）。 */
export function simTurnLike(
  world: SimWorld,
  playerId: string,
  rules: RulesManifest,
  events: readonly ResolutionEvent[] = [],
): TurnLike {
  const player = world.players.get(playerId);
  if (player === undefined) throw new Error(`simTurnLike: unknown player ${playerId}`);
  const state = projectPlayerState(world, playerId, rules, events);
  const core = player.core;
  const resourceCapacity = Math.max(
    rules.rules.core.minCapacity,
    player.units.length * rules.rules.core.capacityPerUnit,
  );

  return {
    tick: world.tick,
    resources: player.resources,
    resourceCapacity,
    resourceSpace: Math.max(0, resourceCapacity - player.resources),
    units: player.units.map((unit) => ({
      id: unit.id,
      position: unit.position,
      hp: unit.hp,
      unitType: unit.unitType,
      cargo: unit.cargo,
    })),
    workers: player.units.filter((unit) => unit.unitType === "WORKER").map((unit) => ({ ...unit })),
    vanguards: player.units.filter((unit) => unit.unitType === "VANGUARD").map((unit) => ({ ...unit })),
    rangers: player.units.filter((unit) => unit.unitType === "RANGER").map((unit) => ({ ...unit })),
    core: core === null ? null : { ...core, ownerUsername: player.username },
    visibleEnemies: state.objects
      .filter((object) => object.kind === "UNIT" || object.kind === "CORE")
      .filter((object) => object.controlled === false)
      .map((object) => ({
        id: object.id,
        kind: object.kind,
        position: object.position,
        hp: object.hp,
        unit_type: object.kind === "UNIT" ? object.unit_type : undefined,
        owner_username: object.kind === "CORE" ? object.owner_username : undefined,
      })),
    obstacleCells: new Set(
      state.objects.flatMap((object) =>
        object.kind === "OBSTACLE"
          ? object.positions.map((position: Position) => cellKey(position))
          : [],
      ),
    ),
    resourceCells: new Set(
      state.objects.flatMap((object) =>
        object.kind === "RESOURCE"
          ? object.positions.map((position: Position) => cellKey(position))
          : [],
      ),
    ),
    beacon: {
      position: world.beacon!.position,
      status: world.beacon!.status,
      carrier_id: world.beacon!.carrierId,
    },
    events: state.events.map((event) => ({
      ...event,
      values: event.values ?? undefined,
    })),
    state: {
      status: player.status,
      population: player.units.length,
      objects: state.objects,
    },
  };
}
