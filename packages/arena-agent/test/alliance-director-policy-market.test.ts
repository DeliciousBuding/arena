import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAllianceSnapshotFromSightings } from "../src/alliance/snapshot.ts";
import { decideAllianceShadowPolicy } from "../src/alliance/director-policy.ts";
import { BALANCED_PROFILE, AGGRESSIVE_PROFILE, DEFEND_PROFILE } from "../src/alliance/strategic-policy.ts";
import type { AllianceMemberState, EntitySighting } from "../src/alliance/types.ts";

function member(
  tenantId: string,
  opts: Partial<AllianceMemberState> & { corePosition?: readonly [number, number]; military?: number } = {},
): AllianceMemberState {
  const military = opts.military ?? 4;
  return {
    tenantId,
    tick: opts.tick ?? 80,
    observedAtMs: opts.observedAtMs ?? 80_000,
    core: opts.status === "RESPAWNING"
      ? null
      : {
          id: `${tenantId}-core`,
          position: opts.corePosition ?? [0, 0],
          hp: opts.core?.hp ?? 5,
          shield: opts.core?.shield ?? 5,
          moving: opts.core?.moving ?? false,
        },
    resources: opts.resources ?? 10,
    resourceCapacity: opts.resourceCapacity ?? 50,
    population: opts.population ?? 8,
    workers: opts.workers ?? 4,
    vanguards: opts.vanguards ?? military,
    rangers: opts.rangers ?? 0,
    carriedResources: opts.carriedResources ?? 0,
    activeFleetIds: opts.activeFleetIds ?? [],
    localThreat: opts.localThreat ?? 0,
    localHarvestRate: opts.localHarvestRate ?? 0,
    status: opts.status ?? "READY",
  };
}

function sighting(
  key: string,
  kind: "UNIT" | "CORE",
  position: readonly [number, number],
  opts: Partial<EntitySighting> = {},
): EntitySighting {
  return {
    key,
    kind,
    ...(kind === "UNIT" ? { unitType: opts.unitType ?? "VANGUARD" } : {}),
    entityId: opts.entityId ?? key.split(":").at(-1),
    ownerUsername: opts.ownerUsername ?? "enemy",
    position,
    sourceTenant: opts.sourceTenant ?? "t1",
    firstSeenTick: opts.firstSeenTick ?? 80,
    lastSeenTick: opts.lastSeenTick ?? 80,
    currentlyVisible: opts.currentlyVisible ?? true,
    confidence: opts.confidence ?? 1,
    evidence: opts.evidence ?? "LIVE",
  };
}

function snapshot(
  members: readonly AllianceMemberState[],
  sightings: readonly EntitySighting[] = [],
  historicalSightingCount = sightings.length,
) {
  return buildAllianceSnapshotFromSightings({
    revision: 9,
    members,
    sightings,
    allyEntityIds: new Set(members.flatMap((m) => m.core === null ? [] : [m.core.id])),
    nowTick: 80,
    generatedAtMs: 80_000,
    historicalSightingCount,
  });
}

test("vnext: 平静期 RAID 任务进入 market——强兵力租户中标", () => {
  const s = snapshot(
    [member("t1", { military: 6 }), member("t2", { military: 6 })],
    [sighting("CORE:enemy", "CORE", [20, 0])],
  );
  const decision = decideAllianceShadowPolicy(s);
  const raid = decision.missions.find((m) => m.kind === "RAID");
  assert.ok(raid !== undefined, "expected a RAID mission");
  assert.equal(raid.targetEntityKey, "CORE:enemy");
  assert.match(raid.scope ?? "", /alliance-market:utility=/);
  // 未中标租户走 Phase C fallback（SCOUT）
  const others = decision.missions.filter((m) => m.kind !== "RAID");
  assert.ok(others.length >= 1);
  assert.ok(others.every((m) => m.kind === "SCOUT" || m.kind === "ASSEMBLE" || m.kind === "DEFEND"));
  // ASSIST 硬约束
  assert.ok(decision.directives.every((d) => d.mode === "ASSIST"));
});

test("vnext: guarded Core（守军 ≥2）→ multi-slot RAID 联合攻坚", () => {
  const s = snapshot(
    [
      member("t1", { military: 6, activeFleetIds: ["t1:home:0", "t1:strike:0"] }),
      member("t2", { military: 6, activeFleetIds: ["t2:home:0", "t2:strike:0"] }),
    ],
    [
      sighting("CORE:enemy", "CORE", [20, 0]),
      sighting("UNIT:g1", "UNIT", [21, 1]),
      sighting("UNIT:g2", "UNIT", [19, -1]),
    ],
  );
  const decision = decideAllianceShadowPolicy(s);
  const raids = decision.missions.filter((m) => m.kind === "RAID");
  // guarded → slotCount 2 → 两个租户都中标 RAID
  assert.equal(raids.length, 2);
  assert.ok(decision.taskForces.length >= 1);
  const tf = decision.taskForces[0]!;
  assert.equal(tf.synchronization, "RALLY_BEFORE_ENGAGE");
  // 只引用真实 strike fleet
  assert.deepEqual(tf.fleetRefs.map((ref) => ref.fleetId).sort(), ["t1:strike:0", "t2:strike:0"]);
  // missionId 指向 commander 的 mission
  const commanderMission = decision.missions.find((m) => m.id === tf.missionId);
  assert.ok(commanderMission !== undefined);
});

