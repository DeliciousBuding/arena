import assert from "node:assert/strict";
import { test } from "node:test";

import type { Position } from "../src/domain/model.ts";
import { chunkKeyFor } from "../src/domain/world.ts";
import { exploreTarget } from "../src/domain/nav.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import { resolveSafetyVariantConfig } from "../src/strategies/variant-registry.ts";

type FrontierProbe = {
  militaryScavengeDirection(home: Position, beacon: Position, ringIndex: number, index: number, directionCount: number): number;
};

function probe(planner: SafetyPlanner): FrontierProbe {
  return planner as unknown as FrontierProbe;
}

test("military-frontier-scavenge variant is registered and only enables frontier selection", () => {
  const config = resolveSafetyVariantConfig("military-frontier-scavenge-v1");
  assert.deepEqual(config, { militaryScavengeFrontier: true });
});

test("military frontier direction delegates to stale chunk ordering; disabled path preserves fixed order", () => {
  const home: Position = [0, 0];
  const beacon: Position = [100, 100];
  const ring = 0;
  const unitIndex = 1;
  const directionCount = 8;

  const on = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, militaryScavengeFrontier: true });
  for (let direction = 0; direction < directionCount; direction += 1) {
    on.world.seedChunkMemory([{
      key: chunkKeyFor(exploreTarget(home, beacon, direction, DEFAULT_SAFETY_CONFIG.exploreRadius)),
      lastSeenTick: 100 + direction * 10,
    }]);
  }
  // Make one direction materially staler than the rest. The exact selected rank is intentionally
  // delegated to World.staleDirection so multi-unit offsets remain a single SSOT.
  on.world.seedChunkMemory([{
    key: chunkKeyFor(exploreTarget(home, beacon, 5, DEFAULT_SAFETY_CONFIG.exploreRadius)),
    lastSeenTick: 1,
  }]);

  const offset = (unitIndex * 3 + 7) % directionCount;
  const expected = on.world.staleDirection(
    home,
    beacon,
    ring,
    DEFAULT_SAFETY_CONFIG.exploreRadius,
    directionCount,
    offset,
  );
  assert.equal(probe(on).militaryScavengeDirection(home, beacon, ring, unitIndex, directionCount), expected);

  const off = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  assert.equal(
    probe(off).militaryScavengeDirection(home, beacon, ring, unitIndex, directionCount),
    offset,
    "flag off must preserve the historical fixed direction",
  );
});
