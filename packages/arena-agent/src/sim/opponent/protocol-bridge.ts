/**
 * Protocol Bridge — 中立协议翻译层（2026-08-08，对抗测试平台核心）
 *
 * 设计目标：把"我方模拟器世界"与"对手决策"彻底解耦。中间用一个**中立协议**
 * ——官方 Arena Hero 的线模型（PlayerState / CommandPlan / 各类 View）——作为
 * 交换格式。任何对手（我的 TS planner / reference 决策提取 / 未来任意 HTTP
 * agent）都只讲这一种方言，模拟器不感知对手内部实现。
 *
 * 三层解耦：
 *   [世界结算 runEpisode]  ⟷（本文件）⟷  [决策器 PlanProvider / 对手 adapter]
 *
 * 本文件定义：
 *  1. 中立协议模型（对齐官方 arena-hero wire 结构，字段名/value 语义一致）；
 *  2. TickState → PlayerState 的翻译（模拟器世界 → 官方观察视图）；
 *  3. CommandPlan → Plan 的翻译（官方计划 → 模拟器 settle 计划）。
 *
 * 为什么用官方 wire 模型而非自造：reference 生态（arena-hero-python 的 pydantic
 * 模型、lost arena_farmer）天然吃这套结构，翻译是无损的，不丢字段、不双解析。
 * 自造 DTO 会造成"两套真相"，违背解耦。
 */
import type {
  CoreAction,
  Direction,
  Plan,
  Position,
  ResolutionEventSnapshot,
  TickState,
  UnitAction,
  UnitType,
  VisibleEntity,
} from "../../domain/model.ts";

/* ============================================================
 * 1. 中立协议模型（对齐官方 wire 结构，仅取模拟器需要的最小集）
 * ============================================================ */

export type ProtoDirection = "UP" | "DOWN" | "LEFT" | "RIGHT";
export type ProtoUnitType = "WORKER" | "VANGUARD" | "RANGER";
export type ProtoCoreState = "NORMAL" | "MOVING";
export type ProtoPlayerStatus = "ACTIVE" | "RESPAWNING";
export type ProtoObjectKind = "OBSTACLE" | "RESOURCE" | "CORE" | "UNIT";

/** 官方 CoreView。 */
export interface ProtoCoreView {
  readonly kind: "CORE";
  readonly id: string;
  readonly controlled: boolean;
  readonly owner_username: string;
  readonly position: readonly [number, number];
  readonly hp: number;
  readonly shield: number;
  readonly state: ProtoCoreState;
  readonly move_direction: ProtoDirection | null;
  readonly move_progress: number | null;
  readonly move_required_ticks: number | null;
  readonly destination: readonly [number, number] | null;
}

/** 官方 UnitView。 */
export interface ProtoUnitView {
  readonly kind: "UNIT";
  readonly id: string;
  readonly controlled: boolean;
  readonly position: readonly [number, number];
  readonly hp: number;
  readonly unit_type: ProtoUnitType;
  readonly cargo: number | null;
}

/** 官方 TerrainView（UUID-less 批量地形）。 */
export interface ProtoTerrainView {
  readonly kind: ProtoObjectKind;
  readonly positions: readonly (readonly [number, number])[];
}

/** 官方 WorldObject 判别联合。 */
export type ProtoWorldObject = ProtoCoreView | ProtoUnitView | ProtoTerrainView;

/** 官方 ChampionBeacon。 */
export interface ProtoChampionBeacon {
  readonly position: readonly [number, number];
  readonly status: "GROUND" | "CARRIED" | null;
  readonly carrier_id: string | null;
}

/** 官方 ResolutionEvent（最小集）。 */
export interface ProtoResolutionEvent {
  readonly event_id: string;
  readonly tick: number;
  readonly event_type: string;
  readonly reason_code: string | null;
  readonly actor_id: string | null;
  readonly target_id: string | null;
  readonly position: readonly [number, number] | null;
  readonly values: Readonly<Record<string, unknown>> | null;
}

