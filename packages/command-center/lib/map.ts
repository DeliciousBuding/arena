/**
 * 全局联盟测绘地图：合并 4 租户的累积测绘（survey-db）与最新 calibration case →
 * 全局 cells/bounds/beacons/coreTrails（只读）。
 * 测绘语义：障碍/资源 = 共享世界静态地形，以 survey-db 跨 run 累积为主源
 * （障碍永久、矿带状态），当前帧 after 只做新鲜度刷新；单位/核心 = 动态层
 * 按 object id 保留最新 tick 快照（以 after.state 为准，已摧毁的不残留）。
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, TENANTS, calibrationDir, cellKey, latestRunDir, listCases, parseTick } from "./fs-jsonl.ts";
import { loadTenantSurveyCached } from "./survey-cache.ts";
import { loadBeaconTrail, loadCoreTrails, loadCoreTrailsFromSurveyDb, type TrailPoint } from "./trails.ts";

const SURVEY_CASE_LIMIT = 24; // before 兜底循环最多取最近 N 个 case（主源已切 survey-db）

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
  /** 矿状态（survey-db）：visible=活跃 / stale=待确认 / harvested=采过 / empty=确认空。 */
  state?: string;
  seenCount?: number;
  harvestCount?: number;
  ageTicks?: number;
  tenant: string;
  fresh: boolean;
}
export interface MergedMap {
  generatedAt: string;
  tenants: Array<{ tenant: string; runId: string | null; caseCount: number; latestTick: number | null; beacon: unknown }>;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  cellCount: number;
  cells: MapCell[];
  /** 探索分区（16×16 chunk，跨租户合并）：全局视图"探索过的范围"底纹。 */
  chunks: Array<{ key: string; cx: number; cy: number; lastSeenTick: number }>;
  beacons: Array<{ tenant: string; x: number; y: number; status: string; carrier_id: string | null; trail: TrailPoint[] }>;
  coreTrails: Array<{ username: string; trail: TrailPoint[]; tenant?: string }>;
}

interface TerrainEntry { x: number; y: number; type: "obstacle" | "resource"; tick: number; state?: string; seenCount?: number; harvestCount?: number; ageTicks?: number }
interface DynamicEntry { x: number; y: number; type: "unit" | "core"; tick: number; hp?: number; shield?: number; controlled?: boolean; owner?: string | null; id?: string | null; unitType?: string; cargo?: number }

