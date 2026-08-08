/**
 * 数据管线健康（2026-08-08，数据架构可观测）：每租户 survey-db 同步水位 vs
 * live calibration 最新 tick 的滞后、数据量、缓存新鲜度——让"测绘记录层
 * 是否在健康前进"一眼可读，综合调试用。纯只读，15s 缓存。
 *
 * 实证（2026-08-08）：四租户 survey-db 落后 live ~400 tick（sync 在
 * watchdog 重启周期同步，非连续）——热区/快照/冲突都在用滞后数据，本端点
 * 显性化该滞后，供运维判断是否需要补同步。
 */
import { existsSync, statSync, readdirSync } from "node:fs";
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
  /** 矿生命周期负态（harvested+empty，2026-08-08）：>0 说明 survey-sync 事件回写生效。 */
  lifecycleNegative: number;
  /** 各生命周期状态矿数（2026-08-08）：visible/stale/harvested/empty——数据质量守卫。 */
  lifecycleStates: { visible: number; stale: number; harvested: number; empty: number } | null;
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

/** 数据源新鲜度（2026-08-08，综合管线）：每数据源最近写入年龄 + 陈旧标记——
 *  综合调试一屏看全"哪个源在健康前进"。world=live case 文件 / surveyDb=tN.db /
 *  leaderboard=官方快照 / shop=商店历史 / humanAudit=手操流水。 */
export interface SourceFreshness {
  name: "world" | "surveyDb" | "leaderboard" | "shop" | "humanAudit";
  ageSeconds: number | null;
  stale: boolean;
  detail: string;
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
    /** 滞后趋势（2026-08-08）：滚动窗口内 avgLag 变化方向 + delta——同步水位在
     *  缩小（narrowing）/扩大（widening）/稳定（stable）。样本 <3 时 null。 */
    lagTrend: { direction: "narrowing" | "widening" | "stable"; delta: number; samples: number } | null;
    /** 数据源新鲜度表（2026-08-08）。 */
    sources: readonly SourceFreshness[];
    /** 决策数据新鲜度：survey-db 同步水位是 planner/advice 的真实数据龄，而不仅是文件 mtime。 */
    decisionFreshness: { lagTicks: number; lagSeconds: number; healthy: boolean } | null;
    /** 矿生命周期闭环状态（2026-08-08）：OK=负态在流动（采集事件正确回写）/
     *  STALLED=有采集事件但负态为 0（survey-sync 静默空跑——如 --data-root 缺失
     *  时全 visible 回归的根因类）/ NO_DATA=无采集事件（数据不足，不算故障）。 */
    lifecycleFlow: "OK" | "STALLED" | "NO_DATA";
  };
  cachedAt: string;
}

/** 滞后阈值：超过视为 STALE。 */
const STALE_LAG_TICKS = 600;
/** Command Center 的 survey/decision freshness 换算口径；与主线 UI 契约保持一致。 */
export const TICK_SECONDS = 15;
export const DECISION_FRESH_TICKS = 60;

const HEALTH_TTL_MS = 15_000;
const healthCache = new TtlCache<PipelineHealthPayload>(HEALTH_TTL_MS);

/** 滞后历史滚动窗口（2026-08-08）：最近 LAG_HISTORY_MAX 次 avgLag 采样，趋势判断用。 */
const LAG_HISTORY_MAX = 20;
const lagHistory: number[] = [];

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
    counts: { resources: 0, obstacles: 0, cores: 0, unitsSeen: 0, chunks: 0, harvestEvents: 0, spends: 0, lifecycleUnits: 0, lifecycleNegative: 0, lifecycleStates: null },
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
      lifecycleNegative: 0,
      lifecycleStates: null,
    };
    // 矿生命周期状态分布（2026-08-08 数据质量守卫）：survey-sync 事件回写产生的
    // 负态（harvested/empty）是"过时矿"根因已修的实证——若采集事件在涨但负态恒 0，
    // 说明 survey-sync 静默空跑（如 --data-root 缺失类回归），综合调试一屏可判。
    try {
      const states = db.prepare("SELECT state, COUNT(*) AS c FROM resources GROUP BY state").all() as Array<{ state: string; c: number }>;
      const st: Record<string, number> = {};
      for (const s of states) st[s.state] = num(s.c);
      base.counts.lifecycleStates = {
        visible: st.visible ?? 0, stale: st.stale ?? 0, harvested: st.harvested ?? 0, empty: st.empty ?? 0,
      };
      base.counts.lifecycleNegative = (st.harvested ?? 0) + (st.empty ?? 0);
    } catch { /* 表结构缺失忽略 */ }
    base.surveyCachedAt = loadTenantSurveyCached(tenant).cachedAt;
    base.health = base.lagTicks > STALE_LAG_TICKS ? "STALE" : "OK";
  } catch {
    base.health = "MISSING";
  } finally {
    db.close();
  }
  return base;
}

/** 各数据源陈旧阈值（秒）：world 15s tick 容忍 6 tick；survey-db 周期同步；
 *  leaderboard 官方 15min 一档；shop/手操请求驱动。 */
const SOURCE_STALE_SECONDS: Record<SourceFreshness["name"], number> = {
  world: 90, surveyDb: 600, leaderboard: 900, shop: 3600, humanAudit: 3600,
};

function fileAgeSeconds(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    return Math.max(0, Math.round((Date.now() - statSync(path).mtimeMs) / 1000));
  } catch {
    return null;
  }
}

/** 指定 dataRoot 下某租户最新 calibration case 年龄。先按 cases 目录 mtime 选最新
 * run，再只扫描该 run 的 JSON case，避免 source-health 重新变成全历史 O(runs×cases)。 */
