/**
 * 联盟探索覆盖分析（2026-08-08，地图系统 + 共享测绘 + 综合决策）：
 * 基于 survey-db chunks（16×16 探索分区，跨 run 累积）计算：
 *  - 每租户探索格数/新鲜度/bbox/独家贡献（仅自己见过的 chunk——共享记忆价值）；
 *  - 联盟并集覆盖（观测跨度内覆盖率）+ 各租户独家贡献；
 *  - 距友方核心 ≤N chunk 的未探索盲区（探索扩展目标）。
 * 纯只读，30s 缓存。
 */
import { loadTenantSurveyCached } from "./survey-cache.ts";
import { loadWorld } from "./streams.ts";
import { TENANTS } from "./fs-jsonl.ts";
import { TtlCache } from "./cache.ts";

export const CHUNK_SIZE = 16;

interface ChunkRow {
  key: string;
  lastSeenTick?: number | null;
}

export interface TenantCoverage {
  tenant: string;
  exploredChunks: number;
  recentChunks: number;
  lastSeenTick: number | null;
  bbox: { minCx: number; maxCx: number; minCy: number; maxCy: number } | null;
  /** 联盟内独家贡献：仅本租户见过的 chunk 数。 */
  exclusiveChunks: number;
}

export interface ExplorationGap {
  cx: number;
  cy: number;
  nearCoreOf: string;
  /** 距该核心中心（chunk 单位）的 Chebyshev 距离。 */
  distChunks: number;
  corePos: [number, number] | null;
}

/** 补测目标（2026-08-08，测绘记录层→勘探）：已探索但观测过旧的 chunk——该区资源可能
 *  已刷新/已消耗，地图记忆过期，需重新测绘（refill 模型证伪后的替代信号：不预测刷新，
 *  而是"哪块旧观测区最该先补测"）。按 陈旧度 降序 + 距核心 升序 排。 */
export interface ResurveyTarget {
  key: string;
  cx: number;
  cy: number;
  lastSeenTick: number;
  /** currentTick - lastSeenTick（越大越旧，越该补测）。 */
  stalenessTicks: number;
  nearCoreOf: string;
  distChunks: number;
  corePos: [number, number] | null;
}

export interface AllianceExplorationPayload {
  generatedAt: string;
  world: {
    chunkSize: number;
    observedSpan: { minCx: number; maxCx: number; minCy: number; maxCy: number } | null;
    spanChunks: number;
    exploredChunks: number;
    /** 观测跨度内的覆盖率（union/span）。 */
    coveragePct: number | null;
  };
  perTenant: Record<string, TenantCoverage>;
  alliance: {
    unionChunks: number;
    unionRecent: number;
    coveragePct: number | null;
    exclusiveByTenant: Record<string, number>;
  };
  /** 距友方核心 ≤GAP_RADIUS_CHUNKS 的未探索盲区（探索扩展目标，上限 40）。 */
  gaps: ExplorationGap[];
  /** 补测目标（2026-08-08）：已探索但观测过旧的 chunk，按陈旧度+距核心排（上限 40）。 */
  resurveyTargets: ResurveyTarget[];
  cachedAt: string;
}

const TTL_MS = 30_000;
const cache = new TtlCache<AllianceExplorationPayload>(TTL_MS);
/** 新鲜窗口（tick）：与 survey A6 同口径。 */
const FRESH_WINDOW_TICKS = 2000;
/** 核心盲区半径（chunk 单位）：核心 5×5 chunk（80 格）内未探索视为盲区。 */
const GAP_RADIUS_CHUNKS = 5;
const GAP_CAP = 40;
/** 补测半径（chunk）：核心周围已探索但观测过旧的区（略大于盲区半径，覆盖回看范围）。 */
const RESURVEY_RADIUS_CHUNKS = 8;
const RESURVEY_CAP = 40;

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

