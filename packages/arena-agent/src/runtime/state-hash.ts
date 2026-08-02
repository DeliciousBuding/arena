import { createHash } from "node:crypto";
import { type TickState } from "../domain/model.ts";

/**
 * Hash only authoritative current-Tick facts. Strategic memory is intentionally excluded:
 * a DecisionCandidate is valid for exactly the state snapshot shown to the Agent.
 */
export function hashTickState(state: TickState): string {
  const canonical = {
    tick: state.tick,
    status: state.status,
    resources: state.resources,
    resourceCapacity: state.resourceCapacity,
    population: state.population,
    core: state.core,
    units: [...state.units]
      .map((unit) => ({ ...unit, position: [...unit.position] }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    enemies: [...state.visibleEnemies]
      .map((enemy) => ({ ...enemy, position: [...enemy.position] }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    resources: [...state.resourceCells].sort(),
    obstacles: [...state.obstacleCells].sort(),
    beacon: state.beacon,
    events: [...state.events]
      .map((event) => ({ ...event, values: sortRecord(event.values) }))
      .sort((a, b) => a.eventId.localeCompare(b.eventId)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function sortRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
