/**
 * 共享测绘人工仲裁（2026-08-08，冲突闭环）：人类可覆盖同格矿的默认仲裁
 * （lastSeen 最新者胜，tie 按租户序）。落盘 data/runtime/survey/arbitration.jsonl
 * （追加式，同 cell 最后一条生效：override 或 clear），**不写 survey-db**
 * （单一 writer 纪律保持）。面板写入口 = 人类最高控制权通道（与 human-commands 同构）。
 *
 * 消费：alliance-survey 聚合时把生效仲裁应用到 consensusResources /
 * resourceOverlaps（arbitrated 标记），前端可显示"人工仲裁"。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_ROOT } from "./fs-jsonl.ts";

export interface ArbitrationEntry {
  /** 冲突格 key（"x,y"）。 */
  cell: string;
  /** 指定 winner 租户；null = clear（回到自动仲裁）。 */
  winnerTenant: string | null;
  note?: string;
  createdAt: string;
}

export const arbitrationFile = (root: string = DATA_ROOT): string =>
  join(root, "runtime", "survey", "arbitration.jsonl");

/** 读全部仲裁，按 cell 取最后生效条目（追加式日志的最后一行胜）。 */
export function loadArbitrations(root: string = DATA_ROOT): Map<string, ArbitrationEntry> {
  const file = arbitrationFile(root);
  if (!existsSync(file)) return new Map();
  try {
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    const out = new Map<string, ArbitrationEntry>();
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as ArbitrationEntry;
        if (!e || typeof e.cell !== "string" || e.cell === "") continue;
        out.set(e.cell, e);
      } catch { /* 容错坏行 */ }
    }
    return out;
  } catch {
    return new Map();
  }
}

/** 追加一条仲裁（override 或 clear）。 */
export function appendArbitration(entry: ArbitrationEntry, root: string = DATA_ROOT): void {
  const file = arbitrationFile(root);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
}

/** 取消某格仲裁（回自动规则）。 */
export function clearArbitration(cell: string, root: string = DATA_ROOT): void {
  appendArbitration({ cell, winnerTenant: null, note: "清除仲裁（回自动规则）", createdAt: new Date().toISOString() }, root);
}

/** 生效仲裁列表（同 cell 最后一条）。 */
export function listArbitrations(root: string = DATA_ROOT): ArbitrationEntry[] {
  return [...loadArbitrations(root).values()];
}
