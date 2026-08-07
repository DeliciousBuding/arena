/**
 * 信标/敌核历史轨迹：跨 run 增量缓存，按 tick 升序去重连续同格，
 * 供面板画虚线轨迹 + 方向箭头。
 * 信标：全玩家共享同一对象，位置随携带者迁移（实测 1 格/4-5 tick）；
 * 敌核：按 username 收集（controlled=false），展示谁在迁移/逼近。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calibrationDir, listCases, parseTick, runsByMaxTick } from "./fs-jsonl.ts";

export interface TrailPoint { x: number; y: number; tick: number }

/** 信标历史轨迹（跨 run 增量缓存）：跨最近 N 个 run 合并历史（run 重启不丢轨迹）。
 *  增量：同一最新 run 新 case 只追加新点；run 变更才重建。 */
const beaconTrailCache = new Map<string, { latestRun: string; latestFile: string | null; trail: TrailPoint[] }>();
const BEACON_TRAIL_RUNS = 6; // 跨最近 N 个 run 合并历史（run 重启不丢轨迹）
const BEACON_TRAIL_CASE_LIMIT = 300; // 每 run 最多扫 N 个 case（首扫/重建成本上限）
const BEACON_TRAIL_MAX_POINTS = 96; // 轨迹点数上限（超长滚动保留最近）

function beaconPointsFromRun(tenant: string, runDir: string, maxCases: number): TrailPoint[] {
  const files = listCases(tenant, runDir).slice(-maxCases);
  const pts: TrailPoint[] = [];
  let lastKey: string | null = null;
  for (const file of files) {
    const path = join(calibrationDir(tenant), runDir, "cases", file);
    let raw: { before?: { state?: { champion_beacon?: { position?: number[] } } } } | null = null;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    const cb = raw?.before?.state?.champion_beacon;
    if (!cb?.position) continue;
    const x = cb.position[0], y = cb.position[1];
    const key = x + "," + y;
    if (key === lastKey) continue; // 连续同格去重（不动 = 不堆点）
    lastKey = key;
    pts.push({ x, y, tick: parseTick(file) });
  }
  return pts;
}

export function loadBeaconTrail(tenant: string): TrailPoint[] {
  const runs = runsByMaxTick(tenant).slice(0, BEACON_TRAIL_RUNS);
  if (!runs.length) return [];
  const latestRun = runs[0].run;
  const latestFiles = listCases(tenant, latestRun);
  const latestFile = latestFiles.length ? latestFiles[latestFiles.length - 1] : null;
  const cached = beaconTrailCache.get(tenant);
  if (cached && cached.latestRun === latestRun && cached.latestFile === latestFile) return cached.trail;
  let trail: TrailPoint[] = [];
  if (cached && cached.latestRun === latestRun && cached.latestFile) {
    // 增量：同一最新 run，只补新 case
    const files = listCases(tenant, latestRun);
    const from = files.indexOf(cached.latestFile);
    if (from >= 0) {
      trail = [...cached.trail];
      let lastKey: string | null = trail.length ? trail[trail.length - 1].x + "," + trail[trail.length - 1].y : null;
      for (let i = from + 1; i < files.length; i++) {
        const file = files[i];
        const path = join(calibrationDir(tenant), latestRun, "cases", file);
        let raw: { before?: { state?: { champion_beacon?: { position?: number[] } } } } | null = null;
        try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
        const cb = raw?.before?.state?.champion_beacon;
        if (!cb?.position) continue;
        const key = cb.position[0] + "," + cb.position[1];
        if (key === lastKey) continue;
        lastKey = key;
        trail.push({ x: cb.position[0], y: cb.position[1], tick: parseTick(file) });
        if (trail.length > BEACON_TRAIL_MAX_POINTS) trail.shift();
      }
    }
  }
  if (trail.length === 0) {
    // 重建：跨最近 N 个 run 合并（按 tick 升序），连续同格去重，超长滚动保留最近
    const all: TrailPoint[] = [];
    for (const r of runs) all.push(...beaconPointsFromRun(tenant, r.run, BEACON_TRAIL_CASE_LIMIT));
    all.sort((a, b) => a.tick - b.tick);
    let lastKey: string | null = null;
    for (const pt of all) {
      const key = pt.x + "," + pt.y;
      if (key === lastKey) continue;
      lastKey = key;
      trail.push(pt);
      if (trail.length > BEACON_TRAIL_MAX_POINTS) trail.shift();
    }
  }
  beaconTrailCache.set(tenant, { latestRun, latestFile, trail });
  return trail;
}

/** 敌方核心历史轨迹（跨 run 增量缓存）：与信标轨迹同机制，按
 *  username 收集敌 CORE 位置序列（controlled=false）——面板画虚线展示谁在
 *  迁移/逼近（如 jerkman 核心带信标东移）。 */
