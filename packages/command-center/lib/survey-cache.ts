/** 测绘数据内存缓存（2026-08-08，UX 优化）：/api/survey、/api/exploration
 *  从落盘 DB 实时读（首次 1.7-16s，用户反馈"等待测绘数据/卡"）——改为内存
 *  缓存 + 后台定时刷新，前端请求毫秒级返回。TTL 30s（生产 tick 持续增长，
 *  测绘新鲜度 30s 足够；与 watchdog survey:sync 增量节奏匹配）。 */
import { loadChunksDb, loadLifecycleDb, loadSpendTrend, loadSurveyDb, loadUnitLifecycleDb, type SurveyData } from "./survey.ts";
import { TENANTS } from "./fs-jsonl.ts";

export interface TenantSurveyCache {
  survey: SurveyData | null;
  lifecycle: Record<string, unknown> | null;
  spendsTrend: Array<Record<string, unknown>>;
  unitsDetail: Array<Record<string, unknown>>;
  chunks: Array<Record<string, unknown>>;
  /** 内存态生成时间（ISO）。 */
  cachedAt: string;
}

const SURVEY_TTL_MS = 60_000; // 请求侧 TTL 60s；刷新循环 30s 主动预热，请求永远命中缓存
const surveyCache = new Map<string, { v: TenantSurveyCache; at: number }>();

/** 读某租户测绘缓存（TTL 内命中，过期重载）。 */
export function loadTenantSurveyCached(tenant: string): TenantSurveyCache {
  const hit = surveyCache.get(tenant);
  if (hit && Date.now() - hit.at < SURVEY_TTL_MS) return hit.v;
  const v: TenantSurveyCache = {
    survey: loadSurveyDb(tenant),
    lifecycle: loadLifecycleDb(tenant),
    spendsTrend: loadSpendTrend(tenant, 1000),
    unitsDetail: loadUnitLifecycleDb(tenant, 500),
    chunks: loadChunksDb(tenant, 20_000),
    cachedAt: new Date().toISOString(),
  };
  surveyCache.set(tenant, { v, at: Date.now() });
  return v;
}

/** 后台预热/刷新全部租户（启动后 + 定时器调用，不阻塞请求）。 */
export function refreshSurveyCache(): void {
  for (const t of TENANTS) loadTenantSurveyCached(t);
}

/** 启动后台刷新循环（返回 timer 供测试清理）。 */
export function startSurveyCacheLoop(intervalMs = 30_000): NodeJS.Timeout {
  setTimeout(refreshSurveyCache, 0); // 启动即后台预热，不阻塞首次 listen（2026-08-08）
  return setInterval(refreshSurveyCache, intervalMs);
}
