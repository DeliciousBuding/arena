/**
 * Alliance orchestration/control contracts.
 *
 * Canonical observed-world facts live in types.ts/sightings.ts/counts.ts/threat-field.ts.
 * This file adds only control-plane concepts: roles, missions, directives and fleet refs.
 * It intentionally contains no Arena token, Plan, CandidateSink, I/O or writer capability.
 */
import type { AllianceMemberState, Position } from "./types.ts";

/** Compatibility name for the compressed member state sent over Alliance IPC. */
export type AllianceMemberReport = AllianceMemberState;
export type MemberStatus = AllianceMemberState["status"];

export type AllianceRole = "TREASURY" | "DEFENDER" | "RAIDER" | "SCOUT";
export type ControlMode = "AUTO" | "ASSIST" | "DIRECT";

export type FleetState = "ASSEMBLE" | "MARCH" | "ENGAGE" | "HOLD" | "RETREAT" | "REBUILD";
export type FormationType = "FORTRESS_RING" | "ASSAULT_WEDGE" | "SCOUT_FAN";

export interface FleetRef {
  readonly fleetId: string;
  readonly tenantId: string;
}

export interface TaskForce {
  readonly id: string;
  readonly missionId: string;
  readonly fleetRefs: readonly FleetRef[];
  readonly commanderTenant: string;
  readonly synchronization: "LOOSE" | "RALLY_BEFORE_ENGAGE";
}

export type MissionKind =
  | "DEFEND"
  | "SCOUT"
  | "ASSEMBLE"
  | "RAID"
  | "INTERCEPT"
  | "ESCORT"
  | "RETREAT";

export type MissionStatus =
  | "PROPOSED"
  | "ASSIGNED"
  | "ACTIVE"
  | "SATISFIED"
  | "CANCELLED"
  | "EXPIRED"
  | "FAILED";

export type MissionSource = "AUTO" | "HUMAN_ASSIST";

export interface Mission {
  readonly id: string;
  readonly revision: number;
  readonly kind: MissionKind;
  readonly priority: number;
  readonly target?: Position;
  readonly targetEntityKey?: string;
  readonly defendTenant?: string;
  readonly scope?: string;
  readonly issuedAtTick: number;
  readonly expiresAtTick: number;
  readonly status: MissionStatus;
  readonly source: MissionSource;
}

export type DirectiveSource = "auto" | "human";

export interface AllianceDirective {
  readonly tenantId: string;
  readonly revision: number;
  readonly missionRefs: readonly string[];
  readonly issuedAtTick: number;
  readonly expiresAtTick: number;
  readonly source: DirectiveSource;
  readonly mode: ControlMode;
  readonly explanation?: string;
}
