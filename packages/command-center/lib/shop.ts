/**
 * 官方商店代理：products 公开可缓存；me/orders/order 需要登录 cookie
 * （经 X-Shop-Cookie 请求头传入，不落盘，CSRF 从 cookie 内联提取）。
 */
import type { IncomingMessage } from "node:http";

const SHOP_BASE = "https://linuxdoshop.arenahero.io"; // 官方兑换商店（动态价格/库存）
const SHOP_CACHE_MS = 20_000; // products 公开缓存

let shopCache: { at: number; data: unknown } = { at: 0, data: null };
export async function shopProducts(): Promise<unknown> {
  const now = Date.now();
  if (shopCache.data && now - shopCache.at < SHOP_CACHE_MS) return shopCache.data;
  const res = await fetch(`${SHOP_BASE}/api/v1/products`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`shop products HTTP ${res.status}`);
  const data: unknown = await res.json();
  shopCache = { at: now, data };
  return data;
}
export function shopCookie(req: IncomingMessage | Request): string | null {
  const raw = req instanceof Request ? req.headers.get("x-shop-cookie") : req.headers["x-shop-cookie"];
  const c = Array.isArray(raw) ? raw[0] : raw;
  return typeof c === "string" && c.trim().length > 0 ? c.trim() : null;
}
/** 官方商店要求 X-CSRF-Token：与 cookie 中的 arena_shop_csrf 同值，从 Cookie 内联提取，不落盘。 */
function extractShopCsrf(cookie: string): string | null {
  const m = /(?:^|;\s*)arena_shop_csrf=([^;]+)/.exec(cookie);
  return m ? m[1] : null;
}
function shopHeaders(cookie: string): Record<string, string> {
  const headers: Record<string, string> = { Cookie: cookie, Accept: "application/json" };
  const csrf = extractShopCsrf(cookie);
  if (csrf) headers["x-csrf-token"] = csrf;
  return headers;
}
async function shopGet(path: string, cookie: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(`${SHOP_BASE}${path}`, {
    headers: shopHeaders(cookie),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `shop ${path} HTTP ${res.status}`);
  return data;
}
export function shopMe(cookie: string): Promise<unknown> {
  return shopGet("/api/v1/me", cookie, 10_000);
}
export function shopOrders(cookie: string): Promise<unknown> {
  return shopGet("/api/v1/orders", cookie, 10_000);
}
export async function shopOrder(cookie: string, productId: string): Promise<unknown> {
  const headers = shopHeaders(cookie);
  headers["Content-Type"] = "application/json";
  const res = await fetch(`${SHOP_BASE}/api/v1/orders`, {
    method: "POST",
    headers,
    body: JSON.stringify({ product_id: productId }),
    signal: AbortSignal.timeout(15_000),
  });
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `shop order HTTP ${res.status}`);
  return data;
}
