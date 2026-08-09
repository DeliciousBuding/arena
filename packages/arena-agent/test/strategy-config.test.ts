/** Runtime strategy compiler / hot-reload contract. */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { TenantRuntimeConfig } from "../src/app/runtime-config.ts";
import {
  compileRuntimeStrategy,
  hotReloadCompatibility,
} from "../src/app/strategy-config.ts";

function base(overrides: Partial<TenantRuntimeConfig> = {}): TenantRuntimeConfig {
  return {
    tenantId: "t1",
    rulesVersion: "v0.14",
    arenaTokenEnv: "ARENA_TEST_KEY",
    decisionMode: "deterministic",
    submitEnabled: false,
    model: { provider: "test", id: "test-model" },
    baseDir: "runtime",
    ...overrides,
  };
}

test("strategy compiler: worker-mission/no-fire compile through one registry boundary", () => {
  const compiled = compileRuntimeStrategy(base({ variants: ["worker-mission-v1", "alliance-no-fire-v1"] }));
  assert.deepEqual(compiled.variants, ["worker-mission-v1", "alliance-no-fire-v1"]);
  assert.equal(compiled.safetyOverrides.allianceNoFire, true);
  assert.equal(compiled.deterministicOverrides.mission?.surveyWorkerCap, 3);
  assert.match(compiled.configHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(compiled.strategyHash, /^sha256:[0-9a-f]{64}$/);
});

test("strategy compiler: unknown and duplicate variant fail before runtime ownership", () => {
  assert.throws(() => compileRuntimeStrategy(base({ variants: ["not-real-v1"] })), /unknown safety variant/);
  assert.throws(
    () => compileRuntimeStrategy(base({ variants: ["worker-mission-v1", "worker-mission-v1"] })),
    /duplicate strategy variant/,
  );
});

test("hot reload contract: variants are hot; writer/model/deadline/policy fields require restart", () => {
  const active = base({ variants: ["worker-mission-v1"] });
  const variantsOnly = base({ variants: ["worker-mission-v1", "alliance-no-fire-v1"] });
  const hot = hotReloadCompatibility(active, variantsOnly);
  assert.equal(hot.compatible, true);
  assert.equal(hot.variantsChanged, true);
  assert.deepEqual(hot.restartRequiredFields, []);

  const missionOnly = base({
    variants: ["worker-mission-v1"],
    mission: { collectionValueFloor: -12 },
  });
  const missionHot = hotReloadCompatibility(active, missionOnly);
  assert.equal(missionHot.compatible, true);
  assert.equal(missionHot.missionChanged, true);
  assert.deepEqual(missionHot.restartRequiredFields, []);

  for (const candidate of [
    base({ variants: active.variants, submitEnabled: true }),
    base({ variants: active.variants, model: { provider: "test", id: "other-model" } }),
    base({ variants: active.variants, deadlines: { agentSoftMs: 1000, selectionMs: 2000, submitMs: 3000, hardMs: 4000 } }),
    base({ variants: active.variants, policyOverride: { posture: "harvest", workerTarget: 8, militaryRatio: 0.2, focusRegion: null, attackPriority: null } }),
  ]) {
    const compatibility = hotReloadCompatibility(active, candidate);
    assert.equal(compatibility.compatible, false);
    assert.ok(compatibility.restartRequiredFields.length > 0);
  }
});

test("strategy hash changes only with strategy surface; restart hash ignores variants", () => {
  const a = compileRuntimeStrategy(base({ variants: ["worker-mission-v1"] }));
  const b = compileRuntimeStrategy(base({ variants: ["worker-mission-v1", "alliance-no-fire-v1"] }));
  assert.notEqual(a.strategyHash, b.strategyHash);
  assert.equal(a.restartHash, b.restartHash);
  assert.notEqual(a.configHash, b.configHash);

  const c = compileRuntimeStrategy(base({
    variants: ["worker-mission-v1"],
    mission: { collectionValueFloor: -12 },
  }));
  assert.notEqual(a.strategyHash, c.strategyHash, "mission tuning is part of the hot strategy identity");
  assert.equal(a.restartHash, c.restartHash, "mission tuning must not require immutable runtime restart");
});
