/**
 * 日记层测试（2026-08-08）：buildAllianceCoverageLine——共享测绘覆盖摘要。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAllianceCoverageLine, buildDecisionHealthLine } from "../lib/deeds-journal.ts";
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
