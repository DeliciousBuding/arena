import { test } from "node:test";
import assert from "node:assert/strict";

import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";

test("reduceTurn creates an immutable normalized state", () => {
  const worker = {
    id: "00000000-0000-0000-0000-000000000010",
    position: [1, 0] as const,
    hp: 2,
    unitType: "WORKER" as const,
    cargo: 1,
  };
  const core = {
    id: "00000000-0000-0000-0000-000000000001",
    position: [0, 0] as const,
    hp: 5,
    shield: 4,
    ownerUsername: "buding",
  };
  const turn: TurnLike = {
    tick: 9,
    resources: 3,
    resourceCapacity: 10,
    resourceSpace: 7,
    units: [worker],
    workers: [worker],
    vanguards: [],
    rangers: [],
    core,
    visibleEnemies: [{
      id: "00000000-0000-0000-0000-000000000099",
      kind: "CORE",
      position: [3, 3],
      hp: 5,
      owner_username: "other",
    }],
    obstacleCells: new Set(["2,2"]),
    resourceCells: new Set(["1,0"]),
    beacon: { position: [5, 5], status: "GROUND", carrier_id: null },
    events: [{
      event_id: "e1",
      tick: 8,
      event_type: "HARVEST_SUCCEEDED",
      reason_code: null,
      actor_id: worker.id,
      target_id: null,
      position: [1, 0],
      values: {},
    }],
    state: {
      status: "ACTIVE",
      population: 1,
      objects: [{
        kind: "CORE",
        controlled: true,
        id: core.id,
        state: "MOVING",
      }],
    },
  };

  const state = reduceTurn(turn);
  assert.equal(state.tick, 9);
  assert.equal(state.core?.state, "MOVING");
  assert.equal(state.workers[0].cargo, 1);
  assert.equal(state.visibleEnemies[0].ownerUsername, "other");
  assert.deepEqual(state.events[0].position, [1, 0]);
  assert.equal(state.events[0].reasonCode, null);
  assert.equal(state.events[0].actorId, worker.id);
  assert.equal(state.events[0].targetId, null);
  assert.notEqual(state.resourceCells, turn.resourceCells);
  assert.throws(() => {
    (state.units[0].position as [number, number])[0] = 99;
  }, TypeError);
});

test("reduceTurn rejects malformed tick and coordinates", () => {
  const base = {
    resources: 0,
    resourceCapacity: 10,
    resourceSpace: 10,
    units: [],
    workers: [],
    vanguards: [],
    rangers: [],
    core: null,
    visibleEnemies: [],
    obstacleCells: new Set<string>(),
    resourceCells: new Set<string>(),
    beacon: { position: [0, 0] as const, status: "GROUND" as const, carrier_id: null },
    events: [],
    state: { status: "RESPAWNING" as const, population: 0, objects: [] },
  };
  assert.throws(() => reduceTurn({ ...base, tick: 0 }), /invalid tick/);
  assert.throws(
    () => reduceTurn({
      ...base,
      tick: 1,
      units: [{
        id: "u",
        position: [1.5, 0] as const,
        hp: 2,
        unitType: "WORKER",
        cargo: 0,
      }],
      workers: [],
    }),
    /invalid position/,
  );
});
