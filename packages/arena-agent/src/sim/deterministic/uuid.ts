/**
 * 确定性原语：raw UUID 比较（S2）。
 *
 * 规则 tie-break 要求 "ascending raw UUID bytes"（game-rules v0.11）。
 * 对 canonical lowercase hex UUID，UTF-16 code unit 序 == 原始字节序；
 * 因此用 < / > 比较（不是 localeCompare——locale-sensitive，跨机器不确定）。
 * 非 canonical 输入（大写/非法长度）直接抛错，防止静默乱序。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class InvalidUuidError extends Error {
  constructor(value: string) {
    super(`invalid canonical lowercase uuid: ${value}`);
    this.name = "InvalidUuidError";
  }
}

export function assertCanonicalUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new InvalidUuidError(value);
  }
}

/** 跨 locale 的稳定 code-unit 序；适用于 playerId、cellKey、eventType 等普通字符串。 */
export function compareCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** raw UUID byte 序比较：a < b → -1；a > b → 1；相等 → 0。 */
export function compareUuidRaw(a: string, b: string): number {
  assertCanonicalUuid(a);
  assertCanonicalUuid(b);
  return compareCodeUnit(a, b);
}

/**
 * 按 raw UUID 序排序（原地复制，不修改输入）。
 * 用于同玩家容量争抢等规则 tie-break。
 */
export function sortByUuidRaw<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return [...items].sort((x, y) => compareUuidRaw(x.id, y.id));
}