test("vnext: 参与 tenant 无真实 activeFleetId → 不生成 TaskForce（不捏造 FleetRef）", () => {
  const s = snapshot(
    [
      member("t1", { military: 6, activeFleetIds: [] }),
      member("t2", { military: 6, activeFleetIds: [] }),
    ],
    [
      sighting("CORE:enemy", "CORE", [20, 0]),
      sighting("UNIT:g1", "UNIT", [21, 1]),
      sighting("UNIT:g2", "UNIT", [19, -1]),
    ],
  );
  const decision = decideAllianceShadowPolicy(s);
  assert.equal(decision.taskForces.length, 0);
  // 但 per-tenant RAID mission 仍然存在（纯 shadow 建议）
  assert.ok(decision.missions.filter((m) => m.kind === "RAID").length >= 1);
});

test("vnext: 单人槽 RAID（守军 <2）→ 无 TaskForce", () => {
  const s = snapshot(
    [member("t1", { military: 6, activeFleetIds: ["t1:strike:0"] })],
    [sighting("CORE:enemy", "CORE", [20, 0])],
  );
  const decision = decideAllianceShadowPolicy(s);
  assert.equal(decision.taskForces.length, 0);
  assert.equal(decision.missions.filter((m) => m.kind === "RAID").length, 1);
});

test("vnext: urgent 防御 → 空闲租户竞标 ESCORT 交叉支援", () => {
  const s = snapshot(
    [
      // t1 近距威胁 → INTERCEPT（urgent，进入 assist 市场）；t2 远处空闲
      member("t1", { military: 2 }),
      member("t2", { military: 6, corePosition: [30, 0] }),
    ],
    [sighting("UNIT:e", "UNIT", [4, 0])],
  );
  const decision = decideAllianceShadowPolicy(s);
  // t1 近距威胁 → INTERCEPT（urgent）
  assert.equal(decision.missions.filter((m) => m.kind === "INTERCEPT").length, 1);
  // t2 竞标 ESCORT 支援 t1
  const escort = decision.missions.find((m) => m.kind === "ESCORT");
  assert.ok(escort !== undefined, "expected an ESCORT mission for the free tenant");
  assert.equal(escort.defendTenant, "t1");
  assert.match(escort.scope ?? "", /alliance-market:utility=/);
});

test("vnext: defend-only profile → 禁 RAID/ESCORT/SCOUT，未分配成员守家兜底", () => {
  const s = snapshot(
    [member("t1", { military: 6 }), member("t2", { military: 6 })],
    [sighting("CORE:enemy", "CORE", [20, 0])],
  );
  const decision = decideAllianceShadowPolicy(s, {}, DEFEND_PROFILE);
  assert.equal(decision.missions.filter((m) => m.kind === "RAID").length, 0);
  assert.equal(decision.missions.filter((m) => m.kind === "ESCORT").length, 0);
  assert.equal(decision.missions.filter((m) => m.kind === "SCOUT").length, 0);
  assert.equal(decision.taskForces.length, 0);
  // 全部为生存/兜底任务，且 profile 阈值生效（minInterceptMilitary=1 → 全员可拦截，
  // 但无近距威胁 → DEFEND 兜底）
  assert.ok(decision.missions.every((m) => ["DEFEND", "ASSEMBLE", "RETREAT", "INTERCEPT"].includes(m.kind)));
  assert.ok(decision.directives.every((d) => d.mode === "ASSIST"));
});

test("vnext: aggressive profile 阈值生效——低门槛 RAID 触发", () => {
  // 敌核 confidence 0.55、距 80：balanced 不触发（minConfidence 0.65 / maxDistance 64），
  // aggressive 触发（0.5 / 96）
  const s = snapshot(
    [member("t1", { military: 5 })],
    [sighting("CORE:enemy", "CORE", [80, 0], { confidence: 0.55 })],
  );
  const balanced = decideAllianceShadowPolicy(s, {}, BALANCED_PROFILE);
  assert.equal(balanced.missions.filter((m) => m.kind === "RAID").length, 0);
  const aggressive = decideAllianceShadowPolicy(s, {}, AGGRESSIVE_PROFILE);
  assert.ok(aggressive.missions.some((m) => m.kind === "RAID"));
  assert.equal(aggressive.roles.get("t1"), "RAIDER");
});
