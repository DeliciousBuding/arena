import { cellKey, parseCellKey, type Position, type TickState, type UnitType, type VisibleEntity } from "./model.ts";
import { chebyshev, exploreRadiusForRing, exploreTarget } from "./nav.ts";

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

/** 敌情狩猎（2026-08-07，持久敌情测绘）：CORE 目击目标 sticky 窗口
 *  （≈2000 tick ≈ 敌 Core 残血回满/迁移周期——回访最后已知基地仍有效）。 */
const CORE_HUNT_STICKY_TICKS = 2000;
/** 敌情狩猎：WORKER_INFER（轨迹/单次目击推断）目标记忆窗口——推断会漂移，短于 CORE。 */
const CORE_HUNT_WORKER_INFER_TICKS = 400;
/** 敌情狩猎：敌 Worker 轨迹反推基地的方向延伸距离（格）。 */
const CORE_HUNT_INFER_EXTEND = 8;
/** 敌情狩猎：敌 Worker 单次目击（无轨迹）时"远离最近我方单位"的猜测距离（格）。 */
const CORE_HUNT_SINGLE_EXTEND = 8;
/** 敌战斗单位归属敌 Core 的最大距离（assault-overmatch-v1，Chebyshev）：
 *  可见 Vanguard/Ranger 距某已知敌 Core ≤ 该值 = 该基地守军（v3.0
 *  ASSAULT_CORE_FORCE_RADIUS=16 放宽到 30——记忆目标可能滞后于实际位置，
 *  单位在视野边缘游走仍应计入守军）。 */
const ENEMY_CORE_ASSIGN_RADIUS = 30;
/** 敌情狩猎：单次目击猜测的 8 方位候选（与巡逻探索同构，覆盖全向）。 */
const HUNT_AWAY_DELTAS: readonly (readonly [number, number])[] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

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

/** 敌情狩猎目标（2026-08-07，持久敌情测绘）：敌 Core 基地候选——发现即长期
 *  保留，即使短 TTL 战术记忆过期，部队仍会回访最后已知基地清扫（竞品
 *  "old Core coordinate 标为待确认并按区域彻查"）。来源：
 *  - CORE：直接目击敌 Core（最高置信，sticky）；
 *  - WORKER_INFER：由敌 Worker 轨迹/单次目击推断的基地候选（较短窗口）。 */
export interface CoreHuntTarget {
  readonly position: Position;
  readonly lastSeenTick: number;
  readonly source: "CORE" | "WORKER_INFER";
  /** 敌方 Core 所有者用户名（2026-08-07，排行榜威胁画像接入）：enemy-intel
   *  播种时从 calibration 提取；用于把官方排行榜"猛攻蛆"威胁等级映射到
   *  攻坚目标——高威胁对手留强防守。缺省 null/undefined = 未知所有者。 */
  readonly owner?: string | null;
}

/** 敌 Core 兵力记忆（2026-08-07，assault-overmatch-v1）：可见敌战斗单位
 *  (Vanguard/Ranger) 按最近已知敌 Core 分配——按 Core 估计守军兵力，供攻坚
 *  "严格占优"决策（存活兵力 > 守军估计才压上；守军增援则提高门槛/蓄势）。
 *  与 coreHuntMemory 同 key（cellKey of Core position）。单位按 ID 去重。 */
