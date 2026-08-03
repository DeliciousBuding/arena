/**
 * Movement resolver（S4/P05）：Unit move 与到期 Core migration 共用一个全局依赖图。
 *
 * 官方语义：所有 Unit MOVE 与第四 Tick Core real move 同时解析；跨玩家争抢、
 * swap、占用依赖与容量不能按 resolver 顺序近似。
 */

import { cellKey, type Direction, type Plan, type Position } from "../../domain/model.ts";
import { compareCodeUnit, compareUuidRaw, sortByUuidRaw } from "../deterministic/uuid.ts";
import type { SimCore, SimPlayer, SimWorld } from "../world/types.ts";
import { CELL_ENTITY_CAPACITY } from "../world/world.ts";
import { eventOf, outcome, type Phase, type ResolutionEvent } from "./phase.ts";

const DIRECTION_DELTA: Readonly<Record<Direction, readonly [number, number]>> = {
  UP: [0, -1],
  DOWN: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
};

type MoveKind = "unit" | "core";
type MoveStatus = "pending" | "success" | "fail";

interface MoveIntent {
  readonly entityId: string;
  readonly kind: MoveKind;
  readonly playerId: string;
  readonly source: Position;
  readonly dest: Position;
  readonly destKey: string;
}

interface EntityInfo {
  readonly id: string;
  readonly kind: MoveKind;
  readonly playerId: string;
  readonly position: Position;
}

export interface MovementResolution {
  readonly events: readonly ResolutionEvent[];
  /** Successful Unit and Core destinations keyed by real entity UUID. */
  readonly positions: ReadonlyMap<string, Position>;
  /** Unit-only compatibility diagnostics used by S4 Golden tests. */
  readonly moves: readonly { unitId: string; status: MoveStatus; reason: string | null }[];
  /** Due Core movement outcomes applied before P06 progress/new actions. */
  readonly coreMoves: readonly {
    playerId: string;
    coreId: string;
    source: Position;
    dest: Position;
    status: MoveStatus;
    reason: string | null;
  }[];
}

function stepCell(source: Position, direction: Direction): Position {
  const [dx, dy] = DIRECTION_DELTA[direction];
  return [source[0] + dx, source[1] + dy];
}

function coreMoveIsDue(core: SimCore): boolean {
  return core.state === "MOVING" &&
    core.moveProgress !== null &&
    core.moveRequiredTicks !== null &&
    core.destination !== null &&
    core.moveProgress + 1 >= core.moveRequiredTicks;
}

function collectMoves(
  world: SimWorld,
  plans: ReadonlyMap<string, Plan>,
): { moves: MoveIntent[]; entities: Map<string, EntityInfo> } {
  const entities = new Map<string, EntityInfo>();
  for (const [playerId, player] of world.players) {
    for (const unit of player.units) {
      entities.set(unit.id, { id: unit.id, kind: "unit", playerId, position: unit.position });
    }
    if (player.core !== null) {
      entities.set(player.core.id, {
        id: player.core.id,
        kind: "core",
        playerId,
        position: player.core.position,
      });
    }
  }

  const moves: MoveIntent[] = [];
  for (const [playerId, plan] of plans) {
    for (const [unitId, action] of Object.entries(plan.unitActions)) {
      const unit = entities.get(unitId);
      if (unit === undefined || unit.kind !== "unit" || unit.playerId !== playerId) continue;
      if (action.type !== "MOVE") continue;
      const dest = stepCell(unit.position, action.direction);
      moves.push({
        entityId: unitId,
        kind: "unit",
        playerId,
        source: unit.position,
        dest,
        destKey: cellKey(dest),
      });
    }
  }

  // A fourth-Tick Core move is autonomous; no repeated plan action is required.
  for (const [playerId, player] of world.players) {
    const core = player.core;
    if (core === null || !coreMoveIsDue(core)) continue;
    moves.push({
      entityId: core.id,
      kind: "core",
      playerId,
      source: core.position,
      dest: core.destination!,
      destKey: cellKey(core.destination!),
    });
  }

  moves.sort((a, b) => compareUuidRaw(a.entityId, b.entityId));
  return { moves, entities };
}

