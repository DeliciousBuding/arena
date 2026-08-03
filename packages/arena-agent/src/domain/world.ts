import { cellKey, parseCellKey, type Position, type TickState, type UnitType } from "./model.ts";

export type ResourceState = "visible" | "stale" | "harvested";
export type WorkerMode = "patrol" | "go_harvest";

const TRANSIENT_MOVE_FAILURE_REASONS = new Set([
  "MOVE_CONTESTED",
  "MOVE_SWAP_BLOCKED",
  "MOVE_DESTINATION_OCCUPIED",
  "CELL_UNIT_LIMIT",
]);

export interface ResourceMemory {
  readonly cell: Position;
  state: ResourceState;
  readonly firstSeenTick: number;
  lastSeenTick: number;
}

export interface EnemyMemory {
  readonly id: string;
  position: Position;
  kind: "UNIT" | "CORE";
  unitType?: UnitType;
  lastSeenTick: number;
}

export interface UnitMemory {
  workerMode: WorkerMode;
  harvestTarget: Position | null;
  patrolDirection: number;
  patrolRing: number;
  patrolStarted: boolean;
  patrolReturning: boolean;
  lastTick: number;
}

export interface WorldSnapshot {
  readonly tick: number;
  readonly obstacles: readonly string[];
  readonly resources: readonly {
    cell: string;
    state: ResourceState;
    firstSeenTick: number;
    lastSeenTick: number;
  }[];
  readonly enemies: readonly {
    id: string;
    cell: string;
    kind: "UNIT" | "CORE";
    lastSeenTick: number;
  }[];
  readonly unitModes: Readonly<Record<string, WorkerMode>>;
}

export class World {
  private tick = 0;
  private readonly obstacleMemory = new Set<string>();
  private readonly resourceMemory = new Map<string, ResourceMemory>();
  private readonly enemyMemory = new Map<string, EnemyMemory>();
  private readonly failedCells = new Map<string, number>();
  private readonly unitMoveFailures = new Map<string, Map<string, number>>();
  private readonly unitMemories = new Map<string, UnitMemory>();

  observe(state: TickState): void {
    this.tick = state.tick;
    for (const cell of state.obstacleCells) this.obstacleMemory.add(cell);

    const visibleResources = new Set(state.resourceCells);
    for (const cell of visibleResources) {
      const previous = this.resourceMemory.get(cell);
      this.resourceMemory.set(cell, {
        cell: parseCellKey(cell),
        state: "visible",
        firstSeenTick: previous?.firstSeenTick ?? state.tick,
        lastSeenTick: state.tick,
      });
    }
    for (const [cell, memory] of this.resourceMemory) {
      if (visibleResources.has(cell)) continue;
      if (memory.state === "visible" || memory.state === "harvested") {
        memory.state = "stale";
      }
    }

    for (const event of state.events) {
      if (event.position === undefined) continue;
      const cell = cellKey(event.position);
      if (event.eventType === "HARVEST_FAILED") {
        this.failedCells.set(cell, state.tick);
        const memory = this.resourceMemory.get(cell);
        if (memory?.state === "visible") memory.state = "stale";
      } else if (event.eventType === "HARVEST_SUCCEEDED") {
        const previous = this.resourceMemory.get(cell);
        this.resourceMemory.set(cell, {
          cell: event.position,
          state: "harvested",
          firstSeenTick: previous?.firstSeenTick ?? state.tick,
          lastSeenTick: state.tick,
        });
      } else if (
        event.eventType === "UNIT_MOVE_FAILED" &&
        event.actorId !== null &&
        event.reasonCode !== null &&
        TRANSIENT_MOVE_FAILURE_REASONS.has(event.reasonCode)
      ) {
        let failures = this.unitMoveFailures.get(event.actorId);
        if (failures === undefined) {
          failures = new Map<string, number>();
          this.unitMoveFailures.set(event.actorId, failures);
        }
        failures.set(cell, state.tick);
      }
    }

    for (const enemy of state.visibleEnemies) {
      this.enemyMemory.set(enemy.id, {
        id: enemy.id,
        position: enemy.position,
        kind: enemy.kind,
        unitType: enemy.unitType,
        lastSeenTick: state.tick,
      });
    }

    const liveUnits = new Set(state.units.map((unit) => unit.id));
    for (const unitId of this.unitMemories.keys()) {
      if (!liveUnits.has(unitId)) this.unitMemories.delete(unitId);
    }
    for (const unitId of this.unitMoveFailures.keys()) {
      if (!liveUnits.has(unitId)) this.unitMoveFailures.delete(unitId);
    }
  }

