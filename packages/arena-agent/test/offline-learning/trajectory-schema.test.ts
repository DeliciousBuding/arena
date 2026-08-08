/**
 * trajectory-v1 schema 单元测试：
 * - 类型合法性验证
 * - 确定性 trajectoryId
 * - 边界条件
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeTrajectoryId,
  projectStepAction,
  projectStepLabel,
  projectTickState,
  TRAJECTORY_SCHEMA_VERSION,
  validateTrajectoryV1,
  type TrajectoryStep,
  type TrajectoryV1,
} from "../../src/offline-learning/schema/trajectory.ts";

// ── 辅助工厂 ──

function makeStep(tick: number): TrajectoryStep {
  return {
    state: {
      tick,
      resources: 10,
      resourceCapacity: 25,
      population: 5,
      workers: 3,
      vanguards: 1,
      rangers: 1,
      coreHp: 5,
      coreShield: 5,
      corePosition: [0, 0],
      coreState: "NORMAL",
      visibleResourceCells: 2,
      carriedResources: 3,
      visibleEnemyUnits: 1,
      visibleEnemyCombat: 1,
      visibleEnemyCores: 1,
      nearestEnemyCoreDist: 20,
      nearestEnemyCombatDist: 15,
      threatLevel: "NORMAL",
    },
    action: {
      actionCounts: { MOVE: 2, HARVEST: 1 },
      coreAction: "WAIT",
      spawnUnitType: null,
      intents: ["patrol"],
      planHash: "abc12345",
    },
    label: {
      immediateResourceDelta: 2,
      immediatePopulationDelta: 0,
      deaths: 0,
      netResourceDelta20: 5,
      deathProb20: 0,
      coreRisk50: 0,
      windowComplete: true,
    },
  };
}

function makeTrajectory(overrides: Partial<TrajectoryV1> = {}): TrajectoryV1 {
  const steps = [makeStep(1), makeStep(2), makeStep(3)];
  return {
    schema: TRAJECTORY_SCHEMA_VERSION,
    trajectoryId: computeTrajectoryId(steps),
    metadata: {
      episodeId: "test-ep-001",
      tenantId: "t1",
      rulesVersion: "v0.14",
      rulesManifestHash: "sha256:abcd1234",
      seed: 42,
      tickCount: 3,
      source: "sim",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      engineVersion: "0.1.0",
      startedAt: "2026-08-08T00:00:00Z",
      completedAt: "2026-08-08T00:01:00Z",
    },
    steps,
    ...overrides,
  };
}

// ── 测试 ──

test("validateTrajectoryV1 accepts valid trajectory", () => {
  const trajectory = makeTrajectory();
  const problems = validateTrajectoryV1(trajectory);
  assert.deepStrictEqual(problems, [], `Expected no problems, got: ${problems.join("; ")}`);
});

test("validateTrajectoryV1 rejects wrong schema", () => {
  const trajectory = makeTrajectory({ schema: "wrong-schema" as unknown as typeof TRAJECTORY_SCHEMA_VERSION });
  const problems = validateTrajectoryV1(trajectory);
  assert.ok(problems.length > 0, "Should reject wrong schema");
  assert.ok(problems.some((p) => p.includes("schema")), "Should mention schema in error");
});

test("validateTrajectoryV1 rejects empty steps", () => {
  const trajectory = makeTrajectory({ steps: [] });
  const problems = validateTrajectoryV1(trajectory);
  assert.ok(problems.length > 0, "Should reject empty steps");
});

test("validateTrajectoryV1 rejects missing trajectoryId", () => {
  const trajectory = makeTrajectory({ trajectoryId: "" });
  const problems = validateTrajectoryV1(trajectory);
  assert.ok(problems.length > 0, "Should reject empty trajectoryId");
});

test("validateTrajectoryV1 rejects step with invalid tick", () => {
  const badStep = makeStep(0); // tick must be >= 1 if we checked, but our validator checks isSafeInteger
  const trajectory = makeTrajectory({ steps: [{ ...badStep, state: { ...badStep.state, tick: NaN } }] });
  const problems = validateTrajectoryV1(trajectory);
  assert.ok(problems.length > 0, "Should reject NaN tick");
});

test("validateTrajectoryV1 rejects null root", () => {
  const problems = validateTrajectoryV1(null);
  assert.ok(problems.length > 0);
});

test("validateTrajectoryV1 rejects array root", () => {
  const problems = validateTrajectoryV1([]);
  assert.ok(problems.length > 0);
});

test("computeTrajectoryId is deterministic", () => {
  const steps1 = [makeStep(1), makeStep(2)];
  const steps2 = [makeStep(1), makeStep(2)];
  assert.strictEqual(computeTrajectoryId(steps1), computeTrajectoryId(steps2),
    "Same steps should produce same ID");
});

test("computeTrajectoryId differs for different steps", () => {
  const steps1 = [makeStep(1), makeStep(2)];
  const steps2 = [makeStep(1), makeStep(3)]; // different tick
  assert.notStrictEqual(computeTrajectoryId(steps1), computeTrajectoryId(steps2),
    "Different steps should produce different IDs");
});

test("computeTrajectoryId is order-sensitive", () => {
  const steps1 = [makeStep(1), makeStep(2)];
  const steps2 = [makeStep(2), makeStep(1)];
  assert.notStrictEqual(computeTrajectoryId(steps1), computeTrajectoryId(steps2),
    "Reordered steps should produce different IDs");
});

test("computeTrajectoryId output is 64-char hex", () => {
  const id = computeTrajectoryId([makeStep(1)]);
  assert.match(id, /^[0-9a-f]{64}$/, "Should be 64-char hex string");
});

test("projectStepAction extracts action counts correctly", () => {
  const plan = {
    tick: 1,
    unitActions: {
      u1: { type: "MOVE", direction: "UP" },
      u2: { type: "HARVEST" },
      u3: { type: "MOVE", direction: "DOWN" },
    },
    coreAction: { type: "SPAWN", unitType: "WORKER" },
    intents: { u1: "patrol", u3: "patrol" },
  };
  const result = projectStepAction(plan as unknown as import("../../src/domain/model.ts").Plan, "abc12345");
  assert.deepStrictEqual(result.actionCounts, { MOVE: 2, HARVEST: 1 });
  assert.strictEqual(result.coreAction, "SPAWN");
  assert.strictEqual(result.spawnUnitType, "WORKER");
  assert.deepStrictEqual(result.intents, ["patrol"], "trajectory stores intent labels, not unit ids");
  assert.strictEqual(result.planHash, "abc12345");
});

test("projectStepAction handles null coreAction", () => {
  const plan = {
    tick: 1,
    unitActions: { u1: { type: "WAIT" } },
    coreAction: null,
    intents: {},
  };
  const result = projectStepAction(plan as unknown as import("../../src/domain/model.ts").Plan, "00000000");
  assert.strictEqual(result.coreAction, null);
  assert.strictEqual(result.spawnUnitType, null);
  assert.deepStrictEqual(result.actionCounts, { WAIT: 1 });
});

test("projectTickState projects the exact private planner observation without placeholders", () => {
  const state: import("../../src/domain/model.ts").TickState = {
    tick: 7,
    status: "ACTIVE",
    resources: 13,
    resourceCapacity: 20,
    resourceSpace: 7,
    population: 4,
    core: { id: "c1", position: [10, 10], hp: 4, shield: 3, state: "NORMAL", ownerUsername: "me" },
    units: [
      { id: "w1", position: [11, 10], hp: 2, unitType: "WORKER", cargo: 1 },
      { id: "w2", position: [12, 10], hp: 2, unitType: "WORKER", cargo: 0 },
      { id: "v1", position: [10, 11], hp: 3, unitType: "VANGUARD", cargo: 0 },
      { id: "r1", position: [10, 12], hp: 2, unitType: "RANGER", cargo: 0 },
    ],
    workers: [
      { id: "w1", position: [11, 10], hp: 2, unitType: "WORKER", cargo: 1 },
      { id: "w2", position: [12, 10], hp: 2, unitType: "WORKER", cargo: 0 },
    ],
    vanguards: [{ id: "v1", position: [10, 11], hp: 3, unitType: "VANGUARD", cargo: 0 }],
    rangers: [{ id: "r1", position: [10, 12], hp: 2, unitType: "RANGER", cargo: 0 }],
    visibleEnemies: [
      { id: "ev", kind: "UNIT", unitType: "VANGUARD", position: [13, 10], hp: 3 },
      { id: "ec", kind: "CORE", position: [20, 20], hp: 5 },
    ],
    resourceCells: new Set(["11,11", "15,15"]),
    obstacleCells: new Set(),
    beacon: { position: [0, 0], status: "GROUND", carrierId: null },
    events: [],
  };
  const projected = projectTickState(state, "ALERT");
  assert.equal(projected.resources, 13);
  assert.equal(projected.resourceCapacity, 20);
  assert.equal(projected.visibleResourceCells, 2);
  assert.equal(projected.carriedResources, 1);
  assert.equal(projected.visibleEnemyCombat, 1);
  assert.equal(projected.visibleEnemyCores, 1);
  assert.equal(projected.nearestEnemyCombatDist, 3);
  assert.equal(projected.nearestEnemyCoreDist, 10);
  assert.equal(projected.threatLevel, "ALERT");
});

test("projectStepLabel computes all fields", () => {
  const label = projectStepLabel(10, 12, 5, 5, 0, 8, 0.1, 0, true);
  assert.strictEqual(label.immediateResourceDelta, 2);
  assert.strictEqual(label.immediatePopulationDelta, 0);
  assert.strictEqual(label.deaths, 0);
  assert.strictEqual(label.netResourceDelta20, 8);
  assert.strictEqual(label.deathProb20, 0.1);
  assert.strictEqual(label.coreRisk50, 0);
  assert.strictEqual(label.windowComplete, true);
});
