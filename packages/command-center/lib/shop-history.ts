/**
 * 商店价格历史记录层（2026-08-08，数据记录层）：官方兑换商店价格/库存会变
 * （用户实证），本模块把每次公开 products 快照追加落盘（shop-history.jsonl），
 * 供前端展示"价格涨跌/库存变化"——不依赖登录 cookie（products 公开），
 * 请求驱动刷新（POST /api/shop/history/refresh），**无计划任务**。
 *
 * 记录：{ at, products: [{id,name,resourceCost,availableStock,purchaseLimit}] }
 * 去重：与上一快照签名相同（id:cost:stock 全同）不追加——只记变化。
 * 输出（GET /api/shop/history）：每商品 current/delta（vs 上一快照）+ 首末见时间。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_ROOT } from "./fs-jsonl.ts";
import { TtlCache } from "./cache.ts";
import { shopProducts } from "./shop.ts";

export interface ShopProductBrief {
  id: string;
  name: string;
  resourceCost: number;
  availableStock: number;
  purchaseLimit: number;
}

export interface ShopHistoryEntry {
  at: string;
  products: ShopProductBrief[];
}

export interface ShopProductTrend {
  id: string;
  name: string;
  /** 当前价 / 库存（最近快照）。 */
  currentCost: number;
  currentStock: number;
  /** vs 上一快照（无前值 = null）。 */
  costDelta: number | null;
  stockDelta: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** 该商品被记录到的快照数。 */
  snapshots: number;
}

export interface ShopHistoryPayload {
  generatedAt: string;
  /** 落盘快照总数。 */
  snapshots: number;
  /** 在售商品数（最近快照）。 */
  productCount: number;
  lastSnapshotAt: string | null;
  refreshedAt: string | null;
  trends: ShopProductTrend[];
  cachedAt: string;
}

const TTL_MS = 30_000;
const cache = new TtlCache<ShopHistoryPayload>(TTL_MS);
const historyFile = join(DATA_ROOT, "runtime", "shop-history.jsonl");

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

/** 纯函数（可测）：官方 products 行 → 紧凑快照条目。 */
export function normalizeProducts(products: readonly Record<string, unknown>[]): ShopProductBrief[] {
  return (products ?? [])
    .map((p) => ({
      id: String(p.id ?? ""),
      name: String(p.name ?? ""),
      resourceCost: num(p.resource_cost),
      availableStock: num(p.available_stock),
      purchaseLimit: num(p.purchase_limit),
    }))
    .filter((p) => p.id.length > 0);
}

/** 纯函数（可测）：快照签名（id:cost:stock 排序拼接）——全同 = 无变化。 */
export function snapshotSignature(products: readonly ShopProductBrief[]): string {
  return products.map((p) => `${p.id}:${p.resourceCost}:${p.availableStock}`).sort().join("|");
}

/** 纯函数（可测）：是否需要追加（首条或与上一快照不同）。 */
export function shouldAppend(prev: ShopHistoryEntry | null, products: readonly ShopProductBrief[]): boolean {
  return prev === null || snapshotSignature(prev.products) !== snapshotSignature(products);
}

