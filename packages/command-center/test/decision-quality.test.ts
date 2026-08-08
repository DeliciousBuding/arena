/**
 * 综合决策质量分测试（2026-08-08）：computeDecisionQuality 权重合成 + 等级 + 归因；
 * aggregateQuality 联盟平均。空转/满载/波动/增长/兑现各维度。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeDecisionQuality, aggregateQuality } from "../lib/decision-quality.ts";

test("decision-quality: 健康信号 → 高分 A", () => {
  const q = computeDecisionQuality({ stallRate: 0.1, cargoEff: 0.8, planChurn: 0.2, coreDelta: 8, effectiveRate: 0.9 });
  assert.ok(q.score >= 80, `score=${q.score}`);
  assert.equal(q.grade, "A");
  assert.ok(q.reasons.includes("决策活跃"));
  assert.ok(q.reasons.includes("核心正增长"));
  assert.ok(q.reasons.includes("分工兑现良好"));
});

test("decision-quality: 恶化信号 → 低分 D + 归因", () => {
  const q = computeDecisionQuality({ stallRate: 0.95, cargoEff: 0.1, planChurn: 0.98, coreDelta: -5, effectiveRate: 0 });
  assert.ok(q.score < 40, `score=${q.score}`);
  assert.equal(q.grade, "D");
  assert.ok(q.reasons.includes("空转率过高"));
  assert.ok(q.reasons.includes("满载率低（搬运瓶颈）"));
  assert.ok(q.reasons.includes("规划高频波动"));
  assert.ok(q.reasons.includes("核心负增长"));
  assert.ok(q.reasons.includes("分工零兑现"));
});

test("decision-quality: 数据缺项按可用权重归一 + 空输入兜底", () => {
  const q = computeDecisionQuality({ stallRate: 0, cargoEff: null, planChurn: null, coreDelta: 0, effectiveRate: null });
  // 可用权重 30 + 15 = 45；stall 满分 30 + growth 0 → 30/45 ≈ 67
  assert.ok(q.score >= 55 && q.score <= 75, `score=${q.score}`);
  assert.equal(q.grade, "B");
  const agg = aggregateQuality([q, null]);
  assert.ok(agg && agg.score === q.score, "单租户平均 = 自身");
  assert.equal(aggregateQuality([]), null, "无有效租户 → null");
});
