/** 地图 LOD 聚合视图（2026-08-08，缩放优化数据支撑）：全局缩放时不需 7030 格明细
 *  （/api/map 全量 642KB）——按 16×16 chunk 聚合矿/障碍/核心计数 +
 *  最新 tick，缩小到全局时前端可用轻量数据绘制（~12KB vs 642KB），
 *  放大到局部时再用全量。纯只读（读 survey 内存缓存），30s 缓存 + 启动预热。
 *
 *  输出（/api/map/lod?tenant=all|tN）：{ generatedAt, tenant, chunkSize, chunks:
 *  [{ cx, cy, tenant, resourceCount, obstacleCount, coreCount, lastTick }], cachedAt }
 *  每租户独立条目（前端按租户着色）。 */
import { TENANTS } from "./fs-jsonl.ts";
import { TtlCache } from "./cache.ts";
import { loadTenantSurveyCached } from "./survey-cache.ts";

const TTL_MS = 30_000;
const cache = new TtlCache<MapLodPayload>(TTL_MS);
/** 与探索分区 / 热区同粒度的 chunk 边长。 */
export const MAP_LOD_CHUNK = 16;

export interface MapLodChunk {
  cx: number;
  cy: number;
  tenant: string;
  resourceCount: number;
  obstacleCount: number;
  coreCount: number;
  /** 该 chunk 在该租户的最新观测 tick。 */
  lastTick: number;
}

export interface MapLodPayload {
  generatedAt: string;
  tenant: string;
  chunkSize: number;
  chunks: readonly MapLodChunk[];
  cachedAt: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

/** 纯函数（可测）：某租户的矿/障碍/核心列表 → chunk 级聚合。 */
export function aggregateMapLod(
  tenant: string,
  resources: readonly { x?: unknown; y?: unknown; tick?: unknown }[],
  obstacles: readonly { x?: unknown; y?: unknown; tick?: unknown }[],
  cores: readonly { x?: unknown; y?: unknown; tick?: unknown }[],
): readonly MapLodChunk[] {
  const byKey = new Map<string, MapLodChunk>();
  const put = (x: unknown, y: unknown, tick: unknown, kind: "resourceCount" | "obstacleCount" | "coreCount"): void => {
    const cx = Math.floor(num(x) / MAP_LOD_CHUNK);
    const cy = Math.floor(num(y) / MAP_LOD_CHUNK);
    const key = `${cx},${cy}`;
    let c = byKey.get(key);
    if (!c) {
      c = { cx, cy, tenant, resourceCount: 0, obstacleCount: 0, coreCount: 0, lastTick: 0 };
      byKey.set(key, c);
    }
    c[kind] += 1;
    const t = num(tick);
    if (t > c.lastTick) c.lastTick = t;
  };
  for (const r of resources ?? []) put(r?.x, r?.y, r?.tick, "resourceCount");
  for (const o of obstacles ?? []) put(o?.x, o?.y, o?.tick, "obstacleCount");
  for (const c of cores ?? []) put(c?.x, c?.y, c?.tick, "coreCount");
  return [...byKey.values()].sort((a, b) => b.lastTick - a.lastTick || a.cx - b.cx || a.cy - b.cy);
}

export function loadMapLod(tenant: string): MapLodPayload {
  const key = `lod:${tenant}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const tenants = tenant === "all" ? [...TENANTS] : [tenant];
  const chunks: MapLodChunk[] = [];
  for (const t of tenants) {
    const v = loadTenantSurveyCached(t);
    chunks.push(...aggregateMapLod(t, v.survey?.resourceCells ?? [], v.survey?.obstacleCells ?? [], v.survey?.coreCells ?? []));
  }
  const payload: MapLodPayload = {
    generatedAt: new Date().toISOString(),
    tenant,
    chunkSize: MAP_LOD_CHUNK,
    chunks: chunks.sort((a, b) => b.lastTick - a.lastTick || (a.tenant < b.tenant ? -1 : 1)),
    cachedAt: new Date().toISOString(),
  };
  cache.set(key, payload);
  return payload;
}

/** 启动预热一次（不进周期循环，过期请求惰性刷新）。 */
export function warmMapLod(): void {
  loadMapLod("all");
}
