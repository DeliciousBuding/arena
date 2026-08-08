/**
 * 决策-分配对齐审计（2026-08-08，综合决策 + 执行闭环）：把决策审计的采集动作
 * 占比与矿缺口/分工兑现对齐——回答"分配了为什么没人采"的决策侧根因。
 *
 * 单调用组合（全部复用 30s 缓存，只读，无新增 I/O）：
 *   - decision-audit：harvest/deposit 动作占比（决策在不在产采集）；
 *   - mine-utilization：visibleNever 矿缺口 + 缺口趋势；
 *   - mining-effectiveness：assigned/open/stale/harvested 分工兑现。
 * 输出（/api/audit/alignment）：每租户 grade（aligned / gap_widening /
 * allocation_unfulfilled / data_gap）+ reasons（中文归因）+ 全局对齐统计。
 */
import { TENANTS } from "./fs-jsonl.ts";
import { TtlCache } from "./cache.ts";
import { loadDecisionAudit, type DecisionAuditPayload } from "./decision-audit.ts";
import { loadMineUtilization, type MineUtilizationPayload } from "./mine-utilization.ts";
import { loadMiningEffectiveness, type MiningEffectivenessPayload } from "./mining-effectiveness.ts";
import { loadMineUtilizationTrend } from "./mine-utilization.ts";

const TTL_MS = 30_000;
const cache = new TtlCache<AlignmentPayload>(TTL_MS);

export type AlignmentGrade = "aligned" | "gap_widening" | "allocation_unfulfilled" | "data_gap";

export interface TenantAlignment {
  tenant: string;
  /** 采集动作占全部动作比例（决策在不在产采集）。 */
  harvestActionRate: number | null;
  depositActionRate: number | null;
  /** 矿缺口（可见未开采）。 */
  visibleNever: number;
  /** 缺口趋势（最新 vs 前一窗口，正=扩大）。 */
  gapTrendDelta: number | null;
  /** 分工兑现。 */
  assigned: number;
  open: number;
  stale: number;
  harvested: number;
  grade: AlignmentGrade;
  reasons: string[];
}

export interface AlignmentPayload {
  generatedAt: string;
  tenants: Record<string, TenantAlignment>;
  global: {
    aligned: number;
    misaligned: number;
    dataGap: number;
    /** 全联盟未兑现分工数。 */
    unfulfilledAssignments: number;
  };
  cachedAt: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

/** 纯函数（可测）：决策审计 + 矿缺口 + 分工兑现 → 对齐评分。 */
export function aggregateAlignment(
  decisions: Record<string, DecisionAuditPayload>,
  mines: MineUtilizationPayload["tenants"],
  effectiveness: MiningEffectivenessPayload | null,
  trends: Record<string, { visibleNever: number; visibleNeverPrev: number }> = {},
): AlignmentPayload {
  const tenants: Record<string, TenantAlignment> = {};
  let alignedN = 0, misalignedN = 0, dataGapN = 0, unfulfilled = 0;
  for (const t of TENANTS) {
    const dec = decisions[t]?.decision;
    const am = (dec?.actionMix ?? {}) as Record<string, number>;
    const total = num(am.move) + num(am.harvest) + num(am.deposit) + num(am.wait) + num(am.repair);
    const harvestRate = total > 0 ? num(am.harvest) / total : null;
    const depositRate = total > 0 ? num(am.deposit) / total : null;
    const mu = mines[t];
    const visibleNever = num(mu?.visibleNever);
    const eff = effectiveness?.perTenant?.[t];
    const assigned = num(eff?.assigned);
    const open = num(eff?.open);
    const stale = num(eff?.stale);
    const harvested = num(eff?.harvested);
    const tr = trends[t];
    const gapTrendDelta = tr && typeof tr.visibleNever === "number" && typeof tr.visibleNeverPrev === "number"
      ? tr.visibleNever - tr.visibleNeverPrev : null;

    const reasons: string[] = [];
    let grade: AlignmentGrade = "aligned";
    if (harvestRate === null && assigned === 0 && visibleNever === 0) {
      grade = "data_gap";
    } else {
      if (assigned > 0 && harvested === 0 && open + stale > 0) {
        grade = "allocation_unfulfilled";
        reasons.push(`分工 ${assigned} 矿 0 兑现（${open} 在途${stale > 0 ? `/${stale} 失效` : ""}）——需派 worker`);
        unfulfilled += 1;
      }
      if (visibleNever >= 10 && (harvestRate ?? 0) < 0.3) {
        if (grade === "aligned") grade = "gap_widening";
        reasons.push(`缺口 ${visibleNever} 但采集动作占比 ${harvestRate === null ? "-" : (harvestRate * 100).toFixed(0)}%——决策未对齐矿分配`);
      }
      if (gapTrendDelta !== null && gapTrendDelta > 0) {
        reasons.push(`缺口较上窗口 +${gapTrendDelta}`);
      }
      if (grade === "aligned" && reasons.length === 0 && harvestRate !== null) {
        reasons.push(`采集占比 ${(harvestRate * 100).toFixed(0)}%，缺口 ${visibleNever}——对齐`);
      }
      if (grade === "aligned") alignedN += 1; else misalignedN += 1;
    }
    if (grade === "data_gap") dataGapN += 1;

    tenants[t] = {
      tenant: t,
      harvestActionRate: harvestRate === null ? null : Math.round(harvestRate * 1000) / 1000,
      depositActionRate: depositRate === null ? null : Math.round(depositRate * 1000) / 1000,
      visibleNever,
      gapTrendDelta,
      assigned,
      open,
      stale,
      harvested,
      grade,
      reasons,
    };
  }
  return {
    generatedAt: new Date().toISOString(),
    tenants,
    global: { aligned: alignedN, misaligned: misalignedN, dataGap: dataGapN, unfulfilledAssignments: unfulfilled },
    cachedAt: new Date().toISOString(),
  };
}

export function loadAlignmentAudit(): AlignmentPayload {
  const key = "alignment";
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const decisions = loadDecisionAudit("all") as Record<string, DecisionAuditPayload>;
  const mines = loadMineUtilization("all") as MineUtilizationPayload;
  const effectiveness = loadMiningEffectiveness();
  const trends: Record<string, { visibleNever: number; visibleNeverPrev: number }> = {};
  for (const t of TENANTS) {
    try {
      const mt = loadMineUtilizationTrend(t, 2000, 3);
      const last = mt.trend[mt.trend.length - 1];
      const prev = mt.trend[mt.trend.length - 2];
      if (last) trends[t] = { visibleNever: num(last.visibleNever), visibleNeverPrev: num(prev?.visibleNever) };
    } catch { /* 趋势不可用跳过 */ }
  }
  const payload = aggregateAlignment(decisions, mines.tenants, effectiveness, trends);
  cache.set(key, payload);
  return payload;
}

/** 启动预热一次（不进周期循环；过期后请求惰性刷新）。 */
export function warmAlignmentAudit(): void {
  loadAlignmentAudit();
}
