/**
 * 日记层测试（2026-08-08）：buildAllianceCoverageLine——共享测绘覆盖摘要。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAllianceCoverageLine } from "../lib/deeds-journal.ts";
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
