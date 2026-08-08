/**
 * 分工矿兑现校验（2026-08-08）：闭环"分配 → 实际采集"反馈。
 *
 * 背景：alliance/mining 给出"谁去采哪个矿"的就近分配，audit/mines 暴露
 * 可见未开采缺口——但缺一环：**分配到底兑现了没有**？本模块把分配清单与
 * 各租户 survey-db 的逐格采集事件对齐，算出每个分配格的状态：
 *   - harvested        本租户采到了（闭环）
 *   - harvestedByOther 被别租户采了（分配模型需修正：距离不是唯一因素）
 *   - open             仍可见但没人采（in-flight，继续派）
 *   - stale            已过时仍没人采（分配失效）
 * 输出（/api/audit/mining-effectiveness）：
 *   - items：每分配格状态 + 首采耗时（最近观测→首采，越短越好）；
 *   - perTenant：resolvedRate（已闭环/已闭环+失效）、progressRate（本租户采到/全部分工）；
 *   - global：effectiveRate（任意租户闭环/闭环+失效）、open 在途量。
 *
 * 纯只读：30s 惰性缓存 + 启动预热，不进周期循环（无计划任务）。
 * 输入全部复用既有 30s 缓存（alliance/mining 分配 + survey-db 采集事件）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_ROOT, TENANTS } from "./fs-jsonl.ts";
import { TtlCache } from "./cache.ts";
import { loadAllianceMining, type MiningAssignment } from "./alliance-mining.ts";
import { loadAllianceSnapshot } from "./alliance-snapshot.ts";

const TTL_MS = 30_000;
/** 新鲜度窗口与 mine-utilization A6 一致。 */
const FRESH_TICKS = 2000;

export interface CellHarvestStat {
  ok: number;
  fail: number;
  amount: number;
  first: number | null;
  last: number | null;
}

export type AllocationStatus = "harvested" | "harvestedByOther" | "open" | "stale";

export interface AllocationEffectivenessItem {
  cell: string;
  x: number;
  y: number;
  assignedTenant: string;
  distanceToCore: number | null;
  lastSeenTick: number | null;
  harvestOk: number;
  harvestFail: number;
  harvestAmount: number;
  firstHarvestTick: number | null;
  status: AllocationStatus;
  /** 最近观测 → 首采耗时（tick，≥0）；未采 = null。 */
  timeToHarvest: number | null;
}

export interface AllocationEffectivenessTenant {
  assigned: number;
  harvested: number;
  harvestedByOther: number;
  open: number;
  stale: number;
  /** 已闭环 /（已闭环 + 已失效）——排除在途 open。 */
  resolvedRate: number | null;
  /** 本租户采到 / 全部分工——含在途 open 视为未完成。 */
  progressRate: number | null;
  avgTimeToHarvest: number | null;
}

export interface MiningEffectivenessPayload {
  generatedAt: string;
  currentTick: number | null;
  items: AllocationEffectivenessItem[];
  perTenant: Record<string, AllocationEffectivenessTenant>;
  global: {
    assigned: number;
    harvested: number;
    harvestedByOther: number;
    open: number;
    stale: number;
    /** 任意租户闭环 /（闭环 + 失效）。 */
    effectiveRate: number | null;
    /** 本租户采到 / 全部分工。 */
    progressRate: number | null;
  };
  cachedAt: string;
}

const cache = new TtlCache<MiningEffectivenessPayload>(TTL_MS);

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

