/** Strict offline calibration case schema (S8a). */

import type { PlayerState } from "@arena/arena-hero-ts";
import type { Plan } from "../../domain/model.ts";

export const CALIBRATION_CASE_SCHEMA = "sim-calibration-case-v1" as const;

export interface CalibrationCaseMetadata {
  readonly source: "fixture" | "live-recorder";
  /** Whether every opponent's locked plan for this Tick is represented in the case. */
  readonly opponentPlans: "complete" | "absent";
  readonly recordedAt: string | null;
  readonly sourceCommit: string | null;
  readonly runId: string | null;
}

export interface CalibrationObservation {
  readonly tick: number;
  readonly state: PlayerState;
}

export interface CalibrationCaseV1 {
  readonly schema: typeof CALIBRATION_CASE_SCHEMA;
  readonly caseId: string;
  readonly tenantId: string;
  readonly rulesVersion: string;
  /** Local replay seed. It is not claimed to be the server's hidden world seed. */
  readonly seed: number;
  readonly metadata: CalibrationCaseMetadata;
  readonly before: CalibrationObservation;
  /** Full executed domain plan is mandatory; old state-only fixtures are rejected. */
  readonly plan: Plan;
  readonly after: CalibrationObservation;
}

export class CalibrationCaseError extends Error {
  constructor(message: string) {
    super(`calibration case: ${message}`);
    this.name = "CalibrationCaseError";
  }
}

