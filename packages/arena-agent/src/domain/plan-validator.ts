import { cellKey, type CoreAction, type Plan, type TickState, type UnitAction } from "./model.ts";
import { lineBlocked, manhattan, move } from "./nav.ts";

export type ValidationCode =
  | "tick_mismatch"
  | "unknown_unit"
  | "wrong_capability"
  | "blocked_move"
  | "invalid_harvest"
  | "invalid_deposit"
  | "invalid_heal"
  | "invalid_beacon"
  | "invalid_shot"
  | "missing_core"
  | "core_unavailable"
  | "insufficient_resources";

export interface ValidationIssue {
  readonly code: ValidationCode;
  readonly actorId: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly repaired: boolean;
  readonly plan: Plan;
  readonly issues: readonly ValidationIssue[];
}

const UNIT_MAX_HP = { WORKER: 2, VANGUARD: 4, RANGER: 2 } as const;
const SPAWN_COST = { WORKER: 5, VANGUARD: 10, RANGER: 12 } as const;

export function validatePlan(
  state: TickState,
  plan: Plan,
  obstacles: ReadonlySet<string> = state.obstacleCells,
): ValidationResult {
  if (plan.tick !== state.tick) {
    return {
      valid: false,
      repaired: true,
      plan: { tick: state.tick, unitActions: {}, coreAction: null, intents: {} },
      issues: [{
        code: "tick_mismatch",
        actorId: "plan",
        message: `plan tick ${plan.tick} does not match state tick ${state.tick}`,
      }],
    };
  }

  const issues: ValidationIssue[] = [];
  const unitActions: Record<string, UnitAction> = {};
  const intents: Record<string, string> = {};
  const unitsById = new Map(state.units.map((unit) => [unit.id, unit]));

  for (const [unitId, action] of Object.entries(plan.unitActions).sort(([a], [b]) => a.localeCompare(b))) {
    const unit = unitsById.get(unitId);
    if (unit === undefined) {
      issues.push({ code: "unknown_unit", actorId: unitId, message: "unit is not currently controlled" });
      continue;
    }
    const issue = validateUnitAction(state, unit, action, obstacles);
    if (issue !== null) {
      issues.push(issue);
      continue;
    }
    unitActions[unitId] = action;
    if (plan.intents[unitId] !== undefined) intents[unitId] = plan.intents[unitId];
  }

  const coreIssue = plan.coreAction === null ? null : validateCoreAction(state, plan.coreAction);
  const coreAction = coreIssue === null ? plan.coreAction : null;
  if (coreIssue !== null) issues.push(coreIssue);
  if (coreAction !== null && plan.intents.core !== undefined) intents.core = plan.intents.core;

  const repairedPlan: Plan = {
    tick: state.tick,
    unitActions,
    coreAction,
    intents,
  };
  return {
    valid: issues.length === 0,
    repaired: issues.length > 0,
    plan: repairedPlan,
    issues,
  };
}

