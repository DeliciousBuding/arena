/**
 * 人机协同冲突审计（2026-08-08）：手操 vs 自动决策的冲突量化。
 *
 * 输入（只读）：
 *  - telemetry/<tenant>/outcome.jsonl 尾部：humanOverride.applied/rejected
 *    （rejected 带 reason，如 "Core is already moving"）；
 *  - runtime/human-command-audit.jsonl：手操流水（goal/clear/delete/mode/command）。
 * 输出（/api/audit/human/conflicts）：
 *  - 每租户：applied / rejected / 拒绝率；拒绝原因 top（reason × count × share）；
 *    手操类型构成（goal/clear/delete/...）。
 *  - 典型信号：t3 404 次拒绝全部 "Core is already moving"（核心移动中重复指令）——
 *    UI 未反馈"核心移动中不可指令"导致用户盲点。
 *
 * 只读尾部 + 30s 缓存 + 启动预热，不进周期循环（无计划任务）。
 */
import { existsSync, openSync, readSync, statSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, TENANTS } from "./fs-jsonl.ts";
import { TtlCache } from "./cache.ts";
import type { HumanAuditEntry } from "./human-audit.ts";

const TAIL_BYTES = 3 * 1024 * 1024;
const TTL_MS = 30_000;

export interface HumanConflictPayload {
  generatedAt: string;
  tenant: string;
  window: number;
  currentTick: number | null;
  applied: number;
  rejected: number;
  rejectedRate: number | null;
  topRejectedReasons: Array<{ reason: string; count: number; share: number | null }>;
  commandKinds: Record<string, number>;
  cachedAt: string;
}

const cache = new TtlCache<Record<string, HumanConflictPayload> | HumanConflictPayload>(TTL_MS);

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

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

/** 纯函数（可测）：outcome 尾部 + 手操流水 → 人机冲突量化。 */
export function aggregateHumanConflict(
  tenant: string,
  window: number,
  oLines: readonly string[],
  auditEntries: readonly HumanAuditEntry[],
): HumanConflictPayload {
  let applied = 0, rejected = 0, currentTick = 0;
  const reasonCounts = new Map<string, number>();
  for (const line of oLines) {
    let o: { tick?: unknown; humanOverride?: { applied?: unknown; rejected?: unknown } };
    try { o = JSON.parse(line) as typeof o; } catch { continue; }
    const t = num(o.tick);
    if (t > currentTick) currentTick = t;
    const ho = o.humanOverride;
    if (!ho || typeof ho !== "object") continue;
    if (Array.isArray(ho.applied)) applied += ho.applied.length;
    if (Array.isArray(ho.rejected)) {
      rejected += ho.rejected.length;
      for (const r of ho.rejected) {
        const reason = String((r as { reason?: unknown })?.reason ?? "unknown");
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }
    }
  }
  const topRejectedReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count, share: rejected > 0 ? Math.round((count / rejected) * 1000) / 1000 : null }));

  const commandKinds: Record<string, number> = {};
  for (const e of auditEntries) {
    if (e.tenant !== tenant) continue;
    commandKinds[e.kind] = (commandKinds[e.kind] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    tenant,
    window,
    currentTick: currentTick > 0 ? currentTick : null,
    applied,
    rejected,
    rejectedRate: applied + rejected > 0 ? Math.round((rejected / (applied + rejected)) * 1000) / 1000 : null,
    topRejectedReasons,
    commandKinds,
    cachedAt: new Date().toISOString(),
  };
}

function conflictTenant(tenant: string, window: number): HumanConflictPayload {
  const base = join(DATA_ROOT, "runtime", tenant, "telemetry");
  const oLines = tailLines(join(base, "outcome.jsonl"), TAIL_BYTES, window);
  let auditEntries: HumanAuditEntry[] = [];
  const auditFile = join(DATA_ROOT, "runtime", "human-command-audit.jsonl");
  if (existsSync(auditFile)) {
    try {
      auditEntries = readFileSync(auditFile, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0)
        .map((l) => { try { return JSON.parse(l) as HumanAuditEntry; } catch { return null; } })
        .filter((r): r is HumanAuditEntry => r !== null);
    } catch { /* 容错 */ }
  }
  return aggregateHumanConflict(tenant, window, oLines, auditEntries);
}

export function loadHumanConflict(tenant = "all", window = 3000): Record<string, HumanConflictPayload> | HumanConflictPayload {
  const key = `human-conflict:${tenant}:${window}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (tenant === "all") {
    const perTenant: Record<string, HumanConflictPayload> = {};
    for (const t of TENANTS) perTenant[t] = conflictTenant(t, window);
    cache.set(key, perTenant);
    return perTenant;
  }
  const payload = conflictTenant(tenant, window);
  cache.set(key, payload);
  return payload;
}

/** 启动预热一次（不进周期循环；过期后请求惰性刷新）。 */
export function warmHumanConflict(): void {
  loadHumanConflict("all");
}
