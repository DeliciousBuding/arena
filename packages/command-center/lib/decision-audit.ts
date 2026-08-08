/**
 * 决策-结果审计（2026-08-08，综合决策 + 日志系统）：把 telemetry 的
 * decision.jsonl（每 tick 决策动作/意图/planHash）与 outcome.jsonl
 * （经济产出/交付成败/工人效率/人类覆盖）聚合为决策健康审计——
 * 振荡（planHash 高频切换）、停摆（wait 主导 + 零采集/交付）、
 * 交付成功率、经济吞吐、人类覆盖执行。纯只读，30s 缓存 + 启动预热。
 *
 * I/O 边界：尾部截读（每文件 ≤3MB/≤3000 行），四租户全量 ≤24MB/轮，不做
 * 30s 周期轮询——启动预热一次 + 请求惰性（30s 缓存）。
 */
import { openSync, readSync, closeSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, TENANTS } from "./fs-jsonl.ts";
import { TtlCache } from "./cache.ts";

const TAIL_BYTES = 3 * 1024 * 1024;
const DEFAULT_RECORDS = 3000;
const TTL_MS = 30_000;

export interface DecisionAuditPayload {
  generatedAt: string;
  tenant: string;
  /** 每文件尾部读取的记录数上限。 */
  window: number;
  currentTick: number | null;
  decision: {
    records: number;
    actionMix: Record<string, number>;
    intentTop: Array<{ intent: string; count: number }>;
    sourceMix: Record<string, number>;
    /** 振荡信号：窗口内 planHash 唯一数 / 记录数（>0.5 视为高频切换）。 */
    planChurn: { unique: number; records: number; rate: number | null } | null;
    /** 停摆 tick：wait 主导且 0 采集/0 交付。 */
    stallTicks: number;
  };
  outcome: {
    records: number;
    coreDeltaSum: number;
    coreDeltaPositiveTicks: number;
    depositSucceeded: number;
    depositFailed: number;
    harvestSucceeded: number;
    harvestFailed: number;
    depositSuccessRate: number | null;
    /** 平均满载率（workersWithCargo / workerCount）。 */
    cargoEfficiency: number | null;
    workerMeanDistFromCore: number | null;
    humanApplied: number;
    humanRejected: number;
  };
  cachedAt: string;
}

const cache = new TtlCache<Record<string, DecisionAuditPayload> | DecisionAuditPayload>(TTL_MS);

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

/** 尾部截读：最多 maxBytes 字节、最多 maxLines 行。 */
function tailLines(file: string, maxBytes: number, maxLines: number): string[] {
  if (!existsSync(file)) return [];
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8").split("\n").filter(Boolean).slice(-maxLines);
  } finally {
    closeSync(fd);
  }
}

interface DecisionLine {
  tick?: unknown; decisionSource?: unknown;
  moveCount?: unknown; harvestCount?: unknown; depositCount?: unknown; waitCount?: unknown; repairCount?: unknown;
  intentCounts?: Record<string, unknown>; planHash?: unknown;
}
interface OutcomeLine {
  tick?: unknown; coreResourcesBefore?: unknown; coreResourcesAfter?: unknown; coreResourceDelta?: unknown;
  workerCount?: unknown; workersWithCargo?: unknown; workerMeanDistanceFromCore?: unknown;
  events?: unknown; failedEvents?: unknown; humanOverride?: { applied?: unknown; rejected?: unknown };
}

