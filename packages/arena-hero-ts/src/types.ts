/** Immutable models for Arena Hero state and WebSocket messages.
 *
 * 数据模型为纯只读接口；wire 字段级校验由 TypeBox schema 承担
 * （wire-schema.ts，单源）；本文件保留 domain 层关系约束
 * （cross-field 不变量）与事件辅助属性。
 */

import { ProtocolError } from "./errors.ts";
import type {
  BeaconStatus,
  CommandSource,
  CoreState,
  Direction,
  HarvestSource,
  PlayerStatus,
  UnitType,
} from "./enums.ts";
import { CoreState as CSt, PlayerStatus as PS, UnitType as UT } from "./enums.ts";
import type { Position } from "./geometry.ts";
import type { CommandPlan } from "./actions.ts";

/** The public Beacon position and its visibility-limited status. */
export interface ChampionBeacon {
  position: Position;
  status: BeaconStatus | null;
  carrier_id: string | null;
}

/** A batch of visible UUID-less terrain cells. */
export interface TerrainView {
  kind: "OBSTACLE" | "RESOURCE";
  positions: readonly Position[];
}

/** A controlled or visible Core. */
export interface CoreView {
  kind: "CORE";
  id: string;
  controlled: boolean;
  owner_username: string;
  position: Position;
  hp: number;
  shield: number;
  state: CoreState;
  move_direction: Direction | null;
  move_progress: number | null;
  move_required_ticks: number | null;
  destination: Position | null;
}

/** A controlled or visible Unit. */
export interface UnitView {
  kind: "UNIT";
  id: string;
  controlled: boolean;
  position: Position;
  hp: number;
  unit_type: UnitType;
  cargo: number | null;
}

/** A controlled Core or Unit seen in the player state. */
export type WorldObject = TerrainView | CoreView | UnitView;

/** Typed values from a CORE_RESOURCES_CAPTURED result. */
export interface CoreResourceCapture {
  amount: number;
  available: number;
  destroyed: number;
  capacity: number;
}

/** Typed values from a successful Unit or Core heal result. */
export interface HealingResult {
  amount: number;
  hp: number;
  cost: number;
}

/** A private result produced while resolving the previous Tick. */
export interface ResolutionEvent {
  event_id: string;
  tick: number;
  event_type: string;
  reason_code: string | null;
  actor_id: string | null;
  target_id: string | null;
  position: Position | null;
  values: Record<string, unknown> | null;
}

const RESOURCE_EVENT_TYPES = new Set([
  "CORE_RESOURCES_CAPTURED",
  "CORE_RESOURCE_OVERFLOW_DESTROYED",
  "DEPOSIT_SUCCEEDED",
  "HARVEST_SUCCEEDED",
  "WORKER_CARGO_DROPPED",
]);

/** A complete authoritative player-state replacement. */
export interface PlayerState {
  status: PlayerStatus;
  respawn_at_tick: number | null;
  resources: number;
  population: number;
  population_tier: number;
  upkeep_next_tick: number;
  champion_beacon: ChampionBeacon;
  objects: readonly WorldObject[];
  events: readonly ResolutionEvent[];
}

/** Notice that a new logical Tick has started. */
export interface Tick {
  tick: number;
}

/** The latest canonical complete plan stored for one source. */
export interface Received {
  tick: number;
  source: CommandSource;
  received_at: string;
  plan: CommandPlan;
}

// ---- domain 层关系约束（wire schema 之外的 cross-field 不变量） ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验 beacon 的关系不变量（CARRIED 必须有 carrier）。 */
export function checkBeaconRelations(beacon: ChampionBeacon): void {
  if (beacon.status === "CARRIED" && beacon.carrier_id == null) {
    throw new ProtocolError("carrier_id is required when status is CARRIED");
  }
  if (beacon.status !== "CARRIED" && beacon.carrier_id != null) {
    throw new ProtocolError("carrier_id is only valid when status is CARRIED");
  }
}

