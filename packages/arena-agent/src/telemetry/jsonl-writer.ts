/**
 * JSONL 写入器（切片 4 阶段 5，Agent C 地界，leader 补齐）。
 *
 * 约束（W9 + GPT 裁决）：
 * - append-only：每次 write 一条完整 JSON 行（appendFileSync，简单可靠）；
 * - 每条记录先过 schema 校验（非法 → 抛错，脏数据不进审计链，不静默）；
 * - 递归脱敏：Authorization/API key/token/cookie/疑似凭据不落盘；
 * - close 后 write 抛错（生命周期闭合）。
 */

import { appendFileSync } from "node:fs";

import { validateTraceRecord } from "./schema.ts";
import type { TraceRecord } from "./decision-trace.ts";

// ---------- 脱敏（递归） ----------

const SECRET_PATTERNS: Array<RegExp> = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(authorization|api[-_]?key|token|cookie|secret|password)\s*[:=]\s*["']?[^\s"'",}]+/gi,
  /ARENA_HERO_API_KEY(?:_\d+)?=\S+/g,
  /[A-Za-z0-9_-]{32,}/g, // 任意 ≥32 位疑似凭据串（长随机 token）
];

function redactText(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      // 保留 key 名前缀（如 authorization=），只替换值
      const eq = match.indexOf("=");
      if (eq >= 0 && eq < 24) {
        return `${match.slice(0, eq + 1)}[REDACTED]`;
      }
      const colon = match.indexOf(":");
      if (colon >= 0 && colon < 16) {
        return `${match.slice(0, colon + 1)}[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return out;
}

/** 递归脱敏任意 JSON 值（字符串替换；数组/对象递归；其他原样）。 */
export function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeValue(v);
    }
    return out;
  }
  return value;
}

/** 单测直接验证脱敏（导出）。 */
export function sanitizeText(text: string): string {
  return redactText(text);
}

// ---------- JsonlWriter ----------

export class JsonlWriter {
  private readonly path: string;
  private closed = false;
  /** 运行中偶发写失败计数（不可阻塞 submit deadline；由调用方按需上报）。 */
  private errorCount = 0;

  constructor(path: string) {
    this.path = path;
  }

  get droppedCount(): number {
    return this.errorCount;
  }

  /** 校验 → 脱敏 → append。校验失败抛错（fail-fast）；IO 失败计入 errorCount 不抛（不阻塞决策路径）。 */
  write(record: TraceRecord): void {
    if (this.closed) {
      throw new Error("JsonlWriter is closed");
    }
    validateTraceRecord(record); // 非法记录抛错（含字段路径），不落盘
    const sanitized = sanitizeValue(record);
    try {
      appendFileSync(this.path, `${JSON.stringify(sanitized)}\n`, "utf-8");
    } catch {
      this.errorCount += 1;
    }
  }

  close(): void {
    this.closed = true;
  }
}
