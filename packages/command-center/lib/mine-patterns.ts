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
  /** 矿刷新规律（2026-08-08，refill 周期）：resource_seen_history 出现窗口 → 相邻
   *  窗口起始 tick 差 = 刷新周期。新表随 sync 累积；样本 <2 时 avgRefillTicks null。 */
  refill: {
    samples: number;
    avgRefillTicks: number | null;
    recent: readonly { cell: string; gapTicks: number; lastSeenTick: number }[];
  } | null;
  /** 逐矿刷新预测（2026-08-08，矿刷新规律 → 地图/决策输入）：出现过 ≥2 次出现窗口的
   *  矿格，预测下次出现 tick = 最后出现窗口起始 + 平均周期。dueInTicks 正=还有多久
   *  预计刷新，负=已过预期（历史异常/被永久采空）。按 dueInTicks 升序（即将刷新优先）。 */
  predictions: readonly MineRefillPrediction[];
}

/** 逐矿刷新预测（2026-08-08）：cell 级 refill 估计。 */
export interface MineRefillPrediction {
  cell: string;
  x: number;
  y: number;
  /** 出现窗口数（≥2 才可预测）。 */
  windows: number;
  /** 相邻窗口起始 tick 差的均值（刷新周期估计）。 */
  avgGapTicks: number | null;
  lastSeenTick: number;
  /** 预测下次出现 tick（lastWindowStart + avgGap）。 */
  predictedNextTick: number | null;
  /** predictedNextTick - currentTick（正=预计还有多久，负=已过预期）。 */
  dueInTicks: number | null;
}

export interface MinePatternsPayload {
  generatedAt: string;
  tenant: string;
  tenants: Record<string, MineTenantPattern>;
  cachedAt: string;
}

const PATTERN_TTL_MS = 30_000;
const patternCache = new TtlCache<MinePatternsPayload>(PATTERN_TTL_MS);

/** 连续 tick 间隔 ≤ 该值视为同一出现窗口（矿可见跨 tick 抖动容忍）。 */
const REFILL_GAP_TICKS = 5;

/** 矿刷新周期统计（2026-08-08）：resource_seen_history (cell × tick) → 每格出现
 *  窗口（连续 tick 段）→ 相邻窗口起始 tick 差 = 刷新周期。无历史/样本 <2 = null。 */
function computeRefillStats(rows: readonly { cell: string; tick: number }[]): MineTenantPattern["refill"] {
  if (rows.length === 0) return null;
  const byCell = new Map<string, number[]>();
  for (const r of rows) {
    const arr = byCell.get(r.cell) ?? [];
    arr.push(num(r.tick));
    byCell.set(r.cell, arr);
  }
  const gaps: { cell: string; gapTicks: number; lastSeenTick: number }[] = [];
  for (const [cell, ticks] of byCell) {
    ticks.sort((a, b) => a - b);
    let prevStart: number | null = null;
    let prevEnd: number | null = null;
    for (const t of ticks) {
      if (prevEnd === null || t - prevEnd > REFILL_GAP_TICKS) {
        // 新出现窗口：上一窗口起始 → 本窗口起始 = 刷新周期（两次出现的间隔）
        if (prevStart !== null) gaps.push({ cell, gapTicks: t - prevStart, lastSeenTick: t });
        prevStart = t;
      }
      prevEnd = t;
    }
  }
  if (gaps.length < 2) {
    return { samples: gaps.length, avgRefillTicks: null, recent: gaps.sort((a, b) => b.lastSeenTick - a.lastSeenTick).slice(0, 10) };
  }
  gaps.sort((a, b) => b.lastSeenTick - a.lastSeenTick);
  const avg = Math.round(gaps.reduce((acc, g) => acc + g.gapTicks, 0) / gaps.length);
  return { samples: gaps.length, avgRefillTicks: avg, recent: gaps.slice(0, 10) };
}

