/* Arena 指挥面板前端 — 画布绘制助手层（ring/血条/载货/核心名/堆叠徽章）。
 * 维持与 mapEngine 一致的模块级 ctx 约定（createMapEngine 时 setCtx）——这些助手
 * 只在动态层使用（静态缓存 renderStaticCache 的 ctx 换入不影响，实证 0 调用）。 */

/** Canvas font: bold sans stack - Geist for latin, PingFang/YaHei/Noto Sans CJK for CJK (never SimSun). */
export const CANVAS_FONT = '"Geist", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

let ctx: any = null; // createMapEngine 时初始化（CanvasRenderingContext2D；宽松标注）
export function setCtx(c: any) { ctx = c; }

/** 空心圆环（选中/范围/目标标记），可选虚线。 */
export function ring(x: any, y: any, r: any, color: any, width = 1.5, dash: number[] = []) {
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
}

/** 血量/载货条：标签 + 比例条 + 细描边（官方 statArt 语义）。 */
export function drawMeterBar(s: any, x: any, y: any, cell: any, value: any, maximum: any, color: any, labelColor: any, displayLabel: any) {
  const gap = Math.max(1.5, cell * 0.04), maxWidth = cell * 0.9, barHeight = Math.max(2, cell * 0.06);
  const ratio = maximum > 0 ? Math.max(0, Math.min(1, value / maximum)) : 0;
  let fontSize = Math.max(6, cell * 0.15);
  ctx.save();
  ctx.font = '600 ' + fontSize + 'px ' + CANVAS_FONT;
  ctx.textBaseline = 'middle';
  let labelWidth = ctx.measureText(displayLabel).width;
  const preferredBarWidth = cell * 0.35;
  if (labelWidth + gap + preferredBarWidth > maxWidth) {
    fontSize = Math.max(cell * 0.1, fontSize * (maxWidth - gap - preferredBarWidth) / labelWidth);
    ctx.font = '600 ' + fontSize + 'px ' + CANVAS_FONT;
    labelWidth = ctx.measureText(displayLabel).width;
  }
  const barWidth = Math.max(cell * 0.2, Math.min(preferredBarWidth, maxWidth - labelWidth - gap));
  const startX = x - (labelWidth + gap + barWidth) / 2, barX = startX + labelWidth + gap;
  ctx.fillStyle = labelColor; ctx.shadowColor = '#000'; ctx.shadowBlur = 2;
  ctx.fillText(displayLabel, startX, y);
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(20,22,26,.9)'; ctx.fillRect(barX, y - barHeight / 2, barWidth, barHeight);
  ctx.fillStyle = color; ctx.fillRect(barX, y - barHeight / 2, barWidth * ratio, barHeight);
  ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 1;
  ctx.strokeRect(barX + .5, y - barHeight / 2 + .5, barWidth - 1, barHeight - 1);
  ctx.restore();
}

/** 单位血量条：满血不画；>1 绿 / ≤1 红。 */
export function drawUnitHealth(s: any, x: any, y: any, cell: any, hp: any, maxHp: any) {
  if (maxHp <= 0 || hp >= maxHp) return;
  drawMeterBar(s, x, y, cell, hp, maxHp, hp > 1 ? '#8fce9f' : '#e0625d', '#e4e4e7', `${hp}/${maxHp}`);
}

/** 工人载货条：×N 绿条（上限 2）。 */
export function drawWorkerCargo(s: any, x: any, y: any, cell: any, cargo: any) {
  if (!cargo) return;
  drawMeterBar(s, x, y, cell, cargo, 2, '#8fce9f', '#b2d2ba', `×${cargo}`);
}

/** 核心持有者标签：描边文字（受控亮蓝 / 敌方淡红）。 */
export function drawCoreOwnerLabel(s: any, x: any, y: any, cell: any, username: any, controlled: any) {
  const label = '@' + (username || '?');
  let fontSize = Math.max(6, Math.min(9, cell * 0.17));
  const maxWidth = cell * 0.95;
  ctx.save();
  ctx.font = '600 ' + fontSize + 'px ' + CANVAS_FONT;
  const measured = ctx.measureText(label).width;
  if (measured > maxWidth) { fontSize = Math.max(5.5, fontSize * maxWidth / measured); ctx.font = '600 ' + fontSize + 'px ' + CANVAS_FONT; }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.6, fontSize * 0.28); ctx.strokeStyle = 'rgba(0,0,0,.9)';
  ctx.strokeText(label, x, y);
  ctx.fillStyle = controlled ? '#a8c8dd' : '#e9a0aa';
  ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 2; ctx.shadowOffsetY = 1;
  ctx.fillText(label, x, y);
  ctx.restore();
}

/** 同格堆叠徽章：×N 圆角胶囊（黑底 + 租户色描边）。 */
export function drawStackBadge(s: any, x: any, y: any, cell: any, count: any, color: any) {
  const fontSize = Math.max(6, cell * 0.13), label = '×' + count, padding = Math.max(1, cell * 0.045);
  const height = fontSize + padding * 2;
  ctx.save();
  ctx.font = '600 ' + fontSize + 'px ' + CANVAS_FONT;
  const width = ctx.measureText(label).width + padding * 2;
  ctx.fillStyle = 'rgba(0,0,0,.92)'; ctx.strokeStyle = color; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(x - width / 2, y - height / 2, width, height, height / 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fafafa'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y + 0.25);
  ctx.restore();
}