interface CoreTrailCacheEntry { latestRun: string; lastFile: string | null; byUser: Map<string, { lastKey: string | null; pts: TrailPoint[] }>; list: Array<{ username: string; trail: TrailPoint[] }> }
const coreTrailCache = new Map<string, CoreTrailCacheEntry>();
const CORE_TRAIL_RUNS = 6;
const CORE_TRAIL_CASE_LIMIT = 300;
const CORE_TRAIL_MAX_POINTS = 48;

function corePointsFromRun(tenant: string, runDir: string, maxCases: number): Map<string, { lastKey: string | null; pts: TrailPoint[] }> {
  const files = listCases(tenant, runDir).slice(-maxCases);
  const byUser = new Map<string, { lastKey: string | null; pts: TrailPoint[] }>(); // username -> { lastKey, pts }
  for (const file of files) {
    const path = join(calibrationDir(tenant), runDir, "cases", file);
    let raw: { before?: { state?: { objects?: Array<Record<string, unknown>> } } } | null = null;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    const objs = raw?.before?.state?.objects;
    if (!Array.isArray(objs)) continue;
    const tick = parseTick(file);
    for (const obj of objs) {
      if (obj?.kind !== "CORE" || obj.controlled !== false || !obj.owner_username || !obj.position) continue;
      const x = (obj.position as number[])[0], y = (obj.position as number[])[1];
      const key = x + "," + y;
      let rec = byUser.get(obj.owner_username as string);
      if (!rec) { rec = { lastKey: null, pts: [] }; byUser.set(obj.owner_username as string, rec); }
      if (key === rec.lastKey) continue; // 连续同格去重
      rec.lastKey = key;
      rec.pts.push({ x, y, tick });
      if (rec.pts.length > CORE_TRAIL_MAX_POINTS) rec.pts.shift();
    }
  }
  return byUser;
}

export function loadCoreTrails(tenant: string): Array<{ username: string; trail: TrailPoint[] }> {
  const runs = runsByMaxTick(tenant).slice(0, CORE_TRAIL_RUNS);
  if (!runs.length) return [];
  const latestRun = runs[0].run;
  const latestFiles = listCases(tenant, latestRun);
  const latestFile = latestFiles.length ? latestFiles[latestFiles.length - 1] : null;
  const cached = coreTrailCache.get(tenant);
  if (cached && cached.latestRun === latestRun && cached.lastFile === latestFile) return cached.list;
  let byUser: Map<string, { lastKey: string | null; pts: TrailPoint[] }> | null = null;
  if (cached && cached.latestRun === latestRun && cached.lastFile) {
    const from = latestFiles.indexOf(cached.lastFile);
    if (from >= 0) {
      byUser = new Map(cached.byUser);
      for (let i = from + 1; i < latestFiles.length; i++) {
        const path = join(calibrationDir(tenant), latestRun, "cases", latestFiles[i]);
        let raw: { before?: { state?: { objects?: Array<Record<string, unknown>> } } } | null = null;
        try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
        const objs = raw?.before?.state?.objects;
        if (!Array.isArray(objs)) continue;
        const tick = parseTick(latestFiles[i]);
        for (const obj of objs) {
          if (obj?.kind !== "CORE" || obj.controlled !== false || !obj.owner_username || !obj.position) continue;
          const x = (obj.position as number[])[0], y = (obj.position as number[])[1], key = x + "," + y;
          let rec = byUser.get(obj.owner_username as string);
          if (!rec) { rec = { lastKey: null, pts: [] }; byUser.set(obj.owner_username as string, rec); }
          if (key === rec.lastKey) continue;
          rec.lastKey = key;
          rec.pts.push({ x, y, tick });
          if (rec.pts.length > CORE_TRAIL_MAX_POINTS) rec.pts.shift();
        }
      }
    }
  }
  if (!byUser) {
    byUser = new Map();
    for (const r of runs) {
      for (const [u, rec] of corePointsFromRun(tenant, r.run, CORE_TRAIL_CASE_LIMIT)) {
        const target = byUser.get(u);
        if (!target) { byUser.set(u, rec); continue; }
        const merged = [...target.pts, ...rec.pts].sort((a, b) => a.tick - b.tick);
        const pts: TrailPoint[] = [];
        let lastKey: string | null = null;
        for (const p of merged) {
          const key = p.x + "," + p.y;
          if (key === lastKey) continue;
          lastKey = key;
          pts.push(p);
          if (pts.length > CORE_TRAIL_MAX_POINTS) pts.shift();
        }
        byUser.set(u, { lastKey: pts.length ? pts[pts.length - 1].x + "," + pts[pts.length - 1].y : null, pts });
      }
    }
  }
  const list = [...byUser.entries()].map(([username, rec]) => ({ username, trail: rec.pts }));
  coreTrailCache.set(tenant, { latestRun, lastFile: latestFile, byUser, list });
  return list;
}