/** 逐矿刷新预测（2026-08-08）：resource_seen_history (cell×tick) → 每格出现窗口
 *  （连续 tick 段，gap≤REFILL_GAP_TICKS 视为同一窗口）。两个信号：
 *   - avgGapTicks：相邻窗口起始差均值 = 完整刷新周期（窗口长 + 缺席长）；
 *   - predictedNextTick：最后窗口结束 + 平均缺席长（窗口间隔 − 前一窗口时长）——
 *     "矿消失后预计多久再出现"（可行动信号：stale 矿即将刷新 / visible 矿即将消失后刷新）。
 *  x/y 从 resources 查（cell→坐标）。样本 <2 窗口的格不预测（数据不足）。 */
export function computeRefillPredictions(
  rows: readonly { cell: string; tick: number }[],
  resources: readonly { cell: string; x: number; y: number }[],
  currentTick: number,
): MineRefillPrediction[] {
  const posOf = new Map<string, { x: number; y: number }>();
  for (const r of resources) posOf.set(r.cell, { x: num(r.x), y: num(r.y) });
  const byCell = new Map<string, number[]>();
  for (const r of rows) {
    const arr = byCell.get(r.cell) ?? [];
    arr.push(num(r.tick));
    byCell.set(r.cell, arr);
  }
  const out: MineRefillPrediction[] = [];
  for (const [cell, ticks] of byCell) {
    ticks.sort((a, b) => a - b);
    const windows: Array<{ start: number; end: number }> = [];
    let start = ticks[0], prevEnd = ticks[0];
    for (let i = 1; i < ticks.length; i += 1) {
      if (ticks[i] - prevEnd > REFILL_GAP_TICKS) {
        windows.push({ start, end: prevEnd });
        start = ticks[i];
      }
      prevEnd = ticks[i];
    }
    windows.push({ start, end: prevEnd });
    if (windows.length < 2) continue; // 单窗口无法预测
    const gaps: number[] = [];       // 窗口起始差（完整周期）
    const absents: number[] = [];    // 缺席长（窗口间隔 − 前一窗口时长）
    for (let i = 1; i < windows.length; i += 1) {
      const gap = windows[i].start - windows[i - 1].start;
      gaps.push(gap);
      const dur = windows[i - 1].end - windows[i - 1].start;
      absents.push(gap - dur);
    }
    const avgGap = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
    const avgAbsent = Math.max(1, Math.round(absents.reduce((a, b) => a + b, 0) / absents.length));
    const lastEnd = windows[windows.length - 1].end;
    const predictedNext = lastEnd + avgAbsent;
    const pos = posOf.get(cell) ?? { x: 0, y: 0 };
    out.push({
      cell,
      x: pos.x,
      y: pos.y,
      windows: windows.length,
      avgGapTicks: avgGap,
      lastSeenTick: prevEnd,
      predictedNextTick: predictedNext,
      dueInTicks: predictedNext - currentTick,
    });
  }
  out.sort((a, b) => (a.dueInTicks ?? 1e9) - (b.dueInTicks ?? 1e9));
  return out;
}

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
    refill: null, predictions: [],
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
    const histRows = db.prepare(
      "SELECT cell, tick FROM resource_seen_history ORDER BY tick",
    ).all() as Array<{ cell: string; tick: number }>;
    const refill = computeRefillStats(histRows);
    return {
      tenant,
      total, visible, stale,
      avgAgeTicks: total > 0 ? Math.round(ageSum / total) : 0,
      medianSeenCount,
      harvestSuccessRate: rate === null ? null : Math.round(rate * 1000) / 1000,
      harvestSucceeded: succeeded,
      harvestFailed: failed,
      topActive: entries.slice(0, 20),
      refill,
      predictions: computeRefillPredictions(
        histRows,
        rows.map((r) => ({ cell: r.x + "," + r.y, x: num(r.x), y: num(r.y) })),
        currentTick,
      ),
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