/** Initial occupancy index: every Unit and Core occupies one slot. */
function occupancyIndex(entities: ReadonlyMap<string, EntityInfo>): Map<string, EntityInfo[]> {
  const index = new Map<string, EntityInfo[]>();
  for (const entity of entities.values()) {
    const key = cellKey(entity.position);
    index.set(key, [...(index.get(key) ?? []), entity]);
  }
  return index;
}

function groupArrivals(
  moves: readonly MoveIntent[],
  status: ReadonlyMap<string, MoveStatus>,
): Map<string, MoveIntent[]> {
  const groups = new Map<string, MoveIntent[]>();
  for (const move of moves) {
    if (status.get(move.entityId) === "fail") continue;
    groups.set(move.destKey, [...(groups.get(move.destKey) ?? []), move]);
  }
  return new Map([...groups.entries()].sort(([a], [b]) => compareCodeUnit(a, b)));
}

/** Pure global movement resolution. */
export function resolveMovement(world: SimWorld, plans: ReadonlyMap<string, Plan>): MovementResolution {
  const { moves, entities } = collectMoves(world, plans);
  const occupancy = occupancyIndex(entities);
  const byEntity = new Map(moves.map((move) => [move.entityId, move]));
  const status = new Map<string, MoveStatus>();
  const reason = new Map<string, string | null>();
  for (const move of moves) {
    status.set(move.entityId, "pending");
    reason.set(move.entityId, null);
  }

  const fail = (entityId: string, failure: string): void => {
    if (status.get(entityId) === "pending") {
      status.set(entityId, "fail");
      reason.set(entityId, failure);
    }
  };

  // 1. Static failures.
  for (const move of moves) {
    const [x, y] = move.dest;
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
      fail(move.entityId, "MOVE_OUT_OF_BOUNDS");
      continue;
    }
    if (world.terrain.obstacles.has(move.destKey)) {
      fail(move.entityId, move.kind === "core" ? "CORE_DESTINATION_TERRAIN_BLOCKED" : "MOVE_BLOCKED_TERRAIN");
      continue;
    }
    if (move.kind === "core" && world.terrain.resources.has(move.destKey)) {
      fail(move.entityId, "CORE_DESTINATION_TERRAIN_BLOCKED");
    }
  }

  // 2. Any hostile two-way swap fails, including Unit↔Core.
  for (const move of moves) {
    if (status.get(move.entityId) !== "pending") continue;
    for (const occupant of occupancy.get(move.destKey) ?? []) {
      if (occupant.playerId === move.playerId) continue;
      const occupantMove = byEntity.get(occupant.id);
      if (occupantMove !== undefined && cellKey(occupantMove.dest) === cellKey(move.source)) {
        fail(move.entityId, "MOVE_SWAP_BLOCKED");
        fail(occupantMove.entityId, "MOVE_SWAP_BLOCKED");
      }
    }
  }

  // 3. Fixed-point contest, dependency and capacity resolution.
  let changed = true;
  while (changed) {
    changed = false;

    for (const arrivals of groupArrivals(moves, status).values()) {
      if (new Set(arrivals.map((move) => move.playerId)).size <= 1) continue;
      for (const move of arrivals) {
        if (status.get(move.entityId) === "pending") {
          fail(move.entityId, "MOVE_CONTESTED");
          changed = true;
        }
      }
    }

    for (const move of moves) {
      if (status.get(move.entityId) !== "pending") continue;
      const occupants = occupancy.get(move.destKey) ?? [];

      // Hostile occupants must successfully leave.
      for (const occupant of occupants) {
        if (occupant.playerId === move.playerId) continue;
        const occupantMove = byEntity.get(occupant.id);
        if (occupantMove === undefined || status.get(occupant.id) === "fail") {
          fail(move.entityId, "MOVE_DESTINATION_OCCUPIED");
          changed = true;
          break;
        }
      }
      if (status.get(move.entityId) !== "pending") continue;

      // A full cell requires every initial occupant to leave successfully.
      if (occupants.length >= CELL_ENTITY_CAPACITY) {
        for (const occupant of occupants) {
          const occupantMove = byEntity.get(occupant.id);
          if (occupantMove === undefined) {
            fail(
              move.entityId,
              occupant.playerId === move.playerId ? "CELL_UNIT_LIMIT" : "MOVE_DESTINATION_OCCUPIED",
            );
            changed = true;
            break;
          }
          if (status.get(occupant.id) === "fail") {
            fail(move.entityId, "MOVE_DEPENDENCY_FAILED");
            changed = true;
            break;
          }
        }
      }
    }

    for (const arrivals of groupArrivals(moves, status).values()) {
      const destKey = arrivals[0].destKey;
      const staying = (occupancy.get(destKey) ?? []).filter((occupant) => {
        const occupantMove = byEntity.get(occupant.id);
        return occupantMove === undefined || status.get(occupant.id) === "fail";
      }).length;
      const room = Math.max(0, CELL_ENTITY_CAPACITY - staying);
      if (arrivals.length <= room) continue;
      const sorted = sortByUuidRaw(arrivals.map((move) => ({ id: move.entityId })));
      for (const loser of sorted.slice(room)) {
        if (status.get(loser.id) === "pending") {
          fail(loser.id, "CELL_UNIT_LIMIT");
          changed = true;
        }
      }
    }
  }

  for (const move of moves) {
    if (status.get(move.entityId) === "pending") status.set(move.entityId, "success");
  }

  const events: ResolutionEvent[] = [];
  const positions = new Map<string, Position>();
  for (const move of moves) {
    const moveStatus = status.get(move.entityId)!;
    if (moveStatus === "success") positions.set(move.entityId, move.dest);
    if (move.kind === "unit") {
      events.push(
        moveStatus === "success"
          ? eventOf(world.tick, "UNIT_MOVE_SUCCEEDED", { actorId: move.entityId, position: move.dest })
          : eventOf(world.tick, "UNIT_MOVE_FAILED", {
              reasonCode: reason.get(move.entityId) ?? null,
              actorId: move.entityId,
              position: move.source,
            }),
      );
    } else {
      events.push(
        moveStatus === "success"
          ? eventOf(world.tick, "CORE_MOVE_SUCCEEDED", { actorId: move.entityId, position: move.dest })
          : eventOf(world.tick, "CORE_MOVE_FAILED", {
              reasonCode: reason.get(move.entityId) ?? null,
              actorId: move.entityId,
              position: move.source,
            }),
      );
    }
  }

  return {
    events,
    positions,
    moves: moves
      .filter((move) => move.kind === "unit")
      .map((move) => ({
        unitId: move.entityId,
        status: status.get(move.entityId)!,
        reason: reason.get(move.entityId) ?? null,
      })),
    coreMoves: moves
      .filter((move) => move.kind === "core")
      .map((move) => ({
        playerId: move.playerId,
        coreId: move.entityId,
        source: move.source,
        dest: move.dest,
        status: status.get(move.entityId)!,
        reason: reason.get(move.entityId) ?? null,
      })),
  };
}

