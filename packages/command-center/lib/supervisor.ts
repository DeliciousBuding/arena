/**
 * Supervisor Debug API 探测：只读探测 127.0.0.1:8120 /ready
 * （在线状态、writer-lock PID）。
 */
const SUPERVISOR_READY_URL = "http://127.0.0.1:8120/ready";

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
  try {
    const res = await fetch(SUPERVISOR_READY_URL, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json() as SupervisorState;
  } catch { return null; }
}
