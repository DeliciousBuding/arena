/**
 * Worker 活性审计：只读 runtime.jsonl 的 worker_liveness 异常事件。
 *
 * 设计目标不是再造一套执行逻辑，而是给人/Agent 一个稳定的 forensic API：
 * - 哪个 Worker 卡住；
 * - 属于静态假活、MOVE 无效果、两三格振荡、拥挤饥饿还是普通 idle；
 * - 触发时的 intent/action/位置轨迹；
 * - targeted recovery 是否已下发、是否重复触发。
 *
 * 只有异常才落盘，因此 I/O 很小；当前状态用“距最新 runtime tick 的年龄”表达，
 * 不冒充严格的 live state。重复触发 recoveryCount>1 是最值得关注的未自愈信号。
 */
import { join } from "node:path";
import { TtlCache } from "./cache.ts";
import { TENANTS, readJsonlTail, telemetryDir } from "./fs-jsonl.ts";

const TTL_MS = 5_000;
const DEFAULT_WINDOW = 4000;
const RECENT_TICKS = 16;

export interface WorkerLivenessIncident {
  tenant: string;
  unitId: string;
  kind: string;
  tick: number;
  ageTicks: number | null;
  streak: number;
  position: readonly [number, number] | null;
  cargo: number | null;
  priorActionType: string | null;
  priorIntent: string | null;
  recentPositions: readonly (readonly [number, number])[];
  uniqueRecentPositions: number | null;
  recoveryCount: number;
  recoveryApplied: boolean;
  recoveryError: string | null;
  /** recent = 刚触发/仍需观察；repeated = 同单位重复触发；historical = 已离开近期窗口。 */
  status: "recent" | "repeated" | "historical";
}

export interface WorkerLivenessTenantAudit {
  tenant: string;
  currentTick: number | null;
  eventCount: number;
  affectedWorkers: number;
  repeatedWorkers: number;
  byKind: Record<string, number>;
  latestByWorker: WorkerLivenessIncident[];
}

export interface WorkerLivenessAuditPayload {
  generatedAt: string;
  tenant: string;
  window: number;
  totals: {
    eventCount: number;
    affectedWorkers: number;
    repeatedWorkers: number;
    recentWorkers: number;
  };
  tenants: WorkerLivenessTenantAudit[];
  cachedAt: string;
}

interface RuntimeLine extends Record<string, unknown> {
  tick?: unknown;
  telemetryType?: unknown;
  workerLivenessKind?: unknown;
  unitId?: unknown;
  streak?: unknown;
  position?: unknown;
  cargo?: unknown;
  priorActionType?: unknown;
  priorIntent?: unknown;
  recentPositions?: unknown;
  uniqueRecentPositions?: unknown;
  recoveryCount?: unknown;
  recoveryApplied?: unknown;
  recoveryError?: unknown;
}

const cache = new TtlCache<WorkerLivenessAuditPayload>(TTL_MS);

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function position(value: unknown): readonly [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const x = finiteNumber(value[0]);
  const y = finiteNumber(value[1]);
  return x === null || y === null ? null : [x, y];
}

function positions(value: unknown): readonly (readonly [number, number])[] {
  if (!Array.isArray(value)) return [];
  return value.map(position).filter((p): p is readonly [number, number] => p !== null);
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** 纯函数核心，方便用生产事件 fixture 回归。 */
export function aggregateWorkerLiveness(tenant: string, rows: readonly RuntimeLine[]): WorkerLivenessTenantAudit {
  let currentTick: number | null = null;
  const incidents: RuntimeLine[] = [];
  for (const row of rows) {
    const tick = finiteNumber(row.tick);
    if (tick !== null && (currentTick === null || tick > currentTick)) currentTick = tick;
    if (row.telemetryType === "worker_liveness" && typeof row.unitId === "string") incidents.push(row);
  }

  const byKind: Record<string, number> = {};
  const latest = new Map<string, RuntimeLine>();
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const row of incidents) {
    const id = String(row.unitId);
    const kind = text(row.workerLivenessKind) ?? "unknown";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
    const prev = latest.get(id);
    if (prev === undefined || (finiteNumber(row.tick) ?? -1) >= (finiteNumber(prev.tick) ?? -1)) latest.set(id, row);
  }

  const latestByWorker = [...latest.entries()].map(([unitId, row]): WorkerLivenessIncident => {
    const tick = finiteNumber(row.tick) ?? 0;
    const ageTicks = currentTick === null ? null : Math.max(0, currentTick - tick);
    const recoveryCount = finiteNumber(row.recoveryCount) ?? 0;
    const status: WorkerLivenessIncident["status"] =
      recoveryCount > 1 || repeated.has(unitId)
        ? "repeated"
        : ageTicks !== null && ageTicks <= RECENT_TICKS
          ? "recent"
          : "historical";
    return {
      tenant,
      unitId,
      kind: text(row.workerLivenessKind) ?? "unknown",
      tick,
      ageTicks,
      streak: finiteNumber(row.streak) ?? 0,
      position: position(row.position),
      cargo: finiteNumber(row.cargo),
      priorActionType: text(row.priorActionType),
      priorIntent: text(row.priorIntent),
      recentPositions: positions(row.recentPositions),
      uniqueRecentPositions: finiteNumber(row.uniqueRecentPositions),
      recoveryCount,
      recoveryApplied: row.recoveryApplied === true,
      recoveryError: text(row.recoveryError),
      status,
    };
  }).sort((a, b) => {
    const priority = (status: WorkerLivenessIncident["status"]): number => status === "repeated" ? 0 : status === "recent" ? 1 : 2;
    return priority(a.status) - priority(b.status) || b.tick - a.tick || a.unitId.localeCompare(b.unitId);
  });

  return {
    tenant,
    currentTick,
    eventCount: incidents.length,
    affectedWorkers: latest.size,
    repeatedWorkers: latestByWorker.filter((item) => item.status === "repeated").length,
    byKind,
    latestByWorker,
  };
}

function loadTenant(tenant: string, window: number): WorkerLivenessTenantAudit {
  const rows = readJsonlTail(join(telemetryDir(tenant), "runtime.jsonl"), window) as RuntimeLine[];
  return aggregateWorkerLiveness(tenant, rows);
}

export function loadWorkerLivenessAudit(tenant = "all", window = DEFAULT_WINDOW): WorkerLivenessAuditPayload {
  const bounded = Math.min(Math.max(Math.floor(window), 200), 20_000);
  const key = `${tenant}:${bounded}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const selected = tenant === "all" ? [...TENANTS] : [tenant];
  const tenants = selected.map((id) => loadTenant(id, bounded));
  const latest = tenants.flatMap((item) => item.latestByWorker);
  const payload: WorkerLivenessAuditPayload = {
    generatedAt: new Date().toISOString(),
    tenant,
    window: bounded,
    totals: {
      eventCount: tenants.reduce((sum, item) => sum + item.eventCount, 0),
      affectedWorkers: latest.length,
      repeatedWorkers: latest.filter((item) => item.status === "repeated").length,
      recentWorkers: latest.filter((item) => item.status === "recent").length,
    },
    tenants,
    cachedAt: new Date().toISOString(),
  };
  cache.set(key, payload);
  return payload;
}

export function warmWorkerLivenessAudit(): void {
  try { loadWorkerLivenessAudit("all", DEFAULT_WINDOW); } catch { /* fail-open: 审计不可阻塞面板 */ }
}
