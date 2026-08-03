import {
  type BeaconSnapshot,
  type CoreSnapshot,
  type Position,
  type ResolutionEventSnapshot,
  type TickState,
  type UnitSnapshot,
  type UnitType,
  type VisibleEntity,
} from "./model.ts";

interface UnitControllerLike {
  readonly id: string;
  readonly position: Position;
  readonly hp: number;
  readonly unitType: UnitType;
  readonly cargo?: number;
}

interface CoreControllerLike {
  readonly id: string;
  readonly position: Position;
  readonly hp: number;
  readonly shield: number;
  readonly ownerUsername: string;
}

interface EnemyLike {
  readonly id: string;
  readonly kind: "UNIT" | "CORE";
  readonly position: Position;
  readonly hp: number;
  readonly unit_type?: UnitType;
  readonly owner_username?: string;
}

interface EventLike {
  readonly event_id?: string;
  readonly tick?: number;
  readonly event_type?: string;
  readonly reason_code?: string | null;
  readonly actor_id?: string | null;
  readonly target_id?: string | null;
  readonly position?: Position | null;
  readonly values?: Readonly<Record<string, unknown>>;
}

export interface TurnLike {
  readonly tick: number;
  readonly resources: number;
  readonly resourceCapacity: number;
  readonly resourceSpace: number;
  readonly units: readonly UnitControllerLike[];
  readonly workers: readonly UnitControllerLike[];
  readonly vanguards: readonly UnitControllerLike[];
  readonly rangers: readonly UnitControllerLike[];
  readonly core: CoreControllerLike | null;
  readonly visibleEnemies: readonly EnemyLike[];
  readonly obstacleCells: ReadonlySet<string>;
  readonly resourceCells: ReadonlySet<string>;
  readonly beacon: {
    readonly position: Position;
    readonly status: "GROUND" | "CARRIED";
    readonly carrier_id: string | null;
  };
  readonly events: readonly EventLike[];
  readonly state: {
    readonly status: "ACTIVE" | "RESPAWNING";
    readonly population: number;
    readonly objects: readonly unknown[];
  };
}

export function reduceTurn(turn: TurnLike): TickState {
  assertPositiveTick(turn.tick);
  const units = turn.units.map(toUnitSnapshot).sort(compareById);
  const byId = new Map(units.map((unit) => [unit.id, unit]));

  return Object.freeze({
    tick: turn.tick,
    status: turn.state.status,
    resources: turn.resources,
    resourceCapacity: turn.resourceCapacity,
    resourceSpace: turn.resourceSpace,
    population: turn.state.population,
    core: reduceCore(turn),
    units,
    workers: selectControllers(turn.workers, byId),
    vanguards: selectControllers(turn.vanguards, byId),
    rangers: selectControllers(turn.rangers, byId),
    visibleEnemies: turn.visibleEnemies.map(toVisibleEntity).sort(compareById),
    resourceCells: new Set(turn.resourceCells),
    obstacleCells: new Set(turn.obstacleCells),
    beacon: reduceBeacon(turn),
    events: turn.events.map((event, index) => reduceEvent(event, turn.tick, index)),
  } satisfies TickState);
}

function toUnitSnapshot(unit: UnitControllerLike): UnitSnapshot {
  return Object.freeze({
    id: unit.id,
    position: freezePosition(unit.position),
    hp: unit.hp,
    unitType: unit.unitType,
    cargo: unit.unitType === "WORKER" ? (unit.cargo ?? 0) : 0,
  });
}

function selectControllers(
  controllers: readonly UnitControllerLike[],
  byId: ReadonlyMap<string, UnitSnapshot>,
): readonly UnitSnapshot[] {
  return controllers
    .map((controller) => {
      const unit = byId.get(controller.id);
      if (unit === undefined) {
        throw new Error(`Turn controller ${controller.id} is missing from units`);
      }
      return unit;
    })
    .sort(compareById);
}

function reduceCore(turn: TurnLike): CoreSnapshot | null {
  if (turn.core === null) {
    return null;
  }
  const raw = turn.state.objects.find((value) => {
    if (!isRecord(value)) return false;
    return value.kind === "CORE" && value.controlled === true && value.id === turn.core?.id;
  });
  const state = isRecord(raw) && raw.state === "MOVING" ? "MOVING" : "NORMAL";
  return Object.freeze({
    id: turn.core.id,
    position: freezePosition(turn.core.position),
    hp: turn.core.hp,
    shield: turn.core.shield,
    state,
    ownerUsername: turn.core.ownerUsername,
  });
}

function toVisibleEntity(enemy: EnemyLike): VisibleEntity {
  return Object.freeze({
    id: enemy.id,
    kind: enemy.kind,
    position: freezePosition(enemy.position),
    hp: enemy.hp,
    unitType: enemy.unit_type,
    ownerUsername: enemy.owner_username,
  });
}

function reduceBeacon(turn: TurnLike): BeaconSnapshot {
  return Object.freeze({
    position: freezePosition(turn.beacon.position),
    status: turn.beacon.status,
    carrierId: turn.beacon.carrier_id,
  });
}

function reduceEvent(event: EventLike, currentTick: number, index: number): ResolutionEventSnapshot {
  return Object.freeze({
    eventId: event.event_id ?? `synthetic:${currentTick}:${index}`,
    tick: event.tick ?? currentTick,
    eventType: event.event_type ?? "UNKNOWN",
    reasonCode: event.reason_code ?? null,
    actorId: event.actor_id ?? null,
    targetId: event.target_id ?? null,
    position: event.position == null ? undefined : freezePosition(event.position),
    values: Object.freeze({ ...(event.values ?? {}) }),
  });
}

function freezePosition(position: Position): Position {
  const [x, y] = position;
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new Error(`invalid position: ${String(position)}`);
  }
  return Object.freeze([x, y] as const);
}

function compareById<T extends { readonly id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id);
}

function assertPositiveTick(tick: number): void {
  if (!Number.isInteger(tick) || tick < 1) {
    throw new Error(`invalid tick: ${tick}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
