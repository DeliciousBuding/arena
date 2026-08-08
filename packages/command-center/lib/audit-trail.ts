/**
 * 统一审计流水（2026-08-08，综合调试）：把所有落盘审计 jsonl 归一成一条
 * 时间倒序流水——"什么时候发生了什么"一眼可查。
 *
 * 四源（全部只读，30s 惰性缓存 + 启动预热，不进周期循环）：
 *   - human       human-command-audit.jsonl（手操：指令/目标/模式/清空/删除）
 *   - command     command-audit/{tenant}.jsonl（命令写通道：worker_mine 等 accepted/rejected）
 *   - arbitration arbitration.jsonl（共享测绘人工仲裁 override/clear）
 *   - supervisor  supervisor.jsonl（生产进程退出/就绪等）
 * 输出（/api/audit/trail）：entries 归一化 {at, source, tenant, kind, detail, ref}
 * 按 at 倒序 + per-source counts；?tenant=&source=&limit= 过滤。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, TENANTS, readJsonlTail } from "./fs-jsonl.ts";
import { TtlCache } from "./cache.ts";
import { loadHumanAudit, type HumanAuditEntry } from "./human-audit.ts";
import { arbitrationFile } from "./arbitration.ts";

export type AuditSource = "human" | "command" | "arbitration" | "supervisor";
const SOURCES: readonly AuditSource[] = ["human", "command", "arbitration", "supervisor"];

export interface AuditTrailEntry {
  /** ISO 时间（归一化：at/ts/createdAt）。 */
  at: string;
  source: AuditSource;
  tenant: string | null;
  /** 归一化类型（如 goal / worker_mine / arbitrate / exited）。 */
  kind: string;
  /** 中文可读摘要。 */
  detail: string;
  /** 引用（unitId / cell / target）。 */
  ref?: string;
}

export interface AuditTrailOptions {
  tenant?: string;
  source?: AuditSource;
  limit?: number;
}

export interface AuditTrailPayload {
  generatedAt: string;
  entries: AuditTrailEntry[];
  counts: Record<AuditSource, number>;
  filters: { tenant: string | null; source: AuditSource | null };
  cachedAt: string;
}

const TTL_MS = 30_000;
const cache = new TtlCache<AuditTrailPayload>(TTL_MS);

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const numOr = (v: unknown): string => (typeof v === "number" ? String(v) : str(v));

function normTime(row: Record<string, unknown>): string {
  const t = str(row.at ?? row.ts ?? row.createdAt ?? "");
  return t;
}

/** 纯函数（可测）：四源 → 归一化条目（未排序，供 merge 用）。 */
export function normalizeAuditTrails(
  human: readonly HumanAuditEntry[],
  commandsByTenant: Record<string, readonly Record<string, unknown>[]>,
  arbitrations: readonly Record<string, unknown>[],
  supervisors: readonly Record<string, unknown>[],
): AuditTrailEntry[] {
  const out: AuditTrailEntry[] = [];
  for (const h of human) {
    const ref = h.unitId || undefined;
    out.push({
      at: h.at, source: "human", tenant: h.tenant,
      kind: h.kind,
      detail: [h.action, h.note].filter(Boolean).join(" — ") || h.kind,
      ref,
    });
  }
  for (const [t, rows] of Object.entries(commandsByTenant)) {
    for (const r of rows) {
      const kind = str(r.kind);
      const action = str(r.action);
      const evidence = r.evidence as Record<string, unknown> | undefined;
      const target = evidence?.target ? JSON.stringify(evidence.target) : "-";
      const units = evidence?.unitIds ? ` unit=${(evidence.unitIds as unknown[]).length}` : "";
      out.push({
        at: normTime(r), source: "command", tenant: t || null,
        kind: kind || action || "command",
        detail: `${action || kind} → ${target}${units} issuer=${str(r.issuer) || "-"}`,
        ref: target !== "-" ? target : undefined,
      });
    }
  }
  for (const r of arbitrations) {
    const cell = str(r.cell);
    const winner = r.winnerTenant === null || r.winnerTenant === undefined ? "auto" : str(r.winnerTenant);
    out.push({
      at: normTime(r), source: "arbitration", tenant: null,
      kind: winner === "auto" ? "arbitrate-clear" : "arbitrate",
      detail: `cell ${cell} → winner ${winner}${str(r.note) ? "（" + str(r.note) + "）" : ""}`,
      ref: cell || undefined,
    });
  }
  for (const r of supervisors) {
    const type = str(r.type);
    const pid = r.pid !== undefined && r.pid !== null ? ` pid=${r.pid}` : "";
    const code = r.exitCode !== undefined && r.exitCode !== null ? ` code=${r.exitCode}` : "";
    const sig = r.signal !== undefined && r.signal !== null ? ` sig=${r.signal}` : "";
    out.push({
      at: normTime(r), source: "supervisor", tenant: str(r.tenantId) || null,
      kind: type || "event",
      detail: `${type}${pid}${code}${sig}`.trim(),
      ref: undefined,
    });
  }
  return out;
}

/** 纯函数（可测）：归一化条目 → 时间倒序（ISO 字典序=时间序），可过滤。 */
export function mergeAuditTrails(
  normalized: readonly AuditTrailEntry[],
  opts: AuditTrailOptions = {},
): AuditTrailEntry[] {
  const tenant = opts.tenant ? String(opts.tenant) : null;
  const source = opts.source ? String(opts.source) as AuditSource : null;
  const cap = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const filtered = normalized
    .filter((e) => (!tenant || e.tenant === tenant) && (!source || e.source === source))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return filtered.slice(0, cap);
}

export function loadAuditTrail(opts: AuditTrailOptions = {}): AuditTrailPayload {
  const key = `trail:${opts.tenant ?? "*"}:${opts.source ?? "*"}:${opts.limit ?? 200}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const human = loadHumanAudit(undefined, 200);
  const commandsByTenant: Record<string, readonly Record<string, unknown>[]> = {};
  for (const t of TENANTS) {
    const f = join(DATA_ROOT, "runtime", "command-audit", `${t}.jsonl`);
    commandsByTenant[t] = existsSync(f) ? readJsonlTail(f, 100) : [];
  }
  const arbFile = arbitrationFile();
  const arbitrations = existsSync(arbFile) ? readJsonlTail(arbFile, 100) : [];
  const supFile = join(DATA_ROOT, "runtime", "supervisor.jsonl");
  const supervisors = existsSync(supFile) ? readJsonlTail(supFile, 100) : [];
  const normalized = normalizeAuditTrails(human, commandsByTenant, arbitrations, supervisors);
  const entries = mergeAuditTrails(normalized, opts);
  const counts: Record<AuditSource, number> = { human: 0, command: 0, arbitration: 0, supervisor: 0 };
  for (const e of entries) counts[e.source] += 1;
  const payload: AuditTrailPayload = {
    generatedAt: new Date().toISOString(),
    entries,
    counts,
    filters: { tenant: opts.tenant ?? null, source: opts.source ?? null },
    cachedAt: new Date().toISOString(),
  };
  cache.set(key, payload);
  return payload;
}

/** 启动预热一次（不进周期循环；过期后请求惰性刷新）。 */
export function warmAuditTrail(): void {
  loadAuditTrail();
}
