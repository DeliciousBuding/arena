/** Deterministic local military fleet partitioning for Alliance control-plane.
 *
 * This does NOT issue Arena actions. It gives stable fleet identity/roles to the existing
 * SafetyPlanner-controlled units so Alliance TaskForce can reference real local groups.
 * Baseline composition follows the strongest reusable pattern from the reference guide:
 * home reserve first, then 2 Vanguard + 1 Ranger strike squads, then a mobile remainder.
 */
import type { UnitSnapshot } from "../domain/model.ts";
import type { FleetState, FormationType } from "./control-types.ts";

export type LocalFleetRole = "HOME_DEFENSE" | "STRIKE" | "MOBILE";

export interface LocalFleetPlan {
  readonly id: string;
  readonly tenantId: string;
  readonly role: LocalFleetRole;
  readonly formation: FormationType;
  readonly state: FleetState;
  readonly unitIds: readonly string[];
  readonly vanguardIds: readonly string[];
  readonly rangerIds: readonly string[];
}

function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function take<T>(source: T[], count: number): T[] {
  return source.splice(0, Math.min(count, source.length));
}

function buildFleet(
  tenantId: string, role: LocalFleetRole, index: number, vanguards: readonly UnitSnapshot[], rangers: readonly UnitSnapshot[],
): LocalFleetPlan | null {
  const all = [...vanguards, ...rangers].sort((a, b) => stableCompare(a.id, b.id));
  if (all.length === 0) return null;
  const tag = role === "HOME_DEFENSE" ? "home" : role === "STRIKE" ? "strike" : "mobile";
  const formation: FormationType = role === "HOME_DEFENSE" ? "FORTRESS_RING" : role === "STRIKE" ? "ASSAULT_WEDGE" : "SCOUT_FAN";
  return Object.freeze({
    id: `${tenantId}:${tag}:${index}`, tenantId, role, formation,
    state: role === "HOME_DEFENSE" ? "HOLD" : all.length >= 2 ? "ASSEMBLE" : "HOLD",
    unitIds: Object.freeze(all.map((unit) => unit.id)),
    vanguardIds: Object.freeze([...vanguards].map((unit) => unit.id).sort(stableCompare)),
    rangerIds: Object.freeze([...rangers].map((unit) => unit.id).sort(stableCompare)),
  });
}

export function partitionLocalFleets(units: readonly UnitSnapshot[], tenantId: string): readonly LocalFleetPlan[] {
  const vanguards = units.filter((unit) => unit.unitType === "VANGUARD").slice().sort((a, b) => stableCompare(a.id, b.id));
  const rangers = units.filter((unit) => unit.unitType === "RANGER").slice().sort((a, b) => stableCompare(a.id, b.id));
  if (vanguards.length + rangers.length === 0) return [];

  const fleets: LocalFleetPlan[] = [];
  // Home reserve: up to 2V1R. If force is tiny, all available military stays home.
  const homeV = take(vanguards, 2);
  const homeR = take(rangers, 1);
  const home = buildFleet(tenantId, "HOME_DEFENSE", 0, homeV, homeR);
  if (home !== null) fleets.push(home);

  let strikeIndex = 0;
  while (vanguards.length + rangers.length >= 2) {
    const strikeV = take(vanguards, Math.min(2, vanguards.length));
    const strikeR = take(rangers, strikeV.length < 2 ? Math.min(2 - strikeV.length, rangers.length) : 1);
    // Fill a short squad from whichever type remains if the preferred 2V1R mix is unavailable.
    while (strikeV.length + strikeR.length < 3 && vanguards.length > 0) strikeV.push(...take(vanguards, 1));
    while (strikeV.length + strikeR.length < 3 && rangers.length > 0) strikeR.push(...take(rangers, 1));
    const strike = buildFleet(tenantId, "STRIKE", strikeIndex++, strikeV, strikeR);
    if (strike !== null) fleets.push(strike);
  }

  if (vanguards.length + rangers.length > 0) {
    const mobile = buildFleet(tenantId, "MOBILE", 0, take(vanguards, vanguards.length), take(rangers, rangers.length));
    if (mobile !== null) fleets.push(mobile);
  }
  return Object.freeze(fleets);
}

export function activeFleetIds(units: readonly UnitSnapshot[], tenantId: string): readonly string[] {
  return partitionLocalFleets(units, tenantId).map((fleet) => fleet.id);
}
