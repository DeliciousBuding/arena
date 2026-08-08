/**
 * feature-vector-v1 单元测试：
 * - 特征向量提取维度正确
 * - 数值范围合理
 * - 按组过滤
 * - 确定性
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractFeatureVector,
  FEATURE_DIM,
  FEATURE_NAMES,
  featureNamesByGroup,
  featureIndicesByGroup,
  featureVectorToRecord,
  validateFeatureVector,
} from "../../src/offline-learning/schema/feature-vector.ts";
import type { TrajectoryStepState } from "../../src/offline-learning/schema/trajectory.ts";

function makeState(overrides: Partial<TrajectoryStepState> = {}): TrajectoryStepState {
  return {
    tick: 100,
    resources: 50,
    resourceCapacity: 125,
    population: 5,
    workers: 3,
    vanguards: 1,
    rangers: 1,
    coreHp: 5,
    coreShield: 3,
    corePosition: [10, -5],
    coreState: "NORMAL",
    visibleResourceCells: 3,
    carriedResources: 7,
    visibleEnemyUnits: 2,
    visibleEnemyCombat: 1,
    visibleEnemyCores: 1,
    nearestEnemyCoreDist: 25,
    nearestEnemyCombatDist: 18,
    threatLevel: "NORMAL",
    ...overrides,
  };
}

test("FEATURE_DIM is 31", () => {
  assert.strictEqual(FEATURE_DIM, 31);
});

test("FEATURE_NAMES has 31 entries", () => {
  assert.strictEqual(FEATURE_NAMES.length, 31);
});

test("FEATURE_NAMES has no duplicates", () => {
  assert.strictEqual(new Set(FEATURE_NAMES).size, FEATURE_NAMES.length);
});

test("extractFeatureVector returns correct dimension", () => {
  const state = makeState();
  const vec = extractFeatureVector(state);
  assert.strictEqual(vec.length, FEATURE_DIM);
});

test("extractFeatureVector produces finite values", () => {
  const state = makeState();
  const vec = extractFeatureVector(state);
  for (let i = 0; i < vec.length; i++) {
    assert.ok(Number.isFinite(vec[i]!), `Feature ${i} (${FEATURE_NAMES[i]}) should be finite, got ${vec[i]}`);
  }
});

test("extractFeatureVector is deterministic", () => {
  const state = makeState();
  const vec1 = extractFeatureVector(state);
  const vec2 = extractFeatureVector(state);
  for (let i = 0; i < vec1.length; i++) {
    assert.strictEqual(vec1[i], vec2[i], `Feature ${i} should be deterministic`);
  }
});

test("extractFeatureVector handles NORMAL threat level", () => {
  const state = makeState({ threatLevel: "NORMAL" });
  const vec = extractFeatureVector(state);
  const record = featureVectorToRecord(vec);
  assert.strictEqual(record.threat_normal, 1);
  assert.strictEqual(record.threat_alert, 0);
  assert.strictEqual(record.threat_engaged, 0);
  assert.strictEqual(record.threat_breakout, 0);
});

test("extractFeatureVector handles BREAKOUT threat level", () => {
  const state = makeState({ threatLevel: "BREAKOUT" });
  const vec = extractFeatureVector(state);
  const record = featureVectorToRecord(vec);
  assert.strictEqual(record.threat_normal, 0);
  assert.strictEqual(record.threat_alert, 0);
  assert.strictEqual(record.threat_engaged, 0);
  assert.strictEqual(record.threat_breakout, 1);
});

test("extractFeatureVector handles null enemy distances", () => {
  const state = makeState({
    nearestEnemyCoreDist: null,
    nearestEnemyCombatDist: null,
    visibleEnemyCores: 0,
    visibleEnemyCombat: 0,
  });
  const vec = extractFeatureVector(state);
  const record = featureVectorToRecord(vec);
  assert.strictEqual(record.nearest_enemy_core_dist, 128, "Null distance → sentinel 128");
  assert.strictEqual(record.nearest_enemy_combat_dist, 128, "Null distance → sentinel 128");
  assert.strictEqual(record.enemy_combat_nearby_12, 0);
});

test("extractFeatureVector enemy within 12 range", () => {
  const state = makeState({ nearestEnemyCombatDist: 8 });
  const vec = extractFeatureVector(state);
  const record = featureVectorToRecord(vec);
  assert.strictEqual(record.enemy_combat_nearby_12, 1);
});

test("extractFeatureVector resource_ratio in [0,1]", () => {
  const state = makeState({ resources: 50, resourceCapacity: 100 });
  const vec = extractFeatureVector(state);
  const record = featureVectorToRecord(vec);
  assert.ok(record.resource_ratio >= 0 && record.resource_ratio <= 1,
    `resource_ratio ${record.resource_ratio} should be in [0,1]`);
});

test("extractFeatureVector resource_ratio is 0 when capacity is 0", () => {
  const state = makeState({ resources: 0, resourceCapacity: 0, population: 0, workers: 0, vanguards: 0, rangers: 0 });
  const vec = extractFeatureVector(state);
  const record = featureVectorToRecord(vec);
  assert.strictEqual(record.resource_ratio, 0);
});

test("extractFeatureVector handles coreState RESPAWNING", () => {
  const state = makeState({ coreState: "RESPAWNING" });
  const vec = extractFeatureVector(state);
  const record = featureVectorToRecord(vec);
  assert.strictEqual(record.core_normal, 0);
});

test("featureVectorToRecord has all keys", () => {
  const state = makeState();
  const vec = extractFeatureVector(state);
  const record = featureVectorToRecord(vec);
  for (const name of FEATURE_NAMES) {
    assert.ok(name in record, `Record missing key: ${name}`);
  }
  assert.strictEqual(Object.keys(record).length, FEATURE_DIM);
});

test("validateFeatureVector accepts valid vector", () => {
  const state = makeState();
  const vec = extractFeatureVector(state);
  const problems = validateFeatureVector(vec);
  assert.deepStrictEqual(problems, []);
});

test("validateFeatureVector rejects wrong dimension", () => {
  const vec = new Float64Array(10);
  const problems = validateFeatureVector(vec);
  assert.ok(problems.length > 0);
});

test("validateFeatureVector catches NaN", () => {
  const vec = new Float64Array(FEATURE_DIM);
  vec[0] = NaN;
  const problems = validateFeatureVector(vec);
  assert.ok(problems.length > 0);
  assert.ok(problems.some((p) => p.includes("not finite")));
});

test("featureNamesByGroup returns correct groups", () => {
  const spatial = featureNamesByGroup("spatial");
  assert.ok(spatial.includes("core_x"));
  assert.ok(spatial.includes("core_y"));
  assert.ok(spatial.includes("nearest_enemy_core_dist"));
  assert.strictEqual(spatial.length, 6);

  const economic = featureNamesByGroup("economic");
  assert.ok(economic.includes("resources"));
  assert.ok(economic.includes("workers"));
  assert.strictEqual(economic.length, 6);

  const threat = featureNamesByGroup("threat");
  assert.ok(threat.includes("threat_normal"));
  assert.ok(threat.includes("visible_enemy_combat"));
  assert.strictEqual(threat.length, 8);

  const global = featureNamesByGroup("global");
  assert.ok(global.includes("tick"));
  assert.strictEqual(global.length, 3);
});

test("featureIndicesByGroup matches featureNamesByGroup length", () => {
  for (const group of ["spatial", "economic", "military", "threat", "global"] as const) {
    const names = featureNamesByGroup(group);
    const indices = featureIndicesByGroup(group);
    assert.strictEqual(indices.length, names.length, `Group ${group}: indices and names mismatch`);
  }
});

test("all 31 features assigned to exactly one group", () => {
  const allGroupFeatures = new Set<string>();
  for (const group of ["spatial", "economic", "military", "threat", "global"] as const) {
    for (const name of featureNamesByGroup(group)) {
      assert.ok(!allGroupFeatures.has(name), `Feature ${name} appears in multiple groups`);
      allGroupFeatures.add(name);
    }
  }
  assert.strictEqual(allGroupFeatures.size, 31, "All 31 features should be assigned");
});
