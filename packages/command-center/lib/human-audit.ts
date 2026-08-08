/**
 * 人类指挥审计日志（2026-08-08，日志系统 + 综合调试）：每次手操（指令/目标/
 * 模式切换/清空/删除）追加一条 JSONL——重启不丢，复盘"什么时候手操了什么"。
 * 与 human-commands/<tenant>.json（当前生效状态）互补：状态文件是快照，
 * 审计是流水。纯本地追加/读，只读最近 MAX_KEEP 条。
 *
 * 敏感性：指令/目标坐标本就是 human-commands 落盘的操作数据，审计与其同级
 * （不额外引入敏感字段；兑换码类敏感数据不在此处）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_ROOT } from "./fs-jsonl.ts";

export interface HumanAuditEntry {
  at: string;
  tenant: string;
  /** 操作类型：command（指令）/ goal（目标）/ mode（模式切换）/ clear（清空）/ delete（删除）。 */
  kind: "command" | "goal" | "mode" | "clear" | "delete";
  unitId?: string;
  /** 动作摘要（如 MOVE [x,y] / mine [x,y] / override）。 */
  action?: string;
  note?: string;
}

const AUDIT_FILE = join(DATA_ROOT, "runtime", "human-command-audit.jsonl");
const MAX_KEEP = 500;

/** 追加一条手操审计（落盘失败不阻断手操——尽力而为）。 */
export function appendHumanAudit(entry: HumanAuditEntry): void {
  try {
    mkdirSync(dirname(AUDIT_FILE), { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch { /* 忽略：手操不因审计失败而失败 */ }
}

/** 读手操审计（最近 MAX_KEEP 条，可租户过滤；容错坏行）。 */
export function loadHumanAudit(tenant?: string, limit = 100): HumanAuditEntry[] {
  if (!existsSync(AUDIT_FILE)) return [];
  try {
    const cap = Math.min(Math.max(limit, 1), 500);
    const lines = readFileSync(AUDIT_FILE, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
    const rows = lines.slice(-MAX_KEEP)
      .map((l) => { try { return JSON.parse(l) as HumanAuditEntry; } catch { return null; } })
      .filter((r): r is HumanAuditEntry => r !== null);
    const filtered = tenant ? rows.filter((r) => r.tenant === tenant) : rows;
    return filtered.slice(-cap).reverse(); // 最新在前
  } catch { return []; }
}
