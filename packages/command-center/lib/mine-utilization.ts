/**
 * 矿发现-利用缺口审计（2026-08-08）：直接回答"很多矿发现了却没标注/没分配挖"。
 *
 * 输入：survey-db（共享测绘记录层，只读）——
 *  - resources：每格矿（首/末见 tick、seen_count）；
 *  - resource_events：逐格采集事件（HARVEST_SUCCEEDED/FAILED，tick、amount）。
 * 输出（/api/audit/mines）：
 *  - 每租户汇总：total / harvested / neverHarvested / visibleNever（新鲜窗口内
 *    可见但从未采集 → 应立即分配）/ staleNever；利用率 = harvested/total；
 *  - candidates：可见未开采矿列表（lastSeen 降序）——前端标"已发现未开采"；
 *  - 发现→首次采集耗时（timeToFirstHarvest）中位数：测绘-开采链路效率信号。
 *
 * 纯只读，30s 缓存 + 启动预热，不进周期循环（无计划任务）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_ROOT, TENANTS } from "./fs-jsonl.ts";
import { TtlCache } from "./cache.ts";

const TTL_MS = 30_000;
/** 新鲜度窗口与 survey.ts A6 / mine-patterns 一致。 */
const FRESH_TICKS = 2000;

export interface MineResourceRow {
  cell: string;
  x: number;
  y: number;
  firstSeenTick: number;
  lastSeenTick: number;
  seenCount: number;
}

export interface MineHarvestEvent {
  cell: string;
  tick: number;
  eventType: string;
  amount: number | null;
}

export interface MineUtilEntry {
  cell: string;
  x: number;
  y: number;
  firstSeenTick: number | null;
  lastSeenTick: number | null;
  seenCount: number;
  state: "visible" | "stale";
  harvestOk: number;
  harvestFail: number;
  harvestAmount: number;
  lastHarvestTick: number | null;
  firstHarvestTick: number | null;
  neverHarvested: boolean;
  /** 发现→首次采集耗时（tick）；未开采 = null。 */
  timeToFirstHarvest: number | null;
  activity: number;
  /** 发现后仍未采的时长（tick）：currentTick - firstSeenTick；已采 = null。 */
  gapAgeTicks: number | null;
}

export interface MineTenantUtilization {
  tenant: string;
  currentTick: number | null;
  total: number;
  harvested: number;
  neverHarvested: number;
  visibleNever: number;
  staleNever: number;
  utilizationRate: number | null;
  medianTimeToFirstHarvest: number | null;
  /** 可见未开采矿的发现→仍未采时长（tick）：max / 中位。 */
  maxGapAgeTicks: number | null;
  medianGapAgeTicks: number | null;
  candidates: MineUtilEntry[];
  /** 金牌矿榜（2026-08-08）：累计收益 top / 累计采集次数 top——哪些矿值得守/抢。 */
  topMines: { byAmount: MineUtilEntry[]; byCount: MineUtilEntry[] };
}

export interface MineUtilizationPayload {
  generatedAt: string;
  tenant: string;
  tenants: Record<string, MineTenantUtilization>;
  cachedAt: string;
}

const cache = new TtlCache<MineUtilizationPayload>(TTL_MS);
const trendCache = new TtlCache<MineUtilizationTrendPayload>(TTL_MS);

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

