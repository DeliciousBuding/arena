/**
 * 联盟共享测绘聚合（2026-08-08）：聚合四租户 survey-db（敌核/矿/障碍/探索分区
 * + 生命周期摘要），带租户色与证据来源——地图「全联盟」层数据源。
 *
 * 数据源复用 loadTenantSurveyCached（已带 60s 缓存 + 30s 后台刷新），本模块
 * 再做 30s 聚合缓存：前端轮询 /api/alliance/survey 毫秒级返回，不实时扫库。
 */
import { TENANTS } from "./fs-jsonl.ts";
import { loadTenantSurveyCached } from "./survey-cache.ts";
import { TtlCache } from "./cache.ts";

/** 租户区分色（前端地图/卡片/树目录共用，t1 绿 / t2 蓝 / t3 琥珀 / t4 粉）。 */
export const TENANT_COLORS: Record<string, string> = {
  t1: "#22c55e",
  t2: "#3b82f6",
  t3: "#f59e0b",
  t4: "#ec4899",
};

export interface TenantSummary {
  caseCount: number;
  tickMax: number;
  resources: number;
  obstacles: number;
  cores: number;
  chunks: number;
}

export interface AllianceSurveyPayload {
  generatedAt: string;
  colors: Record<string, string>;
  tenantSummaries: Record<string, TenantSummary>;
  enemyCores: Array<Record<string, unknown>>;
  resources: Array<Record<string, unknown>>;
  obstacles: Array<Record<string, unknown>>;
  chunks: Array<Record<string, unknown>>;
  lifecycle: Record<string, Record<string, unknown> | null>;
  cachedAt: string;
}

const ALLIANCE_SURVEY_TTL_MS = 30_000;
const allianceSurveyCache = new TtlCache<AllianceSurveyPayload>(ALLIANCE_SURVEY_TTL_MS);

export function loadAllianceSurvey(): AllianceSurveyPayload {
  const hit = allianceSurveyCache.get("all");
  if (hit !== undefined) return hit;
  const colors = { ...TENANT_COLORS };
  const tenantSummaries: Record<string, TenantSummary> = {};
  const enemyCores: Array<Record<string, unknown>> = [];
  const resources: Array<Record<string, unknown>> = [];
  const obstacles: Array<Record<string, unknown>> = [];
  const chunks: Array<Record<string, unknown>> = [];
  const lifecycle: Record<string, Record<string, unknown> | null> = {};
  let cachedAt = "";
  for (const t of TENANTS) {
    const c = loadTenantSurveyCached(t);
    cachedAt = c.cachedAt;
    const s = c.survey;
    tenantSummaries[t] = {
      caseCount: s?.caseCount ?? 0,
      tickMax: s?.tickMax ?? 0,
      resources: s?.resourceCells.length ?? 0,
      obstacles: s?.obstacleCells.length ?? 0,
      cores: s?.coreCells.length ?? 0,
      chunks: c.chunks.length,
    };
    for (const r of s?.resourceCells ?? []) resources.push({ tenant: t, ...r });
    for (const o of s?.obstacleCells ?? []) obstacles.push({ tenant: t, ...o });
    for (const k of s?.coreCells ?? []) enemyCores.push({ tenant: t, ...k });
    for (const ch of c.chunks) chunks.push({ tenant: t, ...ch });
    lifecycle[t] = c.lifecycle;
  }
  const payload: AllianceSurveyPayload = {
    generatedAt: new Date().toISOString(),
    colors,
    tenantSummaries,
    enemyCores,
    resources,
    obstacles,
    chunks,
    lifecycle,
    cachedAt,
  };
  allianceSurveyCache.set("all", payload);
  return payload;
}

/** 后台预热（启动时调用，与 intel/survey 缓存一致，前端首开即命中）。 */
export function refreshAllianceSurvey(): void {
  loadAllianceSurvey();
}
