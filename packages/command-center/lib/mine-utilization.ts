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
  candidates: MineUtilEntry[];
}

export interface MineUtilizationPayload {
  generatedAt: string;
  tenant: string;
  tenants: Record<string, MineTenantUtilization>;
  cachedAt: string;
}

const cache = new TtlCache<MineUtilizationPayload>(TTL_MS);

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
    candidates,
  };
}

function tenantUtilization(tenant: string): MineTenantUtilization {
  const file = join(DATA_ROOT, "runtime", "survey", tenant + ".db");
  const empty: MineTenantUtilization = {
    tenant, currentTick: null, total: 0, harvested: 0, neverHarvested: 0,
    visibleNever: 0, staleNever: 0, utilizationRate: null, medianTimeToFirstHarvest: null, candidates: [],
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

/** 启动预热一次（不进周期循环；过期后请求惰性刷新）。 */
export function warmMineUtilization(): void {
  loadMineUtilization("all");
}
