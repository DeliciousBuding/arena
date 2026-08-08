/**
 * 敌情热区（2026-08-08）：把 survey-db units_seen（跨 run 全量单位目击，
 * 此前无消费）聚合为敌方活动热力图——16×16 chunk 级敌情密度/兵力构成/
 * 新鲜度，地图「敌情热区」层 + 联盟威胁的先验数据源。
 *
 * 语义：只统计 controlled=0（敌方）目击；combat=VANGUARD/RANGER，
 * worker=WORKER。recent 窗口（缺省最近 2000 tick）供热图渲染，full 供
 * 记录/审计。纯只读，30s 缓存 + 后台预热。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_ROOT, TENANTS } from "./fs-jsonl.ts";
import { TtlCache } from "./cache.ts";

export interface EnemyHeatBucket {
  readonly bx: number;
  readonly by: number;
  readonly tenant: string;
  readonly count: number;
  readonly combatCount: number;
  readonly workerCount: number;
  readonly lastTick: number;
  readonly firstTick: number;
}

export interface EnemyHeatSummary {
  readonly totalSightings: number;
  readonly distinctCells: number;
  readonly combatSightings: number;
  readonly workerSightings: number;
  readonly tenants: number;
}

export interface EnemyHeatPayload {
  generatedAt: string;
  tenant: string;
  currentTick: number;
  /** 最近窗口热区（缺省 2000 tick）——地图热层渲染用。 */
  buckets: readonly EnemyHeatBucket[];
  /** 全历史热区——记录/审计用。 */
  fullBuckets: readonly EnemyHeatBucket[];
  summary: EnemyHeatSummary;
  cachedAt: string;
}

const HEAT_TTL_MS = 30_000;
const heatCache = new TtlCache<EnemyHeatPayload>(HEAT_TTL_MS);

const BUCKET = 16; // 16×16 格桶（与探索分区 chunk 同粒度）

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

interface HeatAgg {
  count: number;
  combatCount: number;
  workerCount: number;
  lastTick: number;
  firstTick: number;
  cells: Set<string>;
}

/** 单租户敌情热区聚合（SQL 按格×类型分组，JS 按 16×16 桶聚合）。 */
function loadTenantEnemyHeat(tenant: string): { buckets: Map<string, HeatAgg>; currentTick: number } {
  const buckets = new Map<string, HeatAgg>();
  const file = join(DATA_ROOT, "runtime", "survey", `${tenant}.db`);
  if (!existsSync(file)) return { buckets, currentTick: 0 };
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return { buckets, currentTick: 0 };
  }
  try {
    const meta = db.prepare("SELECT MAX(last_tick) AS m FROM sync_meta").get() as { m: number | null };
    const currentTick = num(meta?.m);
    const rows = db.prepare(
      `SELECT x, y, unit_type AS type, COUNT(*) AS n, MAX(tick) AS last_tick
       FROM units_seen WHERE controlled = 0 AND x IS NOT NULL GROUP BY x, y, type`,
      // 2026-08-08 审计 A2：units_seen 已补 x/y 列（迁移+回填），不再
      // substr/instr 解析 cell 字符串；AND x IS NOT NULL 兼容未迁移旧库
    ).all() as Array<{ x: number; y: number; type: string; n: number; last_tick: number }>;
    for (const r of rows) {
      const bx = Math.floor(num(r.x) / BUCKET);
      const by = Math.floor(num(r.y) / BUCKET);
      const key = `${bx},${by}`;
      let agg = buckets.get(key);
      if (!agg) {
        agg = { count: 0, combatCount: 0, workerCount: 0, lastTick: -1, firstTick: Number.MAX_SAFE_INTEGER, cells: new Set() };
        buckets.set(key, agg);
      }
      const n = num(r.n);
      agg.count += n;
      agg.cells.add(`${r.x},${r.y}`);
      const t = num(r.last_tick);
      if (t > agg.lastTick) agg.lastTick = t;
      if (t < agg.firstTick) agg.firstTick = t;
      const type = String(r.type ?? "");
      if (type === "VANGUARD" || type === "RANGER") agg.combatCount += n;
      else if (type === "WORKER") agg.workerCount += n;
    }
    return { buckets, currentTick };
  } catch {
    return { buckets, currentTick: 0 };
  } finally {
    db.close();
  }
}

const toBuckets = (m: Map<string, HeatAgg>, tenant: string, currentTick: number, windowTicks: number): EnemyHeatBucket[] => {
  const cutoff = currentTick - windowTicks;
  const out: EnemyHeatBucket[] = [];
  for (const [key, agg] of m) {
    if (agg.lastTick < cutoff) continue;
    const [bx, by] = key.split(",").map(Number);
    out.push({
      bx,
      by,
      tenant,
      count: agg.count,
      combatCount: agg.combatCount,
      workerCount: agg.workerCount,
      lastTick: agg.lastTick,
      firstTick: agg.firstTick,
    });
  }
  return out.sort((a, b) => b.count - a.count);
};

const toAllBuckets = (m: Map<string, HeatAgg>, tenant: string): EnemyHeatBucket[] => {
  const out: EnemyHeatBucket[] = [];
  for (const [key, agg] of m) {
    const [bx, by] = key.split(",").map(Number);
    out.push({
      bx,
      by,
      tenant,
      count: agg.count,
      combatCount: agg.combatCount,
      workerCount: agg.workerCount,
      lastTick: agg.lastTick,
      firstTick: agg.firstTick,
    });
  }
  return out.sort((a, b) => b.count - a.count);
};

const RECENT_WINDOW_TICKS = 2000;

/** 敌情热区入口：tenant=all 合并四租户（按桶叠加，带租户细分）。 */
export function loadEnemyHeat(tenant: string, recentWindowTicks = RECENT_WINDOW_TICKS): EnemyHeatPayload {
  const key = tenant === "all" ? "all" : tenant;
  const hit = heatCache.get(`${key}:${recentWindowTicks}`);
  if (hit !== undefined) return hit;
  const tenants = tenant === "all" ? [...TENANTS] : [tenant];
  let currentTick = 0;
  let totalSightings = 0;
  let combatSightings = 0;
  let workerSightings = 0;
  const distinctCells = new Set<string>();
  const mergedRecent = new Map<string, EnemyHeatBucket>();
  const mergedFull = new Map<string, EnemyHeatBucket>();
  for (const t of tenants) {
    const { buckets, currentTick: ct } = loadTenantEnemyHeat(t);
    if (ct > currentTick) currentTick = ct;
    const all = toAllBuckets(buckets, t);
    for (const b of all) {
      const k = `${t}:${b.bx},${b.by}`;
      mergedFull.set(k, b);
      if (b.lastTick >= ct - recentWindowTicks) {
        totalSightings += b.count;
        combatSightings += b.combatCount;
        workerSightings += b.workerCount;
        distinctCells.add(`${b.bx},${b.by}`);
        mergedRecent.set(k, b);
      }
    }
  }
  const payload: EnemyHeatPayload = {
    generatedAt: new Date().toISOString(),
    tenant,
    currentTick,
    buckets: [...mergedRecent.values()].sort((a, b) => b.count - a.count),
    fullBuckets: [...mergedFull.values()].sort((a, b) => b.count - a.count),
    summary: {
      totalSightings,
      distinctCells: distinctCells.size,
      combatSightings,
      workerSightings,
      tenants: tenants.length,
    },
    cachedAt: new Date().toISOString(),
  };
  heatCache.set(`${key}:${recentWindowTicks}`, payload);
  return payload;
}

/** 后台预热。 */
export function refreshEnemyHeat(): void {
  loadEnemyHeat("all");
}
