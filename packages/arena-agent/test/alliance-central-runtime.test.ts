import test from "node:test";
import assert from "node:assert/strict";
import type { AllianceShadowFrameV1 } from "../src/alliance/shadow-frame.ts";
import type { AllianceDirective } from "../src/alliance/control-types.ts";
import {
  createAckMessage,
  createDirectiveMessage,
  createFrameMessage,
  isAllianceFrameMessage,
} from "../src/alliance/runtime/ipc.ts";
import { createTenantAllianceIpcBridge } from "../src/alliance/runtime/tenant-bridge.ts";
import { createCentralAllianceShadowRuntime } from "../src/alliance/runtime/central-shadow-runtime.ts";

function frame(tenantId: string, tick: number, x: number): AllianceShadowFrameV1 {
  return {
    schema: "alliance-shadow-frame-v1",
    processRunId: `run-${tenantId}`,
    tenantId,
    tick,
    observedAtMs: tick * 1000,
    member: {
      tenantId,
      tick,
      observedAtMs: tick * 1000,
      core: { id: `core-${tenantId}`, position: [x, 0], hp: 5, shield: 5, moving: false },
      resources: 10,
      resourceCapacity: 50,
      population: 8,
      workers: 2,
      vanguards: 4,
      rangers: 2,
      carriedResources: 0,
      activeFleetIds: [`${tenantId}:home:0`, `${tenantId}:strike:0`],
      localThreat: 0,
      localHarvestRate: 0,
      status: "READY",
    },
    sightings: [],
    allyEntityIds: [`core-${tenantId}`],
    historicalSightingCount: 0,
  };
}

function directive(tenantId: string, revision = 1): AllianceDirective {
  return {
    tenantId,
    revision,
    missionRefs: [`m-${revision}`],
    issuedAtTick: 100,
    expiresAtTick: 120,
    source: "auto",
    mode: "ASSIST",
    explanation: "test only",
  };
}

test("frame IPC: factory/guard preserve transport identity and reject mismatch", () => {
  const f = frame("t1", 100, 0);
  const msg = createFrameMessage(f);
  assert.equal(isAllianceFrameMessage(msg), true);
  assert.equal(isAllianceFrameMessage({ ...msg, tenantId: "t2" }), false);
  assert.equal(isAllianceFrameMessage({ ...msg, tick: 99 }), false);
  assert.equal(isAllianceFrameMessage({ ...msg, schemaVersion: 999 }), false);
});

test("tenant bridge: accepted ACK means stored ASSIST only; duplicate revision is ignored", () => {
  const sent: unknown[] = [];
  const bridge = createTenantAllianceIpcBridge((message) => sent.push(message));
  bridge.onFrame(frame("t1", 100, 0));
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as { type: string }).type, "arena.alliance.frame");

  const msg = createDirectiveMessage(directive("t1", 1), 100);
  bridge.onMessage(msg);
  const accepted = sent.at(-1) as { type: string; status: string; reason?: string };
  assert.equal(accepted.type, "arena.alliance.ack");
  assert.equal(accepted.status, "accepted");
  assert.match(accepted.reason ?? "", /stored; no action ownership/);
  assert.equal(bridge.lastRevision, 1);

  bridge.onMessage(msg);
  const duplicate = sent.at(-1) as { status: string; reason?: string };
  assert.equal(duplicate.status, "ignored");
  assert.match(duplicate.reason ?? "", /revision not newer/);
  assert.equal(bridge.lastRevision, 1);
});

test("tenant bridge: wrong transport tenant is rejected and never advances revision", () => {
  const sent: unknown[] = [];
  const bridge = createTenantAllianceIpcBridge((message) => sent.push(message));
  bridge.onFrame(frame("t1", 100, 0));
  bridge.onMessage(createDirectiveMessage(directive("t2", 5), 100));
  const ack = sent.at(-1) as { status: string; reason?: string };
  assert.equal(ack.status, "rejected");
  assert.match(ack.reason ?? "", /transport tenant mismatch/);
  assert.equal(bridge.lastRevision, -1);
});

test("central shadow: all expected frames must be coherent before replan; period throttles revisions", () => {
  const sends: Array<{ tenantId: string; message: any }> = [];
  const central = createCentralAllianceShadowRuntime({
    enabled: true,
    expectedTenants: ["t1", "t2", "t3", "t4"],
    periodTicks: 4,
    maxSkewTicks: 1,
    send: (tenantId, message) => { sends.push({ tenantId, message }); return true; },
  });
  for (const [i, tenant] of (["t1", "t2", "t3"] as const).entries()) {
    central.onChildMessage(tenant, createFrameMessage(frame(tenant, 100, i * 5)));
  }
  assert.equal(sends.length, 0, "missing t4 => no partial-view replan");
  central.onChildMessage("t4", createFrameMessage(frame("t4", 100, 15)));
  assert.equal(sends.length, 4);
  let view = central.view() as any;
  assert.equal(view.mode, "ASSIST_ONLY");
  assert.equal(view.actionOwnership, "none");
  assert.equal(view.revision, 1);
  assert.equal(view.runtime.directiveSentCount, 4);

  // Period=4: coherent tick 101 is not enough for a second revision.
  for (const [i, tenant] of (["t1", "t2", "t3", "t4"] as const).entries()) {
    central.onChildMessage(tenant, createFrameMessage(frame(tenant, 101, i * 5)));
  }
  assert.equal(sends.length, 4);
  assert.equal((central.view() as any).revision, 1);

  // Skew >1 blocks replan even though one tenant has moved far ahead.
  central.onChildMessage("t1", createFrameMessage(frame("t1", 104, 0)));
  assert.equal(sends.length, 4);
  for (const [i, tenant] of (["t2", "t3", "t4"] as const).entries()) {
    central.onChildMessage(tenant, createFrameMessage(frame(tenant, 104, (i + 1) * 5)));
  }
  assert.equal(sends.length, 8);
  view = central.view() as any;
  assert.equal(view.revision, 2);
  assert.equal(view.tick, 104);
});

