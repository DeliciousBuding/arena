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
import { RESOURCE_FRESH_WINDOW_TICKS } from "./survey.ts";

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
  /** refill 数据源（2026-08-08 A15）：absences=视野覆盖负观测实证（真实缺席→重见
   *  周期）；history=出现窗口（观测中断噪声，仅无缺席数据 fallback）；none=无。 */
  refillSource: "absences" | "history" | "none";
  /** 缺席时长分布（2026-08-08 A16）：严格连续缺席段（GAP=1，观察者逐 tick 覆盖）
   *  长度 = 矿真实缺席时长——实测 median 1 / p90 8 tick（矿快速 refill，与游戏
   *  4 tick 结算一致）。替代「段结束→重见」的错误观测间隔（观察者离开拉长）。 */
  absentStats: {
    segCount: number;
    medianLen: number | null;
    p90Len: number | null;
    p99Len: number | null;
  } | null;
  /** 疑似死矿（2026-08-08 A16）：有 ≥ DEAD_ABSENT_TICKS 长连续缺席段的已知矿格
   *  ——视野持续覆盖却长期无矿，刷新率极低（真实缺席，非视野盲区）。 */
  deadMines: readonly { cell: string; x: number; y: number; maxAbsentLen: number; lastAbsentTick: number }[];
  /** 逐矿刷新预测（2026-08-08，矿刷新规律 → 地图/决策输入）：出现过 ≥2 次出现窗口的
   *  矿格，预测下次出现 tick = 最后出现窗口起始 + 平均周期。dueInTicks 正=还有多久
   *  预计刷新，负=已过预期（历史异常/被永久采空）。按 dueInTicks 升序（即将刷新优先）。 */
  predictions: readonly MineRefillPrediction[];
  /** 预测命中率（2026-08-08，算法适配验证）：已过预测时间的预测重见率——mission 层
   *  Phase 2 死矿剔除的可靠度信号。 */
  predictionAccuracy: MinePredictionAccuracy | null;
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
  /** 模型局限说明（2026-08-08）：resource_seen_history 是观测记录，非资源生命周期——
   *  观测间隔 ≠ 资源缺席。实测已过预测时间命中率 0%（401 样本、四租户），refill 预测
   *  不能用于死矿剔除/刷新计时，只能作低优先级参考。消费方（mission Phase 2）应据此调整。 */
  modelCaveat: string;
  cachedAt: string;
}

const PATTERN_TTL_MS = 30_000;
const patternCache = new TtlCache<MinePatternsPayload>(PATTERN_TTL_MS);

/** 连续 tick 间隔 ≤ 该值视为同一出现窗口（矿可见跨 tick 抖动容忍）。 */
const REFILL_GAP_TICKS = 5;
/** 疑似死矿阈值（2026-08-08 A16）：视野持续覆盖下缺席段 ≥ 该值（tick）→ 矿
 *  长时间未 refill（真实刷新极慢/不再刷新）。实证短缺席 median 1 / p90 8 tick，
 *  >200 tick 缺席段仅 0.7% 且多为观察者断续——保守阈值取 200。 */
const DEAD_ABSENT_TICKS = 200;

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

/** 缺席→重见刷新周期（2026-08-08，A15 负观测）：resource_absences（我方视野覆盖内
 *  确认无矿的真实缺席）连续段（gap≤5 合并）→ 段结束后在 resource_seen_history 首次
 *  重见 → 周期 = 重见 − 段尾。与出现窗口 gap（观测中断噪声）不同，缺席段是「看得到且
 *  没有矿」的真实证据。无缺席数据或全部无重见 → 返回 null（消费方回退旧逻辑）。 */
