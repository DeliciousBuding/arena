/**
 * Alliance Director — Phase 3a runtime shadow primitives 测试。
 *
 * 覆盖：
 * - IPC guard malformed → 不 crash，返回 false
 * - IPC guard valid shapes → 返回 true
 * - DirectiveInbox：wrong tenant / stale / expired / old revision → fail-open ignore
 * - DirectiveInbox：valid latest → current(tick) 可读
 * - Disabled runtime：replan → 0 sends / 0 director calls
 * - Director throws → runtime 下一周期继续
 * - Send failure on one tenant → 不影响其他 tenant
 * - Stale member report → 排除出 snapshot
 * - Deterministic tenant ordering
 * - Ack revision monotonic（旧 ack 不倒退状态）
 *
 * 最后更新：2026-08-08
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AllianceDirective, AllianceMemberReport } from "../../src/alliance/control-types.ts";
import {
  isAllianceIpcMessage,
  isAllianceMemberMessage,
  isAllianceDirectiveMessage,
  isAllianceAckMessage,
  createMemberMessage,
  createDirectiveMessage,
  createAckMessage,
  ALLIANCE_IPC_SCHEMA_VERSION,
} from "../../src/alliance/runtime/ipc.ts";
import type { AllianceAckMessage, AllianceDirectiveMessage } from "../../src/alliance/runtime/ipc.ts";
import { createDirectiveInbox } from "../../src/alliance/runtime/directive-inbox.ts";
import type { DirectiveInbox } from "../../src/alliance/runtime/directive-inbox.ts";
import {
  createSupervisorAllianceDirectorRuntime,
} from "../../src/alliance/runtime/supervisor-director.ts";
import type {
  AllianceDirectorCallbacks,
  AllianceDirectorInterface,
  SupervisorAllianceDirectorRuntime,
} from "../../src/alliance/runtime/supervisor-director.ts";

// ═══════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════

function makeDirective(overrides: Partial<AllianceDirective> = {}): AllianceDirective {
  return {
    tenantId: "t1",
    revision: 1,
    missionRefs: ["m1"],
    issuedAtTick: 100,
    expiresAtTick: 200,
    source: "auto",
    mode: "AUTO",
    ...overrides,
  };
}

function makeReport(overrides: Partial<AllianceMemberReport> = {}): AllianceMemberReport {
  return {
    tenantId: "t1",
    tick: 100,
    observedAtMs: 100,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, moving: false },
    resources: 100,
    resourceCapacity: 200,
    population: 10,
    workers: 6,
    vanguards: 2,
    rangers: 2,
    carriedResources: 0,
    activeFleetIds: ["f1"],
    localThreat: 0,
    localHarvestRate: 1.5,
    status: "READY",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// IPC guards — malformed 不 crash
// ═══════════════════════════════════════════════════════════════

test("IPC guard: null / undefined → false", () => {
  assert.equal(isAllianceIpcMessage(null), false);
  assert.equal(isAllianceIpcMessage(undefined), false);
});

test("IPC guard: non-object → false", () => {
  assert.equal(isAllianceIpcMessage("string"), false);
  assert.equal(isAllianceIpcMessage(42), false);
  assert.equal(isAllianceIpcMessage(true), false);
});

test("IPC guard: object without type → false", () => {
  assert.equal(isAllianceIpcMessage({}), false);
  assert.equal(isAllianceIpcMessage({ foo: "bar" }), false);
});

test("IPC guard: unknown type → false", () => {
  assert.equal(isAllianceIpcMessage({ type: "unknown.message" }), false);
  assert.equal(isAllianceIpcMessage({ type: "arena.shutdown" }), false);
});

test("IPC guard: isAllianceMemberMessage valid → true", () => {
  const report = makeReport({ tenantId: "t1", tick: 100 });
  const msg = createMemberMessage(report);
  assert.equal(isAllianceIpcMessage(msg), true);
  assert.equal(isAllianceMemberMessage(msg), true);
});

test("IPC guard: isAllianceMemberMessage missing report → false", () => {
  const msg = {
    type: "arena.alliance.member",
    schemaVersion: 1,
    tenantId: "t1",
    tick: 100,
    // report missing
  };
  assert.equal(isAllianceMemberMessage(msg), false);
});

test("IPC guard: isAllianceMemberMessage bad tenantId → false", () => {
  const msg = {
    type: "arena.alliance.member",
    schemaVersion: 1,
    tenantId: "",
    tick: 100,
    report: makeReport(),
  };
  assert.equal(isAllianceMemberMessage(msg), false);
});

test("IPC guard: isAllianceMemberMessage negative tick → false", () => {
  const msg = {
    type: "arena.alliance.member",
    schemaVersion: 1,
    tenantId: "t1",
    tick: -1,
    report: makeReport(),
  };
  assert.equal(isAllianceMemberMessage(msg), false);
});

test("IPC guard: isAllianceMemberMessage bad schemaVersion → false", () => {
  const report = makeReport();
  const msg = {
    type: "arena.alliance.member",
    schemaVersion: "not-a-number",
    tenantId: "t1",
    tick: 100,
    report,
  };
  assert.equal(isAllianceMemberMessage(msg), false);
});

test("IPC guard: isAllianceDirectiveMessage valid → true", () => {
  const directive = makeDirective();
  const msg = createDirectiveMessage(directive, 100);
  assert.equal(isAllianceIpcMessage(msg), true);
  assert.equal(isAllianceDirectiveMessage(msg), true);
});

test("IPC guard: isAllianceDirectiveMessage missing directive → false", () => {
  const msg = {
    type: "arena.alliance.directive",
    schemaVersion: 1,
    tenantId: "t1",
    tick: 100,
    revision: 1,
  };
  assert.equal(isAllianceDirectiveMessage(msg), false);
});

test("IPC guard: isAllianceDirectiveMessage negative revision → false", () => {
  const msg = {
    type: "arena.alliance.directive",
    schemaVersion: 1,
    tenantId: "t1",
    tick: 100,
    revision: -1,
    directive: makeDirective(),
  };
  assert.equal(isAllianceDirectiveMessage(msg), false);
});

test("IPC guard: isAllianceAckMessage valid → true", () => {
  const msg = createAckMessage("t1", 100, 1, "accepted");
  assert.equal(isAllianceIpcMessage(msg), true);
  assert.equal(isAllianceAckMessage(msg), true);
});

test("IPC guard: isAllianceAckMessage all status values → true", () => {
  const statuses = ["accepted", "ignored", "rejected"] as const;
  for (const status of statuses) {
    const msg = createAckMessage("t1", 100, 1, status);
    assert.equal(isAllianceAckMessage(msg), true, `status=${status}`);
  }
});

test("IPC guard: isAllianceAckMessage invalid status → false", () => {
  const msg = { type: "arena.alliance.ack", schemaVersion: 1, tenantId: "t1", tick: 100, revision: 1, status: "unknown" };
  assert.equal(isAllianceAckMessage(msg), false);
});

test("IPC guard: isAllianceAckMessage bad reason type → false", () => {
  const msg = { type: "arena.alliance.ack", schemaVersion: 1, tenantId: "t1", tick: 100, revision: 1, status: "accepted", reason: 42 };
  assert.equal(isAllianceAckMessage(msg), false);
});

test("IPC guard: isAllianceAckMessage reason is string → ok", () => {
  const msg = { type: "arena.alliance.ack", schemaVersion: 1, tenantId: "t1", tick: 100, revision: 1, status: "ignored", reason: "stale" };
  assert.equal(isAllianceAckMessage(msg), true);
});

test("IPC guard: malformed messages do not throw (所有 guard 都是 boolean 返回)", () => {
  const malformed = [
    null,
    undefined,
    {},
    { type: 42 },
    { type: "arena.alliance.member" },
    { type: "arena.alliance.member", schemaVersion: 1 },
    { type: "arena.alliance.directive", schemaVersion: 1, tenantId: "t1" },
    { type: "arena.alliance.ack", schemaVersion: 1, tenantId: "t1", tick: 100 },
  ];
  for (const msg of malformed) {
    // None should throw
    assert.doesNotThrow(() => isAllianceIpcMessage(msg));
    assert.doesNotThrow(() => isAllianceMemberMessage(msg));
    assert.doesNotThrow(() => isAllianceDirectiveMessage(msg));
    assert.doesNotThrow(() => isAllianceAckMessage(msg));
  }
});

test("IPC factory: createMemberMessage 正确填充所有字段", () => {
  const report = makeReport({ tenantId: "t2", tick: 42 });
  const msg = createMemberMessage(report);
  assert.equal(msg.type, "arena.alliance.member");
  assert.equal(msg.schemaVersion, ALLIANCE_IPC_SCHEMA_VERSION);
  assert.equal(msg.tenantId, "t2");
  assert.equal(msg.tick, 42);
  assert.equal(msg.report, report);
});

test("IPC factory: createDirectiveMessage 正确填充所有字段", () => {
  const directive = makeDirective({ tenantId: "t3", revision: 7 });
  const msg = createDirectiveMessage(directive, 200);
  assert.equal(msg.type, "arena.alliance.directive");
  assert.equal(msg.schemaVersion, ALLIANCE_IPC_SCHEMA_VERSION);
  assert.equal(msg.tenantId, "t3");
  assert.equal(msg.tick, 200);
  assert.equal(msg.revision, 7);
  assert.equal(msg.directive, directive);
});

test("IPC factory: createAckMessage 正确填充所有字段", () => {
  const msg = createAckMessage("t4", 300, 3, "rejected", "invalid structure");
  assert.equal(msg.type, "arena.alliance.ack");
  assert.equal(msg.schemaVersion, ALLIANCE_IPC_SCHEMA_VERSION);
  assert.equal(msg.tenantId, "t4");
  assert.equal(msg.tick, 300);
  assert.equal(msg.revision, 3);
  assert.equal(msg.status, "rejected");
  assert.equal(msg.reason, "invalid structure");
});

// ═══════════════════════════════════════════════════════════════
// DirectiveInbox — fail-open semantics
// ═══════════════════════════════════════════════════════════════

test("Inbox: 初始状态 hasDirective=false, lastRevision=-1", () => {
  const inbox = createDirectiveInbox("t1");
  assert.equal(inbox.hasDirective, false);
  assert.equal(inbox.lastRevision, -1);
});

test("Inbox: current(tick) 空 inbox → undefined", () => {
  const inbox = createDirectiveInbox("t1");
  assert.equal(inbox.current(100), undefined);
});

test("Inbox: accept 正确 tenant + 有效 → accepted=true", () => {
  const inbox = createDirectiveInbox("t1");
  const d = makeDirective({ tenantId: "t1", revision: 1, issuedAtTick: 100, expiresAtTick: 200 });
  const result = inbox.accept(d, 100);
  assert.equal(result.accepted, true);
  assert.equal(result.revision, 1);
  assert.equal(inbox.hasDirective, true);
  assert.equal(inbox.lastRevision, 1);
});

test("Inbox: accept wrong tenant → fail-open ignore", () => {
  const inbox = createDirectiveInbox("t1");
  const d = makeDirective({ tenantId: "t2", revision: 1 });
  const result = inbox.accept(d, 100);
  assert.equal(result.accepted, false);
  assert.ok(result.reason?.includes("tenant mismatch"));
  assert.equal(inbox.hasDirective, false);
});

test("Inbox: accept old revision → fail-open ignore", () => {
  const inbox = createDirectiveInbox("t1");
  // Accept rev 5
  assert.equal(inbox.accept(makeDirective({ revision: 5, issuedAtTick: 100, expiresAtTick: 200 }), 100).accepted, true);
  // Try rev 3 (older)
  const result = inbox.accept(makeDirective({ revision: 3, issuedAtTick: 100, expiresAtTick: 200 }), 100);
  assert.equal(result.accepted, false);
  assert.ok(result.reason?.includes("revision not newer"));
  // Still has rev 5
  assert.equal(inbox.lastRevision, 5);
});

test("Inbox: accept same revision → fail-open ignore（不覆盖重复指令）", () => {
  const inbox = createDirectiveInbox("t1");
  assert.equal(inbox.accept(makeDirective({ revision: 5, issuedAtTick: 100, expiresAtTick: 200 }), 100).accepted, true);
  const result = inbox.accept(makeDirective({ revision: 5, issuedAtTick: 100, expiresAtTick: 200 }), 100);
  assert.equal(result.accepted, false);
  assert.ok(result.reason?.includes("revision not newer"));
});

test("Inbox: accept newer revision → 覆盖旧值", () => {
  const inbox = createDirectiveInbox("t1");
  inbox.accept(makeDirective({ revision: 5, issuedAtTick: 100, expiresAtTick: 200 }), 100);
  assert.equal(inbox.accept(makeDirective({ revision: 7, issuedAtTick: 100, expiresAtTick: 200 }), 100).accepted, true);
  assert.equal(inbox.lastRevision, 7);
});

test("Inbox: accept invalid directive (revision < 0) → fail-open ignore", () => {
  const inbox = createDirectiveInbox("t1");
  const d = makeDirective({ revision: -1 });
  const result = inbox.accept(d, 100);
  assert.equal(result.accepted, false);
  assert.ok(result.reason?.includes("invalid"));
});

test("Inbox: accept invalid directive (empty missionRefs) → fail-open ignore", () => {
  const inbox = createDirectiveInbox("t1");
  const d = makeDirective({ missionRefs: [] });
  const result = inbox.accept(d, 100);
  assert.equal(result.accepted, false);
  assert.ok(result.reason?.includes("invalid"));
});

test("Inbox: current(tick) — 有效窗口内返回 directive", () => {
  const inbox = createDirectiveInbox("t1");
  // issuedAtTick=148 保证 currentTick=150 时 diff=2 ≤ DEFAULT_DIRECTIVE_STALE_TICKS(4)
  inbox.accept(makeDirective({ revision: 1, issuedAtTick: 148, expiresAtTick: 200 }), 150);
  const d = inbox.current(150);
  assert.ok(d !== undefined);
  assert.equal(d!.revision, 1);
});

test("Inbox: current(tick) — 过期返回 undefined (fail-open)", () => {
  const inbox = createDirectiveInbox("t1");
  inbox.accept(makeDirective({ revision: 1, issuedAtTick: 100, expiresAtTick: 200 }), 100);
  assert.equal(inbox.current(201), undefined);
});

test("Inbox: current(tick) — stale 返回 undefined (fail-open)", () => {
  const inbox = createDirectiveInbox("t1");
  // issuedAtTick=100, current=150: diff=50 > DEFAULT_DIRECTIVE_STALE_TICKS(4)
  inbox.accept(makeDirective({ revision: 1, issuedAtTick: 100, expiresAtTick: 250 }), 100);
  assert.equal(inbox.current(150), undefined);
});

test("Inbox: current(tick) — pending 返回 undefined", () => {
  const inbox = createDirectiveInbox("t1");
  inbox.accept(makeDirective({ revision: 1, issuedAtTick: 100, expiresAtTick: 200 }), 100);
  assert.equal(inbox.current(99), undefined);
});

test("Inbox: current(tick) — 刚 accept 后在有效 tick 可读", () => {
  const inbox = createDirectiveInbox("t1");
  inbox.accept(makeDirective({ revision: 1, issuedAtTick: 50, expiresAtTick: 100 }), 50);
  // tick 50 在边界：50-50=0 ≤ 4 → 未 stale
  const d = inbox.current(50);
  assert.ok(d !== undefined);
  assert.equal(d!.revision, 1);
});

test("Inbox: 多次 accept → current 返回最新 revision", () => {
  const inbox = createDirectiveInbox("t1");
  inbox.accept(makeDirective({ revision: 1, issuedAtTick: 100, expiresAtTick: 300 }), 100);
  inbox.accept(makeDirective({ revision: 3, issuedAtTick: 105, expiresAtTick: 300 }), 105);
  // tick 106: rev3 issuedAtTick=105, diff=1 ≤ 4 → 未 stale
  const d = inbox.current(106);
  assert.ok(d !== undefined);
  assert.equal(d!.revision, 3);
});

test("Inbox: 不创建 Plan/Action——只返回 AllianceDirective 或 undefined", () => {
  const inbox = createDirectiveInbox("t1");
  inbox.accept(makeDirective({ revision: 1, issuedAtTick: 148, expiresAtTick: 200 }), 150);
  const d = inbox.current(150);
  assert.ok(d !== undefined);
  // 验证返回的对象就是原始 AllianceDirective，不包含任何 Plan/Action 字段
  assert.ok(!("plan" in d!));
  assert.ok(!("action" in d!));
  assert.ok(!("submit" in d!));
  assert.ok(!("token" in d!));
  assert.ok(!("candidateSink" in d!));
});

test("Inbox: lastRevision 只跟踪 accepted revision", () => {
  const inbox = createDirectiveInbox("t1");
  // reject: wrong tenant
  inbox.accept(makeDirective({ tenantId: "t2", revision: 10 }), 100);
  assert.equal(inbox.lastRevision, -1);
  // accept
  inbox.accept(makeDirective({ revision: 15, issuedAtTick: 100, expiresAtTick: 200 }), 100);
  assert.equal(inbox.lastRevision, 15);
  // reject: older
  inbox.accept(makeDirective({ revision: 12, issuedAtTick: 100, expiresAtTick: 200 }), 100);
  assert.equal(inbox.lastRevision, 15); // stays at max
});

test("Inbox: 泛型 tenantId——非 t1-t4 也可用", () => {
  const inbox = createDirectiveInbox("tenant-omega");
  const d = makeDirective({ tenantId: "tenant-omega", revision: 1, issuedAtTick: 148, expiresAtTick: 200 });
  assert.equal(inbox.accept(d, 150).accepted, true);
  const current = inbox.current(150);
  assert.ok(current !== undefined);
  assert.equal(current!.tenantId, "tenant-omega");
});

// ═══════════════════════════════════════════════════════════════
// Disabled runtime — 完全 no-op
// ═══════════════════════════════════════════════════════════════

test("Disabled: enabled=false（默认）→ replan 不调用 director", () => {
  let directorCalls = 0;
  const director: AllianceDirectorInterface = {
    replan() { directorCalls += 1; return []; },
  };
  const sent: AllianceDirectiveMessage[] = [];
  const callbacks: AllianceDirectorCallbacks = {
    send(_tenantId, msg) { sent.push(msg); },
  };

  const runtime = createSupervisorAllianceDirectorRuntime(director, callbacks);
  assert.equal(runtime.enabled, false);

  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 100 }));
  runtime.replan(100);
  runtime.replan(200);

  assert.equal(directorCalls, 0, "disabled runtime must never call director");
  assert.equal(sent.length, 0, "disabled runtime must never send");
});

test("Disabled: 即使 member reports 存在，disabled 也不触发任何动作", () => {
  let directorCalls = 0;
  const director: AllianceDirectorInterface = {
    replan() { directorCalls += 1; return [makeDirective({ tenantId: "t1", revision: 1, issuedAtTick: 100, expiresAtTick: 200 })]; },
  };
  const sent: AllianceDirectiveMessage[] = [];
  const callbacks: AllianceDirectorCallbacks = {
    send(_tenantId, msg) { sent.push(msg); },
  };

  const runtime = createSupervisorAllianceDirectorRuntime(director, callbacks);
  // Feed reports from 4 tenants
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 100 }));
  runtime.onMemberReport(makeReport({ tenantId: "t2", tick: 100 }));
  runtime.onMemberReport(makeReport({ tenantId: "t3", tick: 100 }));
  runtime.onMemberReport(makeReport({ tenantId: "t4", tick: 100 }));
  runtime.replan(100);

  assert.equal(directorCalls, 0);
  assert.equal(sent.length, 0);
  // Stats still track reports
  assert.equal(runtime.stats().reportCount, 4);
});

test("Disabled: 对 child writer 完全无影响——0 IPC sends", () => {
  const sent: AllianceDirectiveMessage[] = [];
  const director: AllianceDirectorInterface = { replan() { return [makeDirective()]; } };
  const callbacks: AllianceDirectorCallbacks = { send(_t, m) { sent.push(m); } };
  const runtime = createSupervisorAllianceDirectorRuntime(director, callbacks);
  runtime.onMemberReport(makeReport());
  runtime.replan(100);
  assert.equal(sent.length, 0);
});

test("Enabled: 显式 enabled=true → replan 调用 director + send", () => {
  let directorCalls = 0;
  const director: AllianceDirectorInterface = {
    replan() {
      directorCalls += 1;
      return [makeDirective({ tenantId: "t1", revision: 1, issuedAtTick: 50, expiresAtTick: 200 })];
    },
  };
  const sent: AllianceDirectiveMessage[] = [];
  const callbacks: AllianceDirectorCallbacks = {
    send(_tenantId, msg) { sent.push(msg); },
  };

  const runtime = createSupervisorAllianceDirectorRuntime(director, callbacks, { enabled: true });
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 50 }));
  runtime.replan(50);

  assert.equal(directorCalls, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tenantId, "t1");
});

test("Dynamic toggle: 运行时动态开关", () => {
  let directorCalls = 0;
  const director: AllianceDirectorInterface = {
    replan() {
      directorCalls += 1;
      return [makeDirective({ tenantId: "t1", revision: 1, issuedAtTick: 100, expiresAtTick: 250 })];
    },
  };
  const sent: AllianceDirectiveMessage[] = [];
  const callbacks: AllianceDirectorCallbacks = { send(_t, m) { sent.push(m); } };

  const runtime = createSupervisorAllianceDirectorRuntime(director, callbacks);

  // Feed fresh report before each replan
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 100 }));
  // disabled
  runtime.replan(100);
  assert.equal(directorCalls, 0);

  // enable — feed fresh report
  runtime.enabled = true;
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 200 }));
  runtime.replan(200);
  assert.equal(directorCalls, 1);
  assert.equal(sent.length, 1);

  // disable again
  runtime.enabled = false;
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 300 }));
  runtime.replan(300);
  assert.equal(directorCalls, 1, "disabled again, no more calls");
  assert.equal(sent.length, 1);
});

// ═══════════════════════════════════════════════════════════════
// Director fault isolation
// ═══════════════════════════════════════════════════════════════

test("Fault: director throws → 记录 errorCount，不抛到调用方", () => {
  let calls = 0;
  const director: AllianceDirectorInterface = {
    replan() {
      calls += 1;
      throw new Error("simulated director crash");
    },
  };
  const sent: AllianceDirectiveMessage[] = [];
  const callbacks: AllianceDirectorCallbacks = { send(_t, m) { sent.push(m); } };

  const runtime = createSupervisorAllianceDirectorRuntime(director, callbacks, { enabled: true });
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 100 }));

  // Must not throw
  assert.doesNotThrow(() => runtime.replan(100));
  assert.equal(calls, 1);
  assert.equal(sent.length, 0);
  assert.equal(runtime.stats().directorErrorCount, 1);
});

test("Fault: director throw 后下一周期可继续", () => {
  let shouldThrow = true;
  const director: AllianceDirectorInterface = {
    replan() {
      if (shouldThrow) throw new Error("crash");
      return [makeDirective({ tenantId: "t1", revision: 1, issuedAtTick: 140, expiresAtTick: 250 })];
    },
  };
  const sent: AllianceDirectiveMessage[] = [];
  const callbacks: AllianceDirectorCallbacks = { send(_t, m) { sent.push(m); } };

  const runtime = createSupervisorAllianceDirectorRuntime(director, callbacks, { enabled: true });

  // First replan: director throws（fresh report 需要靠近 replan tick）
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 100 }));
  runtime.replan(100);
  assert.equal(runtime.stats().directorErrorCount, 1);
  assert.equal(sent.length, 0);

  // Second replan: director recovers（更新 report 保持新鲜）
  shouldThrow = false;
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 150 }));
  runtime.replan(150);
  assert.equal(runtime.stats().directorErrorCount, 1); // no new error
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tenantId, "t1");
});

test("Fault: director returns invalid directive → skip + record rejected ack", () => {
  const director: AllianceDirectorInterface = {
    replan() {
      return [
        // Valid
        makeDirective({ tenantId: "t1", revision: 1, issuedAtTick: 98, expiresAtTick: 250 }),
        // Invalid: empty missionRefs
        makeDirective({ tenantId: "t1", revision: 2, missionRefs: [], issuedAtTick: 98, expiresAtTick: 250 }),
      ];
    },
  };
  const sent: AllianceDirectiveMessage[] = [];
  const callbacks: AllianceDirectorCallbacks = { send(_t, m) { sent.push(m); } };

  const runtime = createSupervisorAllianceDirectorRuntime(director, callbacks, { enabled: true });
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 100 }));
  runtime.replan(100);

  // Only valid directive sent
  assert.equal(sent.length, 1);
  assert.equal(sent[0].revision, 1);

  // Check ack records: valid → sent, invalid → rejected
  const stats = runtime.stats();
  const sentAck = stats.ackRecords.find((r) => r.revision === 1);
  assert.ok(sentAck !== undefined);
  assert.equal(sentAck!.state, "sent");

  const rejectedAck = stats.ackRecords.find((r) => r.revision === 2);
  assert.ok(rejectedAck !== undefined);
  assert.equal(rejectedAck!.state, "rejected");
});

// ═══════════════════════════════════════════════════════════════
// Tenant isolation — send failure / disconnected
// ═══════════════════════════════════════════════════════════════

test("Isolation: 单个 tenant send 失败不影响其他 tenant", () => {
  const director: AllianceDirectorInterface = {
    replan() {
      return [
        makeDirective({ tenantId: "t1", revision: 1, issuedAtTick: 98, expiresAtTick: 250 }),
        makeDirective({ tenantId: "t2", revision: 1, issuedAtTick: 98, expiresAtTick: 250 }),
        makeDirective({ tenantId: "t3", revision: 1, issuedAtTick: 98, expiresAtTick: 250 }),
      ];
    },
  };
  const sent: AllianceDirectiveMessage[] = [];
  const callbacks: AllianceDirectorCallbacks = {
    send(tenantId, msg) {
      if (tenantId === "t2") throw new Error("t2 disconnected");
      sent.push(msg);
    },
  };

  const runtime = createSupervisorAllianceDirectorRuntime(director, callbacks, { enabled: true });
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 100 }));
  runtime.onMemberReport(makeReport({ tenantId: "t2", tick: 100 }));
  runtime.onMemberReport(makeReport({ tenantId: "t3", tick: 100 }));

  assert.doesNotThrow(() => runtime.replan(100));

  // t1 and t3 should be sent
  assert.equal(sent.length, 2);
  const sentTenants = sent.map((m) => m.tenantId).sort();
  assert.deepEqual(sentTenants, ["t1", "t3"]);

  // sendErrorCount recorded
  assert.equal(runtime.stats().sendErrorCount, 1);
});

test("Isolation: missing tenant report 不阻塞其他 tenant", () => {
  const director: AllianceDirectorInterface = {
    replan(_reports) {
      // Returns directives for all members in the snapshot
      const result: AllianceDirective[] = [];
      for (const [tid] of _reports) {
        result.push(makeDirective({ tenantId: tid, revision: 1, issuedAtTick: 98, expiresAtTick: 250 }));
      }
      return result;
    },
  };
  const sent: AllianceDirectiveMessage[] = [];
  const callbacks: AllianceDirectorCallbacks = { send(_t, m) { sent.push(m); } };

  const runtime = createSupervisorAllianceDirectorRuntime(director, callbacks, { enabled: true });
  // Only t1 and t3 report; t2 is missing（reports 靠近 replan tick 以保持新鲜）
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 100 }));
  runtime.onMemberReport(makeReport({ tenantId: "t3", tick: 100 }));
  runtime.replan(100);

  // Both t1 and t3 get directives
  const sentTenants = sent.map((m) => m.tenantId).sort();
  assert.deepEqual(sentTenants, ["t1", "t3"]);
});

// ═══════════════════════════════════════════════════════════════
// Member report freshness
// ═══════════════════════════════════════════════════════════════

test("Freshness: stale report 被排除出 snapshot", () => {
  const reportsSeen: string[] = [];
  const director: AllianceDirectorInterface = {
    replan(reports) {
      for (const [tid] of reports) reportsSeen.push(tid);
      return [];
    },
  };
  const callbacks: AllianceDirectorCallbacks = { send() {} };

  const runtime = createSupervisorAllianceDirectorRuntime(director, callbacks, { enabled: true });
  // Fresh report
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 100 }));
  // Stale report (tick=90, currentTick=100, diff=10 > DEFAULT_REPORT_STALE_TICKS=8)
  runtime.onMemberReport(makeReport({ tenantId: "t2", tick: 90 }));

  runtime.replan(100);

  assert.ok(reportsSeen.includes("t1"), "fresh t1 must be included");
  assert.ok(!reportsSeen.includes("t2"), "stale t2 must be excluded");
});

test("Freshness: 自定义 maxReportAgeTicks", () => {
  const reportsSeen: string[] = [];
  const director: AllianceDirectorInterface = {
    replan(reports) {
      for (const [tid] of reports) reportsSeen.push(tid);
      return [];
    },
  };
  const callbacks: AllianceDirectorCallbacks = { send() {} };

  // maxReportAgeTicks=20, so tick 90 is fresh at tick 100 (diff=10 ≤ 20)
  const runtime = createSupervisorAllianceDirectorRuntime(director, callbacks, {
    enabled: true,
    maxReportAgeTicks: 20,
  });
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 100 }));
  runtime.onMemberReport(makeReport({ tenantId: "t2", tick: 90 }));
  runtime.replan(100);

  assert.ok(reportsSeen.includes("t1"));
  assert.ok(reportsSeen.includes("t2"), "t2 should be fresh with larger maxReportAgeTicks");
});

test("Freshness: 所有 reports stale → 空 snapshot → 不调用 director，不 send", () => {
  let directorCalls = 0;
  const director: AllianceDirectorInterface = {
    replan() { directorCalls += 1; return [makeDirective()]; },
  };
  const sent: AllianceDirectiveMessage[] = [];
  const callbacks: AllianceDirectorCallbacks = { send(_t, m) { sent.push(m); } };

  const runtime = createSupervisorAllianceDirectorRuntime(director, callbacks, { enabled: true });
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 80 })); // stale at tick 100

  runtime.replan(100);
  // 空 fresh snapshot → early return，不调用 director
  assert.equal(directorCalls, 0);
  assert.equal(sent.length, 0);
});

// ═══════════════════════════════════════════════════════════════
// Deterministic tenant ordering
// ═══════════════════════════════════════════════════════════════

test("Ordering: memberTenants 排序 deterministic（字典序）", () => {
  const director: AllianceDirectorInterface = { replan() { return []; } };
  const callbacks: AllianceDirectorCallbacks = { send() {} };

  const runtime = createSupervisorAllianceDirectorRuntime(director, callbacks);
  // Insert in non-sorted order
  runtime.onMemberReport(makeReport({ tenantId: "t3", tick: 100 }));
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 100 }));
  runtime.onMemberReport(makeReport({ tenantId: "t4", tick: 100 }));
  runtime.onMemberReport(makeReport({ tenantId: "t2", tick: 100 }));

  const tenants = runtime.stats().memberTenants;
  assert.deepEqual(tenants, ["t1", "t2", "t3", "t4"]);
});

test("Ordering: 泛型 tenant——字典序对任意 ID 一致", () => {
  const director: AllianceDirectorInterface = { replan() { return []; } };
  const callbacks: AllianceDirectorCallbacks = { send() {} };

  const runtime = createSupervisorAllianceDirectorRuntime(director, callbacks);
  runtime.onMemberReport(makeReport({ tenantId: "zebra", tick: 100 }));
  runtime.onMemberReport(makeReport({ tenantId: "alpha", tick: 100 }));
  runtime.onMemberReport(makeReport({ tenantId: "beta-2", tick: 100 }));
  runtime.onMemberReport(makeReport({ tenantId: "beta-10", tick: 100 }));

  const tenants = runtime.stats().memberTenants;
  // 字典序："alpha" < "beta-10" < "beta-2" < "zebra"
  assert.deepEqual(tenants, ["alpha", "beta-10", "beta-2", "zebra"]);
});

// ═══════════════════════════════════════════════════════════════
// Ack revision monotonic
// ═══════════════════════════════════════════════════════════════

test("Ack: sent → accepted 正常转换", () => {
  const director: AllianceDirectorInterface = { replan() { return []; } };
  const sent: AllianceDirectiveMessage[] = [];
  const callbacks: AllianceDirectorCallbacks = { send(_t, m) { sent.push(m); } };
  const runtime = createSupervisorAllianceDirectorRuntime(director, callbacks, { enabled: true });
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 50 }));

  // Send a directive
  const directive = makeDirective({ tenantId: "t1", revision: 1, issuedAtTick: 50, expiresAtTick: 250 });
  const dir: AllianceDirectorInterface = {
    replan() { return [directive]; },
  };
  const runtime2 = createSupervisorAllianceDirectorRuntime(dir, callbacks, { enabled: true });
  runtime2.onMemberReport(makeReport({ tenantId: "t1", tick: 50 }));
  runtime2.replan(100);

  // Simulate child ack: accepted
  runtime2.onAck("t1", 1, "accepted", 105);
  const stats = runtime2.stats();
  const ack = stats.ackRecords.find((r) => r.tenantId === "t1" && r.revision === 1);
  assert.ok(ack !== undefined);
  assert.equal(ack!.state, "accepted");
});

test("Ack: 旧 revision ack 不倒退当前状态", () => {
  const runtime = createSupervisorAllianceDirectorRuntime(
    { replan() { return []; } },
    { send() {} },
  );

  // Record ack for revision 5 at state "accepted"
  runtime.onAck("t1", 5, "accepted", 100);
  assert.equal(runtime.stats().ackRecords.find((r) => r.revision === 5)?.state, "accepted");

  // Try to regress with old revision 3
  runtime.onAck("t1", 3, "ignored", 90);
  // Revision 5 should still be "accepted"
  const ack = runtime.stats().ackRecords.find((r) => r.revision === 5);
  assert.equal(ack!.state, "accepted");

  assert.equal(runtime.stats().ackRecords.some((r) => r.revision === 3), false);
});

test("Ack: 同 revision accepted → ignored 不退倒", () => {
  const runtime = createSupervisorAllianceDirectorRuntime(
    { replan() { return []; } },
    { send() {} },
  );

  runtime.onAck("t1", 1, "accepted", 100);
  // Try to downgrade to ignored
  runtime.onAck("t1", 1, "ignored", 101, "retry");
  // Should stay "accepted"
  assert.equal(runtime.stats().ackRecords.find((r) => r.revision === 1)?.state, "accepted");
});

test("Ack: 同 revision rejected → accepted 不退倒", () => {
  const runtime = createSupervisorAllianceDirectorRuntime(
    { replan() { return []; } },
    { send() {} },
  );

  runtime.onAck("t1", 1, "rejected", 100, "invalid");
  runtime.onAck("t1", 1, "accepted", 101);
  // Should stay "rejected"
  assert.equal(runtime.stats().ackRecords.find((r) => r.revision === 1)?.state, "rejected");
});

test("Ack: internal sent 不计 child ack，随后 rejected 可终结 revision", () => {
  const directive = makeDirective({ tenantId: "t1", revision: 1, issuedAtTick: 100, expiresAtTick: 200 });
  const runtime = createSupervisorAllianceDirectorRuntime(
    { replan() { return [directive]; } },
    { send() {} },
    { enabled: true },
  );
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 100 }));
  runtime.replan(100);

  assert.equal(runtime.stats().ackCount, 0);
  assert.equal(runtime.stats().ackRecords.find((r) => r.revision === 1)?.state, "sent");

  runtime.onAck("t1", 1, "rejected", 101, "invalid directive");
  assert.equal(runtime.stats().ackCount, 1);
  assert.equal(runtime.stats().ackRecords.find((r) => r.revision === 1)?.state, "rejected");

  runtime.onAck("t1", 1, "accepted", 102);
  assert.equal(runtime.stats().ackCount, 2);
  assert.equal(runtime.stats().ackRecords.find((r) => r.revision === 1)?.state, "rejected");
});

test("Ack: 新 revision → 总是接受", () => {
  const runtime = createSupervisorAllianceDirectorRuntime(
    { replan() { return []; } },
    { send() {} },
  );

  runtime.onAck("t1", 1, "accepted", 100);
  runtime.onAck("t1", 2, "ignored", 105);
  runtime.onAck("t1", 2, "ignored", 106, "expired");

  assert.equal(runtime.stats().ackRecords.find((r) => r.revision === 1)?.state, "accepted");
  assert.equal(runtime.stats().ackRecords.find((r) => r.revision === 2)?.state, "ignored");
});

test("Ack: ackCount 正确累计", () => {
  const runtime = createSupervisorAllianceDirectorRuntime(
    { replan() { return []; } },
    { send() {} },
  );

  assert.equal(runtime.stats().ackCount, 0);
  runtime.onAck("t1", 1, "accepted", 100);
  assert.equal(runtime.stats().ackCount, 1);
  runtime.onAck("t1", 1, "accepted", 101); // same revision, no update but still counted
  assert.equal(runtime.stats().ackCount, 2);
  runtime.onAck("t2", 1, "ignored", 100, "stale");
  assert.equal(runtime.stats().ackCount, 3);
});

test("Ack: ackRecords 上限截断", () => {
  const runtime = createSupervisorAllianceDirectorRuntime(
    { replan() { return []; } },
    { send() {} },
    { maxAckRecords: 3 },
  );

  runtime.onAck("t1", 1, "accepted", 100);
  runtime.onAck("t1", 2, "accepted", 101);
  runtime.onAck("t1", 3, "accepted", 102);
  assert.equal(runtime.stats().ackRecords.length, 3);

  runtime.onAck("t1", 4, "accepted", 103);
  assert.equal(runtime.stats().ackRecords.length, 3);
  // Oldest (rev 1) should be evicted
  assert.equal(runtime.stats().ackRecords[0].revision, 2);
});

// ═══════════════════════════════════════════════════════════════
// Runtime stats correctness
// ═══════════════════════════════════════════════════════════════

test("Stats: 初始 stats 正确", () => {
  const runtime = createSupervisorAllianceDirectorRuntime(
    { replan() { return []; } },
    { send() {} },
  );
  const s = runtime.stats();
  assert.equal(s.reportCount, 0);
  assert.equal(s.directiveSentCount, 0);
  assert.equal(s.ackCount, 0);
  assert.equal(s.directorErrorCount, 0);
  assert.equal(s.sendErrorCount, 0);
  assert.equal(s.lastReplanTick, -1);
  assert.equal(s.enabled, false);
  assert.deepEqual(s.memberTenants, []);
  assert.deepEqual(s.ackRecords, []);
});

test("Stats: reportCount 随 onMemberReport 增加", () => {
  const runtime = createSupervisorAllianceDirectorRuntime(
    { replan() { return []; } },
    { send() {} },
  );
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 100 }));
  runtime.onMemberReport(makeReport({ tenantId: "t2", tick: 100 }));
  assert.equal(runtime.stats().reportCount, 2);
});

test("Stats: lastReplanTick 正确更新", () => {
  const director: AllianceDirectorInterface = { replan() { return []; } };
  const runtime = createSupervisorAllianceDirectorRuntime(director, { send() {} }, { enabled: true });
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 50 }));
  runtime.replan(42);
  assert.equal(runtime.stats().lastReplanTick, 42);
  runtime.replan(100);
  assert.equal(runtime.stats().lastReplanTick, 100);
});

test("Stats: disabled 时不更新 lastReplanTick", () => {
  const director: AllianceDirectorInterface = { replan() { return []; } };
  const runtime = createSupervisorAllianceDirectorRuntime(director, { send() {} });
  runtime.replan(42);
  assert.equal(runtime.stats().lastReplanTick, -1);
});

// ═══════════════════════════════════════════════════════════════
// Integration-style: end-to-end shadow flow
// ═══════════════════════════════════════════════════════════════

test("E2E: 完整 shadow flow——report → replan → send → ack", () => {
  const sent: AllianceDirectiveMessage[] = [];
  const callbacks: AllianceDirectorCallbacks = { send(_t, m) { sent.push(m); } };
  const director: AllianceDirectorInterface = {
    replan(reports) {
      const result: AllianceDirective[] = [];
      for (const [tid] of reports) {
        result.push(makeDirective({
          tenantId: tid,
          revision: 1,
          issuedAtTick: 48,
          expiresAtTick: 250,
        }));
      }
      return result;
    },
  };

  const runtime = createSupervisorAllianceDirectorRuntime(director, callbacks, { enabled: true });

  // Feed reports from 3 tenants（tick 靠近 replan tick 保持新鲜）
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 50 }));
  runtime.onMemberReport(makeReport({ tenantId: "t2", tick: 50 }));
  runtime.onMemberReport(makeReport({ tenantId: "t3", tick: 50 }));

  // Replan
  runtime.replan(50);
  assert.equal(sent.length, 3);
  const tenants = sent.map((m) => m.tenantId).sort();
  assert.deepEqual(tenants, ["t1", "t2", "t3"]);

  // Children ack
  runtime.onAck("t1", 1, "accepted", 55);
  runtime.onAck("t2", 1, "ignored", 55, "expired");
  runtime.onAck("t3", 1, "accepted", 55);

  const stats = runtime.stats();
  assert.equal(stats.directiveSentCount, 3);
  assert.equal(stats.ackCount, 3);
});

test("E2E: multi-cycle replan with revision advancement", () => {
  const sent: AllianceDirectiveMessage[] = [];
  const callbacks: AllianceDirectorCallbacks = { send(_t, m) { sent.push(m); } };
  let rev = 0;
  const director: AllianceDirectorInterface = {
    replan() {
      rev += 1;
      return [makeDirective({ tenantId: "t1", revision: rev, issuedAtTick: 98, expiresAtTick: 250 })];
    },
  };

  const runtime = createSupervisorAllianceDirectorRuntime(director, callbacks, { enabled: true });

  // Feed fresh report before each replan
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 100 }));
  runtime.replan(100);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].revision, 1);

  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 200 }));
  runtime.replan(200);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].revision, 2);

  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 300 }));
  runtime.replan(300);
  assert.equal(sent.length, 3);
  assert.equal(sent[2].revision, 3);
});

// ═══════════════════════════════════════════════════════════════
// 合同层不变量验证
// ═══════════════════════════════════════════════════════════════

test("合同层不变量: runtime primitives 不含 Arena token/Plan/CandidateSink", () => {
  // DirectiveInbox 只返回 AllianceDirective | undefined
  const inbox = createDirectiveInbox("t1");
  inbox.accept(makeDirective({ revision: 1, issuedAtTick: 148, expiresAtTick: 200 }), 150);
  const current = inbox.current(150);
  assert.ok(current !== undefined);
  assert.ok(!("token" in current));
  assert.ok(!("plan" in current));
  assert.ok(!("submit" in current));

  // IPC messages 不含 token
  const memberMsg = createMemberMessage(makeReport());
  assert.ok(!("token" in memberMsg));

  const dirMsg = createDirectiveMessage(makeDirective(), 100);
  assert.ok(!("token" in dirMsg));

  const ackMsg = createAckMessage("t1", 100, 1, "accepted");
  assert.ok(!("token" in ackMsg));
});

test("合同层不变量: runtime 不硬编码 t1-t4", () => {
  // All factories accept arbitrary tenantId strings
  const inbox = createDirectiveInbox("any-tenant");
  assert.equal(inbox.accept(makeDirective({ tenantId: "any-tenant", revision: 1, issuedAtTick: 100, expiresAtTick: 200 }), 100).accepted, true);

  const memberMsg = createMemberMessage(makeReport({ tenantId: "custom-42" }));
  assert.equal(memberMsg.tenantId, "custom-42");

  const ackMsg = createAckMessage("arbitrary-id", 100, 5, "accepted");
  assert.equal(ackMsg.tenantId, "arbitrary-id");
});
// ═══════════════════════════════════════════════════════════════
// Phase 3a hardening regressions
// ═══════════════════════════════════════════════════════════════

test("IPC guard: schema version mismatch is rejected", () => {
  const member = { ...createMemberMessage(makeReport()), schemaVersion: ALLIANCE_IPC_SCHEMA_VERSION + 1 };
  const directive = { ...createDirectiveMessage(makeDirective(), 100), schemaVersion: ALLIANCE_IPC_SCHEMA_VERSION + 1 };
  const ack = { ...createAckMessage("t1", 100, 1, "accepted"), schemaVersion: ALLIANCE_IPC_SCHEMA_VERSION + 1 };
  assert.equal(isAllianceMemberMessage(member), false);
  assert.equal(isAllianceDirectiveMessage(directive), false);
  assert.equal(isAllianceAckMessage(ack), false);
});

test("IPC guard: member envelope must match report tenant/tick", () => {
  const valid = createMemberMessage(makeReport({ tenantId: "t1", tick: 100 }));
  assert.equal(isAllianceMemberMessage({ ...valid, tenantId: "t2" }), false);
  assert.equal(isAllianceMemberMessage({ ...valid, tick: 101 }), false);
});

test("IPC guard: directive envelope must match payload tenant/revision", () => {
  const valid = createDirectiveMessage(makeDirective({ tenantId: "t1", revision: 7 }), 100);
  assert.equal(isAllianceDirectiveMessage({ ...valid, tenantId: "t2" }), false);
  assert.equal(isAllianceDirectiveMessage({ ...valid, revision: 8 }), false);
});

test("Inbox: stale/expired/pending directives are rejected before storage", () => {
  const staleInbox = createDirectiveInbox("t1");
  const stale = staleInbox.accept(makeDirective({ revision: 9, issuedAtTick: 100, expiresAtTick: 250 }), 150);
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, "stale");
  assert.equal(staleInbox.hasDirective, false);
  assert.equal(staleInbox.lastRevision, -1);

  const expiredInbox = createDirectiveInbox("t1");
  const expired = expiredInbox.accept(makeDirective({ revision: 10, issuedAtTick: 100, expiresAtTick: 200 }), 201);
  assert.equal(expired.accepted, false);
  assert.equal(expired.reason, "expired");
  assert.equal(expiredInbox.hasDirective, false);

  const pendingInbox = createDirectiveInbox("t1");
  const pending = pendingInbox.accept(makeDirective({ revision: 11, issuedAtTick: 100, expiresAtTick: 200 }), 99);
  assert.equal(pending.accepted, false);
  assert.equal(pending.reason, "pending");
  assert.equal(pendingInbox.hasDirective, false);
});

test("Runtime: malformed non-array director output fails open", () => {
  const director: AllianceDirectorInterface = {
    replan() {
      return { bad: true } as unknown as readonly AllianceDirective[];
    },
  };
  const sent: AllianceDirectiveMessage[] = [];
  const runtime = createSupervisorAllianceDirectorRuntime(
    director,
    { send(_tenantId, message) { sent.push(message); } },
    { enabled: true },
  );
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 100 }));
  assert.doesNotThrow(() => runtime.replan(100));
  assert.equal(sent.length, 0);
  assert.equal(runtime.stats().invalidOutputCount, 1);
});

test("Runtime: director output is sent in deterministic tenant/revision order", () => {
  const sent: Array<[string, number]> = [];
  const runtime = createSupervisorAllianceDirectorRuntime(
    {
      replan() {
        return [
          makeDirective({ tenantId: "t2", revision: 3, issuedAtTick: 100, expiresAtTick: 200 }),
          makeDirective({ tenantId: "t1", revision: 5, issuedAtTick: 100, expiresAtTick: 200 }),
          makeDirective({ tenantId: "t1", revision: 2, issuedAtTick: 100, expiresAtTick: 200 }),
        ];
      },
    },
    { send(tenantId, message) { sent.push([tenantId, message.revision]); } },
    { enabled: true },
  );
  runtime.onMemberReport(makeReport({ tenantId: "t2", tick: 100 }));
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 100 }));
  runtime.replan(100);
  assert.deepEqual(sent, [["t1", 2], ["t1", 5], ["t2", 3]]);
});

test("Runtime: same-tick member report is deterministic first-wins", () => {
  let seenResources = -1;
  const runtime = createSupervisorAllianceDirectorRuntime(
    {
      replan(reports) {
        seenResources = reports.get("t1")?.resources ?? -1;
        return [];
      },
    },
    { send() {} },
    { enabled: true },
  );
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 100, resources: 10, observedAtMs: 100 }));
  runtime.onMemberReport(makeReport({ tenantId: "t1", tick: 100, resources: 999, observedAtMs: 101 }));
  runtime.replan(100);
  assert.equal(seenResources, 10);
});

test("Runtime: older revision child ACK is not recorded after newer revision", () => {
  const runtime = createSupervisorAllianceDirectorRuntime(
    { replan() { return []; } },
    { send() {} },
  );
  runtime.onAck("t1", 7, "accepted", 107);
  runtime.onAck("t1", 5, "ignored", 105, "late old ack");
  assert.equal(runtime.stats().ackRecords.some((r) => r.tenantId === "t1" && r.revision === 5), false);
  assert.equal(runtime.stats().ackRecords.find((r) => r.tenantId === "t1" && r.revision === 7)?.state, "accepted");
});
