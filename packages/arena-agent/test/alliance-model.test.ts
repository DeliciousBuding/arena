/**
 * Alliance 域模型核心测试（2026-08-08，spec §5/§6）：
 * 1) 目击去重（同 id 合并 / owner+spatial gate / 无 id UNIT 不永久合并）；
 * 2) confidence decay（exp(-age/tau)、floor、可见强制 1）；
 * 3) 兵力统计四口径（修正"83 敌单位"重复累加假象）；
 * 4) 威胁场投影（direct/projected/coreRaid/leaderboard prior）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type EntitySighting,
  type Position,
  CORE_TAU,
  UNIT_TAU,
  CONFIDENCE_FLOOR,
  mergeKey,
  normalizeSighting,
  mergeSightings,
  currentConfidence,
  confidenceAt,
  computeForceCounts,
  currentVisibleCombat,
  recentUniqueCombat,
  historicalSightingCount,
  estimatedForce,
  projectThreatField,
  adjustWithLeaderboardPrior,
  THREAT_FIELD_RADIUS,
} from "../src/alliance/index.ts";

const P: Position = [0, 0];

function unitSighting(over: Partial<EntitySighting> = {}): EntitySighting {
  return {
    key: "UNIT:u1",
    kind: "UNIT",
    unitType: "VANGUARD",
    entityId: "u1",
    position: P,
    sourceTenant: "t2",
    firstSeenTick: 100,
    lastSeenTick: 100,
    currentlyVisible: true,
    confidence: 1,
    evidence: "LIVE",
    ...over,
  };
}

// ---------- 去重 ----------

test("mergeKey：有 id 按 kind:id 合并", () => {
  assert.equal(mergeKey({ kind: "UNIT", entityId: "u1", sourceTenant: "t2", position: P }), "UNIT:u1");
  assert.equal(mergeKey({ kind: "CORE", entityId: "c1", sourceTenant: "t1", position: P }), "CORE:c1");
});

test("mergeKey：无 id enemy Core 按 ownerUsername", () => {
  assert.equal(mergeKey({ kind: "CORE", ownerUsername: "jerkman", sourceTenant: "t2", position: P }), "CORE:jerkman");
});

test("normalizeSighting：同 id 多 tick 目击合并为同一实体，保留 firstSeen", () => {
  const first = normalizeSighting(
    { kind: "UNIT", unitType: "VANGUARD", entityId: "u1", position: [0, 0], sourceTenant: "t2", tick: 100, evidence: "LIVE" },
    undefined,
    100,
  );
  const second = normalizeSighting(
    { kind: "UNIT", unitType: "VANGUARD", entityId: "u1", position: [3, 4], sourceTenant: "t2", tick: 106, evidence: "LIVE" },
    first,
    106,
  );
  assert.equal(second.key, "UNIT:u1");
  assert.equal(second.firstSeenTick, 100);
  assert.equal(second.lastSeenTick, 106);
  assert.deepEqual(second.position, [3, 4]);
  assert.equal(second.currentlyVisible, true);
});

test("normalizeSighting：无 id enemy Core 位置漂移 ≤ spatial gate 合并", () => {
  const first = normalizeSighting(
    { kind: "CORE", ownerUsername: "tianyuantu", position: [10, 10], sourceTenant: "t2", tick: 100, evidence: "CALIBRATION" },
    undefined,
    100,
  );
  const drifted = normalizeSighting(
    { kind: "CORE", ownerUsername: "tianyuantu", position: [14, 12], sourceTenant: "t2", tick: 105, evidence: "CALIBRATION" },
    first,
    105,
  );
  assert.equal(drifted.key, "CORE:tianyuantu");
  assert.equal(drifted.firstSeenTick, 100);
  // 漂移 4+2=6 ≤ 8：合并；超阈值应新建
  const far = normalizeSighting(
    { kind: "CORE", ownerUsername: "tianyuantu", position: [30, 30], sourceTenant: "t2", tick: 110, evidence: "CALIBRATION" },
    first,
    110,
  );
  assert.notEqual(far.firstSeenTick, 100);
});

test("mergeSightings：同 tick 同格无 id UNIT 去重（防单 tick 重复放大）", () => {
  // 无 id 的 UNIT：同一 tick 同一格出现两次 → 只算一条（ephemeral 键相同）
  const raws = [
    { kind: "UNIT" as const, unitType: "VANGUARD" as const, position: [5, 5] as Position, sourceTenant: "t2", tick: 100, evidence: "LIVE" as const },
    { kind: "UNIT" as const, unitType: "VANGUARD" as const, position: [5, 5] as Position, sourceTenant: "t2", tick: 100, evidence: "LIVE" as const },
  ];
  const merged = mergeSightings([], raws, 100);
  assert.equal(merged.length, 1);
  // 不同 tick → 不合并（不永久合并）
  const raws2 = [
    { kind: "UNIT" as const, unitType: "VANGUARD" as const, position: [5, 5] as Position, sourceTenant: "t2", tick: 100, evidence: "LIVE" as const },
    { kind: "UNIT" as const, unitType: "VANGUARD" as const, position: [5, 5] as Position, sourceTenant: "t2", tick: 101, evidence: "LIVE" as const },
  ];
  const merged2 = mergeSightings([], raws2, 101);
  assert.equal(merged2.length, 2);
});

// ---------- confidence decay ----------

test("confidenceAt：exp(-age/tau) 且带 floor", () => {
  assert.equal(confidenceAt(0, UNIT_TAU), 1);
  const c6 = confidenceAt(6, UNIT_TAU);
  assert.ok(Math.abs(c6 - Math.exp(-1)) < 1e-9, `expected exp(-1), got ${c6}`);
  assert.equal(confidenceAt(10_000, UNIT_TAU), CONFIDENCE_FLOOR);
  assert.equal(confidenceAt(0, CORE_TAU), 1);
});

test("currentConfidence：可见强制 1，陈旧按 tau 衰减", () => {
  const visible = unitSighting({ currentlyVisible: true, lastSeenTick: 100 });
  assert.equal(currentConfidence(visible, 100), 1);
  const stale = unitSighting({ currentlyVisible: false, lastSeenTick: 100 });
  const c = currentConfidence(stale, 100 + 6);
  assert.ok(Math.abs(c - Math.exp(-1)) < 1e-9);
});

// ---------- 兵力统计四口径 ----------

test("computeForceCounts：10 条同一单位目击 → 1 实体（修正重复累加假象）", () => {
  const sightings: EntitySighting[] = [];
  for (let t = 100; t < 110; t += 1) {
    sightings.push(unitSighting({ key: `UNIT:u1`, entityId: "u1", firstSeenTick: 100, lastSeenTick: t, currentlyVisible: t === 109 }));
  }
  const counts = computeForceCounts(sightings, 109);
  assert.equal(counts.historicalSightingCount, 10); // 审计口径：10 条
  assert.equal(counts.currentVisibleCombat, 1); // 本 tick 可见 1
  assert.equal(counts.recentUniqueCombat, 1); // unique 1
  assert.ok(counts.estimatedForce <= 1 + 1e-9, `estimatedForce ${counts.estimatedForce} 不应超过 1 实体`); // 加权 ≤1
});

test("computeForceCounts：2 个不同 id 单位 → unique 2、visible 按实际", () => {
  const s1 = unitSighting({ key: "UNIT:u1", entityId: "u1", lastSeenTick: 109, currentlyVisible: true });
  const s2 = unitSighting({ key: "UNIT:u2", entityId: "u2", lastSeenTick: 109, currentlyVisible: true });
  const counts = computeForceCounts([s1, s2], 109);
  assert.equal(counts.currentVisibleCombat, 2);
  assert.equal(counts.recentUniqueCombat, 2);
  assert.equal(counts.estimatedForce, 2);
});

test("recentUniqueCombat：窗口外目击不计入近期", () => {
  const old = unitSighting({ key: "UNIT:u9", entityId: "u9", lastSeenTick: 99, currentlyVisible: false });
  const fresh = unitSighting({ key: "UNIT:u8", entityId: "u8", lastSeenTick: 400, currentlyVisible: false });
  assert.equal(recentUniqueCombat([old, fresh], 400, 300), 1); // old age 300 > 窗口边界(≤) 不算
});

// ---------- 威胁场投影 ----------

test("projectThreatField：可见战斗单位 → directCombat，陈旧 → projectedCombat", () => {
  const visible = unitSighting({ key: "UNIT:a", entityId: "a", position: [0, 0], lastSeenTick: 200, currentlyVisible: true });
  const stale = unitSighting({ key: "UNIT:b", entityId: "b", position: [20, 0], lastSeenTick: 100, currentlyVisible: false });
  const field = projectThreatField([visible, stale], 200);
  assert.ok((field.cells.get("0,0")?.directCombat ?? 0) >= 1);
  assert.ok((field.cells.get("20,0")?.projectedCombat ?? 0) > 0);
  assert.ok((field.cells.get("20,0")?.directCombat ?? 0) === 0);
  // 可见源 uncertainty = 0（confidence 1）；陈旧源 uncertainty > 0
  assert.equal(field.cells.get("0,0")?.uncertainty, 0);
  assert.ok((field.cells.get("20,0")?.uncertainty ?? 0) > 0);
});

test("projectThreatField：敌 Core 投影 coreRaid 且 WORKER 不投影", () => {
  const enemyCore = unitSighting({ key: "CORE:jerk", kind: "CORE", ownerUsername: "jerkman", position: [0, 0], lastSeenTick: 100, currentlyVisible: false });
  const worker = unitSighting({ key: "UNIT:w", kind: "UNIT", unitType: "WORKER", entityId: "w", position: [5, 0], lastSeenTick: 100, currentlyVisible: true });
  const field = projectThreatField([enemyCore, worker], 100);
  assert.ok((field.cells.get("0,0")?.coreRaid ?? 0) >= 1);
  assert.equal(field.cells.get("5,0")?.directCombat, 0); // WORKER 不投影
  assert.ok(field.cells.size > 0);
});

test("adjustWithLeaderboardPrior：高伤害玩家对敌 Core 附近叠加先验，不生成新实体", () => {
  const enemyCore = unitSighting({ key: "CORE:jerk", kind: "CORE", ownerUsername: "jerkman", position: [0, 0], lastSeenTick: 100, currentlyVisible: false });
  const field = projectThreatField([enemyCore], 100);
  const before = field.cells.get("0,0")?.coreRaid ?? 0;
  const aggression = new Map<string, number>([["jerkman", 0.8]]);
  const boosted = adjustWithLeaderboardPrior(field, [enemyCore], aggression);
  const after = boosted.cells.get("0,0")?.coreRaid ?? 0;
  assert.ok(after > before, `expected prior boost, got ${before} -> ${after}`);
});


