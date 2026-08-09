/* Arena 指挥面板前端 — API 拉取（无 DOM/state 依赖；URL 由调用方传入） */

/** GET JSON：超时 abort + 禁缓存；非 2xx 抛 HTTP 状态错误。 */
export async function getJSON<T = any>(url: string, timeout = 20000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally { clearTimeout(timer); }
}

/** GET JSON + ETag 协商缓存（2026-08-09）：304 时返回 null（调用方保留旧值）。
 *  模块级 ETag 缓存按 URL 维护；后端 /api/map 等支持 ETag 的端点用此函数，
 *  签名不变时 304 零传输（省 642KB）。不支持 ETag 的端点退化为普通 GET。 */
const etagCache = new Map<string, string>();
export async function fetchJSONWithETag<T = any>(url: string, timeout = 20000): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const headers: Record<string, string> = {};
    const etag = etagCache.get(url);
    if (etag) headers['if-none-match'] = etag;
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store', headers });
    if (res.status === 304) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const etagResp = res.headers.get('etag');
    if (etagResp) etagCache.set(url, etagResp);
    return (await res.json()) as T;
  } finally { clearTimeout(timer); }
}
