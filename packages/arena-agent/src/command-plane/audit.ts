/**
 * AI 指挥接入层——审计流水（command-plane v1，2026-08-08）。
 * append-only JSONL：`<data-root>/runtime/command-audit/{tenant}.jsonl`。
 * 每条事件含 issuer/session/intentId/action/reasons/evidence，AI 与人类可回溯。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandAuditEvent } from "./protocol.ts";

/** 追加一条审计事件（append-only；写失败不抛（审计不阻断命令）。 */
export function appendAuditEvent(
  dataRoot: string,
  tenant: string,
  event: Omit<CommandAuditEvent, "ts">,
): void {
  try {
    const dir = join(dataRoot, "runtime", "command-audit");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line: CommandAuditEvent = { ...event, ts: new Date().toISOString() };
    appendFileSync(join(dir, `${tenant}.jsonl`), JSON.stringify(line) + "\n", "utf-8");
  } catch {
    // 审计失败不阻断命令下发（fail-open 仅限审计，护栏本身 fail-closed）
  }
}

/** 读取审计流水（最多 limit 条，最新优先）。 */
export function readAudit(
  dataRoot: string,
  tenant: string,
  limit = 50,
): CommandAuditEvent[] {
  const p = join(dataRoot, "runtime", "command-audit", `${tenant}.jsonl`);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
  const out: CommandAuditEvent[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    try { out.push(JSON.parse(lines[i]) as CommandAuditEvent); } catch { /* skip bad */ }
  }
  return out;
}