/** 纯函数（可测）：resources + 采集事件 → 发现-利用缺口。 */
export function aggregateMineUtilization(
  tenant: string,
  currentTick: number | null,
  resources: readonly MineResourceRow[],
  harvestEvents: readonly MineHarvestEvent[],
): MineTenantUtilization {
  const byCell = new Map<string, { ok: number; fail: number; amount: number; first: number | null; last: number | null }>();
  for (const ev of harvestEvents) {
    const isOk = ev.eventType === "HARVEST_SUCCEEDED";
    const isFail = ev.eventType === "HARVEST_FAILED";
    if (!isOk && !isFail) continue;
    const a = byCell.get(ev.cell) ?? { ok: 0, fail: 0, amount: 0, first: null, last: null };
    if (isOk) {
      a.ok += 1;
      a.amount += num(ev.amount);
      if (a.first === null) a.first = num(ev.tick);
      a.last = num(ev.tick);
    } else {
      a.fail += 1;
    }
    byCell.set(ev.cell, a);
  }

  const cutoff = currentTick === null ? 0 : currentTick - FRESH_TICKS;
  const entries: MineUtilEntry[] = [];
  let total = 0, harvested = 0, neverHarvested = 0, visibleNever = 0, staleNever = 0;
  const firstHarvestTimes: number[] = [];
  for (const r of resources) {
    total += 1;
    const h = byCell.get(r.cell);
    const ok = h?.ok ?? 0;
    const fail = h?.fail ?? 0;
    const state: "visible" | "stale" = num(r.lastSeenTick) >= cutoff ? "visible" : "stale";
    const never = ok === 0;
    if (never) neverHarvested += 1;
    else {
      harvested += 1;
      if (h?.first !== null && h?.first !== undefined) {
        const ttf = num(h.first) - num(r.firstSeenTick);
        if (ttf >= 0) firstHarvestTimes.push(ttf);
      }
    }
    if (never && state === "visible") visibleNever += 1;
    if (never && state === "stale") staleNever += 1;
    const age = Math.max(1, num(r.lastSeenTick) - num(r.firstSeenTick));
    entries.push({
      cell: r.cell, x: num(r.x), y: num(r.y),
      firstSeenTick: num(r.firstSeenTick) || null,
      lastSeenTick: num(r.lastSeenTick) || null,
      seenCount: num(r.seenCount),
      state,
      harvestOk: ok,
      harvestFail: fail,
      harvestAmount: h?.amount ?? 0,
      lastHarvestTick: h?.last ?? null,
      firstHarvestTick: h?.first ?? null,
      neverHarvested: never,
      timeToFirstHarvest: never ? null : (h?.first !== null && h?.first !== undefined ? num(h.first) - num(r.firstSeenTick) : null),
      activity: num(r.seenCount) / age,
      gapAgeTicks: never ? Math.max(0, (currentTick ?? 0) - num(r.firstSeenTick)) : null,
    });
  }

  // candidates：可见未开采，lastSeen 降序（最新发现的优先分配）
  const candidates = entries
    .filter((e) => e.neverHarvested && e.state === "visible")
    .sort((a, b) => (b.lastSeenTick ?? -1) - (a.lastSeenTick ?? -1));

  firstHarvestTimes.sort((a, b) => a - b);
  const median = firstHarvestTimes.length > 0
    ? firstHarvestTimes[Math.floor(firstHarvestTimes.length / 2)]
    : null;
  const gapAges = candidates.map((e) => e.gapAgeTicks ?? 0).sort((a, b) => a - b);
  const maxGapAge = candidates.length > 0 ? gapAges[gapAges.length - 1] : null;
  const medianGapAge = gapAges.length > 0 ? gapAges[Math.floor(gapAges.length / 2)] : null;
  const topByAmount = entries
    .filter((e) => e.harvestAmount > 0)
    .sort((a, b) => b.harvestAmount - a.harvestAmount || (b.lastHarvestTick ?? -1) - (a.lastHarvestTick ?? -1))
    .slice(0, 20);
  const topByCount = entries
    .filter((e) => e.harvestOk > 0)
    .sort((a, b) => b.harvestOk - a.harvestOk || (b.lastHarvestTick ?? -1) - (a.lastHarvestTick ?? -1))
    .slice(0, 20);

  return {
    tenant,
    currentTick,
    total,
    harvested,
    neverHarvested,
    visibleNever,
    staleNever,
    utilizationRate: total > 0 ? Math.round((harvested / total) * 1000) / 1000 : null,
    medianTimeToFirstHarvest: median,
    maxGapAgeTicks: maxGapAge,
    medianGapAgeTicks: medianGapAge,
    candidates,
    topMines: { byAmount: topByAmount, byCount: topByCount },
  };
}

export interface MineTrendStep {
  /** 0=最早，steps-1=最新。 */
  index: number;
  /** 窗口结束 tick。 */
  endTick: number;
  total: number;
  /** 该窗口可见矿（firstSeen<=endTick 且 lastSeen>=endTick-FRESH，累计 last_seen 近似）。 */
  visible: number;
  /** 可见且到 endTick 仍从未采集（发现-利用缺口趋势）。 */
  visibleNever: number;
}

export interface MineUtilizationTrendPayload {
  generatedAt: string;
  tenant: string;
  window: number;
  steps: number;
  currentTick: number | null;
  trend: MineTrendStep[];
  cachedAt: string;
}

/** 矿利用趋势（2026-08-08，共享记忆）：把 resource_events 首次采集 tick + resources
 *  累计 first/last_seen 切成 N 窗口，算每窗口"可见未开采"数——看发现-利用缺口
 *  在扩大还是缩小。近似：last_seen 是累计最大值，历史窗口可见性略偏高，近期窗口准确；
 *  趋势形状（是否恶化）可用。纯函数可测。 */
export function aggregateMineUtilizationTrend(
  tenant: string,
  window: number,
  steps: number,
  resources: readonly { cell: string; firstSeenTick: number; lastSeenTick: number }[],
  harvestEvents: readonly { cell: string; tick: number; eventType: string }[],
  currentTick: number | null,
): MineUtilizationTrendPayload {
  const firstHarvest = new Map<string, number>();
  for (const ev of harvestEvents) {
    if (ev.eventType !== "HARVEST_SUCCEEDED") continue;
    const t = num(ev.tick);
    const prev = firstHarvest.get(ev.cell);
    if (prev === undefined || t < prev) firstHarvest.set(ev.cell, t);
  }
  const base = currentTick ?? 0;
  const trend: MineTrendStep[] = [];
  for (let i = 0; i < steps; i += 1) {
    const endTick = base - (steps - 1 - i) * window;
    let total = 0, visible = 0, visibleNever = 0;
    const cutoff = endTick - FRESH_TICKS;
    for (const r of resources) {
      total += 1;
      if (num(r.firstSeenTick) <= endTick && num(r.lastSeenTick) >= cutoff) {
        visible += 1;
        const fh = firstHarvest.get(r.cell);
        if (fh === undefined || fh > endTick) visibleNever += 1;
      }
    }
    trend.push({ index: i, endTick, total, visible, visibleNever });
  }
  return {
    generatedAt: new Date().toISOString(),
    tenant,
    window,
    steps,
    currentTick,
    trend,
    cachedAt: new Date().toISOString(),
  };
}

