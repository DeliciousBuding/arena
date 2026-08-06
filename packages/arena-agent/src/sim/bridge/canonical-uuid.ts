/**
 * 确定性 ID → UUID（桥接外部策略协议，与 Rust 线 arena-sim-bridge 对偶）：
 * FNV-1a 64 位哈希 → 16 字节 UUID（版本 5 风格布局）。确定性：同 ID 恒同
 * UUID（跨 tick 稳定——外部策略（榜二）的记忆表按 ID 索引依赖此性质）。
 */

export function canonicalUuid(id: string): string {
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  let hash = FNV_OFFSET;
  for (const byte of Buffer.from(`arena:${id}`, "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & 0xffffffffffffffffn;
  }
  const bytes = new Uint8Array(16);
  const high = hash;
  const low = (hash * FNV_PRIME) & 0xffffffffffffffffn;
  for (let index = 0; index < 8; index += 1) {
    bytes[7 - index] = Number((high >> BigInt(index * 8)) & 0xffn);
    bytes[15 - index] = Number((low >> BigInt(index * 8)) & 0xffn);
  }
  // 版本 5 + RFC 4122 变体位（格式合法即可，确定性优先）。
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
