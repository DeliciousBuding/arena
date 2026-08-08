/**
 * 兑换申请日志（2026-08-08 落盘持久化）：内存数组重启即丢——改为 JSONL 落盘
 * data/runtime/redeem-log.jsonl。只记录 code 前 6 位（防完整兑换码泄露）；
 * 兑换码本身由用户在面板粘贴、经官方商店代理使用，不落明文。
 * 纯本地只读/追加；读时滚动最近 MAX_KEEP 条（审计窗口足够）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_ROOT } from "./fs-jsonl.ts";

export interface RedeemRecord {
  /** 兑换码前 6 位 + ***（审计可辨识，不落完整码）。 */
  codeMask: string;
  at: string;
  ip: string;
  status: "pending" | "done" | "failed";
  note?: string;
}

const LOG_FILE = join(DATA_ROOT, "runtime", "redeem-log.jsonl");
const MAX_KEEP = 200;

/** 追加一条兑换记录（落盘失败不阻断兑换申请——尽力而为）。 */
export function appendRedeemRecord(rec: RedeemRecord): void {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify(rec) + "\n", "utf8");
  } catch { /* 忽略：兑换申请不因日志失败而失败 */ }
}

/** 读兑换历史（最近 MAX_KEEP 条，容错坏行）。 */
export function loadRedeemHistory(): RedeemRecord[] {
  if (!existsSync(LOG_FILE)) return [];
  try {
    const lines = readFileSync(LOG_FILE, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
    return lines.slice(-MAX_KEEP)
      .map((l) => { try { return JSON.parse(l) as RedeemRecord; } catch { return null; } })
      .filter((r): r is RedeemRecord => r !== null);
  } catch { return []; }
}
