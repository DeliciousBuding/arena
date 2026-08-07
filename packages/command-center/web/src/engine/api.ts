/* Arena 指挥面板前端 — API 拉取（无 DOM/state 依赖；URL 由调用方传入） */

/** GET JSON：超时 abort + 禁缓存；非 2xx 抛 HTTP 状态错误。 */
export async function getJSON<T = unknown>(url: string, timeout = 8000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally { clearTimeout(timer); }
}
