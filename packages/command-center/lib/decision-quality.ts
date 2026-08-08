/**
 * 综合决策质量分（2026-08-08，综合决策层）：把决策-结果审计的关键健康信号合成
 * 0-100 分——空转率 30 + 满载率 20 + 规划波动 15 + 核心增长 15 + 分工兑现 20。
 *  grade：A ≥80 / B 60-79 / C 40-59 / D <40；数据缺项按可用权重归一。
 *  纯函数可测，供 audit-overview 单调用（前端"综合决策"卡片 + 决策线门禁）。
 */
export interface DecisionQuality {
  score: number;
  grade: "A" | "B" | "C" | "D";
  parts: { stall: number; cargo: number; churn: number; growth: number; fulfillment: number };
  /** 中文归因（改善项/恶化项），供日记/参谋可读。 */
  reasons: string[];
}

export interface QualityInput {
  /** WAIT 空转占比 0-1（越高越差）。 */
  stallRate: number | null;
  /** 满载率 0-1（越高越好）。 */
  cargoEff: number | null;
  /** 规划波动率 0-1（越高越乱）。 */
  planChurn: number | null;
  /** 窗口核心净增（≥0 越好）。 */
  coreDelta: number | null;
  /** 分工兑现率 0-1（本租户采到/全部分工）。 */
  effectiveRate: number | null;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** 纯函数（可测）：健康信号 → 0-100 分 + 等级 + 归因。 */
export function computeDecisionQuality(inp: QualityInput): DecisionQuality {
  const stall = inp.stallRate === null ? null : Math.round((1 - clamp01(inp.stallRate)) * 30);
  const cargo = inp.cargoEff === null ? null : Math.round(clamp01(inp.cargoEff) * 20);
  const churn = inp.planChurn === null ? null : Math.round((1 - clamp01(inp.planChurn)) * 15);
  const growth = inp.coreDelta === null ? 0 : Math.round(clamp01(inp.coreDelta / 10) * 15);
  const fulfillment = inp.effectiveRate === null ? null : Math.round(clamp01(inp.effectiveRate) * 20);
  const maxParts = (stall !== null ? 30 : 0) + (cargo !== null ? 20 : 0) + (churn !== null ? 15 : 0) + 15 + (fulfillment !== null ? 20 : 0);
  const sum = (stall ?? 0) + (cargo ?? 0) + (churn ?? 0) + growth + (fulfillment ?? 0);
  const score = maxParts > 0 ? Math.round((sum / maxParts) * 100) : 0;
  const grade: DecisionQuality["grade"] = score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : "D";
  const reasons: string[] = [];
  if (inp.stallRate !== null && inp.stallRate >= 0.9) reasons.push("空转率过高");
  if (inp.stallRate !== null && inp.stallRate < 0.3) reasons.push("决策活跃");
  if (inp.cargoEff !== null && inp.cargoEff < 0.25) reasons.push("满载率低（搬运瓶颈）");
  if (inp.planChurn !== null && inp.planChurn >= 0.9) reasons.push("规划高频波动");
  if (inp.coreDelta !== null && inp.coreDelta < 0) reasons.push("核心负增长");
  if (inp.coreDelta !== null && inp.coreDelta > 0) reasons.push("核心正增长");
  if (inp.effectiveRate !== null && inp.effectiveRate === 0) reasons.push("分工零兑现");
  if (inp.effectiveRate !== null && inp.effectiveRate > 0.5) reasons.push("分工兑现良好");
  return { score, grade, parts: { stall: stall ?? 0, cargo: cargo ?? 0, churn: churn ?? 0, growth, fulfillment: fulfillment ?? 0 }, reasons };
}

/** 多租户 → 联盟平均分（有数据的租户等权平均）。 */
export function aggregateQuality(scores: ReadonlyArray<DecisionQuality | null>): DecisionQuality | null {
  const valid = scores.filter((s): s is DecisionQuality => s !== null && s.score >= 0);
  if (valid.length === 0) return null;
  const score = Math.round(valid.reduce((a, s) => a + s.score, 0) / valid.length);
  const grade: DecisionQuality["grade"] = score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : "D";
  const reasons: string[] = [];
  const stall = valid.reduce((a, s) => a + s.parts.stall, 0) / valid.length;
  const cargo = valid.reduce((a, s) => a + s.parts.cargo, 0) / valid.length;
  const churn = valid.reduce((a, s) => a + s.parts.churn, 0) / valid.length;
  const growth = valid.reduce((a, s) => a + s.parts.growth, 0) / valid.length;
  const fulfillment = valid.reduce((a, s) => a + s.parts.fulfillment, 0) / valid.length;
  if (stall <= 5) reasons.push("整体空转低");
  if (cargo <= 4) reasons.push("整体满载率低");
  if (fulfillment === 0) reasons.push("分工全未兑现");
  return { score, grade, parts: { stall: Math.round(stall), cargo: Math.round(cargo), churn: Math.round(churn), growth: Math.round(growth), fulfillment: Math.round(fulfillment) }, reasons };
}