test("central shadow: wrong transport identity/malformed input fail open; ACK remains observability only", () => {
  const sends: Array<{ tenantId: string; message: any }> = [];
  const central = createCentralAllianceShadowRuntime({
    enabled: true,
    expectedTenants: ["t1"],
    periodTicks: 1,
    maxSkewTicks: 0,
    send: (tenantId, message) => { sends.push({ tenantId, message }); return true; },
  });
  central.onChildMessage("t2", createFrameMessage(frame("t1", 100, 0)));
  central.onChildMessage("t1", { type: "arena.alliance.frame", schemaVersion: 999 });
  assert.equal(sends.length, 0);
  central.onChildMessage("t1", createFrameMessage(frame("t1", 100, 0)));
  assert.equal(sends.length, 1);
  const revision = sends[0]!.message.revision as number;
  central.onChildMessage("t1", createAckMessage("t1", 100, revision, "accepted", "stored only"));
  const view = central.view() as any;
  assert.equal(view.runtime.ackCount, 1);
  assert.equal(view.runtime.ackRecords.at(-1).state, "accepted");
  assert.equal(view.actionOwnership, "none");
});

test("central strategic profile: request is pending until next coherent replan; last-good rollback is also boundary-applied", () => {
  const sends: Array<{ tenantId: string; message: any }> = [];
  const central = createCentralAllianceShadowRuntime({
    enabled: true,
    expectedTenants: ["t1"],
    periodTicks: 1,
    maxSkewTicks: 0,
    send: (tenantId, message) => { sends.push({ tenantId, message }); return true; },
  });

  central.onChildMessage("t1", createFrameMessage(frame("t1", 100, 0)));
  let view = central.view();
  assert.equal(view.strategy.active.name, "balanced");
  assert.equal(view.strategy.active.selectionRevision, 1);
  assert.equal(view.strategy.pending, null);

  const invalid = central.requestStrategicProfile("does-not-exist");
  assert.equal(invalid.accepted, false);
  assert.equal(central.view().strategy.pending, null);

  const queued = central.requestStrategicProfile("aggressive");
  assert.equal(queued.accepted, true);
  view = central.view();
  assert.equal(view.strategy.active.name, "balanced", "operator request must not mutate an in-flight policy epoch");
  assert.deepEqual(view.strategy.pending, { action: "select", profile: "aggressive" });

  central.onChildMessage("t1", createFrameMessage(frame("t1", 101, 0)));
  view = central.view();
  assert.equal(view.strategy.active.name, "aggressive");
  assert.equal(view.strategy.active.selectionRevision, 2);
  assert.equal(view.strategy.pending, null);
  assert.equal(view.mode, "ASSIST_ONLY");
  assert.equal(view.actionOwnership, "none");
  assert.ok(sends.every((entry) => entry.message.directive?.mode === "ASSIST"));

  central.markStrategicLastGood();
  assert.equal(central.view().strategy.lastGood?.name, "aggressive");
  central.requestStrategicProfile("defend-only");
  central.onChildMessage("t1", createFrameMessage(frame("t1", 102, 0)));
  assert.equal(central.view().strategy.active.name, "defend-only");

  central.requestStrategicRollback();
  assert.deepEqual(central.view().strategy.pending, { action: "rollback" });
  central.onChildMessage("t1", createFrameMessage(frame("t1", 103, 0)));
  view = central.view();
  assert.equal(view.strategy.active.name, "aggressive");
  assert.equal(view.strategy.pending, null);
  assert.equal(view.strategy.lastGood?.name, "aggressive");
});

test("central strategic profile: configured initial profile is validated at construction and applies on first replan", () => {
  assert.throws(() => createCentralAllianceShadowRuntime({
    enabled: true,
    expectedTenants: ["t1"],
    initialStrategicProfile: "missing-profile",
    send: () => true,
  }), /unknown Alliance strategic profile/);

  const central = createCentralAllianceShadowRuntime({
    enabled: true,
    expectedTenants: ["t1"],
    periodTicks: 1,
    maxSkewTicks: 0,
    initialStrategicProfile: "defend-only",
    send: () => true,
  });
  assert.equal(central.view().strategy.active.name, "balanced", "initial profile is queued, not applied outside replan");
  assert.deepEqual(central.view().strategy.pending, { action: "select", profile: "defend-only" });
  central.onChildMessage("t1", createFrameMessage(frame("t1", 50, 0)));
  assert.equal(central.view().strategy.active.name, "defend-only");
});