/** 官方 PlayerState —— 每一个"本租户视角"的权威观察快照。 */
export interface ProtoPlayerState {
  readonly status: ProtoPlayerStatus;
  readonly respawn_at_tick: number | null;
  readonly resources: number;
  readonly population: number;
  readonly champion_beacon: ProtoChampionBeacon;
  readonly objects: readonly ProtoWorldObject[];
  readonly events: readonly ProtoResolutionEvent[];
}

/** 官方 CommandPlan —— 一个租户单 tick 的完整计划。 */
export interface ProtoCommandPlan {
  readonly tick: number;
  readonly unit_actions: Readonly<Record<string, ProtoUnitAction>>;
  readonly core_action: ProtoCoreAction | null;
}

export type ProtoUnitAction =
  | { readonly type: "WAIT" }
  | { readonly type: "MOVE"; readonly direction: ProtoDirection }
  | { readonly type: "HARVEST" }
  | { readonly type: "DEPOSIT" }
  | { readonly type: "SWEEP"; readonly direction: ProtoDirection }
  | { readonly type: "SHOOT"; readonly target_id: string | null; readonly expected_cell: readonly [number, number] }
  | { readonly type: "PICKUP_BEACON" }
  | { readonly type: "DROP_BEACON" }
  | { readonly type: "SELF_DESTRUCT" }
  | { readonly type: "HEAL" };

export type ProtoCoreAction =
  | { readonly type: "WAIT" }
  | { readonly type: "SPAWN"; readonly unit_type: ProtoUnitType }
  | { readonly type: "REPAIR_SHIELD" }
  | { readonly type: "HEAL" }
  | { readonly type: "START_MOVE"; readonly direction: ProtoDirection }
  | { readonly type: "CANCEL_MOVE" }
  | { readonly type: "PICKUP_BEACON" }
  | { readonly type: "DROP_BEACON" }
  | { readonly type: "SELF_DESTRUCT" };

/* ============================================================
 * 1.5 官方 wire 适配：确定性 UUID + 用户名归一化
 *
 * 官方 pydantic 模型是严格模式（extra="forbid"）且 `id` 字段必须合法 UUID。
 * 模拟器内部：
 *  - 单位/核心 ID 已是场景 UUID（loaders assertCanonicalUuid），透传即可；
 *  - 事件 ID 是 "sim:..." 内部格式 → 必须转合法 UUID；
 *  - owner_username 要求 `^[a-z0-9_]+$` 且长度 >=3 → 归一化（"-" → "_"，
 *    不足补 "_"），避免官方 pydantic pattern 校验拒绝。
 * ============================================================ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 把任意内部 ID 确定性映射为合法 UUID（FNV-1a 64 位 → v5 风格布局）。 */
