/**
 * Settlement phase contracts：phase 注册、事件类型、unknown/unsupported 语义。
 *
 * 16 个内部 phase（architecture §6），每个 phase 映射官方结算阶段（官方 15
 * 步；本仓库把 capacity-shrink 与 upkeep 显式化为独立 phase）。结算只允许
 * 在 draft（settlement 内部可变副本）上操作；settleTick 返回新 world 快照，
 * 失败时不返回半更新 world。
 */

import type { Plan, Position } from "../../domain/model.ts";
import type { RulesManifest } from "../contracts/rules-manifest.ts";
import type { SimFeature, SimWorld } from "../world/types.ts";

/**
 * 中央事件类型注册表（agent-ecosystem P4h）：settlement 事件类型的唯一
 * 事实来源。EVENT_CATEGORY_TYPES 按类别穷举（movement/combat/economy/
 * beacon/respawn），EVENT_TYPES 由类别推导——新增事件类型只需加入对应
 * 类别即自动注册（eventOf 创建入口统一校验）+ 被 ledger 按类别统计。
 *
 * 注意：CORE_ACTION_FAILED 同时由 P06 core-migration 与 P12 stationary
 * core action 发出（reasonCode 均属移动状态机），归类 movement；
 * CORE_RESOURCE_OVERFLOW_DESTROYED 由 P03 capacity-shrink 与 P09 combat
 * 后 capacity 检查发出（资源语义），归类 economy。
 */
