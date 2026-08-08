/**
 * 对抗评测统计（M2，evidence-v1 契约）：
 *  - Wilson score 95% 区间（z=1.96）——小样本胜率的不确定度刻画；
 *  - 均资源；
 *  - 控制台展示格式（胜率=75% [41-93]）。
 *
 * 公式（evidence-v1.md §统计约定）：
 *   p̂ ± z√(p̂(1-p̂)/n + z²/4n²) / (1 + z²/n)，z=1.96。
 * 已知标定：wins=6, n=8 → [0.41, 0.93]（evidence-v1.md 示例一致）。
 */

export const WILSON_Z = 1.96;

/** Wilson 95% 区间 [lower, upper]（0..1 实数）。n=0 无样本时返回 [0, 1] 哨兵，
 *  不给出误导性窄区间。 */
export function wilson95(wins: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const p = wins / n;
  const z2 = WILSON_Z * WILSON_Z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const halfWidth = (WILSON_Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const lower = Math.max(0, center - halfWidth);
  const upper = Math.min(1, center + halfWidth);
  return [lower, upper];
}

/** 算术平均（空数组 → NaN，调用方保证非空）。 */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 控制台胜率格式：`75% [41-93]`（整数百分比，Wilson 区间取整）。 */
export function formatWinRateCI(wins: number, n: number): string {
  const [lower, upper] = wilson95(wins, n);
  return `${Math.round((wins / n) * 100)}% [${Math.round(lower * 100)}-${Math.round(upper * 100)}]`;
}