function latestCaseAgeSeconds(dataRoot: string, tenant: string): number | null {
  try {
    const calibrationRoot = join(dataRoot, "runtime", tenant, "calibration");
    if (!existsSync(calibrationRoot)) return null;
    const candidates = readdirSync(calibrationRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const casesDir = join(calibrationRoot, entry.name, "cases");
        return existsSync(casesDir) ? { casesDir, mtime: statSync(casesDir).mtimeMs } : null;
      })
      .filter((entry): entry is { casesDir: string; mtime: number } => entry !== null)
      .sort((a, b) => b.mtime - a.mtime);
    for (const candidate of candidates) {
      const cases = readdirSync(candidate.casesDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => join(candidate.casesDir, name));
      if (cases.length === 0) continue;
      let newest = 0;
      for (const file of cases) newest = Math.max(newest, statSync(file).mtimeMs);
      return Math.max(0, Math.round((Date.now() - newest) / 1000));
    }
    return null;
  } catch {
    return null;
  }
}

/** 数据源新鲜度：mtime 是写入年龄；surveyLagTicks 是同步水位的真实决策滞后。 */
export function computeSourceFreshness(dataRoot: string = DATA_ROOT, surveyLagTicks?: number | null): SourceFreshness[] {
  // live world：严格使用调用方传入的数据根；不同 release/worktree 可独立 preflight。
  let worldAge: number | null = null;
  for (const t of TENANTS) {
    const age = latestCaseAgeSeconds(dataRoot, t);
    if (age !== null) worldAge = worldAge === null ? age : Math.min(worldAge, age);
  }
  let dbAge: number | null = null;
  for (const t of TENANTS) {
    const age = fileAgeSeconds(join(dataRoot, "runtime", "survey", t + ".db"));
    if (age !== null) dbAge = dbAge === null ? age : Math.min(dbAge, age);
  }
  let lbAge: number | null = null;
  try {
    const dir = join(dataRoot, "leaderboard");
    if (existsSync(dir)) {
      const snaps = readdirSync(dir).filter((x) => /^leaderboard-.*\.json$/.test(x)).map((x) => join(dir, x));
      const latest = snaps.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
      if (latest) lbAge = fileAgeSeconds(latest);
    }
  } catch { /* 忽略 */ }
  const shopAge = fileAgeSeconds(join(dataRoot, "runtime", "shop-history.jsonl"));
  const auditAge = fileAgeSeconds(join(dataRoot, "runtime", "human-command-audit.jsonl"));
  const mk = (name: SourceFreshness["name"], age: number | null, lagTicks?: number | null): SourceFreshness => {
    let detail = age === null ? "缺失" : age + "s";
    if (name === "surveyDb" && age !== null && lagTicks !== null && lagTicks !== undefined) {
      detail = `lag ${lagTicks} tick / ${age}s 前同步`;
    }
    return { name, ageSeconds: age, stale: age !== null && age > SOURCE_STALE_SECONDS[name], detail };
  };
  return [
    mk("world", worldAge),
    mk("surveyDb", dbAge, surveyLagTicks),
    mk("leaderboard", lbAge),
    mk("shop", shopAge),
    mk("humanAudit", auditAge),
  ];
}

/** 矿生命周期闭环守卫（2026-08-08）：有采集事件但负态为 0 → survey-sync 事件
 *  回写未生效（静默空跑类回归，如 --data-root 缺失导致全 visible）；无采集事件
 *  = NO_DATA（数据不足，不算故障）。纯函数，入参即测。 */
export function computeLifecycleFlow(tenants: readonly Pick<PipelineTenantHealth, "counts">[]): "OK" | "STALLED" | "NO_DATA" {
  const harvestEventsTotal = tenants.reduce((a, t) => a + t.counts.harvestEvents, 0);
  const negativeTotal = tenants.reduce((a, t) => a + t.counts.lifecycleNegative, 0);
  if (harvestEventsTotal === 0) return "NO_DATA";
  return negativeTotal > 0 ? "OK" : "STALLED";
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
  // 滞后趋势（2026-08-08）：滚动 avgLag 比较最近 3 次采样（15s×2=30s 窗口）。
  lagHistory.push(Math.round(avgLag));
  if (lagHistory.length > LAG_HISTORY_MAX) lagHistory.shift();
  const lagTrend = lagHistory.length >= 3
    ? (() => {
        const prev = lagHistory[lagHistory.length - 3];
        const cur = lagHistory[lagHistory.length - 1];
        const delta = cur - prev;
        const direction = delta < 0 ? "narrowing" as const : delta > 0 ? "widening" as const : "stable" as const;
        return { direction, delta, samples: lagHistory.length };
      })()
    : null;
  const lifecycleFlow = computeLifecycleFlow(tenants);
  const avgLagTicks = Math.round(avgLag);
  const decisionFreshness = {
    lagTicks: avgLagTicks,
    lagSeconds: avgLagTicks * TICK_SECONDS,
    healthy: avgLagTicks <= DECISION_FRESH_TICKS,
  };
  const payload: PipelineHealthPayload = {
    generatedAt: new Date().toISOString(),
    tenants,
    global: {
      maxLagTicks: maxLag,
      avgLagTicks,
      staleTenants,
      missingTenants,
      healthy: staleTenants.length === 0 && missingTenants.length === 0 && lifecycleFlow !== "STALLED",
      lagTrend,
      sources: computeSourceFreshness(undefined, avgLagTicks),
      decisionFreshness,
      lifecycleFlow,
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
