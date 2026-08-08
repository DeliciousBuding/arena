/**
 * Supervisor Debug API 探测：只读探测 127.0.0.1:8120 /ready
 * （在线状态、writer-lock PID）。
 *
 * 缓存（2026-08-08）：8120 慢时单次探测可 2-3s（CPU 满载下更久），/api/overview
 * 与 /api/tenants 每请求实时打 8120 会让前端"卡"——改为 5s TTL 内存缓存，
 * 只缓存成功结果（失败不缓存，下次重试）。租户健康状态秒级不变，5s 足够。
 */
const SUPERVISOR_BASE_URL = process.env.ARENA_SUPERVISOR_DEBUG_URL ?? "http://127.0.0.1:8120";
const SUPERVISOR_READY_URL = `${SUPERVISOR_BASE_URL}/ready`;
const SUPERVISOR_DIRECTOR_URL = `${SUPERVISOR_BASE_URL}/alliance-director`;
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


export interface SupervisorAllianceMission {
  readonly id?: string;
  readonly kind?: string;
  readonly priority?: number;
  readonly defendTenant?: string;
  readonly scope?: string;
}
export interface SupervisorAllianceTaskForce {
  readonly id?: string;
  readonly missionId?: string;
  readonly commanderTenant?: string;
  readonly fleetRefs?: readonly { readonly tenantId?: string; readonly fleetId?: string }[];
}
export interface SupervisorAllianceDirectorState {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly mode: "ASSIST_ONLY";
  readonly actionOwnership: "none";
  readonly revision?: number;
  readonly tick?: number | null;
  readonly frameTenants?: readonly string[];
  readonly runtime?: {
    readonly reportCount?: number;
    readonly directiveSentCount?: number;
    readonly ackCount?: number;
    readonly directorErrorCount?: number;
    readonly invalidOutputCount?: number;
    readonly sendErrorCount?: number;
    readonly ackRecords?: readonly { readonly tenantId?: string; readonly revision?: number; readonly state?: string }[];
  };
  readonly policy?: {
    readonly treasuryTenant?: string;
    readonly missions?: readonly SupervisorAllianceMission[];
    readonly taskForces?: readonly SupervisorAllianceTaskForce[];
  } | null;
}

const DIRECTOR_UNAVAILABLE: SupervisorAllianceDirectorState = Object.freeze({
  available: false, enabled: false, mode: "ASSIST_ONLY", actionOwnership: "none",
});
let directorCache: { at: number; data: SupervisorAllianceDirectorState | null } = { at: 0, data: null };

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


/** Read-only central Alliance Director shadow status. Fail-open when supervisor/v3 is unavailable. */
export async function supervisorAllianceDirectorState(): Promise<SupervisorAllianceDirectorState> {
  const now = Date.now();
  if (directorCache.data && now - directorCache.at < SUPERVISOR_TTL_MS) return directorCache.data;
  try {
    const res = await fetch(SUPERVISOR_DIRECTOR_URL, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return DIRECTOR_UNAVAILABLE;
    const raw = await res.json() as Partial<SupervisorAllianceDirectorState>;
    const data: SupervisorAllianceDirectorState = {
      ...raw,
      available: raw.available !== false,
      enabled: raw.enabled === true,
      mode: "ASSIST_ONLY",
      actionOwnership: "none",
    };
    directorCache = { at: Date.now(), data };
    return data;
  } catch {
    return DIRECTOR_UNAVAILABLE;
  }
}
