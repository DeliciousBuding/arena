import assert from "node:assert/strict";
import { test } from "node:test";

import {
  liveMixedSpawnProfiles,
  makeArenaScenarioN,
  makeSafetyEntry,
  rotateEntriesForSubject,
} from "../src/sim/opponent/tournament.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";

const logical = [
  makeSafetyEntry("subject"),
  makeSafetyEntry("old-rich"),
  makeSafetyEntry("old"),
  makeSafetyEntry("remains-a"),
  makeSafetyEntry("remains-b"),
  makeSafetyEntry("newborn"),
];

test("W54 slot rotation moves only the subject while preserving opponent logical order", () => {
  for (let seed = 0; seed < logical.length; seed += 1) {
    const rotated = rotateEntriesForSubject(logical, "subject", seed);
    assert.equal(rotated[seed]!.id, "subject");
    assert.deepEqual(
      rotated.filter((entry) => entry.id !== "subject").map((entry) => entry.id),
      logical.filter((entry) => entry.id !== "subject").map((entry) => entry.id),
    );
  }
  assert.throws(() => rotateEntriesForSubject(logical, "missing", 1), /subject not found/u);
});

test("W54 live-mixed birth roles are identity-bound and survive geometric slot rotation", () => {
  const profiles = liveMixedSpawnProfiles(
    "subject",
    logical.slice(1).map((entry) => entry.id),
  );
  const rotated = rotateEntriesForSubject(logical, "subject", 2);
  const world = worldFromScenario(makeArenaScenarioN(rotated, 2, {
    radius: 50,
    spawnProfiles: profiles,
  }));

  const summary = Object.fromEntries(
    [...world.players].map(([id, player]) => [id, { resources: player.resources, pop: player.units.length }]),
  );
  assert.deepEqual(summary.subject, { resources: 5, pop: 1 });
  assert.deepEqual(summary["old-rich"], { resources: 20, pop: 19 });
  assert.deepEqual(summary.old, { resources: 10, pop: 19 });
  assert.deepEqual(summary["remains-a"], { resources: 5, pop: 2 });
  assert.deepEqual(summary["remains-b"], { resources: 5, pop: 2 });
  assert.deepEqual(summary.newborn, { resources: 5, pop: 1 });

  const subjectAtSeed0 = worldFromScenario(makeArenaScenarioN(
    rotateEntriesForSubject(logical, "subject", 0),
    2,
    { radius: 50, spawnProfiles: profiles },
  )).players.get("subject")!.core!.position;
  const subjectAtSeed2 = world.players.get("subject")!.core!.position;
  assert.notDeepEqual(subjectAtSeed0, subjectAtSeed2);

  // Roles remain tied to identity, not whichever index they occupy after rotation.
  assert.equal(world.players.get("old-rich")!.units.filter((unit) => unit.unitType === "VANGUARD").length, 6);
  assert.equal(world.players.get("old-rich")!.units.filter((unit) => unit.unitType === "RANGER").length, 6);
});

test("W54 default FFA scenario remains official newborn 5 resources + 1 worker", () => {
  const world = worldFromScenario(makeArenaScenarioN(logical.slice(0, 3), 3));
  for (const player of world.players.values()) {
    assert.equal(player.resources, 5);
    assert.equal(player.units.length, 1);
    assert.equal(player.units[0]!.unitType, "WORKER");
  }
});
