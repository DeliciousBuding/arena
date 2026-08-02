/** Typed command actions and complete command plans. */

import type { CommandSource, Direction, UnitType } from "./enums.ts";
import type { Position } from "./geometry.ts";

/** Explicitly do nothing for this Tick. */
export interface WaitAction {
  type: "WAIT";
}

/** Move a Unit one cell. */
export interface MoveAction {
  type: "MOVE";
  direction: Direction;
}

/** Harvest resources with a Worker. */
export interface HarvestAction {
  type: "HARVEST";
}

/** Deposit Worker cargo into the Core. */
export interface DepositAction {
  type: "DEPOSIT";
}

/** Sweep an adjacent cell with a Vanguard. */
export interface SweepAction {
  type: "SWEEP";
  direction: Direction;
}

/** Shoot an expected target cell with a Ranger in an eight-direction line. */
export interface ShootAction {
  type: "SHOOT";
  target_id: string;
  expected_cell: Position;
}

/** Pick up the Champion Beacon on the current cell. */
export interface PickupBeaconAction {
  type: "PICKUP_BEACON";
}

/** Drop the Champion Beacon on the current cell. */
export interface DropBeaconAction {
  type: "DROP_BEACON";
}

/** Remove a Unit before upkeep without refund or damage. */
export interface SelfDestructAction {
  type: "SELF_DESTRUCT";
}

/** Recover HP after combat by spending Core resources. */
export interface HealAction {
  type: "HEAL";
}

/** Spawn one Unit from the Core. */
export interface SpawnAction {
  type: "SPAWN";
  unit_type: UnitType;
}

/** Spend one resource to restore one Core shield. */
export interface RepairShieldAction {
  type: "REPAIR_SHIELD";
}

/** Start moving the Core in one direction. */
export interface StartMoveAction {
  type: "START_MOVE";
  direction: Direction;
}

/** Cancel the Core's current movement. */
export interface CancelMoveAction {
  type: "CANCEL_MOVE";
}

/** An action a Unit can take in one Tick. */
export type UnitAction =
  | WaitAction
  | MoveAction
  | HarvestAction
  | DepositAction
  | SweepAction
  | ShootAction
  | PickupBeaconAction
  | DropBeaconAction
  | SelfDestructAction
  | HealAction;

/** An action the Core can take in one Tick. */
export type CoreAction =
  | WaitAction
  | SpawnAction
  | RepairShieldAction
  | StartMoveAction
  | CancelMoveAction
  | PickupBeaconAction
  | DropBeaconAction
  | HealAction;

/** A complete replacement plan for one source and Tick. */
export interface CommandPlan {
  tick: number;
  unit_actions: Readonly<Record<string, UnitAction>>;
  core_action: CoreAction | null;
}

/** HTTP acknowledgement that a complete plan was persisted. */
export interface Accepted {
  accepted: true;
  tick: number;
  source: CommandSource;
  received_at: string;
}