function tenantUtilization(tenant: string): MineTenantUtilization {
  const file = join(DATA_ROOT, "runtime", "survey", tenant + ".db");
  const empty: MineTenantUtilization = {
    tenant, currentTick: null, total: 0, harvested: 0, neverHarvested: 0,
    visibleNever: 0, staleNever: 0, utilizationRate: null, medianTimeToFirstHarvest: null,
    maxGapAgeTicks: null, medianGapAgeTicks: null, candidates: [], topMines: { byAmount: [], byCount: [] },
  };
  if (!existsSync(file)) return empty;
  let db: DatabaseSync;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch { return empty; }
  try {
    const meta = db.prepare("SELECT MAX(last_tick) AS m FROM sync_meta").get() as { m: number | null };
    const currentTick = num(meta?.m) || null;
    const resources = db.prepare(
      "SELECT cell, x, y, first_seen_tick AS f, last_seen_tick AS l, seen_count AS n FROM resources",
    ).all() as Array<{ cell: string; x: number; y: number; f: number; l: number; n: number }>;
    const events = db.prepare(
      "SELECT cell, tick, event_type AS e, amount FROM resource_events",
    ).all() as Array<{ cell: string; tick: number; e: string; amount: number | null }>;
    return aggregateMineUtilization(
      tenant,
      currentTick,
      resources.map((r) => ({ cell: r.cell, x: num(r.x), y: num(r.y), firstSeenTick: num(r.f), lastSeenTick: num(r.l), seenCount: num(r.n) })),
      events.map((e) => ({ cell: e.cell, tick: num(e.tick), eventType: e.e, amount: e.amount })),
    );
  } catch {
    return empty;
  } finally {
    db.close();
  }
}

export function loadMineUtilization(tenant = "all"): MineUtilizationPayload {
  const key = `mine-util:${tenant}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const tenants = tenant === "all" ? [...TENANTS] : [tenant];
  const perTenant: Record<string, MineTenantUtilization> = {};
  for (const t of tenants) perTenant[t] = tenantUtilization(t);
  const payload: MineUtilizationPayload = {
    generatedAt: new Date().toISOString(),
    tenant,
    tenants: perTenant,
    cachedAt: new Date().toISOString(),
  };
  cache.set(key, payload);
  return payload;
}

/** 矿利用趋势（只读 survey-db）：单租户 N 窗口；缓存 30s + 启动预热。 */
export function loadMineUtilizationTrend(tenant: string, window = 2000, steps = 6): MineUtilizationTrendPayload {
  const key = `mine-trend:${tenant}:${window}:${steps}`;
  const hit = trendCache.get(key);
  if (hit !== undefined) return hit;
  const file = join(DATA_ROOT, "runtime", "survey", tenant + ".db");
  const empty: MineUtilizationTrendPayload = {
    generatedAt: new Date().toISOString(), tenant, window, steps, currentTick: null, trend: [], cachedAt: new Date().toISOString(),
  };
  if (!existsSync(file)) return empty;
  let db: DatabaseSync;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch { return empty; }
  try {
    const meta = db.prepare("SELECT MAX(last_tick) AS m FROM sync_meta").get() as { m: number | null };
    const currentTick = num(meta?.m) || null;
    const resources = db.prepare(
      "SELECT cell, first_seen_tick AS f, last_seen_tick AS l FROM resources",
    ).all() as Array<{ cell: string; f: number; l: number }>;
    const events = db.prepare(
      "SELECT cell, tick, event_type AS e FROM resource_events",
    ).all() as Array<{ cell: string; tick: number; e: string }>;
    const payload = aggregateMineUtilizationTrend(
      tenant, window, steps,
      resources.map((r) => ({ cell: r.cell, firstSeenTick: num(r.f), lastSeenTick: num(r.l) })),
      events.map((e) => ({ cell: e.cell, tick: num(e.tick), eventType: e.e })),
      currentTick,
    );
    trendCache.set(key, payload);
    return payload;
  } catch {
    return empty;
  } finally {
    db.close();
  }
}

/** 启动预热一次（不进周期循环；过期后请求惰性刷新）。 */
export function warmMineUtilizationTrend(): void {
  for (const t of TENANTS) loadMineUtilizationTrend(t);
}

/** 启动预热一次（不进周期循环；过期后请求惰性刷新）。 */
export function warmMineUtilization(): void {
  loadMineUtilization("all");
}
