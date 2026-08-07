/**
 * 数据管线健康（2026-08-08，数据架构可观测）：每租户 survey-db 同步水位 vs
 * live calibration 最新 tick 的滞后、数据量、缓存新鲜度——让"测绘记录层
 * 是否在健康前进"一眼可读，综合调试用。纯只读，15s 缓存。
 *
 * 实证（2026-08-08）：四租户 survey-db 落后 live ~400 tick（sync 在
 * watchdog 重启周期同步，非连续）——热区/快照/冲突都在用滞后数据，本端点
 * 显性化该滞后，供运维判断是否需要补同步。
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_ROOT, TENANTS } from "./fs-jsonl.ts";
import { loadWorld } from "./streams.ts";
import { loadTenantSurveyCached } from "./survey-cache.ts";
import { TtlCache } from "./cache.ts";

export interface PipelineTenantCounts {
  resources: number;
  obstacles: number;
  cores: number;
  unitsSeen: number;
  chunks: number;
  harvestEvents: number;
  spends: number;
  lifecycleUnits: number;
}

export interface PipelineTenantHealth {
  tenant: string;
  dbExists: boolean;
  dbBytes: number;
  syncTick: number;
  liveTick: number;
  lagTicks: number;
  syncedCases: number;
  counts: PipelineTenantCounts;
  surveyCachedAt: string | null;
  health: "OK" | "STALE" | "MISSING";
}

export interface PipelineHealthPayload {
  generatedAt: string;
  tenants: readonly PipelineTenantHealth[];
  global: {
    maxLagTicks: number;
    avgLagTicks: number;
    staleTenants: readonly string[];
    missingTenants: readonly string[];
    healthy: boolean;
  };
  cachedAt: string;
}

/** 滞后阈值：超过视为 STALE（约 8 分钟，tick≈0.8s 量级）。 */
const STALE_LAG_TICKS = 600;

const HEALTH_TTL_MS = 15_000;
const healthCache = new TtlCache<PipelineHealthPayload>(HEALTH_TTL_MS);

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

const countOf = (db: DatabaseSync, table: string): number => {
  try {
    const r = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
    return num(r.c);
  } catch {
    return 0;
  }
};

function tenantHealth(tenant: string): PipelineTenantHealth {
  const file = join(DATA_ROOT, "runtime", "survey", `${tenant}.db`);
  const dbExists = existsSync(file);
  const base: PipelineTenantHealth = {
    tenant,
    dbExists,
    dbBytes: dbExists ? statSync(file).size : 0,
    syncTick: 0,
    liveTick: 0,
    lagTicks: 0,
    syncedCases: 0,
    counts: { resources: 0, obstacles: 0, cores: 0, unitsSeen: 0, chunks: 0, harvestEvents: 0, spends: 0, lifecycleUnits: 0 },
    surveyCachedAt: null,
    health: dbExists ? "OK" : "MISSING",
  };
  const live = loadWorld(tenant);
  base.liveTick = num(live.tick);
  if (!dbExists) return base;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    base.health = "MISSING";
    return base;
  }
  try {
    const meta = db.prepare("SELECT MAX(last_tick) AS m, SUM(cases_synced) AS c FROM sync_meta").get() as { m: number | null; c: number | null };
    base.syncTick = num(meta?.m);
    base.syncedCases = num(meta?.c);
    base.lagTicks = Math.max(0, base.liveTick - base.syncTick);
    base.counts = {
      resources: countOf(db, "resources"),
      obstacles: countOf(db, "obstacles"),
      cores: countOf(db, "core_hunts"),
      unitsSeen: countOf(db, "units_seen"),
      chunks: countOf(db, "chunks"),
      harvestEvents: countOf(db, "resource_events"),
      spends: countOf(db, "core_spends"),
      lifecycleUnits: countOf(db, "unit_lifecycle"),
    };
    base.surveyCachedAt = loadTenantSurveyCached(tenant).cachedAt;
    base.health = base.lagTicks > STALE_LAG_TICKS ? "STALE" : "OK";
  } catch {
    base.health = "MISSING";
  } finally {
    db.close();
  }
  return base;
}

export function loadPipelineHealth(): PipelineHealthPayload {
  const hit = healthCache.get("latest");
  if (hit !== undefined) return hit;
  const tenants = TENANTS.map(tenantHealth);
  const lags = tenants.map((t) => t.lagTicks);
  const maxLag = lags.length > 0 ? Math.max(...lags) : 0;
  const avgLag = lags.length > 0 ? lags.reduce((a, b) => a + b, 0) / lags.length : 0;
  const staleTenants = tenants.filter((t) => t.health === "STALE").map((t) => t.tenant);
  const missingTenants = tenants.filter((t) => t.health === "MISSING").map((t) => t.tenant);
  const payload: PipelineHealthPayload = {
    generatedAt: new Date().toISOString(),
    tenants,
    global: {
      maxLagTicks: maxLag,
      avgLagTicks: Math.round(avgLag),
      staleTenants,
      missingTenants,
      healthy: staleTenants.length === 0 && missingTenants.length === 0,
    },
    cachedAt: new Date().toISOString(),
  };
  healthCache.set("latest", payload);
  return payload;
}

/** 后台预热。 */
export function refreshPipelineHealth(): void {
  loadPipelineHealth();
}
