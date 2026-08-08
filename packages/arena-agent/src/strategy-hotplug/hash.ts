/**
 * 确定性序列化与哈希工具（v1，2026-08-08）。
 *
 * 纯函数、无外部依赖（不用 crypto）、确定性（同输入 → 同输出）。
 * 供 StrategyComponent release hash 计算与快照 configHash 使用。
 */

/**
 * 确定性 canonical JSON 序列化。
 * - 键按字典序排列；
 * - 数组保留原序（视为有意）；
 * - 嵌套对象递归排序；
 * - 无空格缩进。
 */
export function deterministicCanonicalJson(value: unknown): string {
  return JSON.stringify(value, jsonReplacer);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    // null / 基本类型 / 数组 → 原样（数组不重新排序）
    return value;
  }
  // 普通对象：按键排序重建
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(record).sort();
  for (const key of keys) {
    sorted[key] = record[key];
  }
  return sorted;
}

/**
 * FNV-1a 32-bit 哈希（确定性、无碰撞概率可接受）。
 * 用于 release hash 计算（不用于安全场景）。
 */
export function simpleHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
