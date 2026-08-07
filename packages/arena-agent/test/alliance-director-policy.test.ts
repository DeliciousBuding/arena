import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAllianceSnapshotFromSightings } from "../src/alliance/snapshot.ts";
import { decideAllianceShadowPolicy } from "../src/alliance/director-policy.ts";
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

test("shadow policy: NE+SW 多方向压力 → RETREAT，推荐垂直于威胁轴的 threat-only corridor", () => {
  const s = snapshot(
    [member("t2", { military: 3 })],
    [
      sighting("UNIT:ne", "UNIT", [5, 5]),
      sighting("UNIT:sw", "UNIT", [-5, -5]),
    ],
  );
  const decision = decideAllianceShadowPolicy(s);
  assert.equal(decision.missions.length, 1);
  assert.equal(decision.missions[0]?.kind, "RETREAT");
  assert.equal(decision.directives[0]?.mode, "ASSIST");
  const retreat = decision.retreatAssessments[0];
  assert.ok(retreat !== undefined);
  assert.deepEqual(retreat.pressuredDirections, ["NE", "SW"]);
  assert.ok(retreat.recommendedDirection === "SE" || retreat.recommendedDirection === "NW");
  assert.equal(retreat.basis, "THREAT_ONLY");
  assert.deepEqual(decision.missions[0]?.target, retreat.waypoint);
});

test("shadow policy: 单向近距可见战斗单位 + 足够守军 → INTERCEPT", () => {
  const s = snapshot([member("t2", { military: 3 })], [sighting("UNIT:e", "UNIT", [4, 0])]);
  const decision = decideAllianceShadowPolicy(s);
  assert.equal(decision.missions[0]?.kind, "INTERCEPT");
  assert.equal(decision.missions[0]?.targetEntityKey, "UNIT:e");
  assert.equal(decision.roles.get("t2"), "DEFENDER");
});

test("shadow policy: 无本地压力 + 强兵力 + 新鲜敌核 → RAID", () => {
  const s = snapshot([member("t1", { military: 6 })], [sighting("CORE:enemy", "CORE", [20, 0])]);
  const decision = decideAllianceShadowPolicy(s);
  assert.equal(decision.missions[0]?.kind, "RAID");
  assert.equal(decision.missions[0]?.targetEntityKey, "CORE:enemy");
  assert.equal(decision.roles.get("t1"), "RAIDER");
});

test("shadow policy: 历史计数很大但无实体 → 不制造敌军威胁", () => {
  const s = snapshot([member("t2", { military: 4 })], [], 1_000);
  assert.equal(s.counts.historicalSightingCount, 1_000);
  const decision = decideAllianceShadowPolicy(s);
  assert.equal(decision.missions[0]?.kind, "SCOUT");
  assert.equal(decision.retreatAssessments.length, 0);
});

test("shadow policy: RESPAWNING → ASSEMBLE/rebuild，不分配远征", () => {
  const s = snapshot([member("t3", { status: "RESPAWNING", military: 0 })]);
  const decision = decideAllianceShadowPolicy(s);
  assert.equal(decision.missions[0]?.kind, "ASSEMBLE");
  assert.match(decision.missions[0]?.scope ?? "", /rebuild/);
});

test("shadow policy: member 输入顺序不影响 mission/directive 结果", () => {
  const a = member("t1", { resources: 20, military: 4 });
  const b = member("t2", { resources: 10, military: 4 });
  const left = decideAllianceShadowPolicy(snapshot([a, b]));
  const right = decideAllianceShadowPolicy(snapshot([b, a]));
  const project = (d: ReturnType<typeof decideAllianceShadowPolicy>) => ({
    treasuryTenant: d.treasuryTenant,
    missions: d.missions,
    directives: d.directives,
    roles: [...d.roles.entries()],
    taskForces: d.taskForces,
  });
  assert.deepEqual(project(left), project(right));
  assert.equal(left.treasuryTenant, "t1");
});

test("shadow policy: 所有 directive missionRefs 均存在，且输出不含 action/submit/START_MOVE", () => {
  const s = snapshot(
    [member("t1", { military: 5 }), member("t2", { military: 3 })],
    [sighting("UNIT:ne", "UNIT", [5, 5]), sighting("UNIT:sw", "UNIT", [-5, -5])],
  );
  const decision = decideAllianceShadowPolicy(s);
  const missionIds = new Set(decision.missions.map((m) => m.id));
  for (const d of decision.directives) {
    assert.equal(d.mode, "ASSIST");
    assert.ok(d.missionRefs.every((id) => missionIds.has(id)));
  }
  const text = JSON.stringify({ missions: decision.missions, directives: decision.directives });
  assert.doesNotMatch(text, /START_MOVE|unitActions|coreAction|CandidateSink|submit/i);
});