/** 纯函数（可测）：历史快照 → 每商品趋势（当前值 + 与上一快照差）。 */
export function aggregateShopHistory(entries: readonly ShopHistoryEntry[]): Omit<ShopHistoryPayload, "generatedAt" | "cachedAt" | "refreshedAt"> {
  const byId = new Map<string, { name: string; latest: ShopProductBrief; prev: ShopProductBrief | null; firstAt: string; lastAt: string; count: number }>();
  for (const e of entries) {
    for (const p of e.products) {
      const cur = byId.get(p.id);
      if (!cur) {
        byId.set(p.id, { name: p.name, latest: p, prev: null, firstAt: e.at, lastAt: e.at, count: 1 });
      } else {
        cur.prev = { ...cur.latest }; // 上一快照 = 上一份含此商品的快照
        cur.latest = p;
        cur.lastAt = e.at;
        cur.count += 1;
      }
    }
  }
  const trends: ShopProductTrend[] = [...byId.values()]
    .map((t) => ({
      id: t.latest.id,
      name: t.name,
      currentCost: t.latest.resourceCost,
      currentStock: t.latest.availableStock,
      costDelta: t.prev ? t.latest.resourceCost - t.prev.resourceCost : null,
      stockDelta: t.prev ? t.latest.availableStock - t.prev.availableStock : null,
      firstSeenAt: t.firstAt,
      lastSeenAt: t.lastAt,
      snapshots: t.count,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const last = entries[entries.length - 1];
  return {
    snapshots: entries.length,
    productCount: last?.products.length ?? 0,
    lastSnapshotAt: last?.at ?? null,
    trends,
  };
}

/** 跨快照商品变动摘要（2026-08-08，日记层）：观察期内每商品「首见 → 最新」的价格/
 *  库存变化 + 下架商品。供日记叙事追加一行（联盟级，只读）。无变化/样本不足返回 null。
 *  纯函数可测，读落盘快照（不触网）。 */
export function buildShopJournalLine(entries: readonly ShopHistoryEntry[]): string | null {
  if (entries.length < 2) return null;
  const first = entries[0];
  const last = entries[entries.length - 1];
  const byId = new Map<string, { id: string; name: string; firstCost: number; lastCost: number; firstStock: number; lastStock: number }>();
  for (const e of entries) {
    for (const p of e.products) {
      const cur = byId.get(p.id);
      if (!cur) byId.set(p.id, { id: p.id, name: p.name, firstCost: p.resourceCost, lastCost: p.resourceCost, firstStock: p.availableStock, lastStock: p.availableStock });
      else { cur.lastCost = p.resourceCost; cur.lastStock = p.availableStock; }
    }
  }
  const changed: string[] = [];
  for (const v of byId.values()) {
    if (v.firstCost !== v.lastCost) changed.push(`${v.name || v.id} ${v.firstCost}→${v.lastCost} Core`);
    else if (v.firstStock !== v.lastStock) changed.push(`${v.name || v.id} 库存 ${v.firstStock}→${v.lastStock}`);
  }
  const disappeared = first.products.filter((p) => !last.products.some((q) => q.id === p.id));
  const parts: string[] = [];
  if (changed.length) parts.push(`变动 ${changed.slice(0, 5).join("、")}${changed.length > 5 ? ` 等 ${changed.length} 项` : ""}`);
  if (disappeared.length) parts.push(`下架 ${disappeared.map((p) => p.name || p.id).slice(0, 3).join("、")}${disappeared.length > 3 ? ` 等 ${disappeared.length} 件` : ""}`);
  if (parts.length === 0) return null;
  const span = `${first.at.slice(0, 10)} ~ ${last.at.slice(0, 10)}`;
  return `商店动态（${span} · ${entries.length} 次快照）：${parts.join("；")}。`;
}

/** 读历史快照（全部；文件小，直接读）。 */
export function loadShopHistoryEntries(): ShopHistoryEntry[] {
  if (!existsSync(historyFile)) return [];
  try {
    return readFileSync(historyFile, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((l) => { try { return JSON.parse(l) as ShopHistoryEntry; } catch { return null; } })
      .filter((e): e is ShopHistoryEntry => e !== null && Array.isArray(e.products));
  } catch {
    return [];
  }
}

/** 只读聚合（30s 缓存）。 */
export function loadShopHistory(): ShopHistoryPayload {
  const key = "shop-history";
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const body = aggregateShopHistory(loadShopHistoryEntries());
  const payload: ShopHistoryPayload = { generatedAt: new Date().toISOString(), ...body, refreshedAt: null, cachedAt: new Date().toISOString() };
  cache.set(key, payload);
  return payload;
}

/** 请求驱动刷新：拉取官方 products（20s 缓存），有变化才追加落盘。返回本次结果。 */
export async function refreshShopHistory(): Promise<{ appended: boolean; snapshots: number; productCount: number }> {
  const data = await shopProducts() as { products?: Record<string, unknown>[] };
  const products = normalizeProducts(data?.products ?? []);
  const entries = loadShopHistoryEntries();
  const prev = entries.length > 0 ? entries[entries.length - 1] : null;
  const appended = shouldAppend(prev, products);
  if (appended) {
    const entry: ShopHistoryEntry = { at: new Date().toISOString(), products };
    try {
      mkdirSync(dirname(historyFile), { recursive: true });
      appendFileSync(historyFile, JSON.stringify(entry) + "\n", "utf8");
    } catch { /* 落盘失败不阻断 */ }
  }
  cache.invalidate("shop-history");
  return { appended, snapshots: entries.length + (appended ? 1 : 0), productCount: products.length };
}
