/**
 * 32×32 chunk 几何与官方 refill quota（M4-1，逆向实证定案：
 * docs/design/refill-reverse-engineering-2026-08-08.md §4/§5）。
 *
 * 官方语义：每第 4 个 resolved tick，对每个含自然点的 chunk 按配额补缺；
 * 配额公式 ring = axis(cx)+axis(cy)，axis(c) = c (c≥0) 否则 -c-1，
 * quota = max(2, floor(16*8/(8+ring)))。
 */

export const CHUNK_SIZE = 32;

/** floor 除法：负数坐标向负无穷取整（x∈[-32,-1] → chunk -1）。 */
export function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

/** 所在 chunk 坐标 (cx, cy)：cx = floor(x/32)，cy = floor(y/32)。 */
export function chunkOf(x: number, y: number): readonly [number, number] {
  return [floorDiv(x, CHUNK_SIZE), floorDiv(y, CHUNK_SIZE)];
}

/** chunk 坐标 → 稳定 key（"cx,cy"，负坐标合法）。 */
export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

/** chunk key → 坐标。 */
export function parseChunkKey(key: string): readonly [number, number] {
  const [cx, cy] = key.split(",").map((part) => Number.parseInt(part, 10));
  return [cx, cy];
}

/** 官方 axis(c)：c≥0 → c，否则 -c-1（chunk 坐标到"环"的距离归一化）。 */
export function axisIndex(c: number): number {
  return c >= 0 ? c : -c - 1;
}

/**
 * 官方 quota：max(2, floor(16*8/(8+ring)))，ring = axis(cx)+axis(cy)。
 * chunk (0,0) ring 0 → 16；ring ≥ 56 后 floor 值 ≤ 2，恒取 2（下限）。
 */
export function chunkQuota(cx: number, cy: number): number {
  const ring = axisIndex(cx) + axisIndex(cy);
  return Math.max(2, Math.floor((16 * 8) / (8 + ring)));
}

/** chunk 覆盖格范围（左闭右开：[x0, x1) × [y0, y1)）。 */
export function chunkBounds(
  cx: number,
  cy: number,
): { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } {
  return {
    x0: cx * CHUNK_SIZE,
    y0: cy * CHUNK_SIZE,
    x1: cx * CHUNK_SIZE + CHUNK_SIZE,
    y1: cy * CHUNK_SIZE + CHUNK_SIZE,
  };
}
