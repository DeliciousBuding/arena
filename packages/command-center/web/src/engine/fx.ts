/* Arena 指挥面板前端 — 事件特效层（回放/战斗 FX：弹道弧、剑光、浮字、销毁碎片）。
 * 纯几何/生成逻辑可单测；绘制函数注入 ctx/project/ring/font（mapEngine 提供）。 */

export const FX_LIFE_MS = 2500;

export const FX_KIND_CN: Record<string, { text: string; color: string; size: number }> = {
  HARVEST_SUCCEEDED: { text: '+', color: '#8fce9f', size: 13 },
  DEPOSIT_SUCCEEDED: { text: '¥', color: '#5fd4e8', size: 13 },
  SHOT_HIT: { text: '✚', color: '#e0625d', size: 13 },
  SWEEP_RESOLVED: { text: '⚔', color: '#ffffff', size: 13 },
  CORE_DAMAGED: { text: '⚔', color: '#ff6b6b', size: 14 },
  CORE_DESTROYED: { text: '摧毁!', color: '#e0625d', size: 18 },
  CORE_SPAWN_SUCCEEDED: { text: '产', color: '#5fd4e8', size: 12 },
  UNIT_HEAL_SUCCEEDED: { text: '✚', color: '#8fce9f', size: 12 },
};
export function spawnEventFx(tac: any, replayData: any, frameTick: any, now: number) {
  const d = replayData;
  if (!d || !d.eventFrames) return;
  const frame = d.eventFrames.find((f: any) => f.tick === frameTick);
  if (!frame) return;
  for (const ev of frame.events) {
    const isShot = ev.t === 'SHOT_HIT' || ev.t === 'SHOT_MISSED' || ev.t === 'SHOT_BLOCKED';
    const isSweep = ev.t === 'SWEEP_RESOLVED';
    if ((isShot || isSweep) && ev.f && ev.q) {
      tac.eventFx.push({
        kind: isShot ? 'SHOT' : 'SWEEP', from: ev.f, to: ev.q, hit: ev.t === 'SHOT_HIT',
        born: now, life: isShot ? 950 : 760, seq: ++tac.fxSeq,
      });
      continue; // 弹道弧/剑光代替浮字（更直观）
    }
    // 销毁碎片：单位/核心被摧毁时迸溅——先于浮字 spec 检查（UNIT_DESTROYED 不在
    // FX_KIND_CN，原代码 continue 导致单位销毁碎片永不生成，2026-08-08 测试实证修复）
    if (ev.t === 'UNIT_DESTROYED' || ev.t === 'CORE_DESTROYED') {
      const n = ev.t === 'CORE_DESTROYED' ? 14 : 8;
      const color = ev.t === 'CORE_DESTROYED' ? '#e0625d' : '#ffffff';
      for (let i = 0; i < n; i++) {
        const ang = Math.random() * Math.PI * 2, sp = 0.6 + Math.random() * 1.7;
        tac.debris.push({ x: ev.p[0], y: ev.p[1], vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 0.4, color, born: now, life: 900 + Math.random() * 600 });
      }
    }
    const spec = FX_KIND_CN[ev.t] ?? null;
    if (!spec) continue;
    const amount = ev.v ? (ev.v.amount !== undefined ? ev.v.amount : ev.v.damage !== undefined ? ev.v.damage : ev.v.hp !== undefined ? ev.v.hp : '') : '';
    tac.eventFx.push({ x: ev.p[0], y: ev.p[1], kind: ev.t, text: spec.text + (amount !== '' ? amount : ''), color: spec.color, size: spec.size, born: now, seq: ++tac.fxSeq });
  }
  if (tac.eventFx.length > 80) tac.eventFx.splice(0, tac.eventFx.length - 80);
  if (tac.debris.length > 240) tac.debris.splice(0, tac.debris.length - 240);
}
/** 官方 shotCurve 移植：弹道抛物线（法向侧偏 + 弓高 + 起终点内收）。 */
export function shotCurveFx(a: any, b: any, cell: any) {
  const dx = b.sx - a.sx, dy = b.sy - a.sy, length = Math.hypot(dx, dy);
  if (!length) return null;
  const ux = dx / length, uy = dy / length, px = -uy, py = ux;
  const side = dx > 0 ? -1 : dx < 0 ? 1 : dy > 0 ? -1 : 1;
  const arcHeight = Math.min(cell * 0.8, length * 0.24);
  const arcNormalX = px * side, arcNormalY = py * side;
  const bowX = a.sx + arcNormalX * cell * 0.29 + ux * cell * 0.1, bowY = a.sy + arcNormalY * cell * 0.29 + uy * cell * 0.1;
  const startX = bowX + ux * cell * 0.08, startY = bowY + uy * cell * 0.08;
  const endX = b.sx - ux * cell * 0.2, endY = b.sy - uy * cell * 0.2;
  const controlX = (startX + endX) / 2 + px * arcHeight * side, controlY = (startY + endY) / 2 + py * arcHeight * side;
  return { startX, startY, controlX, controlY, endX, endY };
}
/** 官方 drawResolvedShot 移植：飞行弹丸 + 命中/未中特效（回放战斗可视化）。 */
function drawResolvedShotFx(ctx: any, a: any, b: any, cell: any, progress: any, hit: any) {
  const curve = shotCurveFx(a, b, cell); if (!curve) return;
  const flightEnd = 0.76, flight = Math.min(1, progress / flightEnd), eased = 1 - Math.pow(1 - flight, 3);
  const inv = 1 - eased;
  const x = inv * inv * curve.startX + 2 * inv * eased * curve.controlX + eased * eased * curve.endX;
  const y = inv * inv * curve.startY + 2 * inv * eased * curve.controlY + eased * eased * curve.endY;
  const tanX = 2 * inv * (curve.controlX - curve.startX) + 2 * eased * (curve.endX - curve.controlX);
  const tanY = 2 * inv * (curve.controlY - curve.startY) + 2 * eased * (curve.endY - curve.controlY);
  const tl = Math.hypot(tanX, tanY) || 1;
  const tx = tanX / tl, ty = tanY / tl, px = -ty, py = tx;
  const arrowLength = Math.max(12, cell * 0.3), head = Math.max(5, cell * 0.12);
  const tailX = x - tx * arrowLength, tailY = y - ty * arrowLength;
  const arrowOpacity = progress <= flightEnd ? 1 : Math.max(0, 1 - (progress - flightEnd) / (1 - flightEnd));
  ctx.save(); ctx.globalAlpha = arrowOpacity; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.shadowColor = '#69b3d8'; ctx.shadowBlur = Math.max(5, cell * 0.12);
  ctx.strokeStyle = '#69b3d8'; ctx.lineWidth = Math.max(2, cell * 0.045);
  ctx.beginPath(); ctx.moveTo(tailX, tailY); ctx.lineTo(x, y); ctx.stroke();
  ctx.fillStyle = '#a8d3ea';
  ctx.beginPath(); ctx.moveTo(x + tx * head * 0.25, y + ty * head * 0.25);
  ctx.lineTo(x - tx * head + px * head * 0.55, y - ty * head + py * head * 0.55);
  ctx.lineTo(x - tx * head - px * head * 0.55, y - ty * head - py * head * 0.55);
  ctx.closePath(); ctx.fill(); ctx.restore();
  if (progress < flightEnd) return;
  const impact = Math.min(1, (progress - flightEnd) / (1 - flightEnd)), fade = 1 - impact;
  ctx.save(); ctx.globalAlpha = fade; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(1.5, cell * 0.035);
  if (hit) {
    ctx.strokeStyle = '#e0625d'; ctx.shadowColor = '#e0625d'; ctx.shadowBlur = Math.max(5, cell * 0.11);
    const radius = cell * (0.1 + impact * 0.28);
    ctx.beginPath(); ctx.arc(b.sx, b.sy, radius, 0, Math.PI * 2); ctx.stroke();
    for (let k = 0; k < 4; k++) {
      const ang = Math.PI / 2 * k + Math.PI / 4, inner = radius * 0.35, outer = radius * 1.25;
      ctx.beginPath(); ctx.moveTo(b.sx + Math.cos(ang) * inner, b.sy + Math.sin(ang) * inner);
      ctx.lineTo(b.sx + Math.cos(ang) * outer, b.sy + Math.sin(ang) * outer); ctx.stroke();
    }
  } else {
    ctx.strokeStyle = '#d4d4d8'; ctx.setLineDash([Math.max(3, cell * 0.07), Math.max(2, cell * 0.05)]);
    ctx.beginPath(); ctx.arc(b.sx, b.sy, cell * (0.12 + impact * 0.22), 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}
/** 官方 drawResolvedSweep 移植：横扫剑光（VANGUARD 清扫回放可视化）。 */
function drawResolvedSweepFx(ctx: any, a: any, b: any, cell: any, progress: any) {
  const dx = b.sx - a.sx, dy = b.sy - a.sy, direction = Math.atan2(dy, dx);
  if (!Math.hypot(dx, dy)) return;
  const attackProgress = Math.min(1, progress / 0.72), eased = 1 - Math.pow(1 - attackProgress, 3);
  const fade = progress < 0.72 ? 1 : Math.max(0, 1 - (progress - 0.72) / 0.28);
  const startAngle = direction - Math.PI * 0.42, currentAngle = startAngle + Math.PI * 0.84 * eased;
  const radius = cell * 0.78, handleRadius = cell * 0.2, tipRadius = cell * 0.94;
  const handleX = a.sx + Math.cos(currentAngle) * handleRadius, handleY = a.sy + Math.sin(currentAngle) * handleRadius;
  const tipX = a.sx + Math.cos(currentAngle) * tipRadius, tipY = a.sy + Math.sin(currentAngle) * tipRadius;
  ctx.save(); ctx.globalAlpha = fade; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.shadowColor = '#69b3d8'; ctx.shadowBlur = cell * 0.14;
  ctx.strokeStyle = 'rgba(69,145,197,.34)'; ctx.lineWidth = Math.max(5, cell * 0.13);
  ctx.beginPath(); ctx.arc(a.sx, a.sy, radius, startAngle, currentAngle); ctx.stroke();
  ctx.strokeStyle = '#a8d3ea'; ctx.lineWidth = Math.max(1.5, cell * 0.035);
  ctx.beginPath(); ctx.arc(a.sx, a.sy, radius, startAngle, currentAngle); ctx.stroke();
  ctx.strokeStyle = '#f4f4f5'; ctx.lineWidth = Math.max(2.5, cell * 0.065);
  ctx.beginPath(); ctx.moveTo(handleX, handleY); ctx.lineTo(tipX, tipY); ctx.stroke();
  const guardX = handleX + Math.cos(currentAngle) * cell * 0.17, guardY = handleY + Math.sin(currentAngle) * cell * 0.17;
  const gpx = -Math.sin(currentAngle), gpy = Math.cos(currentAngle);
  ctx.beginPath(); ctx.moveTo(guardX - gpx * cell * 0.1, guardY - gpy * cell * 0.1);
  ctx.lineTo(guardX + gpx * cell * 0.1, guardY + gpy * cell * 0.1); ctx.stroke();
  if (progress > 0.42) {
    const impact = Math.min(1, (progress - 0.42) / 0.38);
    ctx.globalAlpha = fade * (1 - impact); ctx.strokeStyle = '#e0625d'; ctx.lineWidth = Math.max(1.5, cell * 0.04);
    ctx.beginPath(); ctx.arc(b.sx, b.sy, cell * (0.12 + impact * 0.28), 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}
export function drawEventFx(ctx: any, tac: any, project: any, ring: any, font: string, s: any, now: number) {
  if (!tac.eventFx.length) return;
  const alive = [];
  for (const fx of tac.eventFx) {
    const age = now - fx.born;
    const life = fx.life ?? FX_LIFE_MS;
    if (age > life) continue;
    alive.push(fx);
    const t = age / life;
    if (fx.kind === 'SHOT' && fx.from && fx.to) {
      drawResolvedShotFx(ctx, project(fx.from[0], fx.from[1]), project(fx.to[0], fx.to[1]), s, Math.min(1, t * 1.1), fx.hit === true);
      continue;
    }
    if (fx.kind === 'SWEEP' && fx.from && fx.to) {
      drawResolvedSweepFx(ctx, project(fx.from[0], fx.from[1]), project(fx.to[0], fx.to[1]), s, Math.min(1, t * 1.15));
      continue;
    }
    const fade = 1 - t * t;
    const p = project(fx.x, fx.y);
    ctx.save();
    ctx.globalAlpha = Math.max(0, fade);
    ctx.fillStyle = fx.color;
    ctx.font = '700 ' + fx.size + 'px ' + font;
    ctx.textAlign = 'center';
    ctx.shadowColor = fx.color; ctx.shadowBlur = 8;
    ctx.fillText(fx.text, p.sx, p.sy - t * 26 - 10);
    ctx.restore();
    if (fx.kind === 'CORE_DESTROYED') {
      ctx.save();
      ctx.globalAlpha = Math.max(0, fade * 0.6);
      ring(p.sx, p.sy, 16 + t * 30, fx.color, 2.5);
      ctx.restore();
    }
  }
  tac.eventFx = alive;
  // 销毁碎片（外抛 + 重力 + 淡出）
  if (tac.debris.length) {
    const now2 = now;
    const aliveD = [];
    for (const d of tac.debris) {
      const age = now2 - d.born;
      if (age > d.life) continue;
      aliveD.push(d);
      const t = age / d.life;
      const x = d.x + d.vx * t * 6, y = d.y + d.vy * t * 6 + 2.2 * t * t;
      const p = project(x, y);
      const sz = Math.max(1.5, s * 0.16 * (1 - t));
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t) * 0.9;
      ctx.fillStyle = d.color;
      ctx.shadowColor = d.color; ctx.shadowBlur = 6;
      ctx.fillRect(p.sx - sz / 2, p.sy - sz / 2, sz, sz);
      ctx.restore();
    }
    tac.debris = aliveD;
  }
}
