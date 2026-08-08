/**
 * Variant Bridge 测试（v1，2026-08-08）。
 *
 * 覆盖：registerAllVariants 注册完整性、capability 声明、release hash、
 * 现有变体 id 全量映射。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createHotPlugContract } from "../src/strategy-hotplug/contract.ts";
import {
  allCapabilities,
  capabilitiesOf,
  registerAllVariants,
} from "../src/strategy-hotplug/variant-bridge.ts";

// ---- Registration coverage ----

test("registerAllVariants(both) registers all safety + deterministic variants", () => {
  const contract = createHotPlugContract();
  registerAllVariants(contract, "both");

  const ids = contract.registeredIds;
  assert.ok(ids.length >= 30, `expected ≥30 registered variants, got ${ids.length}`);
  // Spot-check: well-known variants must be present
  assert.ok(ids.includes("threat-recall-v1"), "threat-recall-v1 not registered");
  assert.ok(ids.includes("strike-core-v1"), "strike-core-v1 not registered");
  assert.ok(ids.includes("core-clearance-v1"), "core-clearance-v1 not registered");
  assert.ok(ids.includes("alliance-no-fire-v1"), "alliance-no-fire-v1 not registered");
  assert.ok(ids.includes("worker-mission-v1"), "worker-mission-v1 not registered");
});

test("registerAllVariants(safety) only registers safety-side variants", () => {
  const contract = createHotPlugContract();
  registerAllVariants(contract, "safety");

  const ids = contract.registeredIds;
  // All safety variants should be present
  assert.ok(ids.includes("threat-recall-v1"));
  assert.ok(ids.includes("core-clearance-v1"));
  // Safety-side variants with empty config (placeholder for fail-fast validation)
  // are present in VARIANT_SAFETY_CONFIG by design — they exist to satisfy
  // resolveVariantsConfig's "unknown id → fail-fast" contract.
  assert.ok(ids.includes("vanguard-heavy-v1"), "dual-registry variant must be in safety domain");
  assert.ok(ids.includes("worker-mission-v1"), "dual-registry variant must be in safety domain");
  // Deterministic-side-only variants should NOT be present
  // (All deterministic variants also have safety-side entries, so this is vacuously true
  //  for the current registry — the architecture requires safety-side registration.)
});

test("registerAllVariants(deterministic) only registers deterministic variants", () => {
  const contract = createHotPlugContract();
  registerAllVariants(contract, "deterministic");

  const ids = contract.registeredIds;
  assert.ok(ids.includes("strike-core-v1"));
  assert.ok(ids.includes("vanguard-heavy-v1"));
  // Safety-only variants should NOT be present
  assert.ok(!ids.includes("threat-recall-v1"), "safety-only variant leaked into deterministic domain");
});

// ---- Release hash ----

test("each registered variant has a valid release hash", () => {
  const contract = createHotPlugContract();
  registerAllVariants(contract, "both");

  for (const id of contract.registeredIds) {
    const component = contract.get(id);
    assert.notEqual(component, undefined, `${id} not found in contract`);
    const release = component!.release;
    assert.equal(typeof release.version, "string");
    assert.ok(release.hash.startsWith("sha256:"), `${id} hash missing prefix: ${release.hash}`);
    assert.ok(release.hash.length > 7, `${id} hash too short: ${release.hash}`);
  }
});

test("same variant always produces same hash (deterministic)", () => {
  const c1 = createHotPlugContract();
  registerAllVariants(c1, "safety");
  const c2 = createHotPlugContract();
  registerAllVariants(c2, "safety");

  for (const id of c1.registeredIds) {
    const h1 = c1.get(id)!.release.hash;
    const h2 = c2.get(id)!.release.hash;
    assert.equal(h1, h2, `hash mismatch for ${id}: ${h1} vs ${h2}`);
  }
});

// ---- Capability taxonomy ----

test("allCapabilities returns known categories", () => {
  const caps = allCapabilities();
  assert.ok(caps.includes("worker-defense"));
  assert.ok(caps.includes("military-offense"));
  assert.ok(caps.includes("military-defense"));
  assert.ok(caps.includes("core-protection"));
  assert.ok(caps.includes("economy"));
  assert.ok(caps.includes("scouting"));
  assert.ok(caps.includes("blockade"));
  assert.ok(caps.includes("alliance"));
  assert.ok(caps.includes("population"));
});

test("known variants have meaningful capabilities", () => {
  assert.deepEqual(capabilitiesOf("threat-recall-v1"), ["worker-defense"]);
  assert.deepEqual(capabilitiesOf("strike-core-v1"), ["military-offense", "economy"]);
  assert.deepEqual(capabilitiesOf("reinforce-home-v1"), ["military-defense"]);
  assert.deepEqual(capabilitiesOf("core-clearance-v1"), ["core-protection"]);
  assert.deepEqual(capabilitiesOf("harvest-memory-mine-v1"), ["economy"]);
  assert.deepEqual(capabilitiesOf("frontier-priority-v1"), ["scouting"]);
  assert.deepEqual(capabilitiesOf("worker-blockade-v1"), ["blockade"]);
  assert.deepEqual(capabilitiesOf("alliance-no-fire-v1"), ["alliance"]);
  assert.deepEqual(capabilitiesOf("population-ceiling-30-v1"), ["population"]);
});

test("unknown variant returns empty capabilities", () => {
  assert.deepEqual(capabilitiesOf("nonexistent-variant-v99"), []);
});

// ---- Activation of real variants ----

test("activate well-known compatible set succeeds", () => {
  const contract = createHotPlugContract();
  registerAllVariants(contract, "safety");

  const result = contract.activate([
    "threat-recall-v1",
    "frontier-priority-v1",
    "core-clearance-v1",
    "harvest-memory-mine-v1",
  ]);
  assert.equal(result.success, true);
  assert.equal(contract.activeIds.length, 4);
});

test("activate with unknown variant fails", () => {
  const contract = createHotPlugContract();
  registerAllVariants(contract, "safety");

  const result = contract.activate(["threat-recall-v1", "nonexistent-v99"]);
  assert.equal(result.success, false);
});

// ---- Rollback safety with real variants ----

test("contract preserves last-good on failed activation (atomicity)", () => {
  const contract = createHotPlugContract();
  registerAllVariants(contract, "safety");

  // Establish last-good
  const r1 = contract.activate(["threat-recall-v1"]);
  assert.equal(r1.success, true);

  // Attempt to activate garbage — should fail and NOT change active set
  const r2 = contract.activate(["nonexistent-v99"]);
  assert.equal(r2.success, false);
  // Active set unchanged (atomicity — failed activation doesn't touch state)
  assert.deepEqual(contract.activeIds, ["threat-recall-v1"]);
});

test("contract rollback reverts to previous good after successful activation", () => {
  const contract = createHotPlugContract();
  registerAllVariants(contract, "safety");

  // Establish state A
  contract.activate(["threat-recall-v1"]);
  assert.deepEqual(contract.activeIds, ["threat-recall-v1"]);
  const snapshotA = contract.snapshot();

  // Switch to state B
  contract.activate(["frontier-priority-v1", "core-clearance-v1"]);
  assert.deepEqual(contract.activeIds, ["core-clearance-v1", "frontier-priority-v1"]);

  // Rollback → should restore state A (the state before the last successful switch)
  const rollbackResult = contract.rollback();
  assert.equal(rollbackResult.success, true);
  assert.deepEqual(contract.activeIds, snapshotA.activeIds);
});
