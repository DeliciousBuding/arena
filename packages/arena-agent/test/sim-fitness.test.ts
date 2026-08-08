import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FitnessLedgerCollector,
  fitnessFromDetail,
  type EventLedgerFitnessDetail,
} from "../src/sim/opponent/fitness.ts";
import { makeArenaScenarioN, makeSafetyEntry } from "../src/sim/opponent/tournament.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";
import type { ResolutionEvent } from "../src/sim/engine/phase.ts";
import type { SimPlayer, SimWorld } from "../src/sim/world/types.ts";

function event(
  eventType: string,
  actorId: string | null,
  targetId: string | null,
  values: Readonly<Record<string, unknown>> | null = null,
): ResolutionEvent {
  return { tick: 2, eventType, reasonCode: null, actorId, targetId, position: null, values };
}

test("W51 fitness formula matches the 600-tick normalized event-ledger contract", () => {
  const detail: EventLedgerFitnessDetail = {
    harvested: 10,
    deposited: 8,
    damage: 4,
    pop: 5,
    res: 7,
    lost: 1,
    respawn: 1,
    beacon: 20,
    aliveTicks: 500,
    healCost: 2,
    repairCost: 1,
    spawnCost: 13,
    overflowDestroyed: 3,
    resourcesLost: 4,
    resourcesCaptured: 9,
  };
  const expected =
    10 * 0.6 +
    8 * 1.2 +
    7 +
    5 * 0.8 +
    20 * 0.05 +
    (500 / 600) * 2 +
    4 * 0.3 -
    1 * 0.8 -
    1 * 2 -
    2 * 0.15 -
    1 * 0.1 -
    3 * 0.5 -
    4;
  assert.ok(Math.abs(fitnessFromDetail(detail, 600) - expected) < 1e-12);
  // spawnCost/resourcesCaptured are ledger diagnostics, not double-counted in the objective.
  assert.equal(
    fitnessFromDetail({ ...detail, spawnCost: 999, resourcesCaptured: 999 }, 600),
    fitnessFromDetail(detail, 600),
  );
  assert.throws(() => fitnessFromDetail(detail, 0), /positive safe integer/u);
});

test("W51 ledger attributes flows, damage, losses, capture and beacon to the correct player", () => {
  const before = worldFromScenario(
    makeArenaScenarioN([makeSafetyEntry("subject"), makeSafetyEntry("other")], 1),
  );
  const subject = before.players.get("subject")!;
  const other = before.players.get("other")!;
  const subjectCore = subject.core!;
  const otherCore = other.core!;
  const subjectUnit = subject.units[0]!;

  const players = new Map<string, SimPlayer>(before.players);
  players.set("subject", { ...subject, resources: 9, units: [] });
  players.set("other", {
    ...other,
    status: "RESPAWNING",
    respawnAtTick: 3,
    resources: 0,
    core: null,
  });
  const after: SimWorld = {
    ...before,
    tick: 2,
    resolvedTickCount: before.resolvedTickCount + 1,
    players,
    beacon: { position: subjectCore.position, status: "CARRIED", carrierId: subjectCore.id },
  };
  const events: ResolutionEvent[] = [
    event("HARVEST_SUCCEEDED", subjectUnit.id, null, { amount: 2 }),
    event("DEPOSIT_SUCCEEDED", subjectUnit.id, subjectCore.id, { amount: 2 }),
    event("SHOT_HIT", subjectUnit.id, otherCore.id, { damage: 1 }),
    event("SWEEP_RESOLVED", subjectUnit.id, null, { targets_hit: 2 }),
    event("UNIT_HEAL_SUCCEEDED", subjectUnit.id, null, { cost: 1 }),
    event("CORE_HEAL_SUCCEEDED", subjectCore.id, null, { cost: 2 }),
    event("CORE_REPAIR_SUCCEEDED", subjectCore.id, null, { cost: 1 }),
    event("CORE_SPAWN_SUCCEEDED", subjectCore.id, "new-unit", { cost: 5 }),
    event("CORE_RESOURCE_OVERFLOW_DESTROYED", subjectCore.id, null, { amount: 3 }),
    event("CORE_DESTROYED", null, otherCore.id),
    event("CORE_RESOURCES_CAPTURED", subjectCore.id, otherCore.id, {
      amount: 4,
      available: 5,
      destroyed: 1,
    }),
  ];

  const collector = new FitnessLedgerCollector();
  collector.onTick({ tick: 2, before, after, plans: {}, events });

  assert.deepEqual(collector.detail("subject"), {
    harvested: 2,
    deposited: 2,
    damage: 3,
    pop: 0,
    res: 9,
    lost: 1,
    respawn: 0,
    beacon: 1,
    aliveTicks: 1,
    healCost: 3,
    repairCost: 1,
    spawnCost: 5,
    overflowDestroyed: 3,
    resourcesLost: 0,
    resourcesCaptured: 4,
  });
  assert.equal(collector.detail("other").respawn, 1);
  assert.equal(collector.detail("other").resourcesLost, 5);
});
