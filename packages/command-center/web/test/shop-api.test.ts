/**
 * 官方商店 API 客户端测试（2026-08-08）：Cookie 本地持久化 + 兑换历史 + shopRequest
 * 错误映射/请求头转发——兑换码面板数据层（用户可见功能）稳定性基线。
 */
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import {
  SHOP_COOKIE_KEY,
  shopCookieValue,
  saveShopCookie,
  loadRedeemHistory,
  pushRedeemHistory,
  clearRedeemHistory,
  shopRequest,
} from "../src/lib/shopApi.ts";

// Node 无 localStorage：最小内存 shim（shopApi 仅在函数内引用，调用前注入即可）
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
beforeEach(() => store.clear());

test("shop-cookie: 保存/读取去空白 + 空值", () => {
  saveShopCookie("  SESSION=abc  ");
  assert.equal(shopCookieValue(), "SESSION=abc");
  saveShopCookie("   ");
  assert.equal(shopCookieValue(), "");
  saveShopCookie(" x ");
  assert.equal(store.get(SHOP_COOKIE_KEY), "x");
});

test("redeem-history: 追加置顶 + 容量上限 20 + 清空 + 损坏 JSON 兜底", () => {
  let latest: ReturnType<typeof pushRedeemHistory> = [];
  for (let i = 0; i < 25; i++) {
    latest = pushRedeemHistory({ at: `t${i}`, code: `c${i}`, status: "PENDING" });
  }
  assert.equal(latest.length, 20);
  assert.equal(latest[0].at, "t24"); // 最新置顶
  assert.equal(latest[19].at, "t5"); // 最旧被挤出
  assert.equal(loadRedeemHistory().length, 20);
  clearRedeemHistory();
  assert.deepEqual(loadRedeemHistory(), []);
  store.set("arena-cc.redeem-history", "{bad json");
  assert.deepEqual(loadRedeemHistory(), []);
});

test("shop-request: Cookie 请求头转发 + cache no-store + 404 错误映射", async () => {
  const reqLog: { init: RequestInit | null } = { init: null };
  (globalThis as any).fetch = async (_url: unknown, init?: RequestInit) => {
    reqLog.init = init ?? null;
    return new Response(JSON.stringify({ error: "商品加载失败" }), { status: 404, headers: { "Content-Type": "application/json" } });
  };
  saveShopCookie("SESSION=xyz");
  await assert.rejects(() => shopRequest("/api/shop"), /商品加载失败/);
  const headers = new Headers(reqLog.init?.headers ?? {});
  assert.equal(headers.get("X-Shop-Cookie"), "SESSION=xyz");
  assert.equal(reqLog.init?.cache, "no-store");
  // 200 且无 cookie：不转发 X-Shop-Cookie，正常解析
  store.clear();
  (globalThis as any).fetch = async () => new Response("{}", { status: 200 });
  const data = await shopRequest<{ ok?: boolean }>("/api/shop");
  assert.ok(data);
});