/** 校验 Core 的 MOVING/NORMAL 字段一致性。 */
export function checkCoreRelations(core: CoreView): void {
  const movement = [core.move_direction, core.move_progress, core.move_required_ticks, core.destination];
  if (core.state === CSt.MOVING && movement.some((m) => m == null)) {
    throw new ProtocolError("MOVING Core requires all movement fields");
  }
  if (core.state === CSt.NORMAL && movement.some((m) => m != null)) {
    throw new ProtocolError("NORMAL Core cannot contain movement fields");
  }
}

/** 校验 Unit 的 cargo 不变量（只在受控 Worker 上）。 */
export function checkUnitRelations(unit: UnitView): void {
  if (unit.cargo != null && (!unit.controlled || unit.unit_type !== UT.WORKER)) {
    throw new ProtocolError("cargo is only valid for a controlled Worker");
  }
}

/** 校验完整 PlayerState 的关系不变量。 */
export function checkPlayerStateRelations(state: PlayerState): void {
  if (state.status === PS.RESPAWNING && state.respawn_at_tick == null) {
    throw new ProtocolError("RESPAWNING state requires respawn_at_tick");
  }
  if (state.status === PS.ACTIVE && state.respawn_at_tick != null) {
    throw new ProtocolError("ACTIVE state cannot contain respawn_at_tick");
  }
  checkBeaconRelations(state.champion_beacon);
  for (const obj of state.objects) {
    if (obj.kind === "CORE") {
      checkCoreRelations(obj);
    } else if (obj.kind === "UNIT") {
      checkUnitRelations(obj);
    }
  }
}

/** 校验 Received 的关系不变量（plan tick 与 receipt tick 一致）。 */
export function checkReceivedConsistency(rec: Received): void {
  if (rec.plan.tick !== rec.tick) {
    throw new ProtocolError("received plan tick does not match receipt tick");
  }
}

// ---- ResolutionEvent 辅助属性（对应上游 pydantic property） ----

/** Amount carried by a resource event, when available. */
export function eventResourceAmount(ev: ResolutionEvent): number | null {
  if (!RESOURCE_EVENT_TYPES.has(ev.event_type) || ev.values == null) {
    return null;
  }
  const amount = ev.values.amount;
  return typeof amount === "number" && Number.isInteger(amount) && amount > 0 ? amount : null;
}

/** Typed Core loot values when the event is well formed. */
export function eventCoreResourceCapture(ev: ResolutionEvent): CoreResourceCapture | null {
  if (ev.event_type !== "CORE_RESOURCES_CAPTURED" || ev.values == null) {
    return null;
  }
  const v = ev.values;
  if (
    typeof v.amount === "number" && typeof v.available === "number" &&
    typeof v.destroyed === "number" && typeof v.capacity === "number"
  ) {
    return { amount: v.amount, available: v.available, destroyed: v.destroyed, capacity: v.capacity };
  }
  return null;
}

/** Typed values from a successful Unit or Core heal. */
export function eventHealing(ev: ResolutionEvent): HealingResult | null {
  if (
    ev.event_type !== "UNIT_HEAL_SUCCEEDED" && ev.event_type !== "CORE_HEAL_SUCCEEDED" ||
    ev.values == null
  ) {
    return null;
  }
  const v = ev.values;
  if (typeof v.amount === "number" && typeof v.hp === "number" && typeof v.cost === "number") {
    return { amount: v.amount, hp: v.hp, cost: v.cost };
  }
  return null;
}

/** The natural-node or dropped-cargo source for a harvest. */
export function eventHarvestSource(ev: ResolutionEvent): HarvestSource | null {
  if (ev.event_type !== "HARVEST_SUCCEEDED" || ev.values == null) {
    return null;
  }
  const source = ev.values.source;
  if (typeof source !== "string" || (source !== "RESOURCE_NODE" && source !== "DROPPED_CARGO")) {
    return null;
  }
  return source as HarvestSource;
}