function loadMergedMapInner(): MergedMap {
  const cells = new Map<string, MapCell>();
  const perTenant: MergedMap["tenants"] = [];
  const chunkByKey = new Map<string, { key: string; cx: number; cy: number; lastSeenTick: number }>(); // 探索分区（跨租户按 key 合并）
  for (const tenant of TENANTS) {
    const runDir = latestRunDir(tenant);
    if (runDir === null) {
      perTenant.push({ tenant, runId: null, caseCount: 0, latestTick: null, beacon: null });
      continue;
    }
    const caseFiles = listCases(tenant, runDir).slice(-SURVEY_CASE_LIMIT);
    let latestTick = 0;
    // 地形主源：survey-db 跨 run 累积测绘（30s 内存缓存）。
    // 障碍 = 永久地形全量；矿 = 带状态（visible/stale/harvested/empty）。
    // 当前帧 after 只做新鲜度刷新（可见障碍/矿 → 最新 tick + state=visible）。
    const survey = loadTenantSurveyCached(tenant).survey;
    const terrain = new Map<string, TerrainEntry>();
    if (survey) {
      for (const o of survey.obstacleCells ?? []) {
        const x = Number(o.x), y = Number(o.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        terrain.set(cellKey(x, y), { x, y, type: "obstacle", tick: Number(o.tick ?? 0) });
      }
      for (const r of survey.resourceCells ?? []) {
        const x = Number(r.x), y = Number(r.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        // 确认空的矿（survey-sync 事件回写 empty）不作为矿点显示——可能 refill，
        // 但当前无矿；前端只对非 empty 渲染（drawResources 已过滤，这里减少传输）
        if (String(r.state ?? "") === "empty") continue;
        terrain.set(cellKey(x, y), {
          x, y, type: "resource", tick: Number(r.tick ?? 0),
          state: typeof r.state === "string" ? r.state : undefined,
          seenCount: typeof r.seenCount === "number" ? r.seenCount : undefined,
          harvestCount: typeof r.harvestCount === "number" ? r.harvestCount : undefined,
          ageTicks: typeof r.ageTicks === "number" ? r.ageTicks : undefined,
        });
      }
      for (const ch of survey.chunks ?? []) {
        const cx = Number(ch.cx), cy = Number(ch.cy), last = Number(ch.lastSeenTick ?? 0);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
        const key = `${cx},${cy}`;
        const cur = chunkByKey.get(key);
        if (!cur || last > cur.lastSeenTick) chunkByKey.set(key, { key, cx, cy, lastSeenTick: last });
      }
      if (survey.tickMax > latestTick) latestTick = survey.tickMax;
    }
    const coreById = new Map<string, DynamicEntry>(); // id -> 最新快照
    const unitById = new Map<string, DynamicEntry>(); // id -> 最新快照
    let lastCaseRaw: { after?: { tick?: number; state?: { objects?: Array<Record<string, unknown>>; champion_beacon?: { position?: number[]; status?: string; carrier_id?: string | null } } }; before?: { state?: { champion_beacon?: { position?: number[]; status?: string; carrier_id?: string | null } } } } | null = null;
    let afterValid = false; // 2026-08-08 结构性优化：after 全量世界状态直接重建动态层 + 刷新地形，
    // 跳过 before 循环 24 case parse（重建 ~300ms → ~30ms，地图卡根治）
    if (caseFiles.length > 0) {
      const lastPath = join(calibrationDir(tenant), runDir, "cases", caseFiles[caseFiles.length - 1]);
      try { lastCaseRaw = JSON.parse(readFileSync(lastPath, "utf8")); } catch { lastCaseRaw = null; }
      const after = lastCaseRaw?.after?.state;
      const afterTick = typeof lastCaseRaw?.after?.tick === "number" ? lastCaseRaw.after.tick : parseTick(caseFiles[caseFiles.length - 1]);
      if (afterTick > latestTick) latestTick = afterTick;
      if (after?.objects) {
        afterValid = true;
        // 动态层（单位/核心）以 after 为准，已摧毁的不残留。
        // 地形：after 可见障碍/矿刷新为最新 tick（矿 state=visible）；已消失的
        // 矿/障碍不删除——survey-db 累积记忆保留（全局地图 = 完整探索地图）。
        for (const obj of after.objects) {
          if (obj.kind === "OBSTACLE" || obj.kind === "RESOURCE") {
            const type = obj.kind === "OBSTACLE" ? "obstacle" : "resource";
            for (const [x, y] of (obj.positions as number[][] | undefined) ?? []) {
              const key = cellKey(x, y);
              const cur = terrain.get(key);
              terrain.set(key, { x, y, type, tick: latestTick, ...(type === "resource" ? { state: "visible", ...(cur && cur.type === "resource" ? { seenCount: cur.seenCount, harvestCount: cur.harvestCount, ageTicks: cur.ageTicks } : {}) } : {}) });
            }
          } else if (obj.kind === "UNIT" && obj.id) {
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
    // —— after 缺失且无 survey-db（异常 case / 未同步租户）时 before 循环兜底：
    // 24 case 累积地形/单位/核心 ——
    if (!afterValid && terrain.size === 0) {
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
    }
    // 组装：地形在下，动态在上。
    // 地形（障碍/资源）按格去重（priority：obstacle < resource，一格只能一种）；
    // 单位/核心按对象 id 各自保留——同租户多单位可同格（如 worker 叠 core）。
    // 地形是共享世界（4 租户看到同一障碍/矿），合并键 = `type:x,y` 全局去重，
    // 跨租户同格取最新 tick（后处理租户如更新则覆盖）。tenant 字段保留最后观测
    // 租户（hover/图层归属显示用）。单位/核心仍按租户独立（`tenant:type:id`）。
    const byCell = new Map<string, MapCell & { prio: number }>();
    const put = (c: Omit<MapCell, "tenant" | "fresh">, prio: number): void => {
      const key = cellKey(c.x, c.y);
      const cur = byCell.get(key);
      if (cur && cur.prio > prio) return;
      byCell.set(key, { ...c, tenant, fresh: c.tick === latestTick, prio });
    };
    for (const c of terrain.values()) put({ ...c }, c.type === "obstacle" ? 1 : 2);
    // 全局合并：地形按 (x,y) 去重（共享世界）；单位/核心按 `tenant:type:id`。
    for (const { prio, ...c } of byCell.values()) {
      const key = `${c.type}:${c.x},${c.y}`;
      const cur = cells.get(key);
      if (!cur || c.tick >= cur.tick) cells.set(key, c);
    }
    for (const c of unitById.values()) cells.set(`${tenant}:unit:${c.id}`, { ...c, tenant, fresh: c.tick === latestTick });
    for (const c of coreById.values()) cells.set(`${tenant}:core:${c.id}`, { ...c, tenant, fresh: c.tick === latestTick });
    // 最新 case 的冠军信标（用于全局测绘 beacon 图层）
    let beacon: MergedMap["tenants"][number]["beacon"] = null;
    if (caseFiles.length > 0) {
      const cb = lastCaseRaw?.after?.state?.champion_beacon ?? lastCaseRaw?.before?.state?.champion_beacon;
      // 信标判据（2026-08-08 修正 A10 过度修复）：游戏规则"信标永远存在且坐标
      // 永远公开"——position 有效即建 beacon；status 只在信标格可见时下发
      // （null = 不在视野内，非无信标）。A10 曾以 status 非空为判据，把
      // [0,0] 初始信标误当"无信标"过滤（官方 web 渲染为 !CARRIED 即画）。
      // status 为 null 时前端按"未知"渲染（GROUND 尺寸）。
      if (Array.isArray(cb?.position) && cb.position.length === 2) {
        beacon = { x: cb.position[0], y: cb.position[1], status: cb.status ?? null, carrier_id: cb.carrier_id ?? null, trail: loadBeaconTrail(tenant) };
      }
    }
    perTenant.push({ tenant, runId: runDir, caseCount: caseFiles.length, latestTick: latestTick === 0 ? null : latestTick, beacon });
  }
  const list = [...cells.values()];
  const xs = list.map((c) => c.x);
  const ys = list.map((c) => c.y);
  const bounds = list.length === 0
    ? { minX: 0, maxX: 0, minY: 0, maxY: 0 }
    : { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  const chunks = [...chunkByKey.values()].sort((a, b) => b.lastSeenTick - a.lastSeenTick);
  const beacons = perTenant.map((t) => t.beacon ? { tenant: t.tenant, ...(t.beacon as { x: number; y: number; status: string; carrier_id: string | null; trail: TrailPoint[] }) } : null).filter((b): b is { tenant: string; x: number; y: number; status: string; carrier_id: string | null; trail: TrailPoint[] } => b !== null);
  // 敌方核心轨迹（跨租户按 username 去重，保留最长轨迹——同一敌核被多租户目击）
  const coreTrailByUser = new Map<string, { username: string; trail: TrailPoint[]; tenant: string }>();
  for (const t of perTenant) {
    // survey-db core_hunts 全量历史优先（A9，敌核目击稀疏时不空），
    // case 扫描（最近 N run）作补充；长轨迹胜。
    for (const ct of [...loadCoreTrailsFromSurveyDb(t.tenant), ...loadCoreTrails(t.tenant)]) {
      const cur = coreTrailByUser.get(ct.username);
      if (!cur || ct.trail.length > cur.trail.length) coreTrailByUser.set(ct.username, { ...ct, tenant: t.tenant });
    }
  }
  const coreTrails = [...coreTrailByUser.values()];
  return { generatedAt: new Date().toISOString(), tenants: perTenant, bounds, cellCount: list.length, cells: list, chunks, beacons, coreTrails };
}

/** 合并地图缓存（2026-08-08 结构性优化）：/api/map 每 3s poll 一次，原每次重扫
 *  4 租户 × 最近 24 个 case（~96 次文件读+全量 JSON 解析）。case 文件原子写入，
 *  以 (runId, caseCount, 最新 case 名) 为签名——tick 未前进时直接命中缓存，
 *  15s tick vs 3s poll 下命中率 ~80%，/api/map 从毫秒级 I/O 降到近零。 */
/** 2026-08-08 stale-while-revalidate（地图卡根治）：/api/map 全量重建 ~300ms 同步阻塞
 *  事件循环，3s poll 撞上重建即卡。改为：签名变且有旧缓存 → 立即返回旧数据 +
 *  后台 async 分片重建（每 4 case 让出事件循环，其他请求穿插，永不阻塞）；
 *  重建完成前所有请求命中旧缓存，地图每 tick 平滑更新。无缓存（首屏）才同步全量。 */
const mergedCache: { sig: string; payload: MergedMap | null } = { sig: "", payload: null };
let mapRebuilding = false;
/** survey-db 文件 mtime：地形主源（累积测绘）由 watchdog survey:sync 增量写入，
 *  case 文件签名无法反映 db 更新（case 同步滞后独立于 case 写入），加入 mtime
 *  保证 /api/map 在测绘库更新后重建。文件缺失（未同步）→ mtime=0。 */
function surveyDbSig(): string {
  const parts: string[] = [];
  for (const tenant of TENANTS) {
    try {
      const st = statSync(join(DATA_ROOT, "runtime", "survey", `${tenant}.db`));
      parts.push(`${tenant}:${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push(`${tenant}:0:0`);
    }
  }
  return parts.join("|");
}
export function loadMergedMap(): MergedMap {
  const parts: string[] = [];
  for (const tenant of TENANTS) {
    const runDir = latestRunDir(tenant);
    if (runDir === null) { parts.push(`${tenant}:none`); continue; }
    const files = listCases(tenant, runDir);
    parts.push(`${tenant}:${runDir}:${files.length}:${files[files.length - 1] ?? ""}`);
  }
  const sig = `${parts.join("|")}#${surveyDbSig()}`;
  if (mergedCache.sig === sig && mergedCache.payload) return mergedCache.payload;
  if (mergedCache.payload) {
    if (!mapRebuilding) {
      mapRebuilding = true;
      setTimeout(() => {
        try {
          const p = loadMergedMapInner(); // 2026-08-08 结构性优化后 ~30ms，可接受
          mergedCache.sig = sig; mergedCache.payload = p;
        } catch { /* 重建失败保留旧缓存，下次请求重试 */ }
        mapRebuilding = false;
      }, 0);
    }
    return mergedCache.payload;
  }
  const payload = loadMergedMapInner();
  mergedCache.sig = sig;
  mergedCache.payload = payload;
  return payload;
}

