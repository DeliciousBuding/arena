import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { TickState } from "../src/domain/model.ts";
import {
  FEATURE_V2_DIM,
  FEATURE_V2_NAMES,
  extractFeatureVectorV2,
  featureVectorV2ToRecord,
  parseDecisionJsonl,
  lookupDecisionRecord,
  projectMlSampleToFeatureV2,
} from "../src/offline-learning/index.ts";

const CORE = "11111111-1111-1111-1111-111111111111";
const WORKER = "22222222-2222-2222-2222-222222222222";
const ENEMY_CORE = "33333333-3333-3333-3333-333333333333";
const ENEMY_VANGUARD = "44444444-4444-4444-4444-444444444444";

function stateAt(offset: number, tick: number): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 7,
    resourceCapacity: 15,
    resourceSpace: 8,
    population: 3,
    core: {
      id: CORE,
      position: [offset, offset],
      hp: 5,
      shield: 4,
      state: "NORMAL",
      ownerUsername: "t1",
      moveDirection: null,
      moveProgress: null,
      moveRequiredTicks: null,
      destination: null,
    },
    units: [
      { id: WORKER, position: [offset + 1, offset], hp: 2, unitType: "WORKER", cargo: 1 },
    ],
    workers: [
      { id: WORKER, position: [offset + 1, offset], hp: 2, unitType: "WORKER", cargo: 1 },
    ],
    vanguards: [],
    rangers: [],
    visibleEnemies: [
      { id: ENEMY_CORE, kind: "CORE", position: [offset + 4, offset + 2], hp: 5 },
      { id: ENEMY_VANGUARD, kind: "UNIT", unitType: "VANGUARD", position: [offset - 2, offset + 1], hp: 4 },
    ],
    resourceCells: new Set([`${offset + 1},${offset}`, `${offset + 7},${offset}`, `${offset + 12},${offset}`]),
    obstacleCells: new Set([`${offset},${offset + 1}`, `${offset + 2},${offset}`]),
    beacon: { position: [offset + 20, offset + 20], status: "GROUND", carrierId: null },
    events: [
      {
        eventId: "damage",
        tick,
        eventType: "UNIT_DAMAGED",
        reasonCode: null,
        actorId: ENEMY_VANGUARD,
        targetId: WORKER,
        values: {},
      },
    ],
  };
}

const CONTEXT = {
  threatLevel: "ALERT" as const,
  recentNonNormalThreatTicks6: 2,
  workerTarget: 8,
  militaryRatio: 0.4,
  posture: "balanced" as const,
};

test("feature-vector-v2 is translation invariant and excludes absolute tick", () => {
  const a = extractFeatureVectorV2(stateAt(0, 100), CONTEXT);
  const b = extractFeatureVectorV2(stateAt(10_000, 104), CONTEXT);

  assert.equal(a.length, FEATURE_V2_DIM);
  assert.deepEqual([...a], [...b]);
  assert.equal(FEATURE_V2_NAMES.includes("core_x"), false);
  assert.equal(FEATURE_V2_NAMES.includes("core_y"), false);
  assert.equal(FEATURE_V2_NAMES.includes("tick"), false);
  assert.equal(FEATURE_V2_NAMES.includes("tick_normalized"), false);
});

test("feature-vector-v2 encodes unknown telemetry and policy explicitly", () => {
  const record = featureVectorV2ToRecord(extractFeatureVectorV2(stateAt(0, 101), {
    threatLevel: null,
    recentNonNormalThreatTicks6: null,
    workerTarget: null,
    militaryRatio: null,
    posture: null,
  }));

  assert.equal(record.threat_unknown, 1);
  assert.equal(record.threat_normal, 0);
  assert.equal(record.recent_non_normal_threat_ticks_6, -1);
  assert.equal(record.worker_target_known, 0);
  assert.equal(record.military_ratio_known, 0);
  assert.equal(record.posture_unknown, 1);
  assert.equal(record.refill_phase_1, 1);
});

test("owned_damage_events does not count an owned attacker damaging an enemy", () => {
  const base = stateAt(0, 100);
  const state: TickState = {
    ...base,
    events: [{
      eventId: "outgoing-damage",
      tick: 100,
      eventType: "UNIT_DAMAGED",
      reasonCode: null,
      actorId: WORKER,
      targetId: ENEMY_VANGUARD,
      values: {},
    }],
  };
  const record = featureVectorV2ToRecord(extractFeatureVectorV2(state, CONTEXT));
  assert.equal(record.owned_damage_events, 0);
});

test("decision join computes only complete six-tick threat memory", () => {
  const levels = ["NORMAL", "NORMAL", "ALERT", "NORMAL", "NORMAL", "ENGAGED"] as const;
  const lines = levels.map((threatLevel, index) => JSON.stringify({
    processRunId: "run-a",
    tenantId: "t1",
    runId: `r${index}`,
    tick: 10 + index,
    threatLevel,
    threatReason: null,
  }));
  lines.push(JSON.stringify({
    processRunId: "run-b",
    tenantId: "t1",
    runId: "old",
    tick: 20,
  }));

  const index = parseDecisionJsonl(lines.join("\n"));
  assert.equal(index.stats.rowsIndexed, 7);
  assert.equal(index.stats.rowsWithoutThreatLevel, 1);
  assert.equal(lookupDecisionRecord(index, "run-a", 14)?.recentNonNormalThreatTicks6, null);
  assert.equal(lookupDecisionRecord(index, "run-a", 15)?.recentNonNormalThreatTicks6, 2);
  assert.equal(lookupDecisionRecord(index, "run-b", 20)?.threatLevel, null);
});

test("decision join fails closed on duplicate (processRunId, tick)", () => {
  const row = JSON.stringify({ processRunId: "run-a", tick: 10, threatLevel: "NORMAL" });
  assert.throws(() => parseDecisionJsonl(`${row}\n${row}\n`), /duplicate decision telemetry join key/u);
});

test("ml-sample-v1 projects through SDK Turn + reduceTurn into feature-vector-v2", () => {
  const sample = JSON.parse(readFileSync(
    new URL("./fixtures/shared-data/schema/fixtures/ml-sample-v1.sample-status.json", import.meta.url),
    "utf8",
  ));
  const index = parseDecisionJsonl(JSON.stringify({
    processRunId: "process-run-1",
    tenantId: "t1",
    runId: "logical-run-1",
    tick: 10,
    threatLevel: "ALERT",
    threatReason: "fixture",
  }));
  const record = projectMlSampleToFeatureV2(sample, index);

  assert.equal(record.schema, "feature-vector-v2");
  assert.equal(record.processRunId, "process-run-1");
  assert.equal(record.tick, 10);
  assert.equal(record.decisionJoin.matched, true);
  assert.equal(record.decisionJoin.threatLevelKnown, true);
  assert.equal(record.features.threat_alert, 1);
  assert.equal(record.features.worker_target, 8);
  assert.equal(record.features.military_ratio, 0.3);
  assert.equal(record.features.refill_phase_2, 1);
});
