/**
 * Supervisor Debug API 探测：只读探测 127.0.0.1:8120 /ready
 * （在线状态、writer-lock PID）。
 *
 * 缓存（2026-08-08）：8120 慢时单次探测可 2-3s（CPU 满载下更久），/api/overview
 * 与 /api/tenants 每请求实时打 8120 会让前端"卡"——改为 5s TTL 内存缓存，
 * 只缓存成功结果（失败不缓存，下次重试）。租户健康状态秒级不变，5s 足够。
 */
const SUPERVISOR_READY_URL = "http://127.0.0.1:8120/ready";
const SUPERVISOR_TTL_MS = 5_000;
let supervisorCache: { at: number; data: SupervisorState | null } = { at: 0, data: null };

export interface SupervisorTenantState {
  tenantId?: string;
  ready?: boolean;
  alive?: boolean;
  pid?: number | null;
  lifecycle?: string | null;
}
export interface SupervisorState {
  tenants?: SupervisorTenantState[];
}

export async function supervisorState(): Promise<SupervisorState | null> {
  const now = Date.now();
  const hit = supervisorCache.data;
  if (hit && now - supervisorCache.at < SUPERVISOR_TTL_MS) return hit;
  try {
    const res = await fetch(SUPERVISOR_READY_URL, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json() as SupervisorState;
    supervisorCache = { at: Date.now(), data };
    return data;
  } catch { return null; } // 失败不缓存：下一请求重试，避免隐藏恢复
}
