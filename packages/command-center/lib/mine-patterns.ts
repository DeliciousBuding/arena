/**
 * 矿生命周期模式分析（2026-08-08，共享记忆算法深化）：基于 survey-db
 * resources + resource_events 统计矿格活性/刷新规律/采集成功率——采集规划
 * 的直接输入（哪些矿值得去、哪些是死矿/低频格）。纯只读，30s 缓存。
 *
 * 语义（从现有数据可推导的矿活性信号）：
 *  - 矿龄 ageTicks = last_seen_tick - first_seen_tick（矿格被观察到的时间跨度）；
 *  - 活跃度 = seen_count / max(age,1)（每 tick 看到次数——高活跃 = 高频刷新/
 *    持续存在的富矿格；低活跃 = 一次性/早消失格）；
 *  - 采集成功率 = HARVEST_SUCCEEDED / (SUCCEEDED + FAILED)（资源事件统计，
 *    死矿/竞争格会显现失败）；
 *  - topActive：活跃度 top N 的矿（最近 last_seen 且多次被看到）——采集推荐。
 *
 * 限制：resources 表是每格一行（非出现-消失历史），refill 周期需
 * resource_seen_history 表（采集线演进项，见 alliance-system-research 文档）；
 * 本模块只读现有数据，不阻塞采集线。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_ROOT, TENANTS } from "./fs-jsonl.ts";
import { TtlCache } from "./cache.ts";

export interface MineActiveEntry {
  cell: string;
  x: number;
  y: number;
  seenCount: number;
  ageTicks: number;
  activity: number;
  lastSeenTick: number;
  state: string;
}

export interface MineTenantPattern {
  tenant: string;
  total: number;
  visible: number;
  stale: number;
  avgAgeTicks: number;
  medianSeenCount: number;
  /** 采集成功率（resource_events 统计；无事件 = null）。 */
  harvestSuccessRate: number | null;
  harvestSucceeded: number;
  harvestFailed: number;
  /** 活跃度 top N 矿（采集推荐）。 */
  topActive: readonly MineActiveEntry[];
}

export interface MinePatternsPayload {
  generatedAt: string;
  tenant: string;
  tenants: Record<string, MineTenantPattern>;
  cachedAt: string;
}

const PATTERN_TTL_MS = 30_000;
const patternCache = new TtlCache<MinePatternsPayload>(PATTERN_TTL_MS);

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

function tenantPattern(tenant: string): MineTenantPattern {
  const file = join(DATA_ROOT, "runtime", "survey", tenant + ".db");
  const empty: MineTenantPattern = {
    tenant, total: 0, visible: 0, stale: 0, avgAgeTicks: 0, medianSeenCount: 0,
    harvestSuccessRate: null, harvestSucceeded: 0, harvestFailed: 0, topActive: [],
  };
  if (!existsSync(file)) return empty;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return empty;
  }
  try {
    // 新鲜度窗口与 survey.ts A6 一致（last_seen 超过即历史残留，state=stale）——
    // DB 的 state 列恒 visible（sync 不写 stale），需按 currentTick 动态判定。
    const meta = db.prepare("SELECT MAX(last_tick) AS m FROM sync_meta").get() as { m: number | null };
    const currentTick = num(meta?.m);
    const FRESH = 2000;
    const rows = db.prepare(
      "SELECT x, y, first_seen_tick AS f, last_seen_tick AS l, seen_count AS n, state FROM resources",
    ).all() as Array<{ x: number; y: number; f: number; l: number; n: number; state: string }>;
    const entries: MineActiveEntry[] = [];
    let total = 0, visible = 0, stale = 0, ageSum = 0;
    const seenCounts: number[] = [];
    for (const r of rows) {
      total += 1;
      const state = num(r.l) >= currentTick - FRESH ? "visible" : "stale";
      if (state === "visible") visible += 1;
      else stale += 1;
      const age = Math.max(0, num(r.l) - num(r.f));
      ageSum += age;
      seenCounts.push(num(r.n));
      const n = Math.max(1, num(r.n));
      const activity = n / Math.max(1, age);
      entries.push({ cell: r.x + "," + r.y, x: num(r.x), y: num(r.y), seenCount: num(r.n), ageTicks: age, activity, lastSeenTick: num(r.l), state });
    }
    // topActive 排序（2026-08-08）：近期活跃矿（last_seen 在新鲜窗口内）优先，
    // 再按活性分 + 最近目击——采集推荐给「当前还在的矿」，历史高频但已 stale 的
    // 降级到后段（补位），避免推荐死矿。
    const cutoff = currentTick - FRESH;
    const freshScore = (e: MineActiveEntry): number => (e.lastSeenTick >= cutoff ? 1 : 0);
    entries.sort((a, b) => (freshScore(b) - freshScore(a)) || (b.activity - a.activity) || (b.lastSeenTick - a.lastSeenTick));
    const medianSeenCount = seenCounts.length > 0
      ? seenCounts.slice().sort((a, b) => a - b)[Math.floor(seenCounts.length / 2)]
      : 0;
    const ev = db.prepare(
      "SELECT event_type AS e, COUNT(*) AS c FROM resource_events GROUP BY event_type",
    ).all() as Array<{ e: string; c: number }>;
    let succeeded = 0, failed = 0;
    for (const r of ev) {
      if (r.e === "HARVEST_SUCCEEDED") succeeded = num(r.c);
      else if (r.e === "HARVEST_FAILED") failed = num(r.c);
    }
    const rate = succeeded + failed > 0 ? succeeded / (succeeded + failed) : null;
    return {
      tenant,
      total, visible, stale,
      avgAgeTicks: total > 0 ? Math.round(ageSum / total) : 0,
      medianSeenCount,
      harvestSuccessRate: rate === null ? null : Math.round(rate * 1000) / 1000,
      harvestSucceeded: succeeded,
      harvestFailed: failed,
      topActive: entries.slice(0, 20),
    };
  } catch {
    return empty;
  } finally {
    db.close();
  }
}

/** 矿模式分析：tenant=all 合并四租户，或单租户。30s 缓存。 */
export function loadMinePatterns(tenant = "all"): MinePatternsPayload {
  const key = tenant;
  const hit = patternCache.get(key);
  if (hit !== undefined) return hit;
  const tenants = tenant === "all" ? [...TENANTS] : [tenant];
  const perTenant: Record<string, MineTenantPattern> = {};
  for (const t of tenants) perTenant[t] = tenantPattern(t);
  const payload: MinePatternsPayload = {
    generatedAt: new Date().toISOString(),
    tenant,
    tenants: perTenant,
    cachedAt: new Date().toISOString(),
  };
  patternCache.set(key, payload);
  return payload;
}

/** 后台预热。 */
export function refreshMinePatterns(): void {
  loadMinePatterns("all");
}