test("shadow policy market: RAID 由更近的合格租户承接，而不是简单选兵力最大者", () => {
  const s = snapshot([
    member("t1", { corePosition: [0, 0], military: 8, resources: 30 }),
    member("t2", { corePosition: [20, 0], military: 6, resources: 10 }),
  ], [sighting("CORE:enemy", "CORE", [50, 0])]);
  const d = decideAllianceShadowPolicy(s);
  assert.equal(d.missions.find((m) => m.kind === "RAID")?.id.includes("t2"), true);
  assert.equal(d.roles.get("t2"), "RAIDER");
  assert.equal(d.roles.get("t1"), "SCOUT");
});

test("shadow policy market: 某租户受压时，空闲盟友竞价 ESCORT 回援", () => {
  const s = snapshot([
    member("t1", { corePosition: [0, 0], military: 3 }),
    member("t2", { corePosition: [30, 0], military: 4 }),
  ], [sighting("UNIT:e", "UNIT", [3, 0])]);
  const d = decideAllianceShadowPolicy(s);
  assert.equal(d.missions.find((m) => m.id.includes("t1"))?.kind, "INTERCEPT");
  const assist = d.missions.find((m) => m.id.includes("t2"));
  assert.equal(assist?.kind, "ESCORT");
  assert.equal(assist?.defendTenant, "t1");
  assert.match(assist?.scope ?? "", /alliance-market/);
});


test("shadow policy joint RAID: guarded Core creates two tenant slots and a real cross-tenant TaskForce", () => {
  const s = snapshot([
    member("t1", { corePosition:[0,0], military:7, resources:15, activeFleetIds:["t1:home:0","t1:strike:0"] }),
    member("t2", { corePosition:[5,0], military:6, resources:12, activeFleetIds:["t2:home:0","t2:strike:0"] }),
    member("t3", { corePosition:[45,0], military:3, resources:30, activeFleetIds:["t3:home:0","t3:strike:0"] }),
  ], [
    sighting("CORE:enemy", "CORE", [20,0]),
    sighting("UNIT:g1", "UNIT", [19,0], { unitType:"VANGUARD" }),
    sighting("UNIT:g2", "UNIT", [21,1], { unitType:"RANGER" }),
  ]);
  const d = decideAllianceShadowPolicy(s, { threatSummary: { coreWeight: 0, unitWeight: 0 } });
  const raids = d.missions.filter((m) => m.kind === "RAID" && m.targetEntityKey === "CORE:enemy");
  assert.equal(raids.length, 2, `guarded Core 应有两个联合攻坚 mission: ${JSON.stringify(d.missions)}`);
  assert.deepEqual(new Set(raids.map((m) => m.id.includes("t1") ? "t1" : m.id.includes("t2") ? "t2" : "other")), new Set(["t1","t2"]));
  assert.equal(d.taskForces.length, 1);
  const tf = d.taskForces[0]!;
  assert.equal(tf.synchronization, "RALLY_BEFORE_ENGAGE");
  assert.deepEqual(new Set(tf.fleetRefs.map((r) => `${r.tenantId}:${r.fleetId}`)), new Set(["t1:t1:strike:0","t2:t2:strike:0"]));
  assert.ok(tf.commanderTenant === "t1" || tf.commanderTenant === "t2");
  assert.ok(raids.some((m) => m.id === tf.missionId), "TaskForce missionId 必须引用真实 commander mission");
});

test("shadow policy joint RAID: no fabricated TaskForce when one selected tenant has no active fleet", () => {
  const s = snapshot([
    member("t1", { corePosition:[0,0], military:7, activeFleetIds:["t1:home:0","t1:strike:0"] }),
    member("t2", { corePosition:[5,0], military:6, activeFleetIds:[] }),
  ], [
    sighting("CORE:enemy", "CORE", [20,0]),
    sighting("UNIT:g1", "UNIT", [19,0], { unitType:"VANGUARD" }),
    sighting("UNIT:g2", "UNIT", [21,1], { unitType:"RANGER" }),
  ]);
  const d = decideAllianceShadowPolicy(s, { threatSummary: { coreWeight: 0, unitWeight: 0 } });
  assert.equal(d.missions.filter((m) => m.kind === "RAID").length, 2, "联合任务建议仍可存在");
  assert.equal(d.taskForces.length, 0, "缺真实 activeFleetId 时不得伪造 FleetRef");
});

test("shadow policy RAID: isolated Core stays single-slot and does not create joint TaskForce", () => {
  const s = snapshot([
    member("t1", { corePosition:[0,0], military:7, activeFleetIds:["t1:home:0","t1:strike:0"] }),
    member("t2", { corePosition:[5,0], military:6, activeFleetIds:["t2:home:0","t2:strike:0"] }),
  ], [sighting("CORE:enemy", "CORE", [20,0])]);
  const d = decideAllianceShadowPolicy(s);
  assert.equal(d.missions.filter((m) => m.kind === "RAID").length, 1);
  assert.equal(d.taskForces.length, 0);
});
