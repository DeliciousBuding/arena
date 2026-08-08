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

/** 单租户敌情热区聚合（SQL 按格×类型分组，JS 按 16×16 桶聚合）。
 *  recent：窗口内（tick > cutoff，走 idx_units_seen_controlled_tick 索引范围扫，
 *  只扫近 windowTicks 行——t1 200k 全表→ ~5k 行，提速 ~20 倍；
 *  count=近期活跃度（热层渲染用）；
 *  full：全历史（记录/审计用）。 2026-08-08 数据架构优化。 */
function loadTenantEnemyHeat(tenant: string, windowTicks: number): {
  recent: Map<string, HeatAgg>;
  full: Map<string, HeatAgg>;
  currentTick: number;
} {
  const recent = new Map<string, HeatAgg>();
  const full = new Map<string, HeatAgg>();
  const file = join(DATA_ROOT, "runtime", "survey", `${tenant}.db`);
  if (!existsSync(file)) return { recent, full, currentTick: 0 };
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return { recent, full, currentTick: 0 };
  }
  try {
    const meta = db.prepare("SELECT MAX(last_tick) AS m FROM sync_meta").get() as { m: number | null };
    const currentTick = num(meta?.m);
    const cutoff = Math.max(0, currentTick - windowTicks);
    const sql = (where: string) =>
      `SELECT x, y, unit_type AS type, COUNT(*) AS n, MAX(tick) AS last_tick, MIN(tick) AS first_tick
       FROM units_seen WHERE controlled = 0 AND x IS NOT NULL${where} GROUP BY x, y, type`;
    const recentRows = db.prepare(sql(" AND tick > ?")).all(cutoff) as Array<{ x: number; y: number; type: string; n: number; last_tick: number; first_tick: number }>;
    // 共享记忆分层 A13：full = heat_archive（历史聚合，survey-sync 归档）∪ units_seen
    // 近期（窗口内原始目击）——语义不变（全历史格×类型计数），不再扫全表原始行
    // （t1 45 万行 → archive 小表 + 索引近期）。旧库无 heat_archive 表时回退全表。
    let fullRows: Array<{ x: number; y: number; type: string; n: number; last_tick: number; first_tick: number }>;
    try {
      const hasArchive = (db.prepare(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'heat_archive'",
      ).get() as { c: number }).c > 0;
      fullRows = hasArchive
        ? db.prepare(`
            SELECT x, y, unit_type AS type, COUNT(*) AS n, MAX(tick) AS last_tick, MIN(tick) AS first_tick
            FROM (
              SELECT x, y, unit_type, last_tick AS tick FROM heat_archive
              UNION ALL
              SELECT x, y, unit_type, tick FROM units_seen WHERE controlled = 0 AND x IS NOT NULL AND tick > ?
            )
            GROUP BY x, y, type
          `).all(cutoff) as Array<{ x: number; y: number; type: string; n: number; last_tick: number; first_tick: number }>
        : db.prepare(sql("")).all() as Array<{ x: number; y: number; type: string; n: number; last_tick: number; first_tick: number }>;
    } catch {
      fullRows = db.prepare(sql("")).all() as Array<{ x: number; y: number; type: string; n: number; last_tick: number; first_tick: number }>;
    }
    const agg = (m: Map<string, HeatAgg>, rows: Array<{ x: number; y: number; type: string; n: number; last_tick: number; first_tick: number }>): void => {
      for (const r of rows) {
        const bx = Math.floor(num(r.x) / BUCKET);
        const by = Math.floor(num(r.y) / BUCKET);
        const key = `${bx},${by}`;
        let a = m.get(key);
        if (!a) {
          a = { count: 0, combatCount: 0, workerCount: 0, lastTick: -1, firstTick: Number.MAX_SAFE_INTEGER, cells: new Set() };
          m.set(key, a);
        }
        const n = num(r.n);
        a.count += n;
        a.cells.add(`${r.x},${r.y}`);
        const lt = num(r.last_tick);
        const ft = num(r.first_tick);
        if (lt > a.lastTick) a.lastTick = lt;
        if (ft < a.firstTick) a.firstTick = ft;
        const type = String(r.type ?? "");
        if (type === "VANGUARD" || type === "RANGER") a.combatCount += n;
        else if (type === "WORKER") a.workerCount += n;
      }
    };
    agg(recent, recentRows);
    agg(full, fullRows);
    return { recent, full, currentTick };
  } catch {
    return { recent, full, currentTick: 0 };
  } finally {
    db.close();
  }
}

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
    const { recent, full, currentTick: ct } = loadTenantEnemyHeat(t, recentWindowTicks);
    if (ct > currentTick) currentTick = ct;
    for (const b of toAllBuckets(full, t)) {
      mergedFull.set(`${t}:${b.bx},${b.by}`, b);
    }
    // recent 已在 SQL 窗口内聚合，不再需 lastTick 过滤
    for (const b of toAllBuckets(recent, t)) {
      const k = `${t}:${b.bx},${b.by}`;
      totalSightings += b.count;
      combatSightings += b.combatCount;
      workerSightings += b.workerCount;
      distinctCells.add(`${b.bx},${b.by}`);
      mergedRecent.set(k, b);
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