export interface EnemyCoreForce {
  readonly position: Position;
  readonly vanguards: ReadonlySet<string>;
  readonly rangers: ReadonlySet<string>;
  readonly lastSeenTick: number;
  /** cellKey(敌 Core 位置)（与 coreHuntMemory 同 key）。 */
  readonly key: string;
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
  /** 敌情狩猎目标（快照/测绘：指挥面板可渲染敌方基地候选）。 */
  readonly coreHuntTargets: readonly {
    position: Position;
    source: "CORE" | "WORKER_INFER";
    lastSeenTick: number;
    owner?: string | null;
  }[];
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
  /** 敌情狩猎记忆（sticky）：敌 Core 基地候选（绝对坐标——C2 RECOVERY 不清，
   *  属战略 intel 而非相对 Core 的战场记忆）。 */
  private readonly coreHuntMemory = new Map<string, CoreHuntTarget>();
  /** 敌 Core 兵力记忆（assault-overmatch-v1）：key = cellKey(敌 Core 位置)。 */
  private readonly enemyCoreForceRecords = new Map<string, {
    position: Position;
    vanguards: Set<string>;
    rangers: Set<string>;
    lastSeenTick: number;
  }>();
  /** 世界重置计数（tick 回退检测触发；决策层 telemetry/测试可读）。 */
  worldResetCount = 0;
  /** 最近一次世界重置发生时的 tick（从未重置 = null）。 */
  lastWorldResetTick: number | null = null;

