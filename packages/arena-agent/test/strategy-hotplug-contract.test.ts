/**
 * HotPlugContract 集成测试（v1，2026-08-08）。
 *
 * 覆盖：createHotPlugContract / activateAndResolve / rollback / validate /
 * registerPolicy / merge 正确性。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createHotPlugContract } from "../src/strategy-hotplug/contract.ts";
import type { StrategyComponent } from "../src/strategy-hotplug/types.ts";

// ---- Helpers ----

function makeComponent(
  id: string,
  overrides: {
    provides?: string[];
    requires?: string[];
    conflicts?: string[];
    config?: Record<string, unknown>;
  } = {},
): StrategyComponent {
  return {
    id,
    release: { version: "1.0.0", hash: `sha256:test-${id}` },
    description: `Test ${id}`,
    constraint: {
      provides: overrides.provides ?? [],
      requires: overrides.requires ?? [],
      conflicts: overrides.conflicts ?? [],
    },
    config: overrides.config ?? {},
    rollback: {},
  };
}

// ---- Factory ----

test("createHotPlugContract returns contract with all expected methods", () => {
  const contract = createHotPlugContract();
  assert.equal(typeof contract.register, "function");
  assert.equal(typeof contract.activate, "function");
  assert.equal(typeof contract.activateAndResolve, "function");
  assert.equal(typeof contract.deactivate, "function");
  assert.equal(typeof contract.rollback, "function");
  assert.equal(typeof contract.validate, "function");
  assert.equal(typeof contract.snapshot, "function");
  assert.ok(Array.isArray(contract.activeIds));
  assert.ok(Array.isArray(contract.registeredIds));
});

// ---- activateAndResolve ----

test("activateAndResolve returns merged config on success", () => {
  const contract = createHotPlugContract();
  contract.register(makeComponent("a-v1", { config: { flagA: true, shared: "a" } }));
  contract.register(makeComponent("b-v1", { config: { flagB: true, shared: "b" } }));

  const merged = contract.activateAndResolve(["a-v1", "b-v1"]);
  assert.notEqual(merged, undefined);
  assert.equal(merged!.flagA, true);
  assert.equal(merged!.flagB, true);
  // later component wins on conflict (b overrides a)
  assert.equal(merged!.shared, "b");
});

test("activateAndResolve returns undefined on failure", () => {
  const contract = createHotPlugContract();
  contract.register(makeComponent("a-v1", { conflicts: ["b-v1"] }));
  contract.register(makeComponent("b-v1", { conflicts: ["a-v1"] }));

  const merged = contract.activateAndResolve(["a-v1", "b-v1"]);
  assert.equal(merged, undefined);
});

// ---- Custom merge ----

test("custom mergeConfig is used when provided", () => {
  const contract = createHotPlugContract<{ sum: number; ids: string[] }>({
    mergeConfig: (components) => ({
      sum: components.length,
      ids: components.map((c) => c.id),
    }),
  });
  contract.register(makeComponent("a-v1"));
  contract.register(makeComponent("b-v1"));

  const merged = contract.activateAndResolve(["a-v1", "b-v1"]);
  assert.notEqual(merged, undefined);
  assert.equal(merged!.sum, 2);
  assert.deepEqual(merged!.ids, ["a-v1", "b-v1"]);
});

// ---- Rollback cycle ----

test("activate → bad activate → rollback restores config", () => {
  const contract = createHotPlugContract();
  contract.register(makeComponent("a-v1", { config: { flag: true } }));
  contract.register(makeComponent("b-v1", { config: { other: 42 } }));

  // Establish good state
  const good = contract.activateAndResolve(["a-v1"]);
  assert.notEqual(good, undefined);
  assert.equal(good!.flag, true);

  // Attempt bad activation (unknown component)
  contract.activate(["unknown-v1"]);

  // Rollback
  const rollbackResult = contract.rollback();
  assert.equal(rollbackResult.success, true);

  // Verify restored
  const restored = contract.activateAndResolve(["a-v1"]);
  assert.notEqual(restored, undefined);
  assert.equal(restored!.flag, true);
});

// ---- registerPolicy ----

test("registerPolicy validates component references", () => {
  const contract = createHotPlugContract();
  contract.register(makeComponent("a-v1"));
  contract.register(makeComponent("b-v1"));

  // Should not throw: all components registered
  contract.registerPolicy({
    name: "my-policy",
    description: "test policy",
    components: ["a-v1", "b-v1"],
  });
});

test("registerPolicy throws on unknown component reference", () => {
  const contract = createHotPlugContract();
  contract.register(makeComponent("a-v1"));

  assert.throws(
    () =>
      contract.registerPolicy({
        name: "bad-policy",
        description: "references unknown component",
        components: ["a-v1", "unknown-v1"],
      }),
    /unregistered component/,
  );
});

// ---- validate (dry-run) ----

test("validate does not modify active set", () => {
  const contract = createHotPlugContract();
  contract.register(makeComponent("a-v1"));
  contract.activate(["a-v1"]);

  const before = contract.snapshot();
  const report = contract.validate(["a-v1"]);
  const after = contract.snapshot();

  assert.equal(report.valid, true);
  assert.deepEqual(before.activeIds, after.activeIds);
});

// ---- Deterministic behavior ----

test("snapshot configHash is deterministic for same state", () => {
  const createAndSnapshot = (): string => {
    const contract = createHotPlugContract();
    contract.register(makeComponent("a-v1", { config: { x: 1 } }));
    contract.activate(["a-v1"]);
    return contract.snapshot().configHash;
  };

  const h1 = createAndSnapshot();
  const h2 = createAndSnapshot();
  assert.equal(h1, h2);
});
