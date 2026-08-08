/**
 * HotPlugRegistry 单元测试（v1，2026-08-08）。
 *
 * 覆盖：注册/重复注册/激活/停用/冲突/回滚/快照/兼容性/确定性。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { HotPlugRegistry } from "../src/strategy-hotplug/registry.ts";
import type { StrategyComponent } from "../src/strategy-hotplug/types.ts";

// ---- Helpers ----

function makeComponent(
  id: string,
  overrides: {
    provides?: string[];
    requires?: string[];
    conflicts?: string[];
    config?: Record<string, unknown>;
    version?: string;
    hash?: string;
  } = {},
): StrategyComponent {
  return {
    id,
    release: {
      version: overrides.version ?? "1.0.0",
      hash: overrides.hash ?? `sha256:test-${id}`,
    },
    description: `Test component ${id}`,
    constraint: {
      provides: overrides.provides ?? [],
      requires: overrides.requires ?? [],
      conflicts: overrides.conflicts ?? [],
    },
    config: overrides.config ?? {},
    rollback: {},
  };
}

// ---- Registration ----

test("register adds component and creates initial state", () => {
  const registry = new HotPlugRegistry();
  const c = makeComponent("test-v1", { provides: ["eco"] });

  registry.register(c);
  assert.equal(registry.has("test-v1"), true);
  assert.equal(registry.registeredIds.includes("test-v1"), true);
  assert.equal(registry.activeComponentIds.length, 0);

  const state = registry.stateOf("test-v1");
  assert.equal(state?.active, false);
  assert.equal(state?.activeHash, null);
  assert.equal(state?.generation, 0);
});

test("register duplicate id throws", () => {
  const registry = new HotPlugRegistry();
  registry.register(makeComponent("dup-v1"));
  assert.throws(() => registry.register(makeComponent("dup-v1")), /already registered/);
});

test("registerAll adds multiple components", () => {
  const registry = new HotPlugRegistry();
  registry.registerAll([
    makeComponent("a-v1"),
    makeComponent("b-v1"),
    makeComponent("c-v1"),
  ]);
  assert.deepEqual(registry.registeredIds, ["a-v1", "b-v1", "c-v1"]);
});

test("registeredIds are sorted", () => {
  const registry = new HotPlugRegistry();
  registry.registerAll([
    makeComponent("z-v1"),
    makeComponent("a-v1"),
    makeComponent("m-v1"),
  ]);
  assert.deepEqual(registry.registeredIds, ["a-v1", "m-v1", "z-v1"]);
});

// ---- Activation ----

test("activate switches active ids atomically", () => {
  const registry = new HotPlugRegistry();
  registry.registerAll([
    makeComponent("a-v1"),
    makeComponent("b-v1"),
  ]);

  const result = registry.activate(["a-v1", "b-v1"]);
  assert.equal(result.success, true);
  assert.deepEqual(registry.activeComponentIds, ["a-v1", "b-v1"]);

  const aState = registry.stateOf("a-v1");
  assert.equal(aState?.active, true);
  assert.equal(aState?.generation, 1);
  assert.equal(aState?.activeHash, "sha256:test-a-v1");
});

test("activate replaces previous active set", () => {
  const registry = new HotPlugRegistry();
  registry.registerAll([
    makeComponent("a-v1"),
    makeComponent("b-v1"),
    makeComponent("c-v1"),
  ]);

  registry.activate(["a-v1", "b-v1"]);
  const result = registry.activate(["c-v1"]);
  assert.equal(result.success, true);
  assert.deepEqual(registry.activeComponentIds, ["c-v1"]);

  // a-v1 should now be inactive
  assert.equal(registry.stateOf("a-v1")?.active, false);
  // c-v1 should be active
  assert.equal(registry.stateOf("c-v1")?.active, true);
});

test("activate with unknown id fails", () => {
  const registry = new HotPlugRegistry();
  registry.register(makeComponent("a-v1"));

  const result = registry.activate(["a-v1", "unknown-v1"]);
  assert.equal(result.success, false);
  assert.equal(result.error?.includes("unknown"), true);
  // active set unchanged
  assert.deepEqual(registry.activeComponentIds, []);
});

test("activate fails on conflict between components", () => {
  const registry = new HotPlugRegistry();
  registry.register(makeComponent("a-v1", { conflicts: ["b-v1"] }));
  registry.register(makeComponent("b-v1", { conflicts: ["a-v1"] }));

  const result = registry.activate(["a-v1", "b-v1"]);
  assert.equal(result.success, false);
  assert.equal(result.conflicts.length > 0, true);
  // active set unchanged
  assert.deepEqual(registry.activeComponentIds, []);
});

test("activate fails on missing capability", () => {
  const registry = new HotPlugRegistry();
  registry.register(makeComponent("a-v1", {
    provides: ["eco"],
    requires: ["military"], // not provided by anyone
  }));

  const result = registry.activate(["a-v1"]);
  assert.equal(result.success, false);
  assert.equal(result.missingCapabilities.length > 0, true);
});

test("activate succeeds when requirement satisfied by another component", () => {
  const registry = new HotPlugRegistry();
  registry.register(makeComponent("base-v1", { provides: ["military"] }));
  registry.register(makeComponent("dep-v1", { requires: ["military"] }));

  const result = registry.activate(["base-v1", "dep-v1"]);
  assert.equal(result.success, true);
  assert.deepEqual(registry.activeComponentIds, ["base-v1", "dep-v1"]);
});

// ---- Deactivation ----

test("deactivate removes from active set", () => {
  const registry = new HotPlugRegistry();
  registry.registerAll([
    makeComponent("a-v1"),
    makeComponent("b-v1"),
  ]);
  registry.activate(["a-v1", "b-v1"]);

  const result = registry.deactivate("a-v1");
  assert.equal(result.success, true);
  assert.deepEqual(registry.activeComponentIds, ["b-v1"]);
  assert.equal(registry.stateOf("a-v1")?.active, false);
});

test("deactivate non-active component is no-op success", () => {
  const registry = new HotPlugRegistry();
  registry.register(makeComponent("a-v1"));

  const result = registry.deactivate("a-v1");
  assert.equal(result.success, true);
});

// ---- Rollback ----

test("rollback restores last-good snapshot", () => {
  const registry = new HotPlugRegistry();
  registry.registerAll([
    makeComponent("a-v1"),
    makeComponent("b-v1"),
    makeComponent("c-v1"),
  ]);

  // Establish last-good: [a, b]
  registry.activate(["a-v1", "b-v1"]);
  const goodSnapshot = registry.lastGood;
  assert.notEqual(goodSnapshot, null);
  assert.deepEqual(goodSnapshot!.activeIds, ["a-v1", "b-v1"]);

  // Activate [c] (changes state)
  registry.activate(["c-v1"]);
  assert.deepEqual(registry.activeComponentIds, ["c-v1"]);

  // Rollback
  const rollbackResult = registry.rollback();
  assert.equal(rollbackResult.success, true);
  assert.deepEqual(registry.activeComponentIds, ["a-v1", "b-v1"]);
});

test("rollback with no last-good activates empty set", () => {
  const registry = new HotPlugRegistry();
  registry.register(makeComponent("a-v1"));

  // Never activated → no last-good
  const result = registry.rollback();
  assert.equal(result.success, true);
  assert.deepEqual(registry.activeComponentIds, []);
});

// ---- Snapshot ----

test("takeSnapshot captures current state", () => {
  const registry = new HotPlugRegistry();
  registry.registerAll([
    makeComponent("a-v1", { config: { flag: true } }),
    makeComponent("b-v1"),
  ]);
  registry.activate(["a-v1"]);

  const snapshot = registry.takeSnapshot();
  assert.equal(typeof snapshot.at, "number");
  assert.deepEqual(snapshot.activeIds, ["a-v1"]);
  assert.equal(snapshot.states["a-v1"]?.active, true);
  assert.equal(snapshot.states["b-v1"]?.active, false);
  assert.equal(typeof snapshot.configHash, "string");
  assert.ok(snapshot.configHash.length > 0);
});

test("snapshot is immutable after freeze", () => {
  const registry = new HotPlugRegistry();
  registry.register(makeComponent("a-v1"));
  registry.activate(["a-v1"]);

  const snapshot = registry.takeSnapshot();
  assert.throws(() => {
    (snapshot as unknown as { activeIds: string[] }).activeIds = ["x"];
  }, TypeError);
});

// ---- Compatibility Validation ----

test("validateCompatibility returns valid for compatible set", () => {
  const registry = new HotPlugRegistry();
  registry.registerAll([
    makeComponent("a-v1", { provides: ["eco"] }),
    makeComponent("b-v1", { provides: ["military"] }),
  ]);

  const report = registry.validateCompatibility(["a-v1", "b-v1"]);
  assert.equal(report.valid, true);
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(report.missingCapabilities, []);
});

test("validateCompatibility detects missing capability from known components", () => {
  const registry = new HotPlugRegistry();
  registry.register(makeComponent("a-v1", { requires: ["military"] }));

  const report = registry.validateCompatibility(["a-v1"]);
  assert.equal(report.valid, false);
  assert.ok(report.missingCapabilities.includes("military"));
});

test("validateCompatibility includes satisfied capabilities", () => {
  const registry = new HotPlugRegistry();
  registry.registerAll([
    makeComponent("a-v1", { provides: ["eco"] }),
    makeComponent("b-v1", { provides: ["military", "scout"] }),
  ]);
  registry.activate(["a-v1"]);

  const report = registry.validateCompatibility(["b-v1"]);
  assert.ok(report.satisfiedCapabilities.includes("eco"));
  assert.ok(report.satisfiedCapabilities.includes("military"));
  assert.ok(report.satisfiedCapabilities.includes("scout"));
});

// ---- Determinism ----

test("activation is deterministic (same input → same output)", () => {
  const createAndActivate = (): { ids: readonly string[]; hash: string } => {
    const r = new HotPlugRegistry();
    r.registerAll([
      makeComponent("a-v1", { config: { x: 1 } }),
      makeComponent("b-v1", { config: { y: 2 } }),
    ]);
    r.activate(["a-v1", "b-v1"]);
    return { ids: r.activeComponentIds, hash: r.takeSnapshot().configHash };
  };

  const first = createAndActivate();
  const second = createAndActivate();
  assert.deepEqual(first.ids, second.ids);
  assert.equal(first.hash, second.hash);
});

// ---- Generation tracking ----

test("component generation increments on each successful activation", () => {
  const registry = new HotPlugRegistry();
  registry.register(makeComponent("a-v1"));

  assert.equal(registry.stateOf("a-v1")?.generation, 0);
  registry.activate(["a-v1"]);
  assert.equal(registry.stateOf("a-v1")?.generation, 1);
  registry.activate([]);
  registry.activate(["a-v1"]);
  assert.equal(registry.stateOf("a-v1")?.generation, 2);
});

// ---- Rollback-safe: failed activation does not modify state ----

test("failed activation preserves previous active set", () => {
  const registry = new HotPlugRegistry();
  registry.registerAll([
    makeComponent("a-v1"),
    makeComponent("b-v1", { conflicts: ["c-v1"] }),
    makeComponent("c-v1"),
  ]);
  registry.activate(["a-v1"]);

  const result = registry.activate(["b-v1", "c-v1"]); // conflict!
  assert.equal(result.success, false);
  // active set unchanged
  assert.deepEqual(registry.activeComponentIds, ["a-v1"]);
});

test("failed activation does not modify component states", () => {
  const registry = new HotPlugRegistry();
  registry.registerAll([
    makeComponent("a-v1"),
    makeComponent("b-v1", { conflicts: ["c-v1"] }),
    makeComponent("c-v1"),
  ]);
  registry.activate(["a-v1"]);
  const genBefore = registry.stateOf("a-v1")?.generation;

  registry.activate(["b-v1", "c-v1"]); // conflict!
  // a-v1 state unchanged
  assert.equal(registry.stateOf("a-v1")?.generation, genBefore);
  assert.equal(registry.stateOf("a-v1")?.active, true);
  // conflicting components still inactive
  assert.equal(registry.stateOf("b-v1")?.active, false);
  assert.equal(registry.stateOf("c-v1")?.active, false);
});