  /**
   * C2 RECOVERY（竞品 lifecycle overlay 对照）：Core 重生（替换，全新 UUID）
   * 后清**相对 Core** 的战场记忆——敌追击积分（pursuitScore/coreDistance）
   * 与单位巡逻扇区（patrolDirection/patrolRing）基于旧 Core 坐标系，重生后
   * 失真（竞品 "RECOVERY clears battlefield memory, rebuilds locally"）。
   * 绝对坐标地图事实（障碍/资源/chunk 观察老化）保留——不随 Core 位置变化。
   * 返回被清条目数（telemetry/测试可读）。
   */
  clearBattlefieldMemory(): number {
    const cleared = this.enemyMemory.size + this.unitMemories.size;
    this.enemyMemory.clear();
    this.unitMemories.clear();
    return cleared;
  }

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
      this.coreHuntMemory.clear();
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
        // 冷却、不降级；RESOURCE_DEPLETED（被他人采空）→ 失败冷却 + 降级 stale。
        // NOT_RESOURCE_CELL（记忆格已不存在/已耗尽——t4 实证 go_harvest_mem 104
        // 意图仅 12 次成功、worker 跨 30-78 格追空记忆）→ 记 harvested 负记忆
        // （不进 hints，visited-empty 立即失效，杜绝多 worker 反复追同一死矿）。
        // 不写 failedCells：refill 后重新可见即恢复（failedCells 会误压可见矿）。
        if (event.reasonCode === "RESOURCE_DEPLETED") {
          this.failedCells.set(cell, state.tick);
          const memory = this.resourceMemory.get(cell);
          if (memory?.state === "visible") memory.state = "stale";
        } else if (event.reasonCode === "NOT_RESOURCE_CELL") {
          const memory = this.resourceMemory.get(cell);
          if (memory !== undefined) memory.state = "harvested";
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
      // 敌情狩猎（2026-08-07）：CORE 目击 → sticky 基地目标；WORKER 目击 →
      // 推断基地候选（轨迹双向延伸 / 单次目击远离我方猜测——竞品 worker
      // trajectory 推断 Core 方向）。同一格保留更新鲜的目击。
      if (enemy.kind === "CORE") {
        this.coreHuntMemory.set(cellKey(enemy.position), {
          position: enemy.position,
          lastSeenTick: state.tick,
          source: "CORE",
          owner: enemy.ownerUsername ?? null,
        });
      } else if (enemy.unitType === "VANGUARD" || enemy.unitType === "RANGER") {
        // 敌 Core 兵力记忆（assault-overmatch-v1）：战斗单位分配给最近已知
        // 敌 Core（CORE 目击优先）——按 Core 估计守军兵力供严格占优攻坚。
        const assigned = this.assignEnemyCombatUnit(enemy, state.tick);
        if (assigned !== null) {
          const key = cellKey(assigned.position);
          const record = this.enemyCoreForceRecords.get(key) ?? {
            position: assigned.position,
            vanguards: new Set<string>(),
            rangers: new Set<string>(),
            lastSeenTick: 0,
          };
          if (enemy.unitType === "VANGUARD") record.vanguards.add(enemy.id);
          else record.rangers.add(enemy.id);
          record.lastSeenTick = state.tick;
          this.enemyCoreForceRecords.set(key, record);
        }
      } else if (enemy.unitType === "WORKER") {
        for (const anchor of this.inferWorkerCoreAnchors(enemy, state)) {
          const key = cellKey(anchor);
          const existing = this.coreHuntMemory.get(key);
          if (existing === undefined || existing.lastSeenTick < state.tick) {
            this.coreHuntMemory.set(key, {
              position: anchor,
              lastSeenTick: state.tick,
              source: "WORKER_INFER",
            });
          }
        }
      }
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

  /** 敌情狩猎目标（排序：CORE 目击优先 → 新鲜度 → 坐标 tie-break）。
   *  CORE 目击 sticky（maxAge = CORE_HUNT_STICKY_TICKS）；WORKER_INFER
   *  短窗口（CORE_HUNT_WORKER_INFER_TICKS）——推断目标会漂移。 */
  coreHuntTargets(maxAge?: number): readonly CoreHuntTarget[] {
    const coreAge = maxAge ?? CORE_HUNT_STICKY_TICKS;
    const workerAge = maxAge ?? CORE_HUNT_WORKER_INFER_TICKS;
    return [...this.coreHuntMemory.values()]
      .filter((target) => {
        const age = this.tick - target.lastSeenTick;
        return age <= (target.source === "CORE" ? coreAge : workerAge);
      })
      .sort((a, b) => {
        const pa = a.source === "CORE" ? 1 : 0;
        const pb = b.source === "CORE" ? 1 : 0;
        return (
          pb - pa ||
          b.lastSeenTick - a.lastSeenTick ||
          a.position[0] - b.position[0] ||
          a.position[1] - b.position[1]
        );
      });
  }

  /** 威胁方向扇区（threat-sector-scout-v1，2026-08-07）：首个 CORE 目击
   *  敌核心相对 home 的 8 方位索引（0=E,1=SE,2=S,3=SW,4=W,5=NW,6=N,7=NE，
   *  与 nav EXPLORE_DELTAS 同语义）——供 worker 巡逻方位向威胁方向加权
   *  （补侦察盲区：t2 生产实证 NE=jerkman 来路只有 1/12 worker，小股部队
   *  摸过来看不见）。无 CORE 目标返回 null（不加权）。 */
  threatSectorFrom(home: Position): number | null {
    const target = this.coreHuntTargets().find((t) => t.source === "CORE");
    if (target === undefined) return null;
    const dx = target.position[0] - home[0];
    const dy = target.position[1] - home[1];
    if (dx === 0 && dy === 0) return 0;
    const angle = Math.atan2(dy, dx);
    return (Math.round(angle / (Math.PI / 4)) + 8) % 8;
  }

  /** 启动播种（持久敌情测绘，2026-08-07）：从本租户历史 calibration cases
   *  提取的"最后已知敌 Core 位置"注入——重启后军事仍记得敌方基地（解决
   *  "重启→记忆清零→军队空转"）。更新鲜的目击不覆盖。返回实际播种数。 */
  seedCoreHuntTargets(targets: readonly CoreHuntTarget[]): number {
    let seeded = 0;
    for (const target of targets) {
      const key = cellKey(target.position);
      const existing = this.coreHuntMemory.get(key);
      if (existing === undefined || existing.lastSeenTick < target.lastSeenTick) {
        this.coreHuntMemory.set(key, { ...target });
        seeded += 1;
      }
    }
    return seeded;
  }

  /** 敌战斗单位 → 归属敌 Core（assault-overmatch-v1）：取最近已知敌 Core
   *  （CORE 目击优先，同 coreHuntTargets 排序），距其 ≤ ENEMY_CORE_ASSIGN_RADIUS
   *  才归属（防远征单位误计入无关基地）。无合适目标返回 null。 */
  private assignEnemyCombatUnit(enemy: VisibleEntity, tick: number): CoreHuntTarget | null {
    const target = this.coreHuntTargets().find(
      (t) => t.source === "CORE" && chebyshev(enemy.position, t.position) <= ENEMY_CORE_ASSIGN_RADIUS,
    );
    if (target === undefined) return null;
    return target;
  }

  /** 敌 Core 兵力记忆（assault-overmatch-v1）：返回每个已知敌 Core 的守军
   *  估计（Vanguard/Ranger 数量，按 ID 去重），过滤 maxAge 内新鲜度。
   *  排序：CORE 目击优先 → 新鲜度（与 coreHuntTargets 同口径）。 */
  enemyCoreForces(maxAge = 12): readonly EnemyCoreForce[] {
    const out: EnemyCoreForce[] = [];
    for (const [key, record] of this.enemyCoreForceRecords) {
      if (this.tick - record.lastSeenTick > maxAge) continue;
      out.push({
        position: record.position,
        vanguards: new Set(record.vanguards),
        rangers: new Set(record.rangers),
        lastSeenTick: record.lastSeenTick,
        key,
      });
    }
    out.sort((a, b) => {
      const pa = a.key && this.coreHuntMemory.get(a.key)?.source === "CORE" ? 1 : 0;
      const pb = b.key && this.coreHuntMemory.get(b.key)?.source === "CORE" ? 1 : 0;
      return pb - pa || b.lastSeenTick - a.lastSeenTick || a.position[0] - b.position[0] || a.position[1] - b.position[1];
    });
    return out;
  }

  /** 敌 Worker 目击 → 基地候选锚点（竞品 "worker trajectory 推断 Core 方向"）：
   *  - 有轨迹（prevPosition 且移动）：Worker 在 Core 与资源间往返——基地在轨迹
   *    两端之一，双向各延伸 CORE_HUNT_INFER_EXTEND（诚实覆盖，不猜来向）；
   *  - 单次目击（无轨迹）：沿"离最近我方单位最远"的 8 方位猜测（竞品保守
   *    "单次目击沿远离最近我方单位方向给出猜测"）。 */
  private inferWorkerCoreAnchors(
    enemy: VisibleEntity,
    state: TickState,
  ): readonly Position[] {
    const anchors: Position[] = [];
    const previous = this.enemyMemory.get(enemy.id);
    if (previous?.prevPosition !== undefined) {
      const dx = enemy.position[0] - previous.prevPosition[0];
      const dy = enemy.position[1] - previous.prevPosition[1];
      const steps = Math.max(Math.abs(dx), Math.abs(dy));
      if (steps > 0) {
        const nx = dx / steps;
        const ny = dy / steps;
        anchors.push([
          enemy.position[0] + Math.round(nx * CORE_HUNT_INFER_EXTEND),
          enemy.position[1] + Math.round(ny * CORE_HUNT_INFER_EXTEND),
        ]);
        anchors.push([
          enemy.position[0] - Math.round(nx * CORE_HUNT_INFER_EXTEND),
          enemy.position[1] - Math.round(ny * CORE_HUNT_INFER_EXTEND),
        ]);
      }
    }
    if (anchors.length === 0) {
      if (state.units.length === 0) return [enemy.position];
      let best: Position = enemy.position;
      let bestScore = -1;
      for (const [dx, dy] of HUNT_AWAY_DELTAS) {
        const candidate: Position = [
          enemy.position[0] + dx * CORE_HUNT_SINGLE_EXTEND,
          enemy.position[1] + dy * CORE_HUNT_SINGLE_EXTEND,
        ];
        let minD = Number.POSITIVE_INFINITY;
        for (const unit of state.units) {
          const d = chebyshev(candidate, unit.position);
          if (d < minD) minD = d;
        }
        if (minD > bestScore) {
          bestScore = minD;
          best = candidate;
        }
      }
      anchors.push(best);
    }
    return anchors;
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
      coreHuntTargets: [...this.coreHuntMemory.values()]
        .sort((a, b) => b.lastSeenTick - a.lastSeenTick || a.position[0] - b.position[0] || a.position[1] - b.position[1])
        .map((target) => ({
          position: target.position,
          source: target.source,
          lastSeenTick: target.lastSeenTick,
        })),
    };
  }
}