export function toDeterministicUuid(id: string): string {
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  let hash = FNV_OFFSET;
  for (const byte of Buffer.from(`arena:${id}`, "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & 0xffffffffffffffffn;
  }
  const bytes = new Uint8Array(16);
  const high = hash;
  const low = (hash * FNV_PRIME) & 0xffffffffffffffffn;
  for (let index = 0; index < 8; index += 1) {
    bytes[7 - index] = Number((high >> BigInt(index * 8)) & 0xffn);
    bytes[15 - index] = Number((low >> BigInt(index * 8)) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

/** 已是合法 UUID 则原样返回，否则确定性转换（事件 ID/actor/target 用）。 */
function asOfficialUuid(id: string): string {
  return UUID_RE.test(id) ? id : toDeterministicUuid(id);
}

/** 归一化 owner_username 以满足官方 `^[a-z0-9_]+$` 且长度 >=3。 */
export function normalizeOwnerUsername(name: string): string {
  const cleaned = name.replace(/[^a-z0-9_]/g, "_");
  if (cleaned.length >= 3) return cleaned;
  return cleaned.padEnd(3, "_");
}

/** 归一化 champion_beacon 的 carrier_id（UUID 校验）。 */
function asOfficialNullableUuid(id: string | null): string | null {
  return id === null ? null : asOfficialUuid(id);
}

/* ============================================================
 * 2. 翻译：TickState → ProtoPlayerState
 * ============================================================ */

const DIRECTIONS: readonly ProtoDirection[] = ["UP", "DOWN", "LEFT", "RIGHT"];

export function directionToProto(direction: Direction): ProtoDirection {
  return direction;
}

/**
 * 把一个 `TickState`（本租户视角）翻译成官方 `PlayerState`。
 * 语义：
 *  - controlled=true 的单位/核心 = 本租户拥有的；
 *  - 其他可见实体（visibleEnemies）→ controlled=false；
 *  - 资源/障碍 → TerrainView；
 *  - events 直接透传（event_id/actor/target 过 UUID 适配）。
 * 注意：official PlayerState 是"单个玩家视角"，所以本函数只产出**当前玩家**的
 * 视图（no cross-view merging here — 由调用方决定该喂哪个玩家视角）。
 */
export function tickStateToProto(state: TickState, selfPlayerId: string): ProtoPlayerState {
  const objects: ProtoWorldObject[] = [];

  // 己方核心
  if (state.core !== null) {
    objects.push({
      kind: "CORE",
      id: state.core.id,
      controlled: state.core.ownerUsername === selfPlayerId,
      owner_username: normalizeOwnerUsername(state.core.ownerUsername),
      position: state.core.position,
      hp: state.core.hp,
      shield: state.core.shield,
      state: state.core.state,
      move_direction: null,
      move_progress: null,
      move_required_ticks: null,
      destination: null,
    });
  }

  // 己方单位
  for (const unit of state.units) {
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

  // 可见敌方实体（非控）
  for (const enemy of state.visibleEnemies) {
    if (enemy.kind === "CORE") {
      objects.push({
        kind: "CORE",
        id: enemy.id,
        controlled: false,
        owner_username: normalizeOwnerUsername(enemy.ownerUsername ?? "unknown"),
        position: enemy.position,
        hp: enemy.hp,
        shield: 0,
        state: "NORMAL",
        move_direction: null,
        move_progress: null,
        move_required_ticks: null,
        destination: null,
      });
    } else {
      objects.push({
        kind: "UNIT",
        id: enemy.id,
        controlled: false,
        position: enemy.position,
        hp: enemy.hp,
        unit_type: enemy.unitType ?? "VANGUARD",
        cargo: null,
      });
    }
  }

  // 资源/障碍（批量）
  const resourceCells = [...state.resourceCells].map(parseCell);
  const obstacleCells = [...state.obstacleCells].map(parseCell);
  if (obstacleCells.length > 0) objects.push({ kind: "OBSTACLE", positions: obstacleCells } satisfies ProtoTerrainView);
  if (resourceCells.length > 0) objects.push({ kind: "RESOURCE", positions: resourceCells } satisfies ProtoTerrainView);

  return {
    status: state.status,
    respawn_at_tick: null,
    resources: state.resources,
    population: state.population,
    champion_beacon: {
      position: state.beacon.position,
      status: state.beacon.status,
      carrier_id: asOfficialNullableUuid(state.beacon.carrierId),
    },
    objects,
    events: state.events.map(eventToProto),
  };
}

function parseCell(key: string): readonly [number, number] {
  const i = key.indexOf(",");
  return [Number(key.slice(0, i)), Number(key.slice(i + 1))];
}

function eventToProto(event: ResolutionEventSnapshot): ProtoResolutionEvent {
  return {
    event_id: asOfficialUuid(event.eventId),
    tick: event.tick,
    event_type: event.eventType,
    reason_code: event.reasonCode,
    actor_id: asOfficialNullableUuid(event.actorId),
    target_id: asOfficialNullableUuid(event.targetId),
    position: event.position ?? null,
    values: Object.keys(event.values).length === 0 ? null : event.values,
  };
}

/* ============================================================
 * 3. 翻译：ProtoCommandPlan → Plan
 * ============================================================ */

export function protoToUnitAction(action: ProtoUnitAction, unitId: string, intents: Record<string, string>): UnitAction {
  switch (action.type) {
    case "WAIT":
      return { type: "WAIT" };
    case "MOVE":
      return { type: "MOVE", direction: action.direction };
    case "HARVEST":
      return { type: "HARVEST" };
    case "DEPOSIT":
      return { type: "DEPOSIT" };
    case "SWEEP":
      return { type: "SWEEP", direction: action.direction };
    case "SHOOT":
      return { type: "SHOOT", targetId: action.target_id, expectedCell: action.expected_cell };
    case "PICKUP_BEACON":
      return { type: "PICKUP_BEACON" };
    case "DROP_BEACON":
      return { type: "DROP_BEACON" };
    case "SELF_DESTRUCT":
      return { type: "SELF_DESTRUCT" };
    case "HEAL":
      return { type: "HEAL" };
    default:
      return { type: "WAIT" };
  }
}

export function protoToCoreAction(action: ProtoCoreAction | null): CoreAction | null {
  if (action === null) return null;
  switch (action.type) {
    case "WAIT":
      return { type: "WAIT" };
    case "SPAWN":
      return { type: "SPAWN", unitType: action.unit_type };
    case "REPAIR_SHIELD":
      return { type: "REPAIR_SHIELD" };
    case "HEAL":
      return { type: "HEAL" };
    case "START_MOVE":
      return { type: "START_MOVE", direction: action.direction };
    case "CANCEL_MOVE":
      return { type: "CANCEL_MOVE" };
    case "PICKUP_BEACON":
      return { type: "PICKUP_BEACON" };
    case "DROP_BEACON":
      return { type: "DROP_BEACON" };
    case "SELF_DESTRUCT":
      return { type: "SELF_DESTRUCT" };
    default:
      return null;
  }
}

/** 官方计划 → 模拟器 settle 计划。intents 语义由调用方注入（对外部 agent 无法
 *  拿到内部 intent，统一标 "external"）。 */
export function protoPlanToPlan(plan: ProtoCommandPlan, sourceIntent = "external"): Plan {
  const unitActions: Record<string, UnitAction> = {};
  const intents: Record<string, string> = {};
  for (const [unitId, action] of Object.entries(plan.unit_actions)) {
    unitActions[unitId] = protoToUnitAction(action, unitId, intents);
    intents[unitId] = sourceIntent;
  }
  return {
    tick: plan.tick,
    unitActions,
    coreAction: protoToCoreAction(plan.core_action),
    intents,
  };
}

/* ============================================================
 * 反向：Plan → ProtoCommandPlan（供"我方案策略 → 对手视角"时残留对手复制用，
 * 平台化扩展预留，当前非必须，但保留以封闭翻译面）。
 * ============================================================ */

export function unitActionToProto(action: UnitAction): ProtoUnitAction {
  switch (action.type) {
    case "WAIT":
      return { type: "WAIT" };
    case "MOVE":
      return { type: "MOVE", direction: action.direction };
    case "HARVEST":
      return { type: "HARVEST" };
    case "DEPOSIT":
      return { type: "DEPOSIT" };
    case "SWEEP":
      return { type: "SWEEP", direction: action.direction };
    case "SHOOT":
      return { type: "SHOOT", target_id: action.targetId, expected_cell: action.expectedCell };
    case "PICKUP_BEACON":
      return { type: "PICKUP_BEACON" };
    case "DROP_BEACON":
      return { type: "DROP_BEACON" };
    case "SELF_DESTRUCT":
      return { type: "SELF_DESTRUCT" };
    case "HEAL":
      return { type: "HEAL" };
  }
}

export function coreActionToProto(action: CoreAction | null): ProtoCoreAction | null {
  if (action === null) return null;
  switch (action.type) {
    case "WAIT":
      return { type: "WAIT" };
    case "SPAWN":
      return { type: "SPAWN", unit_type: action.unitType };
    case "REPAIR_SHIELD":
      return { type: "REPAIR_SHIELD" };
    case "HEAL":
      return { type: "HEAL" };
    case "START_MOVE":
      return { type: "START_MOVE", direction: action.direction };
    case "CANCEL_MOVE":
      return { type: "CANCEL_MOVE" };
    case "PICKUP_BEACON":
      return { type: "PICKUP_BEACON" };
    case "DROP_BEACON":
      return { type: "DROP_BEACON" };
    case "SELF_DESTRUCT":
      return { type: "SELF_DESTRUCT" };
  }
}
