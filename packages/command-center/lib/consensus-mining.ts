/**
 * 全联盟矿 + 分工兑现标注（2026-08-08，共享测绘设计增强）：把共识矿视图
 * （alliance/survey consensusResources）与分工兑现状态（mining-effectiveness）
 * 按格 join——前端"全联盟矿"地图层直接拿到"已分工未采/已采/在途"标注 +
 * gapAge（发现后仍未采时长），不用跨三个端点自己拼。
 *
 * 独立薄模块（避免 alliance-survey ↔ alliance-mining 循环依赖）：只 import
 * 两个缓存加载器，纯函数 join 可测。只读，30s 惰性缓存 + 启动预热，不进周期循环。
 * 输出（/api/alliance/survey/mining）：
 *   - resources：共识矿每条附 assignedTenant / miningStatus / gapAgeTicks（未分工=null）；
 *   - summary：assigned / open / stale / harvested + topStale（最积压分工矿 top 10）；
 *   - colors：租户色透传。
 */
import { TENANTS } from "./fs-jsonl.ts";
import { TtlCache } from "./cache.ts";
import { loadAllianceSurvey, type AllianceSurveyPayload, type TenantSummary } from "./alliance-survey.ts";
import { loadMiningEffectiveness, type MiningEffectivenessPayload } from "./mining-effectiveness.ts";
import { loadMineUtilization, type MineUtilizationPayload } from "./mine-utilization.ts";
import { loadEnemyHeat } from "./enemy-heat.ts";

const TTL_MS = 30_000;
const cache = new TtlCache<ConsensusMiningPayload>(TTL_MS);

export interface ConsensusMineEntry extends Record<string, unknown> {
  x: number;
  y: number;
  cell: string;
  assignedTenant: string | null;
  miningStatus: "harvested" | "harvestedByOther" | "open" | "stale" | null;
  gapAgeTicks: number | null;
  /** 敌情威胁（2026-08-08）：enemy-heat 桶 combat 分级 0-3 + combat 目击数。 */
  threatLevel: 0 | 1 | 2 | 3;
  threatCombat: number;
}

export interface ConsensusMiningSummary {
  assigned: number;
  open: number;
  stale: number;
  harvested: number;
  harvestedByOther: number;
  /** 高危矿数（2026-08-08，threatLevel >= 2）——地图标红/决策规避。 */
  highThreat: number;
  /** 最积压分工矿 top N（gapAge 降序）——前端标"优先清积压"。 */
  topStale: Array<{ cell: string; x: number; y: number; assignedTenant: string; gapAgeTicks: number | null }>;
}

export interface ConsensusMiningPayload {
  generatedAt: string;
  resources: ConsensusMineEntry[];
  summary: ConsensusMiningSummary;
  colors: Record<string, string>;
  tenantSummaries: Record<string, TenantSummary>;
  cachedAt: string;
}

/** 纯函数（可测）：共识矿 + 分工兑现 → 标注后的全联盟矿视图。 */
export function enrichConsensusMining(
  survey: AllianceSurveyPayload | null,
  effectiveness: MiningEffectivenessPayload | null,
  mines: MineUtilizationPayload | null = null,
  heatByBucket: Record<string, { combatCount: number; count: number; lastTick: number }> = {},
): Omit<ConsensusMiningPayload, "generatedAt" | "cachedAt"> {
  const byCell = new Map<string, { assignedTenant: string; status: string; gapAge: number | null }>();
  for (const it of effectiveness?.items ?? []) {
    byCell.set(it.cell, { assignedTenant: it.assignedTenant, status: it.status, gapAge: null });
  }
  // gapAge（发现后仍未采时长）来自 mine-utilization 候选（mining-effectiveness 事件流无首见 tick）
  for (const t of TENANTS) {
    for (const c of mines?.tenants?.[t]?.candidates ?? []) {
      const cur = byCell.get(c.cell);
      if (!cur) continue;
      const g = Number(c.gapAgeTicks) || 0;
      if (g > (cur.gapAge ?? 0)) cur.gapAge = g;
    }
  }
  const resources: ConsensusMineEntry[] = [];
  let assigned = 0, open = 0, stale = 0, harvested = 0, harvestedByOther = 0, highThreat = 0;
  const topStale: ConsensusMiningSummary["topStale"] = [];
  for (const r of survey?.consensusResources ?? []) {
    const x = Number(r.x ?? 0);
    const y = Number(r.y ?? 0);
    const cell = `${x},${y}`;
    const m = byCell.get(cell);
    const status = (m?.status as ConsensusMineEntry["miningStatus"]) ?? null;
    const hb = heatByBucket[`${Math.floor(x / 16)},${Math.floor(y / 16)}`];
    const combat = hb?.combatCount ?? 0;
    const threatLevel: 0 | 1 | 2 | 3 = combat >= 10 ? 3 : combat >= 3 ? 2 : combat >= 1 ? 1 : 0;
    if (threatLevel >= 2) highThreat += 1;
    if (status === "open") open += 1;
    else if (status === "stale") stale += 1;
    else if (status === "harvested") harvested += 1;
    else if (status === "harvestedByOther") harvestedByOther += 1;
    if (status !== null) assigned += 1;
    if (status === "open" || status === "stale") {
      topStale.push({ cell, x, y, assignedTenant: m?.assignedTenant ?? "", gapAgeTicks: m?.gapAge ?? null });
    }
    resources.push({ ...r, cell, x, y, assignedTenant: m?.assignedTenant ?? null, miningStatus: status, gapAgeTicks: m?.gapAge ?? null, threatLevel, threatCombat: combat });
  }
  topStale.sort((a, b) => ((b.gapAgeTicks ?? 0) - (a.gapAgeTicks ?? 0)) || (a.x - b.x) || (a.y - b.y));
  return {
    resources,
    summary: { assigned, open, stale, harvested, harvestedByOther, highThreat, topStale: topStale.slice(0, 10) },
    colors: survey?.colors ?? {},
    tenantSummaries: survey?.tenantSummaries ?? {},
  };
}

export function loadConsensusMining(): ConsensusMiningPayload {
  const key = "consensus-mining";
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const survey = loadAllianceSurvey();
  const effectiveness = loadMiningEffectiveness();
  const mines = loadMineUtilization("all");
  const heatByBucket: Record<string, { combatCount: number; count: number; lastTick: number }> = {};
  try {
    for (const b of loadEnemyHeat("all").buckets ?? []) {
      const k = `${b.bx},${b.by}`;
      const cur = heatByBucket[k] ?? { combatCount: 0, count: 0, lastTick: 0 };
      cur.combatCount += Number(b.combatCount) || 0;
      cur.count += Number(b.count) || 0;
      heatByBucket[k] = cur;
    }
  } catch { /* 热区不可用不阻断 */ }
  const body = enrichConsensusMining(survey, effectiveness, mines, heatByBucket);
  const payload: ConsensusMiningPayload = {
    generatedAt: new Date().toISOString(),
    ...body,
    cachedAt: new Date().toISOString(),
  };
  cache.set(key, payload);
  return payload;
}

/** 启动预热一次（不进周期循环；过期后请求惰性刷新）。 */
export function warmConsensusMining(): void {
  loadConsensusMining();
}
