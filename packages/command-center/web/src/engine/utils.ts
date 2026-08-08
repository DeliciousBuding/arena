/* Arena 指挥面板前端 — 纯工具函数与常量（无 DOM/state 依赖，供各模块复用） */

/* 素材路径（asset 常量，不随运行态变化） */
export const SPRITE = {
  core: '/assets/game/units/core.png',
  worker: '/assets/game/units/worker.png',
  vanguard: '/assets/game/units/vanguard.png',
  ranger: '/assets/game/units/ranger.png',
  crystal: ['/assets/game/resources/crystal-1.png', '/assets/game/resources/crystal-2.png'],
  obstacle: ['/assets/game/obstacles/asteroid-large-1.png', '/assets/game/obstacles/asteroid-large-2.png'],
  beacon: '/assets/game/beacon.png',
};

/** 确定性格哈希（精灵/装饰随机化用，同格同盐恒同结果）。 */
export function hash2(a: number, b: number, salt: number): number {
  let h = (Math.imul(a + salt * 7919, 73856093) ^ Math.imul(b + salt * 104729, 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return (h ^ (h >>> 13)) >>> 0;
}
/** 数值格式化：≥1000 千分位；其余定小数位；非有限值显示 —。 */
export function fmt(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: digits });
  return n.toFixed(digits);
}
export function shortId(id: string | null | undefined): string { return id ? String(id).slice(0, 8) : '—'; }
/** 时长文本：s / m / h 三档。 */
export function ageText(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
/** 十六进制色 + alpha → rgba() 字符串。 */
export function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}
export const EASE_OUT_CUBIC = (t: number): number => 1 - Math.pow(1 - t, 3);
export const EASE_OUT_QUART = (t: number): number => 1 - Math.pow(1 - t, 4);
/** 单位类型 → 最大 HP（官方语义：VANGUARD 4，其余 2）。 */
export function maxUnitHp(type: string): number { return type === 'VANGUARD' ? 4 : 2; }
/** 单位类型 → 官方素材路径。 */
export function unitSpritePath(type: string): string {
  if (type === 'VANGUARD') return SPRITE.vanguard;
  if (type === 'RANGER') return SPRITE.ranger;
  return SPRITE.worker;
}
/** HTML 转义（用户/外部数据入 innerHTML 前必须转义）。 */
const HTML_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(str: unknown): string {
  return String(str ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
}
/** 坐标 [x, y] → 格键。 */
export type Position = [number, number];
export const pKey = (p: Position): string => `${p[0]},${p[1]}`;
export const samePos = (a: Position | null | undefined, b: Position | null | undefined): boolean => !!(a && b && a[0] === b[0] && a[1] === b[1]);

/** 缩放桶：2 的幂（半档）——静态缓存按缩放桶重建，避免每帧重建。 */
export function bucketScale(s: number): number {
  const k = Math.round(Math.log2(Math.max(0.05, Math.min(64, s))) * 2) / 2;
  return Math.pow(2, k);
}
/** 网格步长：2 的幂，满足 step*s ≥ targetPx（坐标刻度密度自适应缩放）。 */
export function gridStepFor(s: number, targetPx: number): number {
  let step = 4;
  while (step * s < targetPx && step < 2048) step *= 2;
  return step;
}
/** 屏幕线段保底长度：低缩放太短时按方向拉长到 minLen（方向夸张但保持语义）。 */
export function extendScreen(a: { sx: number; sy: number }, b: { sx: number; sy: number }, minLen: number) {
  const dx = b.sx - a.sx, dy = b.sy - a.sy;
  const len = Math.hypot(dx, dy);
  if (len >= minLen || len < 1e-3) return b;
  const k = minLen / len;
  return { sx: a.sx + dx * k, sy: a.sy + dy * k };
}
/** 回放插值：frame-1 → frame 按 progress(0-1) 平滑移动（trail 数组）。 */
export function replayInterp(obj: any, frame: number, progress: number) {
  if (!obj.trail || !obj.trail.length) return null;
  const b = obj.trail[Math.min(frame, obj.trail.length - 1)];
  const a = obj.trail[Math.max(0, frame - 1)];
  if (!b) return null;
  const x = a ? a.x + (b.x - a.x) * progress : b.x;
  const y = a ? a.y + (b.y - a.y) * progress : b.y;
  return { x, y, hp: b.hp, shield: b.shield, cargo: b.cargo, t: b.t };
}