  unitMemory(unitId: string, initialPatrolDirection = 0): UnitMemory {
    let memory = this.unitMemories.get(unitId);
    if (memory === undefined) {
      memory = {
        workerMode: "patrol",
        harvestTarget: null,
        patrolDirection: initialPatrolDirection,
        patrolRing: 0,
        patrolStarted: false,
        patrolReturning: false,
        lastTick: this.tick,
      };
      this.unitMemories.set(unitId, memory);
    }
    memory.lastTick = this.tick;
    return memory;
  }

  obstacles(extra: ReadonlySet<string> = new Set()): ReadonlySet<string> {
    return new Set([...this.obstacleMemory, ...extra]);
  }

  /**
   * 单位级动态避让：服务端 MOVE_CONTESTED 等失败不代表永久地形障碍，
   * 只在短冷却内阻止同一 actor 立即重试同一目的格。
   */
  movementObstacles(
    unitId: string,
    base: ReadonlySet<string> = new Set(),
    cooldownTicks = 3,
  ): ReadonlySet<string> {
    const result = new Set(base);
    const failures = this.unitMoveFailures.get(unitId);
    if (failures === undefined) return result;
    for (const [cell, failedAt] of failures) {
      if (this.tick - failedAt < cooldownTicks) result.add(cell);
      else failures.delete(cell);
    }
    if (failures.size === 0) this.unitMoveFailures.delete(unitId);
    return result;
  }

  resourceHints(options: { maxAge?: number; failedCooldown?: number } = {}): readonly Position[] {
    const maxAge = options.maxAge ?? 8;
    const failedCooldown = options.failedCooldown ?? 4;
    const visible: ResourceMemory[] = [];
    const recent: ResourceMemory[] = [];
    for (const memory of this.resourceMemory.values()) {
      const failedAt = this.failedCells.get(cellKey(memory.cell)) ?? Number.NEGATIVE_INFINITY;
      if (this.tick - failedAt < failedCooldown) continue;
      if (memory.state === "visible") visible.push(memory);
      else if (memory.state === "stale" && this.tick - memory.lastSeenTick <= maxAge) recent.push(memory);
    }
    const compare = (a: ResourceMemory, b: ResourceMemory) =>
      b.lastSeenTick - a.lastSeenTick || a.cell[0] - b.cell[0] || a.cell[1] - b.cell[1];
    return [...visible.sort(compare), ...recent.sort(compare)].map((memory) => memory.cell);
  }

  enemyHints(maxAge = 6): readonly EnemyMemory[] {
    return [...this.enemyMemory.values()]
      .filter((memory) => this.tick - memory.lastSeenTick <= maxAge)
      .sort((a, b) => b.lastSeenTick - a.lastSeenTick || a.id.localeCompare(b.id));
  }

  snapshot(): WorldSnapshot {
    return {
      tick: this.tick,
      obstacles: [...this.obstacleMemory].sort(),
      resources: [...this.resourceMemory.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cell, memory]) => ({
          cell,
          state: memory.state,
          firstSeenTick: memory.firstSeenTick,
          lastSeenTick: memory.lastSeenTick,
        })),
      enemies: [...this.enemyMemory.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((memory) => ({
          id: memory.id,
          cell: cellKey(memory.position),
          kind: memory.kind,
          lastSeenTick: memory.lastSeenTick,
        })),
      unitModes: Object.fromEntries(
        [...this.unitMemories.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, memory]) => [id, memory.workerMode]),
      ),
    };
  }
}
