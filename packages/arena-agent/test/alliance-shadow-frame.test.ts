import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AllianceShadowWriter } from "../src/alliance/shadow.ts";
import { aggregateAllianceShadowFrames } from "../src/alliance/shadow-frame.ts";
import type { TickState, VisibleEntity } from "../src/domain/model.ts";

function state(tick: number, coreId: string, unitId: string, enemies: readonly VisibleEntity[]): TickState {
  const worker = { id: unitId, position: [0, 0] as const, hp: 2, unitType: "WORKER" as const, cargo: 0 };
  return {
    tick, status: "ACTIVE", resources: 10, resourceCapacity: 20, resourceSpace: 10, population: 1,
    core: { id: coreId, position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: coreId },
    units: [worker], workers: [worker], vanguards: [], rangers: [], visibleEnemies: enemies,
    resourceCells: new Set(), obstacleCells: new Set(),
    beacon: { position: [20, 20], status: "GROUND", carrierId: null }, events: [],
  };
}

test("shadow frames：跨租户 union 去盟友 + 同敌去重，raw historical 仍保留审计条数", () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-shadow-aggregate-"));
  try {
    const t1 = new AllianceShadowWriter({ tenantId: "t1", processRunId: "r1", path: join(dir, "t1.jsonl"), intervalTicks: 1, nowMs: () => 100_000 });
    const t2 = new AllianceShadowWriter({ tenantId: "t2", processRunId: "r2", path: join(dir, "t2.jsonl"), intervalTicks: 1, nowMs: () => 100_000 });
    const enemy: VisibleEntity = { id: "enemy-v", kind: "UNIT", position: [2, 2], hp: 3, unitType: "VANGUARD" };
    const mistakenAllyCore: VisibleEntity = { id: "core-t2", kind: "CORE", position: [3, 0], hp: 5, ownerUsername: "t2" };
    const f1 = t1.onState(state(100, "core-t1", "u-t1", [enemy, mistakenAllyCore]));
    const f2 = t2.onState(state(100, "core-t2", "u-t2", [enemy]));
    assert.ok(f1 !== null && f2 !== null);
    const snapshot = aggregateAllianceShadowFrames({ revision: 1, frames: [f2, f1], nowTick: 100, generatedAtMs: 100_000, treasuryTenant: "t1" });
    assert.deepEqual([...snapshot.members.keys()], ["t1", "t2"]);
    assert.equal(snapshot.sightings.length, 1);
    assert.equal(snapshot.sightings[0]?.key, "UNIT:enemy-v");
    assert.equal(snapshot.counts.currentVisibleCombat, 1);
    assert.equal(snapshot.counts.recentUniqueCombat, 1);
    assert.equal(snapshot.counts.historicalSightingCount, 2);
    assert.ok(snapshot.allyEntityIds.has("core-t2"));
    assert.ok(!snapshot.sightings.some((s) => s.entityId === "core-t2"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shadow frames：同 tenant 多 frame 只取最新，输入顺序不影响 snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-shadow-latest-"));
  try {
    const writer = new AllianceShadowWriter({ tenantId: "t1", processRunId: "r1", path: join(dir, "t1.jsonl"), intervalTicks: 1, nowMs: () => 101_000 });
    const oldFrame = writer.onState(state(100, "core-t1", "u-t1", []));
    const newFrame = writer.onState(state(101, "core-t1", "u-t1", [{ id: "e", kind: "UNIT", position: [1, 1], hp: 3, unitType: "VANGUARD" }]));
    assert.ok(oldFrame !== null && newFrame !== null);
    const a = aggregateAllianceShadowFrames({ revision: 2, frames: [oldFrame, newFrame], generatedAtMs: 101_000 });
    const b = aggregateAllianceShadowFrames({ revision: 2, frames: [newFrame, oldFrame], generatedAtMs: 101_000 });
    assert.equal(a.tickWindow[1], 101);
    assert.equal(a.members.get("t1")?.tick, 101);
    assert.deepEqual(JSON.parse(JSON.stringify(a, (_k, v) => v instanceof Map ? [...v] : v instanceof Set ? [...v] : v)), JSON.parse(JSON.stringify(b, (_k, v) => v instanceof Map ? [...v] : v instanceof Set ? [...v] : v)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
