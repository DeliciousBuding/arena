/**
 * command-plane v1 纯函数测试（2026-08-08）：
 *  - protocol.validateIntent：schema 校验（target/phases/force 理由）
 *  - guardrails.runGuardrails：敌核贴脸/弃富投贫/信标禁区/双写保护
 *  - guardrails.checkUnitCapability：单位能力匹配
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateIntent, type Intent } from "../src/command-plane/protocol.ts";
import { runGuardrails, checkUnitCapability, type GuardrailContext } from "../src/command-plane/guardrails.ts";

function baseIntent(over: Partial<Intent> = {}): Intent {
  return {
    schemaVersion: 1,
    issuer: "codex",
    sessionId: "sess-test",
    intentId: "intent-test-1",
    spec: { kind: "core_migrate", target: [-600, -145], phases: [[-600, -145]] },
    createdAt: "2026-08-08T00:00:00Z",
    ...over,
  };
}

function ctx(over: Partial<GuardrailContext> = {}): GuardrailContext {
  return {
    tenant: "t1",
    currentTick: 72000,
    enemyCores: [],
    resources: [],
    active: { activeCount: 0, activeIntentIds: [] },
    ...over,
  };
}

test("validateIntent: 合法意图通过", () => {
  assert.deepEqual(validateIntent(baseIntent()), []);
});

test("validateIntent: 非法 target 拒绝", () => {
  const bad = baseIntent({ spec: { kind: "core_migrate", target: [1] as unknown as [number, number], phases: [[1]] as unknown as [number, number][] } });
  const errs = validateIntent(bad);
  assert.ok(errs.some((e) => e.includes("target")));
});

test("validateIntent: core_migrate phases 末段必须等于 target", () => {
  const bad = baseIntent({ spec: { kind: "core_migrate", target: [-600, -145], phases: [[-610, -145]] } });
  assert.ok(validateIntent(bad).some((e) => e.includes("phases")));
});

test("validateIntent: force 必须带 reason", () => {
  const bad = baseIntent({ constraints: { force: true } });
  assert.ok(validateIntent(bad).some((e) => e.includes("forceReason")));
});

test("guardrails: 无威胁目标通过", () => {
  // 目标 30 格内 8 个新鲜资源 + 无敌核 -> 通过
  const fresh = Array.from({ length: 8 }, (_, i) => ({ x: -600 + i, y: -145, lastSeenTick: 71900 }));
  const c = ctx({ resources: fresh });
  assert.deepEqual(runGuardrails(baseIntent(), c), []);
});

test("guardrails: 活跃敌核贴脸拒绝", () => {
  const c = ctx({
    enemyCores: [{ x: -610, y: -150, lastSeenTick: 71900 }],
  });
  const reasons = runGuardrails(baseIntent({ spec: { kind: "core_migrate", target: [-610, -150], phases: [[-610, -150]] } }), c);
  assert.ok(reasons.some((r) => r.code === "enemy_proximity"));
});

test("guardrails: force+reason 放行敌核贴脸", () => {
  const c = ctx({ enemyCores: [{ x: -610, y: -150, lastSeenTick: 71900 }] });
  const reasons = runGuardrails(
    baseIntent({ constraints: { force: true, forceReason: "战略突围，敌核为旧记忆" }, spec: { kind: "core_migrate", target: [-610, -150], phases: [[-610, -150]] } }),
    c,
  );
  assert.ok(!reasons.some((r) => r.code === "enemy_proximity"));
});

test("guardrails: 弃富投贫拒绝", () => {
  const c = ctx({ resources: [] });
  const reasons = runGuardrails(baseIntent(), c);
  assert.ok(reasons.some((r) => r.code === "resource_poverty"));
});

test("guardrails: 信标禁区不可 force", () => {
  const c = ctx();
  const reasons = runGuardrails(
    baseIntent({ constraints: { force: true, forceReason: "test" }, spec: { kind: "core_migrate", target: [-11, -1], phases: [[-11, -1]] } }),
    c,
  );
  assert.ok(reasons.some((r) => r.code === "beacon_zone"));
});

test("guardrails: 双写保护拒绝（幂等同 id 除外）", () => {
  const fresh = Array.from({ length: 8 }, (_, i) => ({ x: -600 + i, y: -145, lastSeenTick: 71900 }));
  const c = ctx({ resources: fresh, active: { activeCount: 1, activeIntentIds: ["intent-test-1"] } });
  assert.ok(!runGuardrails(baseIntent(), c).some((r) => r.code === "concurrent_intent")); // 幂等
  const other = baseIntent({ intentId: "intent-test-2" });
  assert.ok(runGuardrails(other, c).some((r) => r.code === "concurrent_intent"));
});

test("guardrails: 陈旧敌核（3000 tick 外）不算活跃", () => {
  const c = ctx({ enemyCores: [{ x: -610, y: -150, lastSeenTick: 65000 }] });
  const reasons = runGuardrails(baseIntent({ spec: { kind: "core_migrate", target: [-610, -150], phases: [[-610, -150]] } }), c);
  assert.ok(!reasons.some((r) => r.code === "enemy_proximity"));
});

test("checkUnitCapability: WORKER 不 START_MOVE", () => {
  assert.ok(checkUnitCapability("WORKER", "START_MOVE") !== null);
  assert.equal(checkUnitCapability("WORKER", "DEPOSIT"), null);
  assert.equal(checkUnitCapability("VANGUARD", "SHOOT"), null);
});
