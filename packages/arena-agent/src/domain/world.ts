import { cellKey, parseCellKey, type Position, type TickState, type UnitType } from "./model.ts";
import { exploreRadiusForRing, exploreTarget } from "./nav.ts";

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

/** 地图分块尺寸（frontier 探索）：16×16 格 chunk——巡逻环 8..40、
 *  视野 5，chunk 过大（32）环内 8 方位常落同块无区分，过小（8）碎片化噪声。
 *  chunk 记忆驱动"未观察分区优先"（frontier-v1：观察最老的分区先巡）。 */
const CHUNK_SIZE = 16;

/** chunk 坐标支持负坐标（t1 Core [-619,-154]）：floor 除法而非截断。 */
function chunkKeyFor(position: Position): string {
  const cx = Math.floor(position[0] / CHUNK_SIZE);
  const cy = Math.floor(position[1] / CHUNK_SIZE);
  return `${cx},${cy}`;
}

export interface ResourceMemory {
  readonly cell: Position;
  state: ResourceState;
  readonly firstSeenTick: number;
  lastSeenTick: number;
}

export interface EnemyMemory {
  readonly id: string;
  position: Position;
  /** 上一可见 tick 的位置（威胁评估 ALERT 信号：位置差分 → 敌移动检测，
   *  2026-08-06 竞品 hierarchical threat assessment 对照）。 */
  prevPosition?: Position;
  /** 上一可见 tick（观测间隔 = lastSeenTick - prevSeenTick；竞品
   *  observation-gap 缩放——敌人间歇可见时逼近速度按间隔折算，
   *  2026-08-07 B1 TTR 公式对齐）。 */
  prevSeenTick?: number;
  /** 上一可见 tick 时敌距 Core 的 Chebyshev 距离（距离差分 pursuit score 的
   *  分母——竞品对照：closed = prev.d - cur.d，>0 逼近 +2、==0 平行 +1、
   *  <0 远离 -1，位置未动强制 0——天然滤除"路过"误报）。 */
  coreDistance?: number;
  /** 追击积分 [0,4]（cap 4）：>0 且（d≤12 或 score≥3）= 确认追击。 */
  pursuitScore: number;
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
  /** chunk 观察记忆（frontier 探索）：chunkKey → 最近一次观察 tick。
   *  观察来源 = 视野实体格（障碍/资源/敌人/我方单位/Core/Beacon）——
   *  巡逻/采集到达的区域随实体观察自然更新老化。 */
  private readonly chunkMemory = new Map<string, number>();
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
      this.chunkMemory.clear();
      this.worldResetCount += 1;
      this.lastWorldResetTick = state.tick;
    }
    this.tick = state.tick;
    for (const cell of state.obstacleCells) this.obstacleMemory.add(cell);
    for (const cell of state.obstacleCells) this.chunkMemory.set(chunkKeyFor(parseCellKey(cell)), state.tick);

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
      const previous = this.enemyMemory.get(enemy.id);
      const core = state.core?.position;
      let pursuitScore = 0;
      let coreDistance: number | undefined;
      if (core !== undefined) {
        coreDistance = Math.max(
          Math.abs(enemy.position[0] - core[0]),
          Math.abs(enemy.position[1] - core[1]),
        );
        // 追击积分（竞品 pursuit score 对照）：距离差分——closed = prev.d - cur.d，
        // >0 逼近 +2、==0 平行 +1、<0 远离 -1；位置未动强制 0（静态敌不算——
        // 天然滤除"路过"误报：远离衰减、平行封顶）。cap [0,4]。
        if (previous !== undefined && previous.coreDistance !== undefined) {
          // 位置未动判定用上一 tick 位置（previous.position——prevPosition 是
          // 上上 tick，仅用于威胁评估的移动检测）
          const moved =
            previous.position[0] !== enemy.position[0] ||
            previous.position[1] !== enemy.position[1];
          if (!moved) {
            pursuitScore = 0;
          } else {
            const closed = previous.coreDistance - coreDistance;
            const delta = closed > 0 ? 2 : closed === 0 ? 1 : -1;
            pursuitScore = Math.max(0, Math.min(4, (previous.pursuitScore ?? 0) + delta));
          }
        }
      }
      this.enemyMemory.set(enemy.id, {
        id: enemy.id,
        position: enemy.position,
        // 位置差分：上一次可见位置保留为 prevPosition（同 id 才记录——
        // 新出现敌人无 prev，prevPosition 缺失 = 无法判断移动）。
        prevPosition: previous?.position,
        prevSeenTick: previous?.lastSeenTick,
        coreDistance,
        pursuitScore,
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

    // chunk 老化更新：所有视野实体格（资源/敌人/我方单位/Core/Beacon）——
    // 巡逻与采集到达的区域随实体观察刷新"最近观察时间"。
    for (const cell of visibleResources) this.chunkMemory.set(chunkKeyFor(parseCellKey(cell)), state.tick);
    for (const enemy of state.visibleEnemies) this.chunkMemory.set(chunkKeyFor(enemy.position), state.tick);
    for (const unit of state.units) this.chunkMemory.set(chunkKeyFor(unit.position), state.tick);
    if (state.core !== null) this.chunkMemory.set(chunkKeyFor(state.core.position), state.tick);
    this.chunkMemory.set(chunkKeyFor(state.beacon.position), state.tick);
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

  /**
   * frontier 探索方位选择：8 方位按"当前巡逻环探测点所在 chunk 观察老化"排序，
   * 观察最老（lastSeen 最小）的方位优先；老化相同按方位升序（确定性 tie-break，
   * 全未观察时退化为固定方位序）。offset 按 worker 序号轮转——多 worker 分散到
   * 不同老分区，避免全部涌向同一最老方位（第二名"不要所有侦察走同一走廊"）。
   */
  staleDirection(
    home: Position,
    beacon: Position,
    ringIndex: number,
    baseRadius: number,
    count: number,
    offset: number,
  ): number {
    const radius = exploreRadiusForRing(baseRadius, ringIndex);
    const candidates = Array.from({ length: count }, (_, direction) => ({
      direction,
      lastSeen: this.chunkMemory.get(chunkKeyFor(exploreTarget(home, beacon, direction, radius))) ?? 0,
    }));
    candidates.sort((a, b) => a.lastSeen - b.lastSeen || a.direction - b.direction);
    return candidates[((offset % count) + count) % count].direction;
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