function validateUnitAction(
  state: TickState,
  unit: TickState["units"][number],
  action: UnitAction,
  obstacles: ReadonlySet<string>,
): ValidationIssue | null {
  const issue = (code: ValidationCode, message: string): ValidationIssue => ({
    code,
    actorId: unit.id,
    message,
  });

  switch (action.type) {
    case "WAIT":
    case "SELF_DESTRUCT":
      return null;
    case "MOVE":
      return obstacles.has(cellKey(move(unit.position, action.direction)))
        ? issue("blocked_move", "destination is a known obstacle")
        : null;
    case "HARVEST":
      if (unit.unitType !== "WORKER") return issue("wrong_capability", "only Workers can harvest");
      return state.resourceCells.has(cellKey(unit.position))
        ? null
        : issue("invalid_harvest", "Worker is not standing on a visible resource cell");
    case "DEPOSIT":
      if (unit.unitType !== "WORKER") return issue("wrong_capability", "only Workers can deposit");
      if (unit.cargo <= 0 || state.resourceSpace <= 0 || state.core === null) {
        return issue("invalid_deposit", "deposit requires cargo, Core capacity, and an active Core");
      }
      return samePosition(unit.position, state.core.position)
        ? null
        : issue("invalid_deposit", "Worker must be on the Core cell");
    case "SWEEP":
      return unit.unitType === "VANGUARD"
        ? null
        : issue("wrong_capability", "only Vanguards can sweep");
    case "SHOOT": {
      if (unit.unitType !== "RANGER") return issue("wrong_capability", "only Rangers can shoot");
      const target = state.visibleEnemies.find((enemy) => enemy.id === action.targetId);
      if (target === undefined || !samePosition(target.position, action.expectedCell)) {
        return issue("invalid_shot", "target is not visible at expected_cell");
      }
      const dx = target.position[0] - unit.position[0];
      const dy = target.position[1] - unit.position[1];
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      const aligned = dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy);
      if (distance < 1 || distance > 3 || !aligned || lineBlocked(unit.position, target.position, obstacles)) {
        return issue("invalid_shot", "target is out of line-of-sight range");
      }
      return null;
    }
    case "PICKUP_BEACON":
      return state.beacon.status === "GROUND" &&
        state.beacon.carrierId === null &&
        samePosition(unit.position, state.beacon.position)
        ? null
        : issue("invalid_beacon", "Beacon is not available on this cell");
    case "DROP_BEACON":
      return state.beacon.carrierId === unit.id
        ? null
        : issue("invalid_beacon", "unit is not carrying the Beacon");
    case "HEAL":
      if (state.core === null || state.core.state !== "NORMAL" || !samePosition(unit.position, state.core.position)) {
        return issue("invalid_heal", "unit healing requires a stationary Core on the same cell");
      }
      return unit.hp < UNIT_MAX_HP[unit.unitType]
        ? null
        : issue("invalid_heal", "unit is already at maximum HP");
  }
}

function validateCoreAction(state: TickState, action: CoreAction): ValidationIssue | null {
  const actorId = state.core?.id ?? "core";
  const issue = (code: ValidationCode, message: string): ValidationIssue => ({ code, actorId, message });
  if (state.core === null) return issue("missing_core", "no controlled Core is available");

  switch (action.type) {
    case "WAIT":
      return null;
    case "HEAL":
      return state.core.hp < 5 ? null : issue("core_unavailable", "Core is already at maximum HP");
    case "REPAIR_SHIELD":
      if (state.core.state !== "NORMAL" || state.core.shield >= 5) {
        return issue("core_unavailable", "shield repair requires a stationary damaged Core");
      }
      return state.resources >= 1 ? null : issue("insufficient_resources", "shield repair costs one resource");
    case "SPAWN":
      if (state.core.state !== "NORMAL") return issue("core_unavailable", "moving Core cannot spawn");
      return state.resources >= SPAWN_COST[action.unitType]
        ? null
        : issue("insufficient_resources", `spawn ${action.unitType} costs ${SPAWN_COST[action.unitType]}`);
    case "START_MOVE":
      return state.core.state === "NORMAL" ? null : issue("core_unavailable", "Core is already moving");
    case "CANCEL_MOVE":
      return state.core.state === "MOVING" ? null : issue("core_unavailable", "Core is not moving");
    case "PICKUP_BEACON":
      return state.beacon.status === "GROUND" && samePosition(state.core.position, state.beacon.position)
        ? null
        : issue("invalid_beacon", "Beacon is not available on the Core cell");
    case "DROP_BEACON":
      return state.beacon.carrierId === state.core.id
        ? null
        : issue("invalid_beacon", "Core is not carrying the Beacon");
  }
}

function samePosition(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export function countEnemiesNearCore(state: TickState, radius: number): number {
  if (state.core === null) return 0;
  return state.visibleEnemies.filter((enemy) => manhattan(enemy.position, state.core!.position) <= radius).length;
}
