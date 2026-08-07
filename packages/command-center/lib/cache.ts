/** 通用 TTL 缓存（2026-08-08，UX 优化）：避免前端请求实时读落盘 DB/文件——
 *  测绘/排行榜等只读数据进内存，定时刷新，前端请求毫秒级返回。 */
export class TtlCache<T> {
  private readonly m = new Map<string, { v: T; at: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > this.ttlMs) { this.m.delete(key); return undefined; }
    return e.v;
  }

  set(key: string, v: T): void { this.m.set(key, { v, at: Date.now() }); }

  /** 命中返回，未命中加载并缓存（load 抛错不缓存，下次重试）。 */
  getOrLoad(key: string, load: () => T, ttlMs?: number): T {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const v = load();
    this.m.set(key, { v, at: Date.now() });
    return v;
  }

  invalidate(key?: string): void { if (key === undefined) this.m.clear(); else this.m.delete(key); }
  size(): number { return this.m.size; }
}
