/** 官方商店 API 客户端：Cookie 本地保存 + 经面板服务器内存转发，不落盘。 */

export const SHOP_COOKIE_KEY = "arena-cc.shop-cookie";

export interface ShopProduct {
  id: string;
  name?: string;
  description?: string;
  resource_cost?: number;
  available_stock?: number;
  purchase_limit?: number;
  out_of_stock?: boolean;
}

export interface ShopMe {
  username?: string;
  resources?: number;
}

export interface ShopOrder {
  id?: string;
  product_name?: string;
  status?: string;
  created_at?: string;
}

export function shopCookieValue(): string {
  return (localStorage.getItem(SHOP_COOKIE_KEY) ?? "").trim();
}

export function saveShopCookie(value: string): void {
  localStorage.setItem(SHOP_COOKIE_KEY, value.trim());
}

export async function shopRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers ?? {});
  const cookie = shopCookieValue();
  if (cookie) headers.set("X-Shop-Cookie", cookie);
  const res = await fetch(path, { ...options, headers, cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data as { error?: string; message?: string }).error ?? (data as { message?: string }).message ?? `HTTP ${res.status}`);
    throw err;
  }
  return data as T;
}

export interface RedeemHistoryEntry {
  at: string;
  code: string;
  status: string;
}

export function loadRedeemHistory(): RedeemHistoryEntry[] {
  try {
    const list = JSON.parse(localStorage.getItem("arena-cc.redeem-history") ?? "[]");
    return Array.isArray(list) ? (list as RedeemHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function pushRedeemHistory(entry: RedeemHistoryEntry): RedeemHistoryEntry[] {
  const list = [entry, ...loadRedeemHistory()].slice(0, 20);
  localStorage.setItem("arena-cc.redeem-history", JSON.stringify(list));
  return list;
}

export function clearRedeemHistory(): void {
  localStorage.removeItem("arena-cc.redeem-history");
}
