/**
 * Core migration phase（P06）：advance non-due migrations and resolve new
 * START_MOVE/CANCEL_MOVE actions after P05 global Unit/Core movement.
 */

import { cellKey, type Direction, type Plan, type Position } from "../../domain/model.ts";
import { compareCodeUnit } from "../deterministic/uuid.ts";
import type { SimCore, SimFeature, SimPlayer, SimWorld } from "../world/types.ts";
import { CELL_ENTITY_CAPACITY } from "../world/world.ts";
import { eventOf, outcome, type Phase, type ResolutionEvent } from "./phase.ts";

export const CORE_MIGRATION_REQUIRED_TICKS = 4;

const DIRECTION_DELTA: Readonly<Record<Direction, readonly [number, number]>> = {
  UP: [0, -1],
  DOWN: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
};

export interface CoreMigrationResolution {
  readonly events: readonly ResolutionEvent[];
  readonly updatedCores: ReadonlyMap<string, SimCore>;
}

function stepCell(source: Position, direction: Direction): Position {
  const [dx, dy] = DIRECTION_DELTA[direction];
  return [source[0] + dx, source[1] + dy];
}

function sortedPlayers(world: SimWorld): SimPlayer[] {
  return [...world.players.values()].sort((a, b) => compareCodeUnit(a.id, b.id));
}

function ownUnitsAt(world: SimWorld, playerId: string, destinationKey: string): number {
  return world.players
    .get(playerId)
    ?.units.filter((unit) => cellKey(unit.position) === destinationKey).length ?? 0;
}

function hasEnemyOccupant(
  world: SimWorld,
  effectiveCores: ReadonlyMap<string, SimCore>,
  playerId: string,
  destinationKey: string,
): boolean {
  for (const player of world.players.values()) {
    if (player.id === playerId) continue;
    const core = effectiveCores.get(player.id) ?? player.core;
    if (core !== null && cellKey(core.position) === destinationKey) return true;
    if (player.units.some((unit) => cellKey(unit.position) === destinationKey)) return true;
  }
  return false;
}

function startFailureReason(
  world: SimWorld,
  effectiveCores: ReadonlyMap<string, SimCore>,
  playerId: string,
  destination: Position,
): string | null {
  const [x, y] = destination;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return "CORE_DESTINATION_OUT_OF_BOUNDS";
  const destinationKey = cellKey(destination);
  if (world.terrain.obstacles.has(destinationKey) || world.terrain.resources.has(destinationKey)) {
    return "CORE_DESTINATION_TERRAIN_BLOCKED";
  }
  if (hasEnemyOccupant(world, effectiveCores, playerId, destinationKey)) {
    return "CORE_DESTINATION_OCCUPIED";
  }
  if (ownUnitsAt(world, playerId, destinationKey) + 1 > CELL_ENTITY_CAPACITY) {
    return "CELL_UNIT_LIMIT";
  }
  return null;
}

function resolvePlanActions(
  world: SimWorld,
  plans: ReadonlyMap<string, Plan>,
  effectiveCores: Map<string, SimCore>,
  events: ResolutionEvent[],
): void {
  for (const playerId of [...world.players.keys()].sort(compareCodeUnit)) {
    const plan = plans.get(playerId);
    const action = plan?.coreAction;
    if (
      action === null ||
      action === undefined ||
      action.type === "WAIT" ||
      (action.type !== "START_MOVE" && action.type !== "CANCEL_MOVE")
    ) {
      continue;
    }
    const core = effectiveCores.get(playerId) ?? world.players.get(playerId)!.core;
    if (core === null) continue;

    if (action.type === "START_MOVE") {
      if (core.state === "MOVING") {
        events.push(eventOf(world.tick, "CORE_ACTION_FAILED", {
          reasonCode: "CORE_ALREADY_MOVING",
          actorId: core.id,
          position: core.position,
        }));
        continue;
      }
      const destination = stepCell(core.position, action.direction);
      const failure = startFailureReason(world, effectiveCores, playerId, destination);
      if (failure !== null) {
        events.push(eventOf(world.tick, "CORE_MOVE_START_FAILED", {
          reasonCode: failure,
          actorId: core.id,
          position: core.position,
        }));
        continue;
      }
      effectiveCores.set(playerId, {
        ...core,
        state: "MOVING",
        moveDirection: action.direction,
        moveProgress: 1,
        moveRequiredTicks: CORE_MIGRATION_REQUIRED_TICKS,
        destination,
      });
      events.push(eventOf(world.tick, "CORE_MOVE_STARTED", {
        actorId: core.id,
        position: core.position,
        values: { destination, progress: 1, required: CORE_MIGRATION_REQUIRED_TICKS },
      }));
      continue;
    }

    if (core.state !== "MOVING") {
      events.push(eventOf(world.tick, "CORE_ACTION_FAILED", {
        reasonCode: "CORE_NOT_MOVING",
        actorId: core.id,
        position: core.position,
      }));
      continue;
    }
    effectiveCores.set(playerId, {
      ...core,
      state: "NORMAL",
      moveDirection: null,
      moveProgress: null,
      moveRequiredTicks: null,
      destination: null,
    });
    events.push(eventOf(world.tick, "CORE_MOVE_CANCELLED", {
      actorId: core.id,
      position: core.position,
    }));
  }
}

/** Pure P06 resolution. Due fourth-Tick moves have already resolved in P05. */
export function resolveCoreMigration(
  world: SimWorld,
  plans: ReadonlyMap<string, Plan>,
): CoreMigrationResolution {
  const events: ResolutionEvent[] = [];
  const updatedCores = new Map<string, SimCore>();

  for (const player of sortedPlayers(world)) {
    const core = player.core;
    if (core === null || core.state !== "MOVING") continue;
    if (
      core.moveDirection === null ||
      core.moveProgress === null ||
      core.moveRequiredTicks === null ||
      core.destination === null
    ) {
      continue;
    }
    const progress = core.moveProgress + 1;
    // P05 consumes every due move. This branch only advances 1→2 or 2→3.
    if (progress >= core.moveRequiredTicks) continue;
    updatedCores.set(player.id, { ...core, moveProgress: progress });
    events.push(eventOf(world.tick, "CORE_MOVE_PROGRESS", {
      actorId: core.id,
      position: core.position,
      values: { progress, required: core.moveRequiredTicks },
    }));
  }

  resolvePlanActions(world, plans, updatedCores, events);
  return { events, updatedCores };
}

export const coreMigrationPhase: Phase = {
  id: "P06-core-migration-actions",
  officialPhase: 4,
  run: (draft, ctx) => {
    const resolution = resolveCoreMigration(draft, ctx.plans);
    if (resolution.updatedCores.size > 0) {
      const players = new Map(draft.players);
      for (const [playerId, core] of resolution.updatedCores) {
        const player = players.get(playerId);
        if (player !== undefined) players.set(playerId, { ...player, core });
      }
      (draft as { players: typeof draft.players }).players = players;
    }
    const unsupported: SimFeature[] = ctx.features.has("core-migration") ? ["core-migration"] : [];
    return outcome({ events: resolution.events, unsupported });
  },
};