export const EVENT_CATEGORY_TYPES = {
  movement: [
    "UNIT_MOVE_SUCCEEDED",
    "UNIT_MOVE_FAILED",
    "CORE_MOVE_SUCCEEDED",
    "CORE_MOVE_FAILED",
    "CORE_MOVE_PROGRESS",
    "CORE_MOVE_STARTED",
    "CORE_MOVE_START_FAILED",
    "CORE_MOVE_CANCELLED",
    "CORE_ACTION_FAILED",
  ],
  combat: [
    "SWEEP_RESOLVED",
    "SHOT_MISSED",
    "SHOT_HIT",
    "UNIT_DAMAGED",
    "CORE_DAMAGED",
    "DESTRUCTION_PARTICIPATION",
    "CORE_DESTROYED",
    "CORE_RESOURCES_CAPTURED",
    "CORE_RESOURCES_DESTROYED",
  ],
  economy: [
    "HARVEST_SUCCEEDED",
    "HARVEST_FAILED",
    "DEPOSIT_SUCCEEDED",
    "DEPOSIT_FAILED",
    "CORE_SPAWN_SUCCEEDED",
    "CORE_SPAWN_FAILED",
    "UNIT_HEAL_SUCCEEDED",
    "UNIT_HEAL_FAILED",
    "CORE_HEAL_SUCCEEDED",
    "CORE_HEAL_FAILED",
    "CORE_REPAIR_SUCCEEDED",
    "CORE_REPAIR_FAILED",
    "UPKEEP_PAID",
    "UNIT_SELF_DESTRUCTED",
    "WORKER_CARGO_DROPPED",
    "CORE_RESOURCE_OVERFLOW_DESTROYED",
  ],
  beacon: [
    "BEACON_DROPPED",
    "BEACON_DROP_FAILED",
    "BEACON_PICKED_UP",
    "BEACON_PICKUP_FAILED",
    "BEACON_DROPPED_ON_DEATH",
    "BEACON_HARVEST_BONUS",
  ],
  respawn: [
    "CORE_RESPAWNED",
    "RESPAWN_DELAYED",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** ledger 按类别聚合的统计维度。 */
export type EventCategoryId = keyof typeof EVENT_CATEGORY_TYPES;

/** 全部已知结算事件类型（由 EVENT_CATEGORY_TYPES 推导，无重复）。 */
export const EVENT_TYPES = [
  ...EVENT_CATEGORY_TYPES.movement,
  ...EVENT_CATEGORY_TYPES.combat,
  ...EVENT_CATEGORY_TYPES.economy,
  ...EVENT_CATEGORY_TYPES.beacon,
  ...EVENT_CATEGORY_TYPES.respawn,
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(EVENT_TYPES);

/** 校验事件类型已知；未知类型抛错（eventOf 创建入口统一调用）。 */
export function assertKnownEventType(type: string): EventType {
  if (!KNOWN_EVENT_TYPES.has(type)) {
    throw new Error(`assertKnownEventType: unknown resolution event type "${type}"`);
  }
  return type as EventType;
}

/** 与线上 event_type 对齐的结算事件；recipientPlayerId 仅供内部私有投递。 */
export interface ResolutionEvent {
  readonly tick: number;
  readonly eventType: EventType;
  readonly reasonCode: string | null;
  readonly actorId: string | null;
  readonly targetId: string | null;
  readonly position: Position | null;
  readonly values: Readonly<Record<string, unknown>> | null;
  /** Internal delivery metadata; omitted from SDK wire events. */
  readonly recipientPlayerId?: string;
}

/** unknown/不可预测效应（refill、对手动作）——不得伪装成 MATCH。 */
export interface UnknownEffect {
  readonly tick: number;
  readonly kind:
    | "refill"
    | "opponent-action"
    | "fog-of-war"
    | "rule-assumption"
    | "server-generated-id";
  readonly note: string;
}

/** 一个 phase 的输出。 */
export interface PhaseOutcome {
  readonly events: readonly ResolutionEvent[];
  readonly unknownEffects: readonly UnknownEffect[];
  readonly unsupported: readonly SimFeature[];
}

export interface Phase {
  readonly id: string;
  /** 官方阶段序号（resolution order 第几步，用于 manifest 映射）。 */
  readonly officialPhase: number;
  readonly run: (draft: SimWorld, ctx: PhaseContext) => PhaseOutcome;
}

export interface PhaseContext {
  /** 规则 manifest（refill cadence 等数值来源）。 */
  readonly rules: RulesManifest;
  /** 本 tick 冻结的完整计划（playerId → Plan）；缺失 action 等价 WAIT。 */
  readonly plans: ReadonlyMap<string, Plan>;
  /** 当前 phase 已消费的随机源（test-seeded refill 用；null = disabled）。 */
  readonly rng: (() => number) | null;
  /** 本 tick 输入触发的 unsupported feature（供 unsupported-* phase 报告）。 */
  readonly features: ReadonlySet<SimFeature>;
  /** Cells where a carried Beacon landed through death before P07. */
  readonly beaconPickupLockedCells: Set<string>;
  /** refill（实验可选；undefined = 不实现官方 refill）。chunk-quota 空槽模型，
   *  chunks = 世界载入时含自然点的 32×32 chunk。 */
  readonly refill?: {
    readonly chunks: readonly string[];
    readonly everyTicks: number;
  };
}

export const EMPTY_OUTCOME: PhaseOutcome = Object.freeze({
  events: [],
  unknownEffects: [],
  unsupported: [],
});

export function outcome(partial: Partial<PhaseOutcome> = {}): PhaseOutcome {
  return Object.freeze({
    events: partial.events ?? [],
    unknownEffects: partial.unknownEffects ?? [],
    unsupported: partial.unsupported ?? [],
  });
}

/** 构造 ResolutionEvent 的便捷函数。eventType 在创建入口统一校验（未知类型抛错）。 */
export function eventOf(
  tick: number,
  eventType: string,
  opts: {
    reasonCode?: string | null;
    actorId?: string | null;
    targetId?: string | null;
    position?: Position | null;
    values?: Readonly<Record<string, unknown>> | null;
    recipientPlayerId?: string;
  } = {},
): ResolutionEvent {
  const knownEventType = assertKnownEventType(eventType);
  return Object.freeze({
    tick,
    eventType: knownEventType,
    reasonCode: opts.reasonCode ?? null,
    actorId: opts.actorId ?? null,
    targetId: opts.targetId ?? null,
    position: opts.position ?? null,
    values: opts.values ?? null,
    ...(opts.recipientPlayerId === undefined ? {} : { recipientPlayerId: opts.recipientPlayerId }),
  });
}
