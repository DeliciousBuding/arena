import {
  type BeaconSnapshot,
  type CoreSnapshot,
  type Direction,
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
  readonly moveDirection?: Direction | null;
  readonly moveProgress?: number | null;
  readonly moveRequiredTicks?: number | null;
  readonly destination?: Position | null;
}

interface EnemyLike {
  readonly id: string;
  readonly kind: "UNIT" | "CORE";
  readonly position: Position;
  readonly hp: number;
  readonly unit_type?: UnitType;
  readonly owner_username?: string;
  readonly move_direction?: Direction | null;
  readonly move_progress?: number | null;
  readonly move_required_ticks?: number | null;
  readonly destination?: Position | null;
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
    /** null = Beacon 格不在本玩家视野内（官方：坐标恒知，状态仅格子可见时可知）。 */
    readonly status: "GROUND" | "CARRIED" | null;
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
    moveDirection: turn.core.moveDirection ?? null,
    moveProgress: turn.core.moveProgress ?? null,
    moveRequiredTicks: turn.core.moveRequiredTicks ?? null,
    destination:
      turn.core.destination == null ? null : freezePosition(turn.core.destination),
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
    moveDirection: enemy.move_direction ?? null,
    moveProgress: enemy.move_progress ?? null,
    moveRequiredTicks: enemy.move_required_ticks ?? null,
    destination: enemy.destination == null ? null : freezePosition(enemy.destination),
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

// ─────────────────────────────────────────────────────────────────────────────
// W12 按类型替补队列（replacement-queue-v1，2026-08-09，algorithm-update-plan-v1
// §4-W12）。问题 A2 缺陷 4：阵亡只靠通用产兵，人口崩塌恢复慢。参考定位
// reference/third-party/arena-hero-clone-waaiging/arena_hero_strategy.py HEAD 26675e36：
// - replacement_queue: Counter[str]（:528 field，持久化 :852-856）
// - 入队（:1157-1172）：lost_unit_ids = previous_unit_ids - live_unit_ids，
//   按 previous_labels[unit_id].object_type 计数（set-difference，不依赖事件
//   values.unit_type——UNIT_DESTROYED 事件 values 在实测中恒 null，类型只能
//   靠上一 tick 的单位标签解析）。
// - 出队（:1163-1170）：本 tick 新出现的军事单位（id 不在 previous_unit_ids
//   中）即产兵确认 → 该类型计数 -1（产后确认而非决策时扣减——SPAWN 可能
//   被服务端拒，确认式出队失败时下 tick 自动重试）。
// 本模块只暴露纯函数（state-reducer 无跨 tick 状态）：入队 / 出队的状态
// 转移。可变实例状态由 DeterministicPlanner 持有（与 surgeActive /
// previousCorePosition / previousAssignments 同语义）。
// ─────────────────────────────────────────────────────────────────────────────

/** 军事单位类型（替补队列只覆盖 VANGUARD/RANGER；WORKER 不入队——
 *  spec：worker 阵亡只靠通用产兵补员，不入按类型替补队列）。 */
export type MilitaryUnitType = "VANGUARD" | "RANGER";

/** 按类型计数的阵亡补员队列。不可变（每次转移返回新冻结对象）。 */
export type ReplacementQueue = Readonly<Record<MilitaryUnitType, number>>;

export const EMPTY_REPLACEMENT_QUEUE: ReplacementQueue = Object.freeze({
  VANGUARD: 0,
  RANGER: 0,
});

/** UNIT_DESTROYED 事件 → 该类型计数 +1。类型解析靠 previousUnitTypes
 *  （阵亡单位已从 turn.units 消失，事件 actor_id 是阵亡单位 id；UNIT_DESTROYED
 *  的 values 在实测中恒 null，无 unit_type 字段——只能靠上一 tick 标签）。
 *  敌方阵亡事件的 actor_id 不在 previousUnitTypes（只含我方单位）→ 自动过滤。
 *  WORKER 阵亡不入队（spec：只军事单位）。
 *  变体未启用（enabled=false）→ 恒空（零回归）。 */
export function applyReplacementQueueDelta(
  previous: ReplacementQueue,
  events: readonly ResolutionEventSnapshot[],
  previousUnitTypes: ReadonlyMap<string, UnitType>,
  enabled: boolean,
): ReplacementQueue {
  if (!enabled) return EMPTY_REPLACEMENT_QUEUE;
  let vanguard = previous.VANGUARD;
  let ranger = previous.RANGER;
  for (const event of events) {
    if (event.eventType !== "UNIT_DESTROYED") continue;
    const actorId = event.actorId;
    if (actorId === null) continue;
    const unitType = previousUnitTypes.get(actorId);
    if (unitType === "VANGUARD") {
      vanguard += 1;
    } else if (unitType === "RANGER") {
      ranger += 1;
    }
    // WORKER 阵亡不入队；未知 id（敌方/未追踪）不入队
  }
  if (vanguard === previous.VANGUARD && ranger === previous.RANGER) return previous;
  return Object.freeze({ VANGUARD: vanguard, RANGER: ranger });
}

/** 产兵确认出队（reference :1163-1170）：本 tick 新出现的军事单位（id 不在
 *  previousUnitIds 中）即 SPAWN 已被服务端确认 → 该类型计数 -1。变体关 → 恒空。
 *  队列已空时短路返回（无新单位也不必重建对象）。 */
export function consumeReplacementQueue(
  queue: ReplacementQueue,
  currentUnits: readonly { readonly id: string; readonly unitType: UnitType }[],
  previousUnitIds: ReadonlySet<string>,
  enabled: boolean,
): ReplacementQueue {
  if (!enabled) return EMPTY_REPLACEMENT_QUEUE;
  if (queue.VANGUARD === 0 && queue.RANGER === 0) return queue;
  let vanguard = queue.VANGUARD;
  let ranger = queue.RANGER;
  for (const unit of currentUnits) {
    if (previousUnitIds.has(unit.id)) continue;
    if (unit.unitType === "VANGUARD" && vanguard > 0) {
      vanguard -= 1;
    } else if (unit.unitType === "RANGER" && ranger > 0) {
      ranger -= 1;
    }
  }
  if (vanguard === queue.VANGUARD && ranger === queue.RANGER) return queue;
  return Object.freeze({ VANGUARD: vanguard, RANGER: ranger });
}