function parseChunkKey(key: string): [number, number] | null {
  const m = /^(-?\d+),(-?\d+)$/.exec(key.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** 纯函数核心（可测）：由每租户 chunk 集合 + 核心位置 + 当前 tick 计算
 *  覆盖统计与盲区。chunksByTenant: {tenant -> [{key, lastSeenTick}]}。 */
export function computeExplorationStats(
  chunksByTenant: Record<string, readonly { key: string; lastSeenTick?: number | null }[]>,
  coresByTenant: Record<string, [number, number] | null>,
  currentTick: number,
): { world: AllianceExplorationPayload["world"]; perTenant: Record<string, TenantCoverage>; alliance: AllianceExplorationPayload["alliance"]; gaps: ExplorationGap[]; resurveyTargets: ResurveyTarget[] } {
  const perTenant: Record<string, TenantCoverage> = {};
  const union = new Map<string, { lastSeenTick: number; tenant: string }>();
  const tenantSets: Record<string, Set<string>> = {};

  for (const t of TENANTS) {
    const chunks = chunksByTenant[t] ?? [];
    const set = new Set<string>();
    let minCx = Infinity, maxCx = -Infinity, minCy = Infinity, maxCy = -Infinity;
    let lastSeen = 0, recent = 0;
    for (const c of chunks) {
      const pos = parseChunkKey(String(c.key ?? ""));
      if (!pos) continue;
      const [cx, cy] = pos;
      const key = `${cx},${cy}`;
      set.add(key);
      if (cx < minCx) minCx = cx;
      if (cx > maxCx) maxCx = cx;
      if (cy < minCy) minCy = cy;
      if (cy > maxCy) maxCy = cy;
      const lt = num(c.lastSeenTick);
      if (lt > lastSeen) lastSeen = lt;
      if (lt >= currentTick - FRESH_WINDOW_TICKS) recent += 1;
      const prev = union.get(key);
      if (!prev || lt > prev.lastSeenTick) union.set(key, { lastSeenTick: lt, tenant: String(t) });
    }
    tenantSets[t] = set;
    perTenant[t] = {
      tenant: t,
      exploredChunks: set.size,
      recentChunks: recent,
      lastSeenTick: lastSeen > 0 ? lastSeen : null,
      bbox: set.size > 0 ? { minCx, maxCx, minCy, maxCy } : null,
      exclusiveChunks: 0,
    };
  }

  const unionKeys = new Set(union.keys());
  const exclusiveByTenant: Record<string, number> = {};
  let unionRecent = 0;
  for (const [, v] of union) {
    if (v.lastSeenTick >= currentTick - FRESH_WINDOW_TICKS) unionRecent += 1;
  }
  for (const t of TENANTS) {
    const set = tenantSets[t] ?? new Set<string>();
    let excl = 0;
    for (const k of set) {
      let others = false;
      for (const o of TENANTS) {
        if (o !== t && tenantSets[o]?.has(k)) { others = true; break; }
      }
      if (!others) excl += 1;
    }
    perTenant[t] = { ...perTenant[t], exclusiveChunks: excl };
    exclusiveByTenant[t] = excl;
  }

  let minCx = Infinity, maxCx = -Infinity, minCy = Infinity, maxCy = -Infinity;
  for (const k of unionKeys) {
    const [cx, cy] = parseChunkKey(k) ?? [0, 0];
    if (cx < minCx) minCx = cx;
    if (cx > maxCx) maxCx = cx;
    if (cy < minCy) minCy = cy;
    if (cy > maxCy) maxCy = cy;
  }
  const hasSpan = Number.isFinite(minCx) && minCx <= maxCx;
  const span = hasSpan ? { minCx, maxCx, minCy, maxCy } : null;
  const spanChunks = span ? (maxCx - minCx + 1) * (maxCy - minCy + 1) : 0;
  const coveragePct = spanChunks > 0 ? Math.round((unionKeys.size / spanChunks) * 1000) / 10 : null;

  const gaps: ExplorationGap[] = [];
  if (span) {
    for (const t of TENANTS) {
      const pos = coresByTenant[t];
      if (!pos) continue;
      const [coreX, coreY] = pos;
      if (!Number.isFinite(coreX) || !Number.isFinite(coreY)) continue;
      const ccx = Math.floor(coreX / CHUNK_SIZE);
      const ccy = Math.floor(coreY / CHUNK_SIZE);
      for (let dx = -GAP_RADIUS_CHUNKS; dx <= GAP_RADIUS_CHUNKS; dx += 1) {
        for (let dy = -GAP_RADIUS_CHUNKS; dy <= GAP_RADIUS_CHUNKS; dy += 1) {
          const cx = ccx + dx, cy = ccy + dy;
          const key = `${cx},${cy}`;
          if (unionKeys.has(key)) continue;
          // 盲区 = 核心附近未探索格（不限于已探索跨度——扩展方向正是核心周围空白）
          gaps.push({ cx, cy, nearCoreOf: t, distChunks: Math.max(Math.abs(dx), Math.abs(dy)), corePos: [coreX, coreY] });
        }
      }
    }
  }
  const seen = new Set<string>();
  const dedup: ExplorationGap[] = [];
  gaps.sort((a, b) => a.distChunks - b.distChunks || a.nearCoreOf.localeCompare(b.nearCoreOf));
  for (const g of gaps) {
    const key = `${g.cx},${g.cy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(g);
    if (dedup.length >= GAP_CAP) break;
  }

  // 补测目标（2026-08-08）：已探索 chunk 中观测过旧（< currentTick - FRESH）且
  //  距任一友方核心 ≤RESURVEY_RADIUS_CHUNKS —— 旧观测区优先重测（资源可能已变）。
  const rsSeen = new Set<string>();
  const resurveyTargets: ResurveyTarget[] = [];
  {
    const stale: Array<{ key: string; lastSeenTick: number }> = [];
    for (const [key, v] of union) {
      if (v.lastSeenTick < currentTick - FRESH_WINDOW_TICKS) stale.push({ key, lastSeenTick: v.lastSeenTick });
    }
    stale.sort((a, b) => a.lastSeenTick - b.lastSeenTick); // 最旧优先
    for (const s of stale) {
      if (rsSeen.has(s.key)) continue;
      const [cx, cy] = parseChunkKey(s.key) ?? [0, 0];
      let best: { t: string; d: number; pos: [number, number] | null } | null = null;
      for (const t of TENANTS) {
        const pos = coresByTenant[t];
        if (!pos) continue;
        const ccx = Math.floor(pos[0] / CHUNK_SIZE), ccy = Math.floor(pos[1] / CHUNK_SIZE);
        const d = Math.max(Math.abs(cx - ccx), Math.abs(cy - ccy));
        if (d <= RESURVEY_RADIUS_CHUNKS && (!best || d < best.d)) best = { t, d, pos };
      }
      if (!best) continue;
      rsSeen.add(s.key);
      resurveyTargets.push({ key: s.key, cx, cy, lastSeenTick: s.lastSeenTick, stalenessTicks: currentTick - s.lastSeenTick, nearCoreOf: best.t, distChunks: best.d, corePos: best.pos });
      if (resurveyTargets.length >= RESURVEY_CAP) break;
    }
  }

  return {
    world: { chunkSize: CHUNK_SIZE, observedSpan: span, spanChunks, exploredChunks: unionKeys.size, coveragePct },
    perTenant,
    alliance: { unionChunks: unionKeys.size, unionRecent, coveragePct, exclusiveByTenant },
    gaps: dedup,
    resurveyTargets,
  };
}

function loadAllianceExplorationInner(): AllianceExplorationPayload {
  const chunksByTenant: Record<string, { key: string; lastSeenTick?: number | null }[]> = {};
  const coresByTenant: Record<string, [number, number] | null> = {};
  let currentTick = 0;
  for (const t of TENANTS) {
    const cached = loadTenantSurveyCached(t);
    chunksByTenant[t] = (cached.survey?.chunks ?? []) as unknown as { key: string; lastSeenTick?: number | null }[];
    const world = loadWorld(t) as { state?: { tick?: unknown; objects?: Array<{ kind?: string; controlled?: boolean; position?: unknown }> } | null };
    // tick 在 world 顶层（streams.ts loadWorld 返回 { tick, state }）——2026-08-08 修正
    // 原读 state.tick 恒 undefined → currentTick=0 → 新鲜度/补测全失效。
    const wt = num((world as { tick?: unknown }).tick ?? world.state?.tick);
    if (wt > currentTick) currentTick = wt;
    // 友方核心在 state.objects（kind=CORE + controlled），非 state.core 字段（2026-08-08 修正）
    const coreObj = (world.state?.objects ?? []).find((o) => o.kind === "CORE" && o.controlled === true);
    const pos = coreObj?.position;
    coresByTenant[t] = Array.isArray(pos) && pos.length >= 2 ? [num(pos[0]), num(pos[1])] : null;
  }
  const stats = computeExplorationStats(chunksByTenant, coresByTenant, currentTick);
  return { generatedAt: new Date().toISOString(), ...stats, cachedAt: new Date().toISOString() };
}

export function loadAllianceExploration(): AllianceExplorationPayload {
  const hit = cache.get("all");
  if (hit !== undefined) return hit;
  const payload = loadAllianceExplorationInner();
  cache.set("all", payload);
  return payload;
}

export function refreshAllianceExploration(): void {
  cache.invalidate();
  loadAllianceExploration();
}
