/**
 * 全局联盟测绘地图：合并 4 租户最新 calibration case →
 * 全局 cells/bounds/beacons/coreTrails（只读）。
 * 测绘语义：障碍/资源 = 静态地形累积（lastSeen 新鲜度）；单位/核心 = 动态层
 * 按 object id 保留最新 tick 快照（以 after.state 为准，已摧毁的不残留）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TENANTS, calibrationDir, cellKey, latestRunDir, listCases, parseTick } from "./fs-jsonl.ts";
import { loadBeaconTrail, loadCoreTrails, type TrailPoint } from "./trails.ts";

const SURVEY_CASE_LIMIT = 24; // 每个租户累积测绘最多取最近 N 个 case（覆盖与新鲜度平衡）

export interface MapCell {
  x: number;
  y: number;
  type: "obstacle" | "resource" | "unit" | "core";
  tick: number;
  hp?: number;
  shield?: number;
  controlled?: boolean;
  owner?: string | null;
  id?: string | null;
  unitType?: string;
  cargo?: number;
  tenant: string;
  fresh: boolean;
}
export interface MergedMap {
  generatedAt: string;
  tenants: Array<{ tenant: string; runId: string | null; caseCount: number; latestTick: number | null; beacon: unknown }>;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  cellCount: number;
  cells: MapCell[];
  beacons: Array<{ tenant: string; x: number; y: number; status: string; carrier_id: string | null; trail: TrailPoint[] }>;
  coreTrails: Array<{ username: string; trail: TrailPoint[]; tenant?: string }>;
}

interface TerrainEntry { x: number; y: number; type: "obstacle" | "resource"; tick: number }
interface DynamicEntry { x: number; y: number; type: "unit" | "core"; tick: number; hp?: number; shield?: number; controlled?: boolean; owner?: string | null; id?: string | null; unitType?: string; cargo?: number }

export function loadMergedMap(): MergedMap {
  const cells = new Map<string, MapCell>();
  const perTenant: MergedMap["tenants"] = [];
  for (const tenant of TENANTS) {
    const runDir = latestRunDir(tenant);
    if (runDir === null) {
      perTenant.push({ tenant, runId: null, caseCount: 0, latestTick: null, beacon: null });
      continue;
    }
    const caseFiles = listCases(tenant, runDir).slice(-SURVEY_CASE_LIMIT);
    let latestTick = 0;
    const terrain = new Map<string, TerrainEntry>(); // key -> { type, tick }（obstacle/resource 累积）
    const coreById = new Map<string, DynamicEntry>(); // id -> 最新快照
    const unitById = new Map<string, DynamicEntry>(); // id -> 最新快照
    for (const file of caseFiles) {
      const tick = parseTick(file);
      if (tick > latestTick) latestTick = tick;
      const path = join(calibrationDir(tenant), runDir, "cases", file);
      let raw: { before?: { state?: { objects?: Array<Record<string, unknown>> } } } | null = null;
      try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
      const state = raw?.before?.state;
      if (!state?.objects) continue;
      for (const obj of state.objects) {
        if (obj.kind === "OBSTACLE") {
          for (const [x, y] of (obj.positions as number[][] | undefined) ?? []) {
            const key = cellKey(x, y);
            const cur = terrain.get(key);
            if (!cur || cur.type !== "obstacle") terrain.set(key, { x, y, type: "obstacle", tick });
          }
        } else if (obj.kind === "RESOURCE") {
          for (const [x, y] of (obj.positions as number[][] | undefined) ?? []) {
            const key = cellKey(x, y);
            const cur = terrain.get(key);
            if (!cur || cur.type !== "obstacle") terrain.set(key, { x, y, type: "resource", tick });
          }
        } else if (obj.kind === "CORE") {
          const [x, y] = (obj.position as number[] | undefined) ?? [0, 0];
          const id = typeof obj.id === "string" ? obj.id : `core@${x},${y}`;
          const cur = coreById.get(id);
          if (!cur || tick >= cur.tick) coreById.set(id, { x, y, type: "core", tick, hp: obj.hp as number, shield: obj.shield as number, controlled: obj.controlled as boolean, owner: typeof obj.owner_username === "string" ? obj.owner_username : null, id: typeof obj.id === "string" ? obj.id : null });
        } else if (obj.kind === "UNIT") {
          const [x, y] = (obj.position as number[] | undefined) ?? [0, 0];
          const id = obj.id as string | undefined;
          if (!id) continue;
          const cur = unitById.get(id);
          if (!cur || tick >= cur.tick) unitById.set(id, { x, y, type: "unit", tick, hp: obj.hp as number, unitType: (obj.unit_type as string | undefined) ?? "WORKER", cargo: (obj.cargo as number | undefined) ?? 0, controlled: obj.controlled as boolean, id });
        }
      }
    }
    // —— 动态层实时化：单位/核心改用最新 case 的 after.state ——
    // before.state 是上一 tick 起点，after.state 才是当前实时位置（recorder 在 tick 完成后写 case）；
    // 以 after 为准重建动态层 → 已摧毁/失联的单位核心不再残留（修复"已摧毁还显示""落后 1 tick"）。
    let lastCaseRaw: { after?: { tick?: number; state?: { objects?: Array<Record<string, unknown>>; champion_beacon?: { position?: number[]; status?: string; carrier_id?: string | null } } }; before?: { state?: { champion_beacon?: { position?: number[]; status?: string; carrier_id?: string | null } } } } | null = null;
    if (caseFiles.length > 0) {
      const lastPath = join(calibrationDir(tenant), runDir, "cases", caseFiles[caseFiles.length - 1]);
      try { lastCaseRaw = JSON.parse(readFileSync(lastPath, "utf8")); } catch { lastCaseRaw = null; }
      const afterTick = typeof lastCaseRaw?.after?.tick === "number" ? lastCaseRaw.after.tick : latestTick;
      if (afterTick > latestTick) latestTick = afterTick;
      const after = lastCaseRaw?.after?.state;
      if (after?.objects) {
        unitById.clear(); coreById.clear();
        for (const obj of after.objects) {
          if (obj.kind === "UNIT" && obj.id) {
            const [x, y] = (obj.position as number[] | undefined) ?? [0, 0];
            unitById.set(obj.id as string, { x, y, type: "unit", tick: latestTick, hp: obj.hp as number, unitType: (obj.unit_type as string | undefined) ?? "WORKER", cargo: (obj.cargo as number | undefined) ?? 0, controlled: obj.controlled as boolean, id: obj.id as string });
          } else if (obj.kind === "CORE") {
            const [x, y] = (obj.position as number[] | undefined) ?? [0, 0];
            const id = typeof obj.id === "string" ? obj.id : `core@${x},${y}`;
            coreById.set(id, { x, y, type: "core", tick: latestTick, hp: obj.hp as number, shield: obj.shield as number, controlled: obj.controlled as boolean, owner: typeof obj.owner_username === "string" ? obj.owner_username : null, id: typeof obj.id === "string" ? obj.id : null });
          }
        }
      }
    }
    // 组装：地形在下，动态在上（同格冲突按优先级 obstacle < resource < unit < core）
    const byCell = new Map<string, MapCell & { prio: number }>();
    const put = (c: Omit<MapCell, "tenant" | "fresh">, prio: number): void => {
      const key = cellKey(c.x, c.y);
      const cur = byCell.get(key);
      if (cur && cur.prio > prio) return;
      byCell.set(key, { ...c, tenant, fresh: c.tick === latestTick, prio });
    };
    for (const c of terrain.values()) put({ ...c }, c.type === "obstacle" ? 1 : 2);
    for (const c of unitById.values()) put({ ...c }, 3);
    for (const c of coreById.values()) put({ ...c }, 4);
    for (const { prio, ...c } of byCell.values()) cells.set(cellKey(c.x, c.y), c);
    // 最新 case 的冠军信标（用于全局测绘 beacon 图层）
    let beacon: MergedMap["tenants"][number]["beacon"] = null;
    if (caseFiles.length > 0) {
      const cb = lastCaseRaw?.after?.state?.champion_beacon ?? lastCaseRaw?.before?.state?.champion_beacon;
      if (cb?.position) beacon = { x: cb.position[0], y: cb.position[1], status: cb.status ?? "GROUND", carrier_id: cb.carrier_id ?? null, trail: loadBeaconTrail(tenant) };
    }
    perTenant.push({ tenant, runId: runDir, caseCount: caseFiles.length, latestTick: latestTick === 0 ? null : latestTick, beacon });
  }
  const list = [...cells.values()];
  const xs = list.map((c) => c.x);
  const ys = list.map((c) => c.y);
  const bounds = list.length === 0
    ? { minX: 0, maxX: 0, minY: 0, maxY: 0 }
    : { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  const beacons = perTenant.map((t) => t.beacon ? { tenant: t.tenant, ...(t.beacon as { x: number; y: number; status: string; carrier_id: string | null; trail: TrailPoint[] }) } : null).filter((b): b is { tenant: string; x: number; y: number; status: string; carrier_id: string | null; trail: TrailPoint[] } => b !== null);
  // 敌方核心轨迹（跨租户按 username 去重，保留最长轨迹——同一敌核被多租户目击）
  const coreTrailByUser = new Map<string, { username: string; trail: TrailPoint[]; tenant: string }>();
  for (const t of perTenant) {
    for (const ct of loadCoreTrails(t.tenant)) {
      const cur = coreTrailByUser.get(ct.username);
      if (!cur || ct.trail.length > cur.trail.length) coreTrailByUser.set(ct.username, { ...ct, tenant: t.tenant });
    }
  }
  const coreTrails = [...coreTrailByUser.values()];
  return { generatedAt: new Date().toISOString(), tenants: perTenant, bounds, cellCount: list.length, cells: list, beacons, coreTrails };
}
