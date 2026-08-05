import { cellKey, parseCellKey, type Position, type TickState, type UnitType } from "./model.ts";

export type ResourceState = "visible" | "stale" | "harvested";
export type WorkerMode = "patrol" | "go_harvest";

const TRANSIENT_MOVE_FAILURE_REASONS = new Set([
  "MOVE_CONTESTED",
  "MOVE_SWAP_BLOCKED",
  "MOVE_DESTINATION_OCCUPIED",
  "CELL_UNIT_LIMIT",
]);

/** 资源记忆 TTL：stale/harvested 超过 64 ticks（≈4 个 refill 周期）删除，
 *  防"幽灵资源"——记忆中的资源格实际已被采空/不再 refill。 */
const RESOURCE_MEMORY_TTL_TICKS = 64;

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
  /** 世界重置计数（tick 回退检测触发；决策层 telemetry/测试可读）。 */
  worldResetCount = 0;
  /** 最近一次世界重置发生时的 tick（从未重置 = null）。 */
  lastWorldResetTick: number | null = null;

  observe(state: TickState): void {
    // 世界重置检测：tick 回退（服务器世界重置/异常）→ 全清本地记忆，避免幽灵障碍/资源
    if (this.tick > state.tick) {
      this.obstacleMemory.clear();
      this.resourceMemory.clear();
      this.enemyMemory.clear();
      this.failedCells.clear();
      this.unitMoveFailures.clear();
      this.unitMemories.clear();
      this.worldResetCount += 1;
      this.lastWorldResetTick = state.tick;
    }
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
      // harvested（自采成功）保持负记忆不进 hints，不降级 stale——
      // 自采空格若 refill 会重新可见，未 refill 说明已耗尽（TTL 后删除）。
      if (memory.state === "visible") {
        memory.state = "stale";
      }
    }

    for (const event of state.events) {
      if (event.position === undefined) continue;
      const cell = cellKey(event.position);
      if (event.eventType === "HARVEST_FAILED") {
        // reasonCode 分流：CARGO_FULL 表示格子仍有资源（cargo 满）——不写失败
        // 冷却、不降级；RESOURCE_DEPLETED 表示格子已耗尽——写失败冷却 + 降级 stale。
        if (event.reasonCode === "RESOURCE_DEPLETED") {
          this.failedCells.set(cell, state.tick);
          const memory = this.resourceMemory.get(cell);
          if (memory?.state === "visible") memory.state = "stale";
        }
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

    // 资源记忆过期：stale/harvested 超过 TTL（≈4 个 refill 周期）删除——
    // 若 refill 会重新可见（重新入记忆），未恢复说明已被采空/不再生成。
    for (const [cell, memory] of this.resourceMemory) {
      if (memory.state !== "visible" && state.tick - memory.lastSeenTick > RESOURCE_MEMORY_TTL_TICKS) {
        this.resourceMemory.delete(cell);
        this.failedCells.delete(cell);
      }
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
    // maxAge 8→32、failedCooldown 4→32（2026-08-06 生产实证配对）：
    // - 记忆窗口 32 tick：巡逻环升级需要数十 tick（8 worker 分头巡逻一圈），
    //   stale 记忆 8 tick 就过期导致"刚见过就忘"（t1 生产 40 格矿测绘不到）；
    // - 耗尽冷却 32 tick：RESOURCE_DEPLETED 确认的矿 32 tick 内不再提示——
    //   否则 worker 反复试近处空矿（t1 生产 maxDist 12-17 空转近处、巡逻环
    //   永不推进的证据），冷却与记忆窗口同量级防空转。
    const maxAge = options.maxAge ?? 32;
    const failedCooldown = options.failedCooldown ?? 32;
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
