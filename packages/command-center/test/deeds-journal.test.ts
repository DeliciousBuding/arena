/**
 * 日记层测试（2026-08-08）：buildAllianceCoverageLine——共享测绘覆盖摘要。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAllianceCoverageLine, buildDecisionHealthLine, buildThreatJournalLine, buildMiningExecutionLine, buildPipelineHealthLine } from "../lib/deeds-journal.ts";
import type { PipelineHealthPayload } from "../lib/pipeline-health.ts";
import type { LeaderboardIntel } from "../lib/leaderboard.ts";
import type { EncounterEntry } from "../lib/intel.ts";
import type { AuditOverviewPayload } from "../lib/audit-overview.ts";
import type { AllianceExplorationPayload } from "../lib/exploration-coverage.ts";

const exp = (over: Partial<AllianceExplorationPayload>): AllianceExplorationPayload => ({
  generatedAt: "",
  world: { chunkSize: 16, observedSpan: { minCx: -2, maxCx: 2, minCy: -2, maxCy: 2 }, spanChunks: 25, exploredChunks: 7, coveragePct: 28 },
  perTenant: { t1: { tenant: "t1", exploredChunks: 4, recentChunks: 4, lastSeenTick: 1000, bbox: null as never, exclusiveChunks: 4 } },
  alliance: {} as never,
  gaps: [{ cx: 0, cy: 0, nearCoreOf: "t1", distChunks: 2, corePos: [0, 0] }],
  cachedAt: "",
  ...over,
} as AllianceExplorationPayload);

test("deeds-journal: 联盟测绘覆盖摘要", () => {
  const line = buildAllianceCoverageLine(exp({}));
  assert.ok(line && line.includes("联盟测绘"), "应生成测绘行");
  assert.ok(line && line.includes("覆盖 28%"), "覆盖百分比");
  assert.ok(line && line.includes("7/25 区块"), "区块数");
  assert.ok(line && line.includes("T1 4"), "各租户区块");
  assert.ok(line && line.includes("盲区 1 处"), "盲区数");
});

test("deeds-journal: 覆盖摘要空兜底", () => {
  assert.equal(buildAllianceCoverageLine(null), null, "空输入 → null");
  assert.equal(buildAllianceCoverageLine(exp({ world: { chunkSize: 16, observedSpan: { minCx: 0, maxCx: 0, minCy: 0, maxCy: 0 }, spanChunks: 1, exploredChunks: 0, coveragePct: 0 } })), null, "0 探索 → null");
});

test("deeds-journal: 决策健康摘要", () => {
  const ov = {
    generatedAt: "", cachedAt: "",
    tenants: {
      t1: { tenant: "t1", quality: { score: 19, grade: "D", parts: { stall: 0, cargo: 0, churn: 0, growth: 0, fulfillment: 0 }, reasons: ["空转率过高"] } },
      t2: { tenant: "t2", quality: { score: 80, grade: "A", parts: { stall: 30, cargo: 20, churn: 15, growth: 15, fulfillment: 0 }, reasons: ["决策活跃"] } },
    },
    global: { quality: { score: 50, grade: "C", parts: { stall: 15, cargo: 10, churn: 8, growth: 8, fulfillment: 9 }, reasons: ["分工零兑现"] } },
  } as unknown as AuditOverviewPayload;
  const line = buildDecisionHealthLine(ov);
  assert.ok(line && line.includes("决策健康"), "应生成决策健康行");
  assert.ok(line && line.includes("T1 19D"), "逐租户质量分");
  assert.ok(line && line.includes("T2 80A"), "高分租户");
  assert.ok(line && line.includes("联盟 50C"), "联盟平均");
  assert.ok(line && line.includes("分工零兑现"), "最差归因");
  assert.equal(buildDecisionHealthLine(null), null, "空输入 → null");
  assert.equal(buildDecisionHealthLine({ generatedAt: "", cachedAt: "", tenants: {}, global: {} } as unknown as AuditOverviewPayload), null, "无质量数据 → null");
});

test("deeds-journal: 敌情威胁摘要——高威胁遭遇 + 猛攻蛆", () => {
  const lb = {
    generatedAt: "", snapshot: "", snapshotAt: "", ageSeconds: 0, stale: false,
    beacon_ticks_held: [], damage_dealt: [], core_destruction_participations: [],
    profiles: [
      { username: "jerkman", rank: 2, damage: 2743, tier: "ELITE_AGGRESSOR" },
      { username: "majorcycle", rank: 5, damage: 2082, tier: "ELITE_AGGRESSOR" },
      { username: "nobody", rank: 40, damage: 500, tier: "STANDARD" },
    ],
  } as unknown as LeaderboardIntel;
  const enc = new Map<string, EncounterEntry[]>([
    ["majorcycle", [{ tenant: "t4", lastSeenTick: 72766, distanceToFriendlyCore: 6, raidRisk: "CRITICAL" }]],
    ["jerkman", [{ tenant: "t2", lastSeenTick: 72645, distanceToFriendlyCore: 4, raidRisk: "HIGH" }]],
    ["nobody", [{ tenant: "t1", lastSeenTick: 70000, distanceToFriendlyCore: 99, raidRisk: "LOW" }]],
  ]);
  const line = buildThreatJournalLine(lb, enc);
  assert.ok(line && line.includes("敌情"), "应生成敌情行");
  assert.ok(line && line.includes("高威胁遭遇"), "高威胁遭遇前缀");
  assert.ok(line && line.includes("majorcycle@T4距核6"), "CRITICAL 且距核近优先");
  assert.ok(line && line.includes("jerkman@T2距核4"), "HIGH 遭遇");
  assert.ok(line && line.includes("猛攻蛆 2 人"), "ELITE_AGGRESSOR 计数");
  assert.ok(line && line.includes("jerkman/majorcycle"), "猛攻蛆名单");
});

test("deeds-journal: 敌情摘要空兜底——无高威胁且无精英 → null", () => {
  const lb = { generatedAt: "", snapshot: "", snapshotAt: "", ageSeconds: 0, stale: false,
    beacon_ticks_held: [], damage_dealt: [], core_destruction_participations: [],
    profiles: [{ username: "nobody", rank: 40, damage: 500, tier: "STANDARD" }] } as unknown as LeaderboardIntel;
  const enc = new Map<string, EncounterEntry[]>([
    ["nobody", [{ tenant: "t1", lastSeenTick: 70000, distanceToFriendlyCore: 99, raidRisk: "LOW" }]],
  ]);
  assert.equal(buildThreatJournalLine(lb, enc), null, "无高威胁无精英 → null");
  assert.equal(buildThreatJournalLine(null, new Map()), null, "全空 → null");
});

test("deeds-journal: 采矿执行摘要——矿总量/未采/失联 + 分工兑现", () => {
  const ov = {
    generatedAt: "", cachedAt: "",
    tenants: {
      t1: { tenant: "t1", mines: { total: 328, neverHarvested: 28, visibleNever: 6, overdueRefills: 105 } },
      t2: { tenant: "t2", mines: { total: 200, neverHarvested: 59, visibleNever: 59, overdueRefills: 0 } },
    },
    global: { miningFulfillment: { assigned: 79, harvested: 0, harvestedByOther: 0, open: 79, stale: 0, effectiveRate: 0 } },
  } as unknown as AuditOverviewPayload;
  const line = buildMiningExecutionLine(ov);
  assert.ok(line && line.includes("采矿执行"), "应生成采矿执行行");
  assert.ok(line && line.includes("T1 矿328/未采28/可见未采6/失联105"), "t1 矿总量+缺口");
  assert.ok(line && line.includes("T2 矿200/未采59/可见未采59"), "t2 矿缺口");
  assert.ok(line && line.includes("分工 79 已采 0 在途 79"), "分工兑现");
  assert.ok(line && line.includes("兑现率 0%"), "effectiveRate");
  assert.equal(buildMiningExecutionLine(null), null, "空输入 → null");
});

test("deeds-journal: 管线健康摘要——滞后 + 生命周期闭环 + 陈旧源", () => {
  const ph = {
    generatedAt: "", cachedAt: "",
    tenants: [], global: {
      maxLagTicks: 25, avgLagTicks: 25, staleTenants: [], missingTenants: [], healthy: true,
      lagTrend: { direction: "narrowing", delta: -5, samples: 4 },
      sources: [{ name: "world", ageSeconds: 1, stale: false, detail: "1s" }, { name: "leaderboard", ageSeconds: 2000, stale: true, detail: "2000s" }],
      lifecycleFlow: "OK",
    },
  } as unknown as PipelineHealthPayload;
  const line = buildPipelineHealthLine(ph);
  assert.ok(line && line.includes("管线健康"), "应生成管线健康行");
  assert.ok(line && line.includes("同步滞后 25 tick"), "滞后");
  assert.ok(line && line.includes("收窄"), "趋势收窄");
  assert.ok(line && line.includes("矿生命周期闭环正常"), "闭环 OK");
  assert.ok(line && line.includes("陈旧源 leaderboard"), "陈旧源");
  const stalled = { ...ph, global: { ...ph.global, lifecycleFlow: "STALLED", staleTenants: ["t3"] } } as unknown as PipelineHealthPayload;
  const sl = buildPipelineHealthLine(stalled);
  assert.ok(sl && sl.includes("STALLED") && sl.includes("t3"), "STALLED + 滞后租户");
  assert.equal(buildPipelineHealthLine(null), null, "空输入 → null");
});