function resetCoreAfterAttempt(core: SimCore, position: Position): SimCore {
  return {
    ...core,
    position,
    state: "NORMAL",
    moveDirection: null,
    moveProgress: null,
    moveRequiredTicks: null,
    destination: null,
  };
}

/** P05: apply the shared Unit/Core movement graph. */
export const movementPhase: Phase = {
  id: "P05-global-movement",
  officialPhase: 5,
  run: (draft, ctx) => {
    const resolution = resolveMovement(draft, ctx.plans);
    if (resolution.moves.length > 0 || resolution.coreMoves.length > 0) {
      const coreMoveByPlayer = new Map(resolution.coreMoves.map((move) => [move.playerId, move]));
      const players = new Map<string, SimPlayer>();
      for (const [playerId, player] of draft.players) {
        const coreMove = coreMoveByPlayer.get(playerId);
        const core = player.core === null || coreMove === undefined
          ? player.core
          : resetCoreAfterAttempt(
              player.core,
              coreMove.status === "success" ? coreMove.dest : coreMove.source,
            );
        const units = player.units.map((unit) => {
          const position = resolution.positions.get(unit.id);
          return position === undefined ? unit : { ...unit, position };
        });
        players.set(playerId, { ...player, core, units });
      }
      (draft as { players: typeof draft.players }).players = players;

      const beacon = draft.beacon;
      if (beacon !== null && beacon.status === "CARRIED" && beacon.carrierId !== null) {
        const movedTo = resolution.positions.get(beacon.carrierId);
        if (movedTo !== undefined && cellKey(movedTo) !== cellKey(beacon.position)) {
          (draft as { beacon: SimWorld["beacon"] }).beacon = { ...beacon, position: movedTo };
        }
      }
    }
    return outcome({ events: resolution.events });
  },
};