const DIRECTIONS = new Set(["UP", "DOWN", "LEFT", "RIGHT"]);
const UNIT_TYPES = new Set(["WORKER", "VANGUARD", "RANGER"]);

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CalibrationCaseError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new CalibrationCaseError(`${path}.${key} is not allowed`);
  }
  const optionalSet = new Set(optional);
  for (const key of allowed) {
    if (!(key in value) && !optionalSet.has(key)) {
      throw new CalibrationCaseError(`${path}.${key} is required`);
    }
  }
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CalibrationCaseError(`${path} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return nonEmptyString(value, path);
}

function safePositiveInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new CalibrationCaseError(`${path} must be a positive safe integer`);
  }
  return value;
}

function safeInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CalibrationCaseError(`${path} must be a safe integer`);
  }
  return value;
}

function nonNegativeInt(value: unknown, path: string): number {
  const parsed = safeInt(value, path);
  if (parsed < 0) throw new CalibrationCaseError(`${path} must be non-negative`);
  return parsed;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new CalibrationCaseError(`${path} must be boolean`);
  return value;
}

function position(value: unknown, path: string): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new CalibrationCaseError(`${path} must be [x,y]`);
  }
  return [safeInt(value[0], `${path}[0]`), safeInt(value[1], `${path}[1]`)];
}

function nullablePosition(value: unknown, path: string): readonly [number, number] | null {
  return value === null ? null : position(value, path);
}

function nullableIdentifier(value: unknown, path: string): string | null {
  return value === null ? null : nonEmptyString(value, path);
}

function parseMetadata(value: unknown): CalibrationCaseMetadata {
  const raw = record(value, "metadata");
  exactKeys(raw, ["source", "opponentPlans", "recordedAt", "sourceCommit", "runId"], "metadata");
  if (raw.source !== "fixture" && raw.source !== "live-recorder") {
    throw new CalibrationCaseError("metadata.source must be fixture or live-recorder");
  }
  if (raw.opponentPlans !== "complete" && raw.opponentPlans !== "absent") {
    throw new CalibrationCaseError("metadata.opponentPlans must be complete or absent");
  }
  return {
    source: raw.source,
    opponentPlans: raw.opponentPlans,
    recordedAt: nullableString(raw.recordedAt, "metadata.recordedAt"),
    sourceCommit: nullableString(raw.sourceCommit, "metadata.sourceCommit"),
    runId: nullableString(raw.runId, "metadata.runId"),
  };
}

function parsePlayerState(value: unknown, path: string): PlayerState {
  const raw = record(value, path);
  exactKeys(
    raw,
    [
      "status",
      "respawn_at_tick",
      "resources",
      "population",
      "population_tier",
      "upkeep_next_tick",
      "champion_beacon",
      "objects",
      "events",
    ],
    path,
    // v0.14（2026-08-06 上游 rules v0.14）起服务器不再下发这两个字段；与
    // 共享 schema（integer|null + optional）对齐，缺省或 null 即“服务器未提供”。
    ["population_tier", "upkeep_next_tick"],
  );
  if (raw.status !== "ACTIVE" && raw.status !== "RESPAWNING") {
    throw new CalibrationCaseError(`${path}.status is invalid`);
  }
  for (const field of ["resources", "population"] as const) {
    nonNegativeInt(raw[field], `${path}.${field}`);
  }
  for (const field of ["population_tier", "upkeep_next_tick"] as const) {
    const maintenanceValue = raw[field];
    if (maintenanceValue !== undefined && maintenanceValue !== null) {
      nonNegativeInt(maintenanceValue, `${path}.${field}`);
    }
  }
  if (raw.respawn_at_tick !== null) safePositiveInt(raw.respawn_at_tick, `${path}.respawn_at_tick`);
  if (raw.status === "ACTIVE" && raw.respawn_at_tick !== null) {
    throw new CalibrationCaseError(`${path}.respawn_at_tick must be null while ACTIVE`);
  }
  if (raw.status === "RESPAWNING" && raw.respawn_at_tick === null) {
    throw new CalibrationCaseError(`${path}.respawn_at_tick is required while RESPAWNING`);
  }
  const beacon = record(raw.champion_beacon, `${path}.champion_beacon`);
  exactKeys(beacon, ["position", "status", "carrier_id"], `${path}.champion_beacon`);
  position(beacon.position, `${path}.champion_beacon.position`);
  if (beacon.status !== null && beacon.status !== "GROUND" && beacon.status !== "CARRIED") {
    throw new CalibrationCaseError(`${path}.champion_beacon.status is invalid`);
  }
  nullableIdentifier(beacon.carrier_id, `${path}.champion_beacon.carrier_id`);
  if (beacon.status === "CARRIED" && beacon.carrier_id === null) {
    throw new CalibrationCaseError(`${path}.champion_beacon.carrier_id is required while CARRIED`);
  }
  if (beacon.status !== "CARRIED" && beacon.carrier_id !== null) {
    throw new CalibrationCaseError(`${path}.champion_beacon.carrier_id is only valid while CARRIED`);
  }
  if (!Array.isArray(raw.objects)) throw new CalibrationCaseError(`${path}.objects must be an array`);
  if (!Array.isArray(raw.events)) throw new CalibrationCaseError(`${path}.events must be an array`);

  let controlledUnitCount = 0;
  for (const [index, objectValue] of raw.objects.entries()) {
    const objectPath = `${path}.objects[${index}]`;
    const object = record(objectValue, objectPath);
    if (object.kind === "OBSTACLE" || object.kind === "RESOURCE") {
      exactKeys(object, ["kind", "positions"], objectPath);
      if (!Array.isArray(object.positions) || object.positions.length === 0) {
        throw new CalibrationCaseError(`${objectPath}.positions must be a non-empty array`);
      }
      object.positions.forEach((entry, positionIndex) =>
        position(entry, `${objectPath}.positions[${positionIndex}]`),
      );
      continue;
    }
    if (object.kind === "CORE") {
      exactKeys(
        object,
        [
          "kind", "id", "controlled", "owner_username", "position", "hp", "shield", "state",
          "move_direction", "move_progress", "move_required_ticks", "destination",
        ],
        objectPath,
      );
      nonEmptyString(object.id, `${objectPath}.id`);
      booleanValue(object.controlled, `${objectPath}.controlled`);
      nonEmptyString(object.owner_username, `${objectPath}.owner_username`);
      position(object.position, `${objectPath}.position`);
      nonNegativeInt(object.hp, `${objectPath}.hp`);
      nonNegativeInt(object.shield, `${objectPath}.shield`);
      if (object.state !== "NORMAL" && object.state !== "MOVING") {
        throw new CalibrationCaseError(`${objectPath}.state is invalid`);
      }
      if (object.move_direction !== null && !DIRECTIONS.has(object.move_direction as string)) {
        throw new CalibrationCaseError(`${objectPath}.move_direction is invalid`);
      }
      const moveProgress = object.move_progress === null
        ? null
        : nonNegativeInt(object.move_progress, `${objectPath}.move_progress`);
      const moveRequired = object.move_required_ticks === null
        ? null
        : safePositiveInt(object.move_required_ticks, `${objectPath}.move_required_ticks`);
      const destination = nullablePosition(object.destination, `${objectPath}.destination`);
      const movingFields = [object.move_direction, moveProgress, moveRequired, destination];
      if (object.state === "NORMAL" && movingFields.some((entry) => entry !== null)) {
        throw new CalibrationCaseError(`${objectPath} NORMAL Core cannot contain movement fields`);
      }
      if (object.state === "MOVING" && movingFields.some((entry) => entry === null)) {
        throw new CalibrationCaseError(`${objectPath} MOVING Core requires all movement fields`);
      }
      continue;
    }
    if (object.kind === "UNIT") {
      exactKeys(object, ["kind", "id", "controlled", "position", "hp", "unit_type", "cargo"], objectPath);
      nonEmptyString(object.id, `${objectPath}.id`);
      const controlled = booleanValue(object.controlled, `${objectPath}.controlled`);
      position(object.position, `${objectPath}.position`);
      nonNegativeInt(object.hp, `${objectPath}.hp`);
      if (!UNIT_TYPES.has(object.unit_type as string)) {
        throw new CalibrationCaseError(`${objectPath}.unit_type is invalid`);
      }
      const cargo = object.cargo === null ? null : nonNegativeInt(object.cargo, `${objectPath}.cargo`);
      if (cargo !== null && (!controlled || object.unit_type !== "WORKER")) {
        throw new CalibrationCaseError(`${objectPath}.cargo is only valid for controlled Workers`);
      }
      if (controlled) controlledUnitCount += 1;
      continue;
    }
    throw new CalibrationCaseError(`${objectPath}.kind is invalid`);
  }
  if (raw.population !== controlledUnitCount) {
    throw new CalibrationCaseError(
      `${path}.population ${String(raw.population)} does not match controlled units ${controlledUnitCount}`,
    );
  }

  for (const [index, eventValue] of raw.events.entries()) {
    const eventPath = `${path}.events[${index}]`;
    const event = record(eventValue, eventPath);
    exactKeys(
      event,
      ["event_id", "tick", "event_type", "reason_code", "actor_id", "target_id", "position", "values"],
      eventPath,
    );
    nonEmptyString(event.event_id, `${eventPath}.event_id`);
    safePositiveInt(event.tick, `${eventPath}.tick`);
    nonEmptyString(event.event_type, `${eventPath}.event_type`);
    nullableIdentifier(event.reason_code, `${eventPath}.reason_code`);
    nullableIdentifier(event.actor_id, `${eventPath}.actor_id`);
    nullableIdentifier(event.target_id, `${eventPath}.target_id`);
    nullablePosition(event.position, `${eventPath}.position`);
    if (event.values !== null) record(event.values, `${eventPath}.values`);
  }
  return raw as unknown as PlayerState;
}

function parseObservation(value: unknown, path: string): CalibrationObservation {
  const raw = record(value, path);
  exactKeys(raw, ["tick", "state"], path);
  return {
    tick: safePositiveInt(raw.tick, `${path}.tick`),
    state: parsePlayerState(raw.state, `${path}.state`),
  };
}

function direction(value: unknown, path: string): string {
  if (typeof value !== "string" || !DIRECTIONS.has(value)) {
    throw new CalibrationCaseError(`${path} is invalid`);
  }
  return value;
}

function unitType(value: unknown, path: string): string {
  if (typeof value !== "string" || !UNIT_TYPES.has(value)) {
    throw new CalibrationCaseError(`${path} is invalid`);
  }
  return value;
}

function parseUnitAction(value: unknown, path: string): Record<string, unknown> {
  const action = record(value, path);
  const type = nonEmptyString(action.type, `${path}.type`);
  switch (type) {
    case "WAIT":
    case "HARVEST":
    case "DEPOSIT":
    case "PICKUP_BEACON":
    case "DROP_BEACON":
    case "HEAL":
    case "SELF_DESTRUCT":
      exactKeys(action, ["type"], path);
      break;
    case "MOVE":
    case "SWEEP":
      exactKeys(action, ["type", "direction"], path);
      direction(action.direction, `${path}.direction`);
      break;
    case "SHOOT":
      exactKeys(action, ["type", "targetId", "expectedCell"], path);
      nonEmptyString(action.targetId, `${path}.targetId`);
      position(action.expectedCell, `${path}.expectedCell`);
      break;
    default:
      throw new CalibrationCaseError(`${path}.type is invalid`);
  }
  return action;
}

function parseCoreAction(value: unknown, path: string): Record<string, unknown> {
  const action = record(value, path);
  const type = nonEmptyString(action.type, `${path}.type`);
  switch (type) {
    case "WAIT":
    case "HEAL":
    case "REPAIR_SHIELD":
    case "CANCEL_MOVE":
    case "PICKUP_BEACON":
    case "DROP_BEACON":
      exactKeys(action, ["type"], path);
      break;
    case "SPAWN":
      exactKeys(action, ["type", "unitType"], path);
      unitType(action.unitType, `${path}.unitType`);
      break;
    case "START_MOVE":
      exactKeys(action, ["type", "direction"], path);
      direction(action.direction, `${path}.direction`);
      break;
    default:
      throw new CalibrationCaseError(`${path}.type is invalid`);
  }
  return action;
}

function parsePlan(value: unknown): Plan {
  const raw = record(value, "plan");
  exactKeys(raw, ["tick", "unitActions", "coreAction", "intents"], "plan");
  const tick = safePositiveInt(raw.tick, "plan.tick");
  const unitActions = record(raw.unitActions, "plan.unitActions");
  for (const [unitId, actionValue] of Object.entries(unitActions)) {
    nonEmptyString(unitId, "plan.unitActions key");
    parseUnitAction(actionValue, `plan.unitActions.${unitId}`);
  }
  if (raw.coreAction !== null) {
    parseCoreAction(raw.coreAction, "plan.coreAction");
  }
  const intents = record(raw.intents, "plan.intents");
  for (const [key, intent] of Object.entries(intents)) {
    nonEmptyString(key, "plan.intents key");
    if (typeof intent !== "string") throw new CalibrationCaseError(`plan.intents.${key} must be string`);
  }
  return { tick, unitActions, coreAction: raw.coreAction, intents } as unknown as Plan;
}

export function parseCalibrationCase(rawValue: unknown): CalibrationCaseV1 {
  const raw = record(rawValue, "root");
  exactKeys(
    raw,
    ["schema", "caseId", "tenantId", "rulesVersion", "seed", "metadata", "before", "plan", "after"],
    "root",
  );
  if (raw.schema !== CALIBRATION_CASE_SCHEMA) {
    throw new CalibrationCaseError(`unsupported schema ${String(raw.schema)}`);
  }
  const before = parseObservation(raw.before, "before");
  const plan = parsePlan(raw.plan);
  const after = parseObservation(raw.after, "after");
  if (plan.tick !== before.tick) {
    throw new CalibrationCaseError(`plan.tick ${plan.tick} does not match before.tick ${before.tick}`);
  }
  if (after.tick !== before.tick + 1) {
    throw new CalibrationCaseError(`after.tick ${after.tick} must equal before.tick + 1`);
  }
  return {
    schema: CALIBRATION_CASE_SCHEMA,
    caseId: nonEmptyString(raw.caseId, "caseId"),
    tenantId: nonEmptyString(raw.tenantId, "tenantId"),
    rulesVersion: nonEmptyString(raw.rulesVersion, "rulesVersion"),
    seed: safeInt(raw.seed, "seed"),
    metadata: parseMetadata(raw.metadata),
    before,
    plan,
    after,
  };
}