/** 纯函数核心（可测）：由 decision/outcome 原始行聚合决策健康审计。 */
export function aggregateAudit(tenant: string, window: number, dLines: readonly string[], oLines: readonly string[]): DecisionAuditPayload {
  const empty: DecisionAuditPayload = {
    generatedAt: new Date().toISOString(), tenant, window, currentTick: null,
    decision: { records: 0, actionMix: {}, intentTop: [], sourceMix: {}, planChurn: null, stallTicks: 0 },
    outcome: { records: 0, coreDeltaSum: 0, coreDeltaPositiveTicks: 0, depositSucceeded: 0, depositFailed: 0,
      harvestSucceeded: 0, harvestFailed: 0, depositSuccessRate: null, cargoEfficiency: null,
      workerMeanDistFromCore: null, humanApplied: 0, humanRejected: 0 },
    cachedAt: new Date().toISOString(),
  };
  if (dLines.length === 0 && oLines.length === 0) return empty;

  const actionMix: Record<string, number> = { move: 0, harvest: 0, deposit: 0, wait: 0, repair: 0 };
  const intentCounts = new Map<string, number>();
  const sourceMix: Record<string, number> = {};
  const planHashes = new Set<string>();
  let dRecords = 0, stallTicks = 0, currentTick = 0;
  for (const line of dLines) {
    let d: DecisionLine;
    try { d = JSON.parse(line) as DecisionLine; } catch { continue; }
    dRecords += 1;
    actionMix.move += num(d.moveCount); actionMix.harvest += num(d.harvestCount);
    actionMix.deposit += num(d.depositCount); actionMix.wait += num(d.waitCount); actionMix.repair += num(d.repairCount);
    const src = String(d.decisionSource ?? "unknown");
    sourceMix[src] = (sourceMix[src] ?? 0) + 1;
    if (d.planHash !== undefined && d.planHash !== null) planHashes.add(String(d.planHash));
    if (num(d.waitCount) > 0 && num(d.harvestCount) === 0 && num(d.depositCount) === 0) stallTicks += 1;
    const t = num(d.tick);
    if (t > currentTick) currentTick = t;
    for (const [k, v] of Object.entries(d.intentCounts ?? {})) {
      const n = num(v);
      if (n > 0) intentCounts.set(k, (intentCounts.get(k) ?? 0) + n);
    }
  }
  const intentTop = [...intentCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([intent, count]) => ({ intent, count }));

  let oRecords = 0, coreDeltaSum = 0, coreDeltaPositive = 0;
  let depOk = 0, depFail = 0, harvOk = 0, harvFail = 0;
  let cargoSum = 0, cargoN = 0, distSum = 0, distN = 0, applied = 0, rejected = 0;
  const countEvent = (ev: unknown): void => {
    const name = typeof ev === "string" ? ev : (ev as { eventType?: unknown })?.eventType;
    const s = String(name ?? "");
    if (s.startsWith("DEPOSIT_SUCCEEDED")) depOk += 1;
    else if (s.startsWith("DEPOSIT_FAILED")) depFail += 1;
    else if (s.startsWith("HARVEST_SUCCEEDED")) harvOk += 1;
    else if (s.startsWith("HARVEST_FAILED")) harvFail += 1;
  };
  for (const line of oLines) {
    let o: OutcomeLine;
    try { o = JSON.parse(line) as OutcomeLine; } catch { continue; }
    oRecords += 1;
    coreDeltaSum += num(o.coreResourceDelta);
    if (num(o.coreResourceDelta) > 0) coreDeltaPositive += 1;
    if (Array.isArray(o.events)) for (const e of o.events) countEvent(e);
    if (Array.isArray(o.failedEvents)) for (const e of o.failedEvents) countEvent(e);
    const wc = num(o.workerCount), wcargo = num(o.workersWithCargo);
    if (wc > 0) { cargoSum += Math.min(1, wcargo / wc); cargoN += 1; }
    const dist = num(o.workerMeanDistanceFromCore);
    if (dist > 0) { distSum += dist; distN += 1; }
    applied += Array.isArray(o.humanOverride?.applied) ? o.humanOverride.applied.length : 0;
    rejected += Array.isArray(o.humanOverride?.rejected) ? o.humanOverride.rejected.length : 0;
  }

  return {
    generatedAt: new Date().toISOString(),
    tenant, window,
    currentTick: currentTick > 0 ? currentTick : null,
    decision: {
      records: dRecords,
      actionMix,
      intentTop,
      sourceMix,
      planChurn: dRecords > 0 ? { unique: planHashes.size, records: dRecords, rate: Math.round((planHashes.size / dRecords) * 1000) / 1000 } : null,
      stallTicks,
    },
    outcome: {
      records: oRecords,
      coreDeltaSum,
      coreDeltaPositiveTicks: coreDeltaPositive,
      depositSucceeded: depOk, depositFailed: depFail,
      harvestSucceeded: harvOk, harvestFailed: harvFail,
      depositSuccessRate: depOk + depFail > 0 ? Math.round((depOk / (depOk + depFail)) * 1000) / 1000 : null,
      cargoEfficiency: cargoN > 0 ? Math.round((cargoSum / cargoN) * 1000) / 1000 : null,
      workerMeanDistFromCore: distN > 0 ? Math.round((distSum / distN) * 10) / 10 : null,
      humanApplied: applied, humanRejected: rejected,
    },
    cachedAt: new Date().toISOString(),
  };
}

function auditTenant(tenant: string, window: number): DecisionAuditPayload {
  const base = join(DATA_ROOT, "runtime", tenant, "telemetry");
  const dLines = tailLines(join(base, "decision.jsonl"), TAIL_BYTES, window);
  const oLines = tailLines(join(base, "outcome.jsonl"), TAIL_BYTES, window);
  return aggregateAudit(tenant, window, dLines, oLines);
}

export function loadDecisionAudit(tenant = "all", window = DEFAULT_RECORDS): Record<string, DecisionAuditPayload> | DecisionAuditPayload {
  const key = `${tenant}:${window}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (tenant === "all") {
    const perTenant: Record<string, DecisionAuditPayload> = {};
    for (const t of TENANTS) perTenant[t] = auditTenant(t, window);
    cache.set(key, perTenant);
    return perTenant;
  }
  const payload = auditTenant(tenant, window);
  cache.set(key, payload);
  return payload;
}

/** 启动预热：四租户决策审计（只读尾部，一次性）。 */
export function warmDecisionAudit(): void {
  loadDecisionAudit("all", DEFAULT_RECORDS);
}
