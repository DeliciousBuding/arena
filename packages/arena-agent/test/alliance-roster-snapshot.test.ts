/**
 * Alliance roster / snapshot 测试（2026-08-08，spec §5.4/§5.5 落地）：
 * 1) roster 登记/去重/no-fire 硬规则（knownAllianceEntityId => never target）；
 * 2) snapshot 构建（盟军实体不进敌方目击、去重、四口径、威胁场、leaderboard 先验）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_ROSTER,
  registerAlliedEntities,
  isAllyEntity,
  assertNoDeliberateTarget,
  recordNoFirePrevented,
  buildAllianceSnapshot,
  type AllianceObservation,
  type AllianceMemberState,
} from "../src/alliance/index.ts";

// ---------- roster / no-fire ----------

test("registerAlliedEntities：登记盟军实体；同 tick 重复登记幂等", () => {
  const r1 = registerAlliedEntities(EMPTY_ROSTER, {
    tenantId: "t1", ownerUsername: "buding", entityIds: ["core-a", "unit-1"], tick: 100,
  });
  assert.equal(r1.allyEntityIds.size, 2);
  assert.equal(r1.ownerByTenant.get("t1"), "buding");
  const r2 = registerAlliedEntities(r1, {
    tenantId: "t1", ownerUsername: "buding", entityIds: ["core-a", "unit-1"], tick: 100,
  });
  assert.equal(r2.revision, r1.revision); // 同 tick 幂等
  const r3 = registerAlliedEntities(r1, {
    tenantId: "t2", ownerUsername: "lin", entityIds: ["core-b"], tick: 101,
  });
  assert.equal(r3.allyEntityIds.size, 3);
  assert.equal(r3.revision, r1.revision + 1);
});

test("assertNoDeliberateTarget：knownAllianceEntityId => never deliberate target", () => {
  const roster = registerAlliedEntities(EMPTY_ROSTER, {
    tenantId: "t1", ownerUsername: "buding", entityIds: ["core-a", "unit-1"], tick: 100,
  });
  assert.equal(assertNoDeliberateTarget(roster, "core-a").allowed, false);
  assert.equal(assertNoDeliberateTarget(roster, "core-a").reason, "NO_FIRE_PREVENTED");
  assert.equal(assertNoDeliberateTarget(roster, "enemy-x").allowed, true);
  assert.equal(isAllyEntity(roster, "unit-1"), true);
  assert.equal(isAllyEntity(roster, null), false);
  // 记录 KPI
  const r2 = recordNoFirePrevented(roster);
  assert.equal(r2.noFirePreventedCount, 1);
});

// ---------- snapshot 构建 ----------

function member(tenantId: string, over: Partial<AllianceMemberState> = {}): AllianceMemberState {
  return {
    tenantId, tick: 100, observedAtMs: 0,
    core: { id: "core-" + tenantId, position: [0, 0], hp: 5, shield: 5, moving: false },
    resources: 10, resourceCapacity: 20, population: 5, workers: 3, vanguards: 1, rangers: 1,
    carriedResources: 0, activeFleetIds: [], localThreat: 0, localHarvestRate: 1,
    status: "READY", ...over,
  };
}

function obs(over: Partial<AllianceObservation>): AllianceObservation {
  return {
    tenantId: "t2", tick: 100, kind: "UNIT", entityId: "e1", unitType: "VANGUARD",
    controlled: false, position: [10, 10], evidence: "CALIBRATION", ...over,
  };
}

test("buildAllianceSnapshot：盟军实体不进敌方目击 + 同 id 去重 + 四口径", () => {
  const roster = registerAlliedEntities(EMPTY_ROSTER, {
    tenantId: "t1", ownerUsername: "buding", entityIds: ["core-t1", "unit-t1"], tick: 100,
  });
  const observations: AllianceObservation[] = [
    // 盟军自己的实体（controlled）——不入敌方目击
    obs({ tenantId: "t1", entityId: "unit-t1", controlled: true, unitType: "VANGUARD", position: [0, 1] }),
    // 敌方同 id 多次目击（不同 tick）——去重为 1 实体
    obs({ entityId: "e1", tick: 100 }),
    obs({ entityId: "e1", tick: 101, position: [11, 10] }),
    obs({ entityId: "e2", unitType: "RANGER", tick: 101, position: [20, 20] }),
  ];
  const snap = buildAllianceSnapshot({
    revision: 1,
    members: [member("t1"), member("t2")],
    observations,
    roster,
    nowTick: 101,
  });
  assert.equal(snap.members.size, 2);
  // 敌方目击：e1 合并为 1 条，e2 1 条 → 2 条（盟军 unit-t1 不进）
  assert.equal(snap.sightings.length, 2);
  assert.ok(snap.sightings.some((s) => s.entityId === "e1" && s.lastSeenTick === 101));
  assert.equal(snap.counts.recentUniqueCombat, 2);
  assert.equal(snap.counts.historicalSightingCount, 3); // e1 2 条 + e2 1 条（审计口径）
  assert.equal(snap.allyEntityIds.has("unit-t1"), true);
  assert.ok(snap.threat.estimatedCombatForce >= 1.5); // 两个战斗单位，新近 → 高 confidence
});

test("buildAllianceSnapshot：leaderboard 先验叠加 coreRaid", () => {
  const observations: AllianceObservation[] = [
    obs({ kind: "CORE", entityId: "c-jerk", ownerUsername: "jerkman", position: [0, 0], tick: 100 }),
  ];
  const snap = buildAllianceSnapshot({
    revision: 1, members: [], observations, roster: EMPTY_ROSTER, nowTick: 100,
    leaderboardAggression: new Map([["jerkman", 0.8]]),
  });
  assert.ok((snap.threat.cells.get("0,0")?.coreRaid ?? 0) >= 1);
});