function computeRefillStatsFromAbsences(
  absences: readonly { cell: string; tick: number }[],
  seenHistory: readonly { cell: string; tick: number }[],
): MineTenantPattern["refill"] {
  if (absences.length === 0) return null;
  const byCell = new Map<string, number[]>();
  for (const a of absences) {
    const arr = byCell.get(a.cell) ?? [];
    arr.push(num(a.tick));
    byCell.set(a.cell, arr);
  }
  const seenByCell = new Map<string, number[]>();
  for (const s of seenHistory) {
    const arr = seenByCell.get(s.cell) ?? [];
    arr.push(num(s.tick));
    seenByCell.set(s.cell, arr);
  }
  const gaps: { cell: string; gapTicks: number; lastSeenTick: number }[] = [];
  for (const [cell, ticks] of byCell) {
    ticks.sort((a, b) => a - b);
    // 缺席窗口（连续段）
    let start = ticks[0], prevEnd = ticks[0];
    const segs: Array<{ start: number; end: number }> = [];
    for (let i = 1; i < ticks.length; i += 1) {
      if (ticks[i] - prevEnd > REFILL_GAP_TICKS) {
        segs.push({ start, end: prevEnd });
        start = ticks[i];
      }
      prevEnd = ticks[i];
    }
    segs.push({ start, end: prevEnd });
    const seen = seenByCell.get(cell) ?? [];
    for (const seg of segs) {
      const after = seen.find((x) => x > seg.end + REFILL_GAP_TICKS);
      if (after !== undefined) gaps.push({ cell, gapTicks: after - seg.end, lastSeenTick: after });
    }
  }
  if (gaps.length === 0) {
    return { samples: 0, avgRefillTicks: null, recent: [] };
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

/** 缺席时长分布（2026-08-08 A16）：严格连续缺席段（GAP=1）长度——观察者逐 tick
 *  持续覆盖时，段长 = 矿真实缺席时长（矿消失→refill）。median/p90/p99 实证 1-8 tick
 *  = 快速 refill。纯函数可测。 */
export function computeAbsentStats(
  absences: readonly { cell: string; tick: number }[],
): MineTenantPattern["absentStats"] {
  if (absences.length === 0) return null;
  const byCell = new Map<string, number[]>();
  for (const a of absences) {
    const arr = byCell.get(a.cell) ?? [];
    arr.push(num(a.tick));
    byCell.set(a.cell, arr);
  }
  const lens: number[] = [];
  for (const ticks of byCell.values()) {
    ticks.sort((a, b) => a - b);
    let start = ticks[0], prev = ticks[0];
    for (let i = 1; i < ticks.length; i += 1) {
      if (ticks[i] - prev > 1) {
        lens.push(prev - start);
        start = ticks[i];
      }
      prev = ticks[i];
    }
    lens.push(prev - start);
  }
  if (lens.length === 0) return null;
  lens.sort((a, b) => a - b);
  const pct = (q: number): number => lens[Math.min(lens.length - 1, Math.floor(lens.length * q))];
  return {
    segCount: lens.length,
    medianLen: lens[Math.floor(lens.length / 2)],
    p90Len: pct(0.9),
    p99Len: pct(0.99),
  };
}

/** 疑似死矿（2026-08-08 A16）：严格连续缺席段 ≥ DEAD_ABSENT_TICKS 的已知矿格。
 *  视野持续覆盖却长期无矿 = 真实低刷新（区别于视野盲区）；maxAbsentLen = 最长段，
 *  lastAbsentTick = 该格最后缺席 tick（距 now 越近越可能仍缺席）。纯函数可测。 */
export function computeDeadMines(
  absences: readonly { cell: string; tick: number }[],
  resources: readonly { cell: string; x: number; y: number }[],
): MineTenantPattern["deadMines"] {
  if (absences.length === 0) return [];
  const posOf = new Map<string, { x: number; y: number }>();
  for (const r of resources) posOf.set(r.cell, { x: num(r.x), y: num(r.y) });
  const byCell = new Map<string, number[]>();
  for (const a of absences) {
    const arr = byCell.get(a.cell) ?? [];
    arr.push(num(a.tick));
    byCell.set(a.cell, arr);
  }
  const out: Array<MineTenantPattern["deadMines"][number]> = [];
  for (const [cell, ticks] of byCell) {
    ticks.sort((a, b) => a - b);
    let start = ticks[0], prev = ticks[0], maxLen = 0, lastAbsent = ticks[ticks.length - 1];
    for (let i = 1; i < ticks.length; i += 1) {
      if (ticks[i] - prev > 1) {
        maxLen = Math.max(maxLen, prev - start);
        start = ticks[i];
      }
      prev = ticks[i];
    }
    maxLen = Math.max(maxLen, prev - start);
    if (maxLen >= DEAD_ABSENT_TICKS) {
      const pos = posOf.get(cell) ?? { x: 0, y: 0 };
      out.push({ cell, x: pos.x, y: pos.y, maxAbsentLen: maxLen, lastAbsentTick: lastAbsent });
    }
  }
  out.sort((a, b) => b.maxAbsentLen - a.maxAbsentLen);
  return out;
}

/** 逐矿刷新预测（A15 负观测版）：用缺席段→重见的真实刷新周期预测下次出现。
 *  每格：最后缺席段结束 + avg 缺席→重见周期 = 预计下次刷新。仅对「有缺席→重见
 *  实证周期」的格预测（其余格数据不足不预测——避免出现窗口观测噪声的假预测）。
 *  纯函数可测。 */
export function computeRefillPredictionsFromAbsences(
  absences: readonly { cell: string; tick: number }[],
  seenHistory: readonly { cell: string; tick: number }[],
  resources: readonly { cell: string; x: number; y: number }[],
  currentTick: number,
): MineRefillPrediction[] {
  const posOf = new Map<string, { x: number; y: number }>();
  for (const r of resources) posOf.set(r.cell, { x: num(r.x), y: num(r.y) });
  const absByCell = new Map<string, number[]>();
  for (const a of absences) {
    const arr = absByCell.get(a.cell) ?? [];
    arr.push(num(a.tick));
    absByCell.set(a.cell, arr);
  }
  const seenByCell = new Map<string, number[]>();
  for (const sh of seenHistory) {
    const arr = seenByCell.get(sh.cell) ?? [];
    arr.push(num(sh.tick));
    seenByCell.set(sh.cell, arr);
  }
  const out: MineRefillPrediction[] = [];
  for (const [cell, ticks] of absByCell) {
    ticks.sort((a, b) => a - b);
    const segs: Array<{ start: number; end: number }> = [];
    let start = ticks[0], prevEnd = ticks[0];
    for (let i = 1; i < ticks.length; i += 1) {
      if (ticks[i] - prevEnd > REFILL_GAP_TICKS) {
        segs.push({ start, end: prevEnd });
        start = ticks[i];
      }
      prevEnd = ticks[i];
    }
    segs.push({ start, end: prevEnd });
    const seen = seenByCell.get(cell) ?? [];
    // 每段（除最后）→ 之后首次重见 = 周期样本
    const cycles: number[] = [];
    for (let i = 0; i < segs.length - 1; i += 1) {
      const after = seen.find((x) => x > segs[i].end + REFILL_GAP_TICKS);
      if (after !== undefined) cycles.push(after - segs[i].end);
    }
    if (cycles.length < 1) continue; // 无实证周期不预测
    const avgCycle = Math.round(cycles.reduce((a, b) => a + b, 0) / cycles.length);
    const lastSeg = segs[segs.length - 1];
    const predictedNext = lastSeg.end + avgCycle;
    const pos = posOf.get(cell) ?? { x: 0, y: 0 };
    out.push({
      cell,
      x: pos.x,
      y: pos.y,
      windows: segs.length,
      avgGapTicks: avgCycle,
      lastSeenTick: lastSeg.end,
      predictedNextTick: predictedNext,
      dueInTicks: predictedNext - currentTick,
    });
  }
  out.sort((a, b) => (a.dueInTicks ?? 1e9) - (b.dueInTicks ?? 1e9));
  return out;
}

/** 矿刷新预测命中率评估（2026-08-08，算法适配验证）：对已过预测时间的预测，
 *  检查该格是否在预测时间 ± 容差内被再次观测到。hitRate 高低直接决定 mission 层
 *  Phase 2「死矿剔除」的可靠度——过低则预测不可信，不应剔除只应降权。纯函数可测。 */
export interface MinePredictionAccuracy {
  /** 已过预测时间的预测数（可判定样本）。 */
  evaluated: number;
  /** 预测时间 ± 容差内重见的格数。 */
  hits: number;
  misses: number;
  hitRate: number | null;
  /** 未命中预测平均已过预期时长（tick）——偏离程度。 */
  avgMissOverdue: number | null;
}

export function computePredictionAccuracy(
  predictions: readonly MineRefillPrediction[],
  rows: readonly { cell: string; tick: number }[],
  currentTick: number,
): MinePredictionAccuracy | null {
  const maxByCell = new Map<string, number>();
  for (const r of rows) {
    const cur = maxByCell.get(r.cell) ?? -1;
    if (num(r.tick) > cur) maxByCell.set(r.cell, num(r.tick));
  }
  const TOL = REFILL_GAP_TICKS;
  let evaluated = 0, hits = 0, missSum = 0;
  for (const p of predictions) {
    const next = p.predictedNextTick;
    if (next === null || next === undefined || !Number.isFinite(next)) continue;
    if (currentTick - next < TOL) continue; // 未到判定窗口（预测时间还没到 / 刚到）
    evaluated += 1;
    const maxSeen = maxByCell.get(p.cell) ?? -1;
    if (maxSeen >= next - TOL) {
      hits += 1; // 预测时间 ± 容差内重见
    } else {
      missSum += currentTick - next;
    }
  }
  if (evaluated === 0) return null;
  const misses = evaluated - hits;
  return {
    evaluated,
    hits,
    misses,
    hitRate: Math.round((hits / evaluated) * 1000) / 1000,
    avgMissOverdue: misses > 0 ? Math.round(missSum / misses) : null,
  };
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
    refill: null, refillSource: "none", absentStats: null, deadMines: [], predictions: [], predictionAccuracy: null,
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
    const FRESH = RESOURCE_FRESH_WINDOW_TICKS; // 与 survey.ts 统一（200 tick）
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
    // A15 负观测：resource_absences（视野覆盖内确认无矿的真实缺席）优先——缺席→重见
    // 周期是真实刷新周期；resource_seen_history 出现窗口含观测中断噪声（视野移开=
    // 假消失），仅作无缺席数据时的 fallback。
    let absRows: Array<{ cell: string; tick: number }> = [];
    try {
      absRows = db.prepare(
        "SELECT cell, tick FROM resource_absences ORDER BY tick",
      ).all() as Array<{ cell: string; tick: number }>;
    } catch { /* 旧库无表 */ }
    const resCells = rows.map((r) => ({ cell: r.x + "," + r.y, x: num(r.x), y: num(r.y) }));
    const absStats = computeRefillStatsFromAbsences(absRows, histRows);
    const refill = absStats !== null && absStats.samples > 0 ? absStats : computeRefillStats(histRows);
    const predictions = absStats !== null && absStats.samples > 0
      ? computeRefillPredictionsFromAbsences(absRows, histRows, resCells, currentTick)
      : computeRefillPredictions(histRows, resCells, currentTick);
    const predictionAccuracy = computePredictionAccuracy(predictions, histRows, currentTick);
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
      refillSource: absStats !== null && absStats.samples > 0 ? "absences" : (histRows.length > 0 ? "history" : "none"),
      absentStats: computeAbsentStats(absRows),
      deadMines: computeDeadMines(absRows, resCells),
      predictions,
      predictionAccuracy,
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
  const evaluated = Object.values(perTenant).reduce((a, p) => a + (p.predictionAccuracy?.evaluated ?? 0), 0);
  const hits = Object.values(perTenant).reduce((a, p) => a + (p.predictionAccuracy?.hits ?? 0), 0);
  const absTenants = Object.values(perTenant).filter((p) => p.refillSource === "absences").length;
  // A16：真实刷新信号 = 缺席段长度分布（median 1 / p90 8 tick，矿快速 refill）——
  // 「段结束→重见」预测命中率低是观察者离开的观测间隔，不作刷新计时；死矿 = 长期
  // 缺席段（≥200 tick）格。caveat 反映该实证结论。
  const deadTotal = Object.values(perTenant).reduce((a, p) => a + p.deadMines.length, 0);
  const absLine = absTenants > 0
    ? Object.values(perTenant)
      .filter((p) => p.absentStats !== null)
      .map((p) => `${p.tenant} med=${p.absentStats!.medianLen}/p90=${p.absentStats!.p90Len}`)
      .join(" ")
    : "";
  const caveat = absTenants > 0
    ? `缺席段实证：${absLine}（tick，median/p90——矿消失后快速 refill）；「段结束→重见」预测命中率 ${hits}/${evaluated} 低 = 观察者离开的观测间隔，不作刷新计时；疑似死矿 ${deadTotal} 格（≥200 tick 长缺席段）。派工按 lastSeenTick 新鲜度 + deadMines 剔除。`
    : (evaluated > 0 && hits / evaluated < 0.1
      ? `观测间隔≠资源缺席：refill 预测已过预期命中率 ${hits}/${evaluated}（${Math.round((hits / evaluated) * 100)}%）——resource_seen_history 只记观测 tick（无 resource_absences 负观测），矿格长时间未被测绘即被误判"失联/死矿"。建议按 lastSeenTick 新鲜度派工，勿按 refill 预测剔除。`
      : "refill 预测命中率正常（样本不足或命中率高），可作刷新参考。");
  const payload: MinePatternsPayload = {
    generatedAt: new Date().toISOString(),
    tenant,
    tenants: perTenant,
    modelCaveat: caveat,
    cachedAt: new Date().toISOString(),
  };
  patternCache.set(key, payload);
  return payload;
}

/** 后台预热。 */
export function refreshMinePatterns(): void {
  loadMinePatterns("all");
}
