import { test } from "node:test";
import assert from "node:assert/strict";

import type { AllianceMemberReport, EntitySighting } from "../../src/alliance/types.ts";
import {
  aggregateAllianceIntel,
  fuseEntitySightings,
  buildAllianceThreatSummaries,
} from "../../src/alliance/index.ts";

function report(tenantId: string, position: readonly [number, number] = [0, 0]): AllianceMemberReport {
  return {
    tenantId,
    tick: 100,
    observedAtMs: 100,
    core: { id: `${tenantId}-core`, position, hp: 100, shield: 0, moving: false },
    resources: 10,
    resourceCapacity: 100,
    population: 5,
    workers: 3,
    vanguards: 1,
    rangers: 1,
    carriedResources: 0,
    activeFleetIds: [],
    localThreat: 0,
    localHarvestRate: 1,
    status: "READY",
  };
}

function sighting(key: string, overrides: Partial<EntitySighting> = {}): EntitySighting {
  return {
    key,
    kind: "UNIT",
    unitType: "VANGUARD",
    ownerUsername: "enemy",
    position: [10, 10],
    sourceTenant: "t1",
    firstSeenTick: 90,
    lastSeenTick: 100,
    currentlyVisible: true,
    confidence: 1,
    evidence: "LIVE",
    ...overrides,
  };
}

test("historical sightings never inflate current force count", () => {
  const stale = Array.from({ length: 100 }, (_, i) =>
    sighting(`old-${i}`, {
      lastSeenTick: 10,
      currentlyVisible: false,
      evidence: "HISTORY",
    }));
  const intel = aggregateAllianceIntel({
    reports: [report("t1")],
    sightings: [...stale, sighting("fresh")],
    currentTick: 100,
  });
  assert.equal(intel.counts.currentEnemyUnits, 1);
  assert.equal(intel.counts.recentEnemyUnits, 1);
  assert.equal(intel.counts.historicalEnemyUnits, 101);
  assert.equal(intel.currentlyVisible[0]?.key, "fresh");
});

test("same entity is fused deterministically and retains source tenants", () => {
  const inputs = [
    sighting("u1", { sourceTenant: "t2", confidence: 0.8, evidence: "CALIBRATION" }),
    sighting("u1", { sourceTenant: "t1", confidence: 0.8, evidence: "LIVE" }),
    sighting("u1", { sourceTenant: "t3", lastSeenTick: 99, confidence: 1 }),
  ];
  const fused = fuseEntitySightings(inputs, 100);
  assert.equal(fused.length, 1);
  assert.equal(fused[0]?.sourceTenant, "t1");
  assert.deepEqual(fused[0]?.sourceTenants, ["t1", "t2", "t3"]);

  const shuffled = fuseEntitySightings([inputs[2]!, inputs[0]!, inputs[1]!], 100);
  assert.deepEqual(shuffled, fused);
});

test("ally IDs are excluded from enemy and threat views", () => {
  const intel = aggregateAllianceIntel({
    reports: [report("t1")],
    sightings: [sighting("ally-u"), sighting("enemy-u", { position: [4, 0] })],
    allyEntityIds: ["ally-u"],
    currentTick: 100,
  });
  assert.equal(intel.counts.currentEnemyUnits, 1);
  assert.deepEqual(intel.historicalKnown.map((s) => s.key), ["enemy-u"]);
  const threats = buildAllianceThreatSummaries(intel);
  assert.deepEqual(threats[0]?.sectors.flatMap((s) => s.entityKeys), ["enemy-u"]);
});

test("freshness boundaries, future ticks, and bad confidence stay finite", () => {
  const intel = aggregateAllianceIntel({
    reports: [report("t1")],
    sightings: [
      sighting("live-boundary", { lastSeenTick: 99, currentlyVisible: true }),
      sighting("recent-boundary", { lastSeenTick: 92, currentlyVisible: false }),
      sighting("historical", { lastSeenTick: 91, currentlyVisible: false }),
      sighting("future", { lastSeenTick: 105, confidence: Number.NaN }),
      sighting("infinite", { key: "inf", confidence: Number.POSITIVE_INFINITY }),
    ],
    currentTick: 100,
    config: { liveWindowTicks: 1, freshnessWindowTicks: 8 },
  });
  assert.equal(intel.historicalKnown.find((s) => s.key === "live-boundary")?.freshness, "LIVE");
  assert.equal(intel.historicalKnown.find((s) => s.key === "recent-boundary")?.freshness, "RECENT");
  assert.equal(intel.historicalKnown.find((s) => s.key === "historical")?.freshness, "HISTORICAL");
  assert.equal(intel.historicalKnown.find((s) => s.key === "future")?.ageTicks, 0);
  for (const item of intel.historicalKnown) {
    assert.ok(Number.isFinite(item.confidence));
    assert.ok(Number.isFinite(item.decayedConfidence));
    assert.ok(item.decayedConfidence >= 0 && item.decayedConfidence <= 1);
  }
});

test("opposite NE and SW pressure is represented simultaneously", () => {
  const intel = aggregateAllianceIntel({
    reports: [report("t2", [-44, 51])],
    sightings: [
      sighting("enemy-ne-core", { kind: "CORE", unitType: undefined, position: [-30, 70] }),
      sighting("enemy-sw-core", { kind: "CORE", unitType: undefined, position: [-60, 30] }),
    ],
    currentTick: 100,
  });
  const [summary] = buildAllianceThreatSummaries(intel, { highScoreThreshold: 0.5 });
  assert.ok(summary);
  assert.ok(summary.highDirections.includes("NE"));
  assert.ok(summary.highDirections.includes("SW"));
  assert.equal(summary.multiDirectionPressure, true);
});

test("input order does not affect aggregate output", () => {
  const reports = [report("t2"), report("t1")];
  const sightings = [
    sighting("b", { sourceTenant: "t2", position: [-2, 3] }),
    sighting("a", { sourceTenant: "t1", position: [4, -5] }),
    sighting("a", { sourceTenant: "t2", lastSeenTick: 99 }),
  ];
  const a = aggregateAllianceIntel({ reports, sightings, currentTick: 100 });
  const b = aggregateAllianceIntel({
    reports: [...reports].reverse(),
    sightings: [...sightings].reverse(),
    currentTick: 100,
  });
  assert.deepEqual(b, a);
  assert.deepEqual(buildAllianceThreatSummaries(b), buildAllianceThreatSummaries(a));
});

test("empty input is valid and JSON serializable", () => {
  const intel = aggregateAllianceIntel({ currentTick: 0 });
  assert.deepEqual(intel.currentlyVisible, []);
  assert.deepEqual(intel.recentFused, []);
  assert.deepEqual(intel.historicalKnown, []);
  assert.equal(intel.counts.currentEnemyUnits, 0);
  assert.doesNotThrow(() => JSON.stringify(intel));
});
