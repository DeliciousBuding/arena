/**
 * 全联盟矿 + 分工兑现标注测试（2026-08-08）：
 * - join：共识矿附 assignedTenant/miningStatus/gapAgeTicks；
 * - summary：assigned/open/stale/harvested 计数 + topStale 积压降序；
 * - 空数据兜底。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { enrichConsensusMining } from "../lib/consensus-mining.ts";

test("consensus-mining: 共识矿 join 分工兑现 + 积压 topStale", () => {
  const survey = {
    colors: { t1: "#69b3d8", t2: "#57bd84" },
    tenantSummaries: { t1: { caseCount: 1, tickMax: 1, resources: 2, obstacles: 0, cores: 0, chunks: 1 } },
    consensusResources: [
      { x: 1, y: 1, tick: 100, tenant: "t1", state: "visible" },
      { x: 2, y: 2, tick: 200, tenant: "t2", state: "visible" },
      { x: 3, y: 3, tick: 300, tenant: "t2", state: "visible" },
    ],
  } as unknown as import("../lib/alliance-survey.ts").AllianceSurveyPayload;
  const effectiveness = {
    items: [
      { cell: "1,1", assignedTenant: "t1", status: "open" },
      { cell: "2,2", assignedTenant: "t2", status: "stale" },
    ],
  } as unknown as import("../lib/mining-effectiveness.ts").MiningEffectivenessPayload;
  const mines = {
    tenants: {
      t1: { candidates: [{ cell: "1,1", gapAgeTicks: 500 }] },
      t2: { candidates: [{ cell: "2,2", gapAgeTicks: 9000 }, { cell: "3,3", gapAgeTicks: 100 }] },
    },
  } as unknown as import("../lib/mine-utilization.ts").MineUtilizationPayload;

  const p = enrichConsensusMining(survey, effectiveness, mines);
  assert.equal(p.resources.length, 3);
  const byCell = Object.fromEntries(p.resources.map((r) => [r.cell, r]));
  assert.equal(byCell["1,1"].assignedTenant, "t1");
  assert.equal(byCell["1,1"].miningStatus, "open");
  assert.equal(byCell["1,1"].gapAgeTicks, 500);
  assert.equal(byCell["2,2"].miningStatus, "stale");
  assert.equal(byCell["2,2"].gapAgeTicks, 9000);
  assert.equal(byCell["3,3"].assignedTenant, null, "未分工");
  assert.equal(byCell["3,3"].miningStatus, null);
  // summary
  assert.equal(p.summary.assigned, 2);
  assert.equal(p.summary.open, 1);
  assert.equal(p.summary.stale, 1);
  assert.equal(p.summary.harvested, 0);
  // topStale：gapAge 降序（2,2 9000 在前）
  assert.equal(p.summary.topStale[0].cell, "2,2");
  assert.equal(p.summary.topStale[0].gapAgeTicks, 9000);
  assert.equal(p.summary.topStale.length, 2);
});

test("consensus-mining: 敌情威胁并入标注", () => {
  const survey = {
    consensusResources: [
      { x: 1, y: 1, tick: 100, tenant: "t1" },    // bucket (0,0) combat 0 → 0
      { x: 17, y: 17, tick: 200, tenant: "t2" },  // bucket (1,1) combat 12 → 3
    ],
  } as unknown as import("../lib/alliance-survey.ts").AllianceSurveyPayload;
  const effectiveness = {
    items: [{ cell: "1,1", assignedTenant: "t1", status: "open" }, { cell: "17,17", assignedTenant: "t2", status: "open" }],
  } as unknown as import("../lib/mining-effectiveness.ts").MiningEffectivenessPayload;
  const heatByBucket: Record<string, { combatCount: number; count: number; lastTick: number }> = {
    "0,0": { combatCount: 0, count: 5, lastTick: 90 },
    "1,1": { combatCount: 12, count: 20, lastTick: 95 },
  };
  const p = enrichConsensusMining(survey, effectiveness, null, heatByBucket);
  const byCell = Object.fromEntries(p.resources.map((r) => [r.cell, r]));
  assert.equal(byCell["1,1"].threatLevel, 0);
  assert.equal(byCell["17,17"].threatLevel, 3);
  assert.equal(byCell["17,17"].threatCombat, 12);
  assert.equal(p.summary.highThreat, 1, "threatLevel>=2 计数");
});

test("consensus-mining: 空数据兜底", () => {
  const p = enrichConsensusMining(null, null, null);
  assert.equal(p.resources.length, 0);
  assert.equal(p.summary.assigned, 0);
  assert.equal(p.summary.topStale.length, 0);
});
