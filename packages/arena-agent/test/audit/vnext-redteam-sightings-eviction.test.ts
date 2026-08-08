/**
 * P0 回归测试：sightings.ts 无界累积 → TTL 驱逐
 *
 * 基线：9cea8d3 前 updateSightingsTick 对无 id ephemeral UNIT 条目永不驱逐，
 * 每 tick 每敌单位产生一条新 key（key 含 tick），mergeSightings 只增不删。
 * 证伪方法：喂 N 次同位置同源的无 id UNIT 观测 → 条目数 = N（而非 1）。
 *
 * 修复后：超过 EPHEMERAL_UNIT_MAX_AGE_TICKS 的无 id UNIT 条目（当前不可见 + 过期）被驱逐。
 */

import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  mergeSightings,
  updateSightingsTick,
  EPHEMERAL_UNIT_MAX_AGE_TICKS,
} from "../../src/alliance/sightings.js";
import type { EntitySighting } from "../../src/alliance/types.js";

function rawUnit(tenant: string, tick: number, x: number, y: number) {
  return {
    kind: "UNIT" as const,
    unitType: "WORKER" as EntitySighting["unitType"],
    position: [x, y] as [number, number],
    sourceTenant: tenant,
    tick,
    evidence: "VISIBLE" as EntitySighting["evidence"],
  };
}

describe("sightings eviction (P0 regression)", () => {
  it("ephemeral UNIT keys accumulate without bound pre-fix pattern", () => {
    let sightings: EntitySighting[] = [];
    for (let tick = 0; tick < 100; tick++) {
      sightings = updateSightingsTick(sightings, [rawUnit("t1", tick, 0, 0)], tick);
    }
    // Pre-fix: every tick's UNIT:<tenant>:<tick>:<x>,<y> key is unique → 100 entries.
    // Post-fix (with EPHEMERAL_UNIT_MAX_AGE_TICKS=48): entries older than 48 ticks
    // and not currently visible should be evicted → at most ~49 entries.
    // This test verifies the current behavior (post-fix).
    const notVisible = sightings.filter((s) => !s.currentlyVisible);
    // All entries beyond the most recent one should be markable as not-visible
    // after enough ticks without observation.
    assert.ok(sightings.length <= EPHEMERAL_UNIT_MAX_AGE_TICKS + 2,
      `expected ≤${EPHEMERAL_UNIT_MAX_AGE_TICKS + 2} entries after TTL eviction, got ${sightings.length}`);
    assert.ok(notVisible.length < sightings.length,
      "at least the most recent entry should still be visible");
  });

  it("mergeSightings on same tick + same cell deduplicates", () => {
    const merged = mergeSightings(
      [],
      [rawUnit("t1", 42, 10, 20), rawUnit("t1", 42, 10, 20)],
      42,
    );
    assert.strictEqual(merged.length, 1);
  });

  it("updateSightingsTick marks previously-visible as not visible", () => {
    let sightings: EntitySighting[] = [];
    sightings = updateSightingsTick(sightings, [rawUnit("t1", 0, 5, 5)], 0);
    assert.strictEqual(sightings[0]!.currentlyVisible, true);
    sightings = updateSightingsTick(sightings, [], 1);
    assert.strictEqual(sightings[0]!.currentlyVisible, false);
    assert.strictEqual(sightings.length, 1, "Entry persists immediately after becoming not-visible");
  });

  it("entity-id sightings are deduplicated across ticks", () => {
    let sightings: EntitySighting[] = [];
    sightings = updateSightingsTick(sightings, [{
      ...rawUnit("t1", 0, 5, 5),
      entityId: "unit-42",
    }], 0);
    sightings = updateSightingsTick(sightings, [{
      ...rawUnit("t1", 1, 6, 6),
      entityId: "unit-42",
    }], 1);
    assert.strictEqual(sightings.length, 1, "Same entityId → merged, not duplicated");
  });

  it("ephemeral UNIT entries are evicted after max age when not visible", () => {
    let sightings: EntitySighting[] = [];
    const startTick = 1000;
    // Feed one ephemeral UNIT observation at tick 1000
    sightings = updateSightingsTick(sightings, [rawUnit("t1", startTick, 0, 0)], startTick);
    assert.strictEqual(sightings.length, 1);
    // Advance past EPHEMERAL_UNIT_MAX_AGE_TICKS without new observations
    const farFuture = startTick + EPHEMERAL_UNIT_MAX_AGE_TICKS + 10;
    sightings = updateSightingsTick(sightings, [], farFuture);
    // Entry should be evicted: not currently visible + age > max
    assert.strictEqual(sightings.length, 0,
      `ephemeral UNIT entry should be evicted after ${EPHEMERAL_UNIT_MAX_AGE_TICKS} ticks of no observation`);
  });
});
