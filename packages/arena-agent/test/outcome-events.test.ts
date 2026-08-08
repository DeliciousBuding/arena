import assert from "node:assert/strict";
import { test } from "node:test";

import { countOutcomeEvents } from "../src/telemetry/decision-trace.ts";

const CORE = "core-owned";
const W1 = "worker-owned-1";
const W2 = "worker-owned-2";
const ENEMY = "enemy-unit";

test("W50 outcome counters: deposit/spawn/heal/loss use explicit event semantics", () => {
  const result = countOutcomeEvents(
    [
      { eventType: "DEPOSIT_SUCCEEDED", actorId: W1, values: { amount: 7 } },
      { eventType: "CORE_SPAWN_SUCCEEDED", actorId: CORE, targetId: "new-unit", values: { cost: 5 } },
      { eventType: "UNIT_HEAL_SUCCEEDED", actorId: W2, values: { amount: 1, cost: 1 } },
      { eventType: "CORE_HEAL_SUCCEEDED", actorId: CORE, values: { amount: 1, cost: 1 } },
      { eventType: "UNIT_DESTROYED", actorId: W1, values: null },
      { eventType: "CORE_RESOURCE_OVERFLOW_DESTROYED", actorId: CORE, values: { amount: 99 } },
    ],
    {
      priorUnitIds: new Set([W1, W2]),
      currentUnitIds: new Set([W2, "new-unit"]),
      priorCoreId: CORE,
      currentCoreId: CORE,
    },
  );

  assert.deepEqual(result, { grossDeposit: 7, spawnCount: 1, healCount: 2, unitLossCount: 1 });
});

test("W50 outcome counters: enemy destruction is never counted as own unit loss", () => {
  const result = countOutcomeEvents(
    [
      { eventType: "UNIT_DESTROYED", actorId: ENEMY, values: null },
      { eventType: "UNIT_SELF_DESTRUCTED", actorId: W1, values: null },
      { eventType: "DEPOSIT_SUCCEEDED", actorId: ENEMY, values: { amount: 100 } },
      { eventType: "CORE_SPAWN_SUCCEEDED", actorId: "enemy-core", targetId: ENEMY, values: { cost: 5 } },
    ],
    {
      priorUnitIds: new Set([W1]),
      currentUnitIds: new Set(),
      priorCoreId: CORE,
      currentCoreId: CORE,
    },
  );

  assert.deepEqual(result, { grossDeposit: 0, spawnCount: 0, healCount: 0, unitLossCount: 1 });
});

test("W50 outcome counters: malformed/negative amounts fail closed to zero", () => {
  const result = countOutcomeEvents(
    [
      { eventType: "DEPOSIT_SUCCEEDED", actorId: W1, values: { amount: -3 } },
      { eventType: "DEPOSIT_SUCCEEDED", actorId: W1, values: { amount: "7" } },
      { eventType: "DEPOSIT_SUCCEEDED", actorId: W1, values: null },
    ],
    { priorUnitIds: new Set([W1]), priorCoreId: CORE },
  );

  assert.equal(result.grossDeposit, 0);
});
