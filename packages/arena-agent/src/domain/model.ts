export type Position = readonly [number, number];
export type Direction = "UP" | "DOWN" | "LEFT" | "RIGHT";
export type UnitType = "WORKER" | "VANGUARD" | "RANGER";
export type CoreState = "NORMAL" | "MOVING";
export type PlayerStatus = "ACTIVE" | "RESPAWNING";

export interface UnitSnapshot {
  readonly id: string;
  readonly position: Position;
  readonly hp: number;
  readonly unitType: UnitType;
  readonly cargo: number;
}

export interface CoreSnapshot {
  readonly id: string;
  readonly position: Position;
  readonly hp: number;
  readonly shield: number;
  readonly state: CoreState;
  readonly ownerUsername: string;
}

export interface VisibleEntity {
  readonly id: string;
  readonly kind: "UNIT" | "CORE";
  readonly position: Position;
  readonly hp: number;
  readonly unitType?: UnitType;
  readonly ownerUsername?: string;
}

export interface BeaconSnapshot {
  readonly position: Position;
  readonly status: "GROUND" | "CARRIED";
  readonly carrierId: string | null;
}

export interface ResolutionEventSnapshot {
  readonly eventId: string;
  readonly tick: number;
  readonly eventType: string;
  readonly reasonCode: string | null;
  readonly actorId: string | null;
  readonly targetId: string | null;
  readonly position?: Position;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface TickState {
  readonly tick: number;
  readonly status: PlayerStatus;
  readonly resources: number;
  readonly resourceCapacity: number;
  readonly resourceSpace: number;
  readonly population: number;
  readonly core: CoreSnapshot | null;
  readonly units: readonly UnitSnapshot[];
  readonly workers: readonly UnitSnapshot[];
  readonly vanguards: readonly UnitSnapshot[];
  readonly rangers: readonly UnitSnapshot[];
  readonly visibleEnemies: readonly VisibleEntity[];
  readonly resourceCells: ReadonlySet<string>;
  readonly obstacleCells: ReadonlySet<string>;
  readonly beacon: BeaconSnapshot;
  readonly events: readonly ResolutionEventSnapshot[];
}

export type UnitAction =
  | { readonly type: "WAIT" }
  | { readonly type: "MOVE"; readonly direction: Direction }
  | { readonly type: "HARVEST" }
  | { readonly type: "DEPOSIT" }
  | { readonly type: "SWEEP"; readonly direction: Direction }
  | { readonly type: "SHOOT"; readonly targetId: string; readonly expectedCell: Position }
  | { readonly type: "PICKUP_BEACON" }
  | { readonly type: "DROP_BEACON" }
  | { readonly type: "SELF_DESTRUCT" }
  | { readonly type: "HEAL" };

export type CoreAction =
  | { readonly type: "WAIT" }
  | { readonly type: "SPAWN"; readonly unitType: UnitType }
  | { readonly type: "REPAIR_SHIELD" }
  | { readonly type: "HEAL" }
  | { readonly type: "START_MOVE"; readonly direction: Direction }
  | { readonly type: "CANCEL_MOVE" }
  | { readonly type: "PICKUP_BEACON" }
  | { readonly type: "DROP_BEACON" };

export interface Plan {
  readonly tick: number;
  readonly unitActions: Readonly<Record<string, UnitAction>>;
  readonly coreAction: CoreAction | null;
  readonly intents: Readonly<Record<string, string>>;
}

export interface DecisionCandidate {
  readonly protocolVersion: "1";
  readonly tick: number;
  readonly stateHash: string;
  readonly plan: Plan;
  readonly reason?: string;
  readonly confidence?: number;
}

/** 决策来源（4D-pre 统一：权威定义在 runtime/decision-types.ts，本处 re-export 防双套矛盾）。 */
export type { DecisionSource } from "../runtime/decision-types.ts";

export function cellKey(position: Position): string {
  return `${position[0]},${position[1]}`;
}

export function parseCellKey(value: string): Position {
  const parts = value.split(",");
  if (parts.length !== 2) {
    throw new Error(`invalid cell key: ${value}`);
  }
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new Error(`invalid cell key: ${value}`);
  }
  return [x, y];
}

export function emptyPlan(tick: number): Plan {
  return { tick, unitActions: {}, coreAction: null, intents: {} };
}
