/**
 * 综合审计总览测试（2026-08-08）：决策+生命周期+矿利用+探索+管线 单调用合成。
 * - 每租户字段折叠正确（stallRate 计算 / byType / topCandidates 前 5）；
 * - 全局汇总（maxLag / 总未开采 / 总可见未开采 / 总单位 / 总核心增量 / coverage）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateAuditOverview } from "../lib/audit-overview.ts";
import type { DecisionAuditPayload } from "../lib/decision-audit.ts";
import type { LifecycleAuditPayload } from "../lib/lifecycle-audit.ts";
import type { MineTenantUtilization } from "../lib/mine-utilization.ts";
import type { AllianceExplorationPayload } from "../lib/exploration-coverage.ts";
import type { PipelineHealthPayload } from "../lib/pipeline-health.ts";

const dec = (t: string, stall: number, rec: number, coreDelta: number): DecisionAuditPayload => ({
  generatedAt: "", tenant: t, window: rec, currentTick: 1000,
  decision: { records: rec, actionMix: {}, intentTop: [], sourceMix: {}, planChurn: { unique: 5, records: rec, rate: 0.5 }, stallTicks: stall },
  outcome: { records: rec, coreDeltaSum: coreDelta, coreDeltaPositiveTicks: 1, depositSucceeded: 1, depositFailed: 0,
    harvestSucceeded: 1, harvestFailed: 0, depositSuccessRate: 1, cargoEfficiency: 0.25,
    workerMeanDistFromCore: 5, humanApplied: 3, humanRejected: 1 },
  cachedAt: "",
} as DecisionAuditPayload);

const lc = (t: string): LifecycleAuditPayload => ({
  generatedAt: "", tenant: t, runId: "r", window: { fromTick: 1, toTick: 2, cases: 1, events: 1 },
  units: [
    { actor: "a", unitType: "WORKER", role: "worker", firstSeenTick: 1, lastSeenTick: 2, alive: true,
      destroyedAtTick: null, destroyedBy: null, spawned: true, moves: { ok: 1, fail: 0 },
      harvest: { ok: 1, fail: 0, amount: 2 }, deposit: { ok: 0, fail: 0, amount: 0 },
      combat: { shotsHit: 0, shotsMissed: 0, blocked: 0, sweepsResolved: 0, damageDealt: 0 },
      heals: { ok: 0, fail: 0 }, drops: 0, pickups: 0, lastPosition: [0, 0], positionSamples: [] },
    { actor: "b", unitType: "RANGER", role: "combat", firstSeenTick: 1, lastSeenTick: 3, alive: false,
      destroyedAtTick: 3, destroyedBy: "e", spawned: true, moves: { ok: 0, fail: 0 },
      harvest: { ok: 0, fail: 0, amount: 0 }, deposit: { ok: 0, fail: 0, amount: 0 },
      combat: { shotsHit: 1, shotsMissed: 0, blocked: 0, sweepsResolved: 0, damageDealt: 1 },
      heals: { ok: 0, fail: 0 }, drops: 0, pickups: 0, lastPosition: [1, 1], positionSamples: [] },
  ],
  mines: [{ cell: "5,5", x: 5, y: 5, firstSeenTick: 1, lastSeenTick: 2, harvestCount: 1, harvestAmount: 2,
    harvestFailCount: 0, active: true, refillGapTicks: null }],
  core: { actor: "c", damageTaken: 0, damageEvents: 0, healOk: 0, healFail: 0, moveOk: 1, moveFail: 0,
    capturedResources: 0, captures: { count: 2, amount: 10 }, destroyed: false, destroyedAtTick: null,
    destroyedBy: null, lastPosition: [0, 0], positionSamples: [] },
  consumption: { harvestOk: 1, harvestFail: 0, harvestAmount: 2, depositOk: 0, depositFail: 0, depositAmount: 0,
    cargoDropped: 0, spawns: 1, respawns: 0, unitDestroyed: 1, selfDestructs: 0, destroyedByEnemy: 1,
    coreDamageTaken: 0, spends: { byKind: { spawn: 10 }, byType: { WORKER: 10 }, total: 10 } },
  cachedAt: "",
} as LifecycleAuditPayload);

const mu = (t: string, total: number, never: number, visNever: number): MineTenantUtilization => ({
  tenant: t, currentTick: 1000, total, harvested: total - never, neverHarvested: never,
  visibleNever: visNever, staleNever: never - visNever, utilizationRate: total > 0 ? (total - never) / total : null,
  medianTimeToFirstHarvest: 3,
  candidates: visNever > 0 ? [{ cell: "1,1", x: 1, y: 1, firstSeenTick: 1, lastSeenTick: 999, seenCount: 2,
    state: "visible", harvestOk: 0, harvestFail: 0, harvestAmount: 0, lastHarvestTick: null,
    firstHarvestTick: null, neverHarvested: true, timeToFirstHarvest: null, activity: 0.1 }] : [],
} as MineTenantUtilization);

const exploration: AllianceExplorationPayload = {
  generatedAt: "", world: { exploredChunks: 100, coveragePct: 0.25, lastSeenTick: 1000 } as never,
  perTenant: { t1: { tenant: "t1", exploredChunks: 54, recentChunks: 54, lastSeenTick: 999, bbox: null as never, exclusiveChunks: 54 } },
  alliance: {} as never, gaps: [], cachedAt: "",
} as AllianceExplorationPayload;

const pipeline: PipelineHealthPayload = {
  generatedAt: "", tenants: [
    { tenant: "t1", lagTicks: 22, health: "OK" } as never,
    { tenant: "t2", lagTicks: 5, health: "OK" } as never,
  ], global: {} as never, surveySync: {} as never, cachedAt: "",
} as PipelineHealthPayload;

test("audit-overview: 单租户折叠 + 全局汇总", () => {
  const decisions: Record<string, DecisionAuditPayload> = { t1: dec("t1", 50, 100, 5) };
  const lifecycles: Record<string, LifecycleAuditPayload> = { t1: lc("t1") };
  const mines: Record<string, MineTenantUtilization> = { t1: mu("t1", 100, 20, 5) };
  const conflicts = { t1: {
    generatedAt: "", tenant: "t1", window: 100, currentTick: 1000,
    applied: 3, rejected: 6, rejectedRate: 0.667,
    topRejectedReasons: [{ reason: "Core is already moving", count: 6, share: 1 }],
    commandKinds: { goal: 2 }, cachedAt: "",
  } } as unknown as Record<string, import("../lib/human-conflict.ts").HumanConflictPayload>;
  const mining = {
    generatedAt: "", currentTick: 1000,
    assignments: [], unassigned: [], cachedAt: "",
    perTenant: { t1: { assigned: 5, avgDistance: 29.2, workers: 13 }, t2: { assigned: 48, avgDistance: 32.5, workers: 12 },
      t3: { assigned: 3, avgDistance: 11.7, workers: 12 }, t4: { assigned: 1, avgDistance: 14, workers: 3 } },
    global: { totalCandidates: 57, assigned: 57, shared: 0, conflict: 0, unassigned: 0 },
  } as unknown as import("../lib/alliance-mining.ts").AllianceMiningPayload;
  const trends = { t1: { coreDelta: 5, coreDeltaPrev: -3, visibleNever: 6, visibleNeverPrev: 12, stallRate: 0.5 } };
  const miningEff = { global: { assigned: 3, harvested: 1, harvestedByOther: 0, open: 2, stale: 0, effectiveRate: 1 } } as unknown as import("../lib/mining-effectiveness.ts").MiningEffectivenessPayload;
  const a = aggregateAuditOverview(decisions, lifecycles, mines, exploration, pipeline, conflicts, mining, miningEff, null, trends);
  const t1 = a.tenants.t1;
  assert.ok(t1);
  assert.equal(t1.decisions?.stallTicks, 50);
  // miningEff 传入后 global 暴露兑现汇总
  assert.equal(a.global.miningFulfillment?.assigned, 3);
  assert.equal(a.global.alignment, null, "未传 alignment → null");
  assert.equal(t1.decisions?.stallRate, 0.5, "50/100");
  assert.equal(t1.decisions?.coreDelta, 5);
  assert.equal(t1.decisions?.humanApplied, 3);
  assert.equal(t1.lifecycle?.units, 2);
  assert.equal(t1.lifecycle?.alive, 1);
  assert.equal(t1.lifecycle?.destroyed, 1);
  assert.deepEqual(t1.lifecycle?.byType, { WORKER: 1, RANGER: 1 });
  assert.equal(t1.lifecycle?.minesActive, 1);
  assert.equal(t1.lifecycle?.coreCaptures, 2);
  assert.equal(t1.lifecycle?.spendTotal, 10);
  assert.equal(t1.mines?.total, 100);
  assert.equal(t1.mines?.visibleNever, 5);
  assert.equal(t1.mines?.topCandidates.length, 1);
  assert.equal(t1.mines?.topCandidates[0]?.cell, "1,1");
  assert.equal(t1.exploration?.exploredChunks, 54);
  assert.equal(t1.pipeline?.lagTicks, 22);
  assert.equal(a.global.maxLagTicks, 22);
  assert.equal(a.global.totalNeverHarvested, 20);
  assert.equal(a.global.totalVisibleNever, 5);
  assert.equal(a.global.totalUnits, 2);
  assert.equal(a.global.totalCoreDelta, 5);
  assert.equal(a.global.coveragePct, 0.25);
  assert.equal(a.global.currentTick, 1000);
  assert.equal(t1.conflict?.applied, 3);
  assert.equal(t1.conflict?.rejected, 6);
  assert.equal(t1.conflict?.rejectedRate, 0.667);
  assert.equal(t1.conflict?.topRejectedReason, "Core is already moving");
  assert.equal(t1.mining?.assigned, 5);
  assert.equal(t1.mining?.avgDistance, 29.2);
  assert.equal(t1.trend?.coreDelta, 5);
  assert.equal(t1.trend?.coreDeltaPrev, -3);
  assert.equal(t1.trend?.visibleNever, 6);
  assert.equal(t1.trend?.visibleNeverPrev, 12);
  assert.equal(t1.trend?.stallRate, 0.5);
});

test("audit-overview: 空输入兜底", () => {
  const a = aggregateAuditOverview({}, {}, {}, null, null, {});
  assert.equal(a.tenants.t1.decisions, null);
  assert.equal(a.tenants.t1.lifecycle, null);
  assert.equal(a.tenants.t1.mines, null);
  assert.equal(a.global.maxLagTicks, null);
  assert.equal(a.global.totalUnits, 0);
  assert.equal(a.global.coveragePct, null);
  assert.equal(a.tenants.t1.conflict, null);
  assert.equal(a.tenants.t1.mining, null);
  assert.equal(a.tenants.t1.trend, null);
});