/** 纯函数（可测）：分配清单 + 各租户逐格采集统计 → 兑现状态。 */
export function aggregateAllocationEffectiveness(
  assignments: readonly Pick<MiningAssignment, "cell" | "x" | "y" | "assignedTenant" | "distanceToCore" | "lastSeenTick">[],
  harvestByTenantCell: Record<string, Record<string, CellHarvestStat>>,
  currentTick: number | null,
): MiningEffectivenessPayload {
  const cutoff = currentTick === null ? 0 : currentTick - FRESH_TICKS;
  const items: AllocationEffectivenessItem[] = [];
  const perTenant: Record<string, AllocationEffectivenessTenant> = {};
  for (const t of TENANTS) {
    perTenant[t] = { assigned: 0, harvested: 0, harvestedByOther: 0, open: 0, stale: 0, resolvedRate: null, progressRate: null, avgTimeToHarvest: null };
  }
  let gAssigned = 0, gHarvested = 0, gOther = 0, gOpen = 0, gStale = 0;
  const ttfByTenant: Record<string, number[]> = {};

  for (const a of assignments) {
    const tenant = a.assignedTenant;
    const mine = harvestByTenantCell[tenant]?.[a.cell];
    const ok = mine?.ok ?? 0;
    const fail = mine?.fail ?? 0;
    const amount = mine?.amount ?? 0;
    const first = mine?.first ?? null;
    const lastSeen = num(a.lastSeenTick) || null;
    // 其他租户是否采到（跨租户闭环）
    let otherOk = 0;
    for (const t of TENANTS) {
      if (t === tenant) continue;
      otherOk += num(harvestByTenantCell[t]?.[a.cell]?.ok);
    }
    let status: AllocationStatus;
    if (ok > 0) status = "harvested";
    else if (otherOk > 0) status = "harvestedByOther";
    else if (lastSeen !== null && lastSeen >= cutoff) status = "open";
    else status = "stale";

    const timeToHarvest = first !== null && lastSeen !== null ? Math.max(0, first - lastSeen) : null;

    const p = perTenant[tenant] ?? { assigned: 0, harvested: 0, harvestedByOther: 0, open: 0, stale: 0, resolvedRate: null, progressRate: null, avgTimeToHarvest: null };
    p.assigned += 1;
    if (status === "harvested") { p.harvested += 1; gHarvested += 1; (ttfByTenant[tenant] ??= []).push(timeToHarvest ?? 0); }
    else if (status === "harvestedByOther") { p.harvestedByOther += 1; gOther += 1; }
    else if (status === "open") { p.open += 1; gOpen += 1; }
    else { p.stale += 1; gStale += 1; }
    perTenant[tenant] = p;
    gAssigned += 1;

    items.push({
      cell: a.cell, x: num(a.x), y: num(a.y),
      assignedTenant: tenant,
      distanceToCore: a.distanceToCore ?? null,
      lastSeenTick: lastSeen,
      harvestOk: ok,
      harvestFail: fail,
      harvestAmount: amount,
      firstHarvestTick: first,
      status,
      timeToHarvest,
    });
  }

  for (const t of TENANTS) {
    const p = perTenant[t];
    const closed = p.harvested + p.stale;
    p.resolvedRate = closed > 0 ? Math.round((p.harvested / closed) * 1000) / 1000 : null;
    p.progressRate = p.assigned > 0 ? Math.round((p.harvested / p.assigned) * 1000) / 1000 : null;
    const tt = ttfByTenant[t] ?? [];
    if (tt.length > 0) p.avgTimeToHarvest = Math.round((tt.reduce((a, b) => a + b, 0) / tt.length) * 10) / 10;
  }

  const closedAll = gHarvested + gStale;
  const effectiveRate = closedAll > 0 ? Math.round((gHarvested / closedAll) * 1000) / 1000 : null;
  const progressRate = gAssigned > 0 ? Math.round((gHarvested / gAssigned) * 1000) / 1000 : null;

  return {
    generatedAt: new Date().toISOString(),
    currentTick,
    items,
    perTenant,
    global: { assigned: gAssigned, harvested: gHarvested, harvestedByOther: gOther, open: gOpen, stale: gStale, effectiveRate, progressRate },
    cachedAt: new Date().toISOString(),
  };
}

/** 只读单租户 survey-db → 逐格采集统计（ok/fail/amount/first/last）。 */
function readTenantHarvestMap(tenant: string): Record<string, CellHarvestStat> {
  const file = join(DATA_ROOT, "runtime", "survey", tenant + ".db");
  if (!existsSync(file)) return {};
  let db: DatabaseSync;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch { return {}; }
  try {
    const rows = db.prepare(
      "SELECT cell, tick, event_type AS e, amount FROM resource_events",
    ).all() as Array<{ cell: string; tick: number; e: string; amount: number | null }>;
    const out: Record<string, CellHarvestStat> = {};
    for (const r of rows) {
      const isOk = r.e === "HARVEST_SUCCEEDED";
      const isFail = r.e === "HARVEST_FAILED";
      if (!isOk && !isFail) continue;
      const a = out[r.cell] ?? { ok: 0, fail: 0, amount: 0, first: null, last: null };
      if (isOk) {
        a.ok += 1;
        a.amount += num(r.amount);
        if (a.first === null) a.first = num(r.tick);
        a.last = num(r.tick);
      } else {
        a.fail += 1;
      }
      out[r.cell] = a;
    }
    return out;
  } catch {
    return {};
  } finally {
    db.close();
  }
}

/** 分工矿兑现校验（只读组合：alliance/mining 分配 + 各租户采集统计），30s 缓存。 */
export function loadMiningEffectiveness(): MiningEffectivenessPayload {
  const key = "mining-effectiveness";
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const mining = loadAllianceMining();
  let currentTick: number | null = null;
  try { currentTick = loadAllianceSnapshot().currentTick ?? null; } catch { /* 快照不可用跳过 */ }
  const harvestByTenantCell: Record<string, Record<string, CellHarvestStat>> = {};
  for (const t of TENANTS) harvestByTenantCell[t] = readTenantHarvestMap(t);
  const payload = aggregateAllocationEffectiveness(mining.assignments ?? [], harvestByTenantCell, currentTick);
  payload.currentTick = currentTick;
  cache.set(key, payload);
  return payload;
}

/** 启动预热一次（不进周期循环；过期后请求惰性刷新）。 */
export function warmMiningEffectiveness(): void {
  loadMiningEffectiveness();
}
