/* Arena 指挥面板前端 — 零依赖原生 JS + Canvas（官方素材渲染） */
const TENANTS = ['t1', 't2', 't3', 't4'];
const TENANT_COLORS = { t1: '#4591c5', t2: '#76b889', t3: '#a58bd6', t4: '#c66370' };
const TENANT_LABEL = { t1: '租户 1', t2: '租户 2', t3: '租户 3', t4: '租户 4' };
const POLL_MS = 3000;
const SPRITE = {
  core: '/assets/game/units/core.png',
  worker: '/assets/game/units/worker.png',
  vanguard: '/assets/game/units/vanguard.png',
  ranger: '/assets/game/units/ranger.png',
  crystal: ['/assets/game/resources/crystal-1.png', '/assets/game/resources/crystal-2.png'],
  obstacle: ['/assets/game/obstacles/asteroid-large-1.png', '/assets/game/obstacles/asteroid-large-2.png'],
  beacon: '/assets/game/beacon.png',
};
const UNIT_ICONS = { resource: '/assets/ui/icons/resource.png', population: '/assets/ui/icons/population.png' };
const DECISION_KIND_CN = {
  accepted: '接受', rejected: '拒绝', timeout: '超时', missed: '错过', aborted: '中止',
  not_applicable: '不适用', in_progress: '进行中', unknown: '未知',
};

const state = {
  map: null,
  overview: null,
  streams: {},          // tenant -> rows
  events: {},           // tenant -> events
  view: { cx: 0, cy: 0, scale: 8, ready: false },
  layers: { obstacle: true, resource: true, unit: true, core: true, beacon: true },
  tenantsOn: { t1: true, t2: true, t3: true, t4: true },
  soloTenant: null,     // null=全局联盟；'t1'..'t4'=单租户
  tab: 'all',           // all | t1 | t2 | t3 | t4 | events
  cellIndex: new Map(),
  cells: [],
  beacons: [],
  bounds: null,
  lastRefresh: 0,
  drag: null,
  hover: null,
};

const $ = (sel) => document.querySelector(sel);
const els = {
  canvas: $('#map'), clock: $('#clock'), dataRoot: $('#dataRoot'), badge: $('#refreshBadge'),
  tenantCards: $('#tenantCards'), legendList: $('#legendList'), tenantToggles: $('#tenantToggles'),
  streamTabs: $('#streamTabs'), streamBody: $('#streamBody'),
  tooltip: $('#mapTooltip'), hint: $('#mapHint'),
  redeemBtn: $('#redeemBtn'), redeemDialog: $('#redeemDialog'), redeemClose: $('#redeemClose'),
  redeemResult: $('#redeemResult'), redeemHistory: $('#redeemHistory'),
  shopCookie: $('#shopCookie'), cookieSave: $('#cookieSave'), cookieTest: $('#cookieTest'),
  shopAccount: $('#shopAccount'), shopList: $('#shopList'),
  viewGlobal: $('#viewGlobal'), viewFit: $('#viewFit'),
};

const ctx = els.canvas.getContext('2d');
const images = {};

function hash2(a, b, salt) {
  let h = (Math.imul(a + salt * 7919, 73856093) ^ Math.imul(b + salt * 104729, 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return (h ^ (h >>> 13)) >>> 0;
}
function fmt(n, digits = 0) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: digits });
  return n.toFixed(digits);
}
function shortId(id) { return id ? String(id).slice(0, 8) : '—'; }
function ageText(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
const timeFmt = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/* ---------- 素材加载 ---------- */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('load failed ' + url));
    img.src = url;
  });
}
async function loadSprites() {
  const urls = [SPRITE.core, SPRITE.worker, SPRITE.vanguard, SPRITE.ranger,
    ...SPRITE.crystal, ...SPRITE.obstacle, SPRITE.beacon,
    UNIT_ICONS.resource, UNIT_ICONS.population];
  const results = await Promise.allSettled(urls.map(loadImage));
  [SPRITE.core, SPRITE.worker, SPRITE.vanguard, SPRITE.ranger].forEach((u, i) => { if (results[i].status === 'fulfilled') images[u] = results[i].value; });
  SPRITE.crystal.forEach((u, i) => { if (results[i + 4].status === 'fulfilled') images[u] = results[i + 4].value; });
  SPRITE.obstacle.forEach((u, i) => { if (results[i + 6].status === 'fulfilled') images[u] = results[i + 6].value; });
  if (results[8].status === 'fulfilled') images[SPRITE.beacon] = results[8].value;
  [UNIT_ICONS.resource, UNIT_ICONS.population].forEach((u, i) => { if (results[i + 9].status === 'fulfilled') images[u] = results[i + 9].value; });
}

/* ---------- 数据拉取 ---------- */
async function getJSON(url, timeout = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function poll() {
  try {
    const [overview, map] = await Promise.all([
      getJSON('/api/overview'), getJSON('/api/map'),
    ]);
    state.overview = overview;
    state.map = map;
    state.cells = map.cells ?? [];
    state.beacons = map.beacons ?? [];
    state.bounds = map.bounds ?? null;
    state.cellIndex = new Map();
    for (const c of state.cells) state.cellIndex.set(`${c.x},${c.y}`, c);
    if (overview?.dataRoot) els.dataRoot.textContent = overview.dataRoot;
    if (!state.view.ready && state.bounds && state.cells.length) fitView();
    renderTenantCards();
    renderTenantToggles();
    if (!state.view.ready) draw();
  } catch (err) {
    els.badge.className = 'badge err';
    els.badge.textContent = '数据离线';
    console.warn('poll failed', err);
  }
}

async function pollStreams() {
  const active = state.tab === 'all' ? TENANTS : state.tab === 'events' ? [] : [state.tab];
  if (state.tab === 'events') {
    const results = await Promise.allSettled(TENANTS.map((t) => getJSON(`/api/events?tenant=${t}&n=80`)));
    state.events = {};
    results.forEach((r, i) => { if (r.status === 'fulfilled') state.events[TENANTS[i]] = r.value.events ?? []; });
  } else {
    const results = await Promise.allSettled(active.map((t) => getJSON(`/api/stream?tenant=${t}&n=80`)));
    results.forEach((r, i) => { if (r.status === 'fulfilled') state.streams[active[i]] = r.value.rows ?? []; });
  }
  renderStream();
}

/* ---------- 地图投影 / 交互 ---------- */
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = els.canvas.getBoundingClientRect();
  els.canvas.width = Math.max(1, Math.round(rect.width * dpr));
  els.canvas.height = Math.max(1, Math.round(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function W() { return els.canvas.getBoundingClientRect().width; }
function H() { return els.canvas.getBoundingClientRect().height; }

function fitView() {
  if (!state.bounds || !state.cells.length) return;
  const b = state.bounds;
  const w = Math.max(1, W()), h = Math.max(1, H());
  const pad = 24;
  const spanX = Math.max(1, b.maxX - b.minX + 2);
  const spanY = Math.max(1, b.maxY - b.minY + 2);
  const scale = Math.min(w / spanX, h / spanY);
  state.view = {
    cx: (b.minX + b.maxX) / 2,
    cy: (b.minY + b.maxY) / 2,
    scale: Math.min(64, Math.max(0.05, scale)),
    ready: true,
  };
  draw();
}
function fitSolo(tenant) {
  // 只按该租户已测绘的 cells（障碍/资源/单位/核心）自适应；信标在远处时以边缘指示显示，不撑爆核心区
  const cells = state.cells.filter((c) => c.tenant === tenant);
  if (!cells.length) return;
  const pts = cells.map((c) => [c.x, c.y]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const b = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  const w = Math.max(1, W()), h = Math.max(1, H());
  const spanX = Math.max(1, b.maxX - b.minX + 2), spanY = Math.max(1, b.maxY - b.minY + 2);
  const scale = Math.min(w / spanX, h / spanY);
  state.view = { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: Math.min(64, Math.max(0.05, scale)), ready: true };
  draw();
}
function project(x, y) {
  return { sx: (x - state.view.cx) * state.view.scale + W() / 2, sy: (y - state.view.cy) * state.view.scale + H() / 2 };
}
function visibleCells() {
  const cx = state.view.cx, cy = state.view.cy, s = state.view.scale;
  const vw = W() / 2 / s + 2, vh = H() / 2 / s + 2;
  return state.cells.filter((c) =>
    Math.abs(c.x - cx) <= vw && Math.abs(c.y - cy) <= vh &&
    state.tenantsOn[c.tenant] !== false && (state.soloTenant === null || c.tenant === state.soloTenant) &&
    state.layers[c.type] !== false);
}

/* ---------- 渲染 ---------- */
function draw() {
  const w = W(), h = H();
  ctx.clearRect(0, 0, w, h);
  drawGrid(w, h);
  const s = state.view.scale;
  const drawCells = visibleCells();
  const buckets = { obstacle: [], resource: [], unit: [], core: [] };
  for (const c of drawCells) if (buckets[c.type]) buckets[c.type].push(c);
  drawObstacles(buckets.obstacle, s);
  drawResources(buckets.resource, s);
  drawUnits(buckets.unit, s);
  drawCores(buckets.core, s);
  drawBeacons(s);
  if (!state.cells.length) {
    ctx.fillStyle = '#56626c'; ctx.font = '13px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('等待测绘数据…', w / 2, h / 2);
  }
}
function drawGrid(w, h) {
  ctx.strokeStyle = 'rgba(104,117,167,.08)';
  ctx.lineWidth = 1;
  const step = 32 / state.view.scale;
  if (step < 4) return;
  const startX = Math.floor((state.view.cx - w / 2 / state.view.scale) / step) * step;
  const startY = Math.floor((state.view.cy - h / 2 / state.view.scale) / step) * step;
  ctx.beginPath();
  for (let x = startX; x <= state.view.cx + w / 2 / state.view.scale; x += step) {
    const p = project(x, state.view.cy - h / 2 / state.view.scale);
    ctx.moveTo(p.sx, 0); ctx.lineTo(p.sx, h);
  }
  for (let y = startY; y <= state.view.cy + h / 2 / state.view.scale; y += step) {
    const p = project(state.view.cx - w / 2 / state.view.scale, y);
    ctx.moveTo(0, p.sy); ctx.lineTo(w, p.sy);
  }
  ctx.stroke();
}
function sprite(img, sx, sy, size) {
  if (!img) return;
  const dw = size, dh = size * (img.height / Math.max(1, img.width));
  ctx.drawImage(img, sx - dw / 2, sy - dh / 2, dw, dh);
}
/** 石头：低缩放批量实心格（一次 path，性能好、看得清）；高缩放用官方 asteroid 素材 */
function drawObstacles(cells, s) {
  if (!cells.length) return;
  if (s >= 8) {
    for (const c of cells) {
      const p = project(c.x, c.y);
      const path = SPRITE.obstacle[hash2(c.x, c.y, 7) % SPRITE.obstacle.length];
      if (images[path]) sprite(images[path], p.sx, p.sy, s * 0.86);
      else { ctx.fillStyle = '#4a525a'; roundRect(p.sx - s / 2, p.sy - s / 2, s, s, 3); }
    }
    return;
  }
  const cell = Math.max(2, s);
  ctx.fillStyle = '#454c54';
  ctx.beginPath();
  for (const c of cells) {
    const p = project(c.x, c.y);
    ctx.rect(p.sx - cell / 2, p.sy - cell / 2, cell, cell);
  }
  ctx.fill();
  ctx.strokeStyle = 'rgba(139,183,212,.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
}
/** 矿物：始终可见；高缩放 crystal 素材 + 绿色发光，低缩放亮点 */
function drawResources(cells, s) {
  if (!cells.length) return;
  if (s >= 6) {
    ctx.save();
    ctx.shadowColor = 'rgba(118,184,137,.6)';
    ctx.shadowBlur = 8;
    for (const c of cells) {
      const p = project(c.x, c.y);
      const path = SPRITE.crystal[hash2(c.x, c.y, 13) % SPRITE.crystal.length];
      if (images[path]) sprite(images[path], p.sx, p.sy, Math.max(7, s * 0.92));
      else { ctx.fillStyle = '#76b889'; ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(2.5, s * 0.3), 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore();
    return;
  }
  ctx.fillStyle = 'rgba(118,184,137,.85)';
  ctx.beginPath();
  for (const c of cells) {
    const p = project(c.x, c.y);
    ctx.arc(p.sx, p.sy, Math.max(1.6, s * 0.32), 0, Math.PI * 2);
  }
  ctx.fill();
}
function unitSpritePath(type) {
  if (type === 'VANGUARD') return SPRITE.vanguard;
  if (type === 'RANGER') return SPRITE.ranger;
  return SPRITE.worker;
}
function ring(x, y, r, color, width = 1.5, dash = []) {
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
}
/** 单位：高缩放素材+色环；低缩放紧凑租户色圆点（不放大图标遮挡地图） */
function drawUnits(cells, s) {
  if (!cells.length) return;
  if (s >= 6) {
    for (const c of cells) {
      const p = project(c.x, c.y);
      const size = s * (c.unitType === 'RANGER' ? 0.68 : 0.62);
      const color = TENANT_COLORS[c.tenant] ?? '#999';
      ring(p.sx, p.sy, size * 0.72, c.controlled ? color : 'rgba(150,160,170,.45)', c.controlled ? 1.8 : 1.2, c.controlled ? [] : [3, 3]);
      const path = unitSpritePath(c.unitType);
      if (images[path]) sprite(images[path], p.sx, p.sy, size);
      else {
        ctx.fillStyle = c.controlled ? color : '#7c858d';
        ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(2, size * 0.25), 0, Math.PI * 2); ctx.fill();
      }
    }
    return;
  }
  for (const c of cells) {
    const p = project(c.x, c.y);
    const color = TENANT_COLORS[c.tenant] ?? '#999';
    ctx.fillStyle = c.controlled ? color : 'rgba(150,160,170,.55)';
    ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(1.8, s * 0.42), 0, Math.PI * 2); ctx.fill();
    if (c.controlled) { ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1; ctx.stroke(); }
  }
}
/** 核心：高缩放素材+光环+HP条；低缩放租户色大点+白描边 */
function drawCores(cells, s) {
  if (!cells.length) return;
  if (s >= 6) {
    for (const c of cells) drawCoreSprite(c, s);
    return;
  }
  for (const c of cells) {
    const p = project(c.x, c.y);
    const color = TENANT_COLORS[c.tenant] ?? '#999';
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(3, s * 0.6), 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1.2; ctx.stroke();
  }
}
function drawCoreSprite(c, s) {
  const p = project(c.x, c.y);
  const size = s * 0.72;
  const color = TENANT_COLORS[c.tenant] ?? '#999';
  ctx.shadowColor = color; ctx.shadowBlur = 12;
  if (images[SPRITE.core]) sprite(images[SPRITE.core], p.sx, p.sy, size);
  else {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(3, size * 0.3), 0, Math.PI * 2); ctx.fill();
  }
  ctx.shadowBlur = 0;
  ring(p.sx, p.sy, size * 0.62, color, 2);
  if (typeof c.hp === 'number') {
    const bw = Math.max(14, size * 1.1), bh = 3;
    const bx = p.sx - bw / 2, by = p.sy + size * 0.62 + 4;
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = c.hp > 3 ? '#76b889' : c.hp > 1 ? '#d8b64e' : '#c66370';
    ctx.fillRect(bx, by, bw * Math.max(0, Math.min(1, c.hp / 5)), bh);
  }
}
/** 信标：视野内脉冲；视野外屏幕边缘方向指示（不撑爆自适应） */
function drawBeacons(s) {
  for (const b of state.beacons) {
    if (state.tenantsOn[b.tenant] === false) continue;
    if (state.soloTenant !== null && b.tenant !== state.soloTenant) continue;
    const p = project(b.x, b.y);
    const w = W(), h = H();
    if (p.sx < -70 || p.sx > w + 70 || p.sy < -70 || p.sy > h + 70) { drawEdgeBeacon(b, p); continue; }
    const size = Math.max(14, s * (b.status === 'CARRIED' ? 0.58 : 0.98));
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 420);
    ring(p.sx, p.sy, size * 0.9, `rgba(224,185,79,${0.25 + 0.35 * pulse})`, 2);
    if (images[SPRITE.beacon]) sprite(images[SPRITE.beacon], p.sx, p.sy, size);
    else {
      ctx.fillStyle = '#e0b94f';
      ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(3, size * 0.3), 0, Math.PI * 2); ctx.fill();
    }
  }
}
function drawEdgeBeacon(b, p) {
  const w = W(), h = H();
  const cx = w / 2, cy = h / 2;
  const dx = p.sx - cx, dy = p.sy - cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const margin = 36;
  const k = Math.min((w / 2 - margin) / Math.abs(ux || 1e-9), (h / 2 - margin) / Math.abs(uy || 1e-9));
  const ex = cx + ux * k, ey = cy + uy * k;
  const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);
  ctx.fillStyle = `rgba(224,185,79,${0.4 + 0.45 * pulse})`;
  ctx.beginPath(); ctx.arc(ex, ey, 5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(224,185,79,.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(cx + ux * 12, cy + uy * 12); ctx.lineTo(ex - ux * 4, ey - uy * 4); ctx.stroke();
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath(); ctx.fill();
}

/* ---------- 悬浮提示 ---------- */
function nearestCell(px, py) {
  let best = null, bestD = Infinity;
  for (const c of visibleCells()) {
    const p = project(c.x, c.y);
    const d = Math.hypot(px - p.sx, py - p.sy);
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= Math.max(18, state.view.scale) ? best : null;
}
function showTooltip(px, py, cell) {
  if (!cell) { els.tooltip.hidden = true; return; }
  const color = TENANT_COLORS[cell.tenant] ?? '#999';
  const lines = [];
  const head = cell.type === 'obstacle' ? '障碍' : cell.type === 'resource' ? '资源' : cell.type === 'core' ? '核心' : '单位';
  lines.push(`<div class="tt-title" style="color:${color}">${head} · ${cell.tenant.toUpperCase()}</div>`);
  lines.push(`<div class="tt-row"><span>坐标</span><b>${cell.x}, ${cell.y}</b></div>`);
  lines.push(`<div class="tt-row"><span>tick</span><b>${fmt(cell.tick)}</b></div>`);
  if (cell.type === 'unit') {
    lines.push(`<div class="tt-row"><span>类型</span><b>${cell.unitType ?? '—'}</b></div>`);
    lines.push(`<div class="tt-row"><span>HP</span><b>${fmt(cell.hp)}</b></div>`);
    if (cell.cargo > 0) lines.push(`<div class="tt-row"><span>载货</span><b>${fmt(cell.cargo)}</b></div>`);
    lines.push(`<div class="tt-row"><span>归属</span><b>${cell.controlled ? '我方' : '敌方'}</b></div>`);
  }
  if (cell.type === 'core') {
    lines.push(`<div class="tt-row"><span>HP / 盾</span><b>${fmt(cell.hp)} / ${fmt(cell.shield)}</b></div>`);
    lines.push(`<div class="tt-row"><span>控制</span><b>${cell.controlled ? '我方' : '敌方'}</b></div>`);
    if (cell.owner) lines.push(`<div class="tt-row"><span>拥有者</span><b>${cell.owner}</b></div>`);
  }
  if (cell.id) lines.push(`<div class="tt-row"><span>ID</span><b>${shortId(cell.id)}</b></div>`);
  els.tooltip.innerHTML = lines.join('');
  els.tooltip.hidden = false;
  const tw = els.tooltip.offsetWidth, th = els.tooltip.offsetHeight;
  const rect = els.canvas.getBoundingClientRect();
  let left = px + 14, top = py + 14;
  if (left + tw > rect.width - 8) left = px - tw - 14;
  if (top + th > rect.height - 8) top = py - th - 14;
  els.tooltip.style.left = `${left}px`;
  els.tooltip.style.top = `${top}px`;
}

/* ---------- 租户卡片 ---------- */
function statusOf(t) {
  const s = state.overview?.tenants?.find((x) => x.tenant === t);
  if (!s) return { cls: 'stale', label: '无数据' };
  if (s.live) return { cls: 'live', label: '在线' };
  if (s.fileFresh) return { cls: 'fresh', label: '数据新鲜' };
  return { cls: 'stale', label: '离线' };
}
function renderTenantCards() {
  if (!state.overview) return;
  const html = state.overview.tenants.map((t) => {
    const color = TENANT_COLORS[t.tenant] ?? '#999';
    const st = statusOf(t.tenant);
    const L = t.latest ?? {};
    const delta = typeof L.resourceDelta === 'number' ? L.resourceDelta : null;
    const deltaCls = delta === null ? '' : delta > 0 ? 'delta-pos' : delta < 0 ? 'delta-neg' : '';
    const deltaTxt = delta === null ? '—' : (delta > 0 ? '+' : '') + fmt(delta);
    const solo = state.soloTenant === t.tenant;
    return `<div class="tenant-card${solo ? ' solo' : ''}" data-tenant="${t.tenant}" style="--tc:${color}" role="button" tabindex="0">
      <div class="row1">
        <span class="dot ${st.cls}" title="${st.label}"></span>
        <span class="tenant-name">${t.tenant.toUpperCase()}</span>
        <span class="tenant-tag">${TENANT_LABEL[t.tenant] ?? ''}</span>
      </div>
      <div class="metrics">
        <div class="metric"><img src="${UNIT_ICONS.resource}" alt="" /><span class="v">${fmt(L.resources)}</span><span class="k">资源</span></div>
        <div class="metric"><span class="v ${deltaCls}">${deltaTxt}</span><span class="k">增量</span></div>
        <div class="metric"><img src="${UNIT_ICONS.population}" alt="" /><span class="v">${fmt(L.workers)}</span><span class="k">工人</span></div>
        <div class="metric"><span class="v">${fmt(L.events)}</span><span class="k">事件</span></div>
      </div>
      <div class="row3">
        <span>tick <b>${fmt(L.tick)}</b></span>
        <span>最大距离 <b>${fmt(L.workerMaxDistance)}</b></span>
        <span>均值 <b>${fmt(L.workerMeanDistance)}</b></span>
        <span>可见资源 <b>${fmt(L.visibleResources)}</b></span>
        <span>60tick均值 <b>${fmt(t.window?.avgResources)}</b></span>
      </div>
    </div>`;
  }).join('');
  els.tenantCards.innerHTML = html;
  // 点击事件用容器委托（见 bindEvents），避免 poll 重建 DOM 时丢失/重复绑定
}
function renderTenantToggles() {
  els.tenantToggles.innerHTML = TENANTS.map((t) =>
    `<label><input type="checkbox" data-tenant="${t}" ${state.tenantsOn[t] ? 'checked' : ''} /><span style="color:${TENANT_COLORS[t]}">${t.toUpperCase()}</span></label>`
  ).join('');
}
function toggleSolo(tenant) {
  state.soloTenant = state.soloTenant === tenant ? null : tenant;
  if (state.soloTenant) fitSolo(state.soloTenant);
  else fitView();
  renderTenantCards();
  const global = state.soloTenant === null;
  els.viewGlobal.classList.toggle('active', global);
}

/* ---------- 决策流 ---------- */
function renderStream() {
  const tabs = [{ id: 'all', label: '统一决策' }];
  TENANTS.forEach((t) => tabs.push({ id: t, label: t.toUpperCase() }));
  tabs.push({ id: 'events', label: '事件' });
  els.streamTabs.innerHTML = tabs.map((t) =>
    `<button data-tab="${t.id}" class="${state.tab === t.id ? 'active' : ''}" role="tab">${t.label}</button>`).join('');
  els.streamTabs.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => { state.tab = b.dataset.tab; pollStreams(); }));

  if (state.tab === 'events') {
    const all = [];
    for (const t of TENANTS) for (const ev of state.events[t] ?? []) all.push({ tenant: t, ...ev });
    all.sort((a, b) => (b.tick ?? 0) - (a.tick ?? 0));
    if (!all.length) { els.streamBody.innerHTML = '<div class="stream-empty">暂无事件数据</div>'; return; }
    els.streamBody.innerHTML = all.slice(0, 120).map((e) => {
      const color = TENANT_COLORS[e.tenant] ?? '#999';
      const evColor = e.kind.startsWith('SHOT') || e.kind.includes('DESTROYED') || e.kind.includes('FAILED') ? '#c66370'
        : e.kind.includes('SUCCEEDED') || e.kind === 'SPAWN' || e.kind === 'PICKUP_BEACON' || e.kind === 'HEAL' ? '#76b889' : '#d8b64e';
      const detail = [e.actor ? `actor ${shortId(e.actor)}` : '', e.target ? `target ${shortId(e.target)}` : '', e.amount != null ? `×${e.amount}` : ''].filter(Boolean).join(' ');
      return `<div class="stream-line" style="--tc:${color}">
        <span class="st-tenant">${e.tenant.toUpperCase()}</span>
        <span class="st-tick">${fmt(e.tick)}</span>
        <span class="st-kind" style="color:${evColor}">${e.kind}</span>
        <span class="st-detail">${detail}</span>
      </div>`;
    }).join('');
    return;
  }
  const rows = [];
  for (const t of (state.tab === 'all' ? TENANTS : [state.tab])) {
    for (const r of state.streams[t] ?? []) rows.push({ tenant: t, ...r });
  }
  rows.sort((a, b) => (b.tick ?? 0) - (a.tick ?? 0));
  if (!rows.length) { els.streamBody.innerHTML = '<div class="stream-empty">暂无决策数据</div>'; return; }
  els.streamBody.innerHTML = rows.slice(0, 120).map((r) => {
    const color = TENANT_COLORS[r.tenant] ?? '#999';
    const outcome = String(r.deadlineOutcome ?? '');
    const submit = String(r.submitResult ?? '');
    const outCls = submit === 'accepted' ? 'accepted' : submit === 'rejected' ? 'rejected' : (outcome.includes('timeout') || outcome.includes('missed')) ? 'timeout' : '';
    const badge = submit !== '' ? submit : outcome !== '' ? outcome : '—';
    const lat = [];
    if (r.agentLatencyMs != null) lat.push(`agent ${fmt(r.agentLatencyMs)}ms`);
    if (r.selectionLatencyMs != null) lat.push(`select ${fmt(r.selectionLatencyMs)}ms`);
    const extra = [];
    if (r.abortRequested) extra.push('中止请求');
    if (r.rotationGeneration != null) extra.push(`rot ${r.rotationGeneration}`);
    const detail = [lat.join(' · '), extra.join(' · ')].filter(Boolean).join(' · ');
    return `<div class="stream-line" style="--tc:${color}">
      <span class="st-tenant">${r.tenant.toUpperCase()}</span>
      <span class="st-tick">${fmt(r.tick)}</span>
      <span class="st-kind" style="color:${color}">${outcome !== '' ? outcome.replace(/_/g, ' ') : 'decision'}</span>
      <span class="st-detail">${detail}</span>
      <span class="st-badge ${outCls}">${badge}</span>
    </div>`;
  }).join('');
}

/* ---------- 顶部状态 ---------- */
function tickClock() {
  els.clock.textContent = timeFmt.format(new Date());
}
function markRefresh(ok) {
  els.badge.className = ok ? 'badge ok' : 'badge err';
  els.badge.textContent = ok ? '实时' : '离线';
}

/* ---------- 官方商店 / 兑换码 ---------- */
const SHOP_COOKIE_KEY = 'arena-cc.shop-cookie';
function shopCookieValue() { return (localStorage.getItem(SHOP_COOKIE_KEY) ?? '').trim(); }
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function shopRequest(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  const cookie = shopCookieValue();
  if (cookie) headers.set('X-Shop-Cookie', cookie);
  const res = await fetch(path, { ...options, headers, cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? data.message ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}
async function openRedeem() {
  els.redeemDialog.showModal();
  els.shopCookie.value = shopCookieValue();
  showRedeemResult('', '');
  els.redeemResult.hidden = true;
  renderRedeemHistory();
  await refreshShop();
  if (shopCookieValue()) await refreshAccount();
}
async function refreshShop() {
  els.shopList.innerHTML = '<div class="stream-empty">加载官方商品…</div>';
  try {
    const data = await shopRequest('/api/shop');
    renderShopItems(data.products ?? []);
  } catch (err) {
    els.shopList.innerHTML = `<div class="stream-empty">加载官方商品失败：${escapeHtml(err.message)}</div>`;
  }
}
function renderShopItems(products) {
  if (!products.length) { els.shopList.innerHTML = '<div class="stream-empty">官方商店暂无商品</div>'; return; }
  els.shopList.innerHTML = products.map((p) => {
    const out = p.available_stock <= 0;
    const desc = (p.description ?? '').trim();
    return `<div class="shop-item">
      <div class="si-main">
        <div class="si-name">${escapeHtml(p.name ?? '未命名商品')}</div>
        ${desc ? `<div class="si-desc">${escapeHtml(desc)}</div>` : ''}
        <div class="si-meta">
          <span class="cost">${p.resource_cost} Core</span>
          <span class="${out ? 'stock-out' : ''}">${out ? '已售罄' : `剩余 ${p.available_stock}`}</span>
          ${p.purchase_limit > 0 ? `<span>每人限购 ${p.purchase_limit} 件</span>` : ''}
        </div>
      </div>
      <button type="button" class="btn primary si-btn" data-product="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name ?? '')}" data-cost="${p.resource_cost}" ${out ? 'disabled' : ''}>兑换</button>
    </div>`;
  }).join('');
  els.shopList.querySelectorAll('button[data-product]').forEach((b) => {
    b.addEventListener('click', () => redeemProduct(b.dataset.product, b.dataset.name, Number(b.dataset.cost)));
  });
}
async function refreshAccount() {
  if (!shopCookieValue()) { els.shopAccount.hidden = true; return; }
  try {
    const me = await shopRequest('/api/shop/me');
    els.shopAccount.hidden = false;
    els.shopAccount.innerHTML = `
      <span class="acc-name">@${escapeHtml(me.username ?? '?')}</span>
      <span class="acc-res"><img src="${UNIT_ICONS.resource}" alt="" width="16" height="16" /><strong>${fmt(me.resources)}</strong><small>&nbsp;/ ${fmt(me.resource_capacity)} Core 资源</small></span>`;
    await renderOrders();
  } catch (err) {
    els.shopAccount.hidden = false;
    els.shopAccount.innerHTML = `<span class="acc-err">连接失败：${escapeHtml(err.message)}（Cookie 可能已失效）</span>`;
  }
}
async function renderOrders() {
  try {
    const data = await shopRequest('/api/shop/orders');
    const orders = data.orders ?? [];
    els.redeemHistory.innerHTML = orders.length
      ? orders.slice(0, 12).map((o) => `<li><span class="h-time">${escapeHtml(o.product_name ?? '')}</span><span>${escapeHtml(o.status ?? '')}</span><span class="h-status">${new Date(o.created_at).toLocaleString('zh-CN', { hour12: false })}</span></li>`).join('')
      : '<li style="color:#56626c">暂无兑换订单</li>';
  } catch (err) {
    els.redeemHistory.innerHTML = `<li style="color:#c66370">订单加载失败：${escapeHtml(err.message)}</li>`;
  }
}
async function redeemProduct(id, name, cost) {
  if (!shopCookieValue()) { showRedeemResult('err', '请先粘贴并保存官方商店 Cookie'); return; }
  if (!window.confirm(`确认使用 ${cost} 个 Core 资源兑换「${name}」？\n\n库存与资源同时满足时才扣款。`)) return;
  showRedeemResult('pending', '正在提交兑换…');
  try {
    const data = await shopRequest('/api/shop/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: id }),
    });
    const status = data.status ?? 'PENDING';
    if (status === 'COMPLETED') {
      showRedeemResult('ok', `兑换成功！订单状态：${status}`);
    } else {
      showRedeemResult('pending', `订单已提交（${status}），正在确认扣款，可在账户页查看进度。`);
    }
    await refreshAccount();
  } catch (err) {
    showRedeemResult('err', `兑换失败：${escapeHtml(err.message)}`);
  }
}
function showRedeemResult(cls, msg) {
  els.redeemResult.className = `redeem-result ${cls}`;
  els.redeemResult.textContent = msg;
  els.redeemResult.hidden = false;
}
function saveShopCookie() {
  const v = els.shopCookie.value.trim();
  if (!v) { showRedeemResult('err', 'Cookie 不能为空'); return; }
  localStorage.setItem(SHOP_COOKIE_KEY, v);
  showRedeemResult('pending', 'Cookie 已保存（仅本机浏览器）。正在连接官方商店…');
  refreshAccount();
}
function renderRedeemHistory() {
  const list = JSON.parse(localStorage.getItem('arena-cc.redeem-history') ?? '[]');
  els.redeemHistory.innerHTML = list.length
    ? list.map((h) => `<li><span class="h-time">${new Date(h.at).toLocaleTimeString('zh-CN', { hour12: false })}</span><span>${escapeHtml(h.code)}</span><span class="h-status">${escapeHtml(h.status)}</span></li>`).join('')
    : '<li style="color:#56626c">暂无本地记录</li>';
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  // 地图交互
  els.canvas.addEventListener('pointerdown', (e) => {
    els.canvas.setPointerCapture(e.pointerId);
    state.drag = { x: e.clientX, y: e.clientY, cx: state.view.cx, cy: state.view.cy };
  });
  let hoverTimer = null;
  els.canvas.addEventListener('pointermove', (e) => {
    const rect = els.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    if (state.drag) {
      const dx = (e.clientX - state.drag.x) / state.view.scale;
      const dy = (e.clientY - state.drag.y) / state.view.scale;
      state.view.cx = state.drag.cx - dx;
      state.view.cy = state.drag.cy - dy;
      draw();
      return;
    }
    // hover 提示节流，避免 mousemove 高频全量计算卡顿
    if (hoverTimer !== null) return;
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      showTooltip(px, py, nearestCell(px, py));
    }, 40);
  });
  const endDrag = (e) => { if (state.drag) { state.drag = null; } };
  els.canvas.addEventListener('pointerup', endDrag);
  els.canvas.addEventListener('pointercancel', endDrag);
  els.canvas.addEventListener('pointerleave', () => { els.tooltip.hidden = true; });
  els.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = els.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0012);
    const ns = Math.min(64, Math.max(0.05, state.view.scale * factor));
    const wx = state.view.cx + (px - rect.width / 2) / state.view.scale;
    const wy = state.view.cy + (py - rect.height / 2) / state.view.scale;
    state.view.scale = ns;
    state.view.cx = wx - (px - rect.width / 2) / ns;
    state.view.cy = wy - (py - rect.height / 2) / ns;
    draw();
  }, { passive: false });
  els.canvas.addEventListener('dblclick', () => { state.soloTenant ? fitSolo(state.soloTenant) : fitView(); });
  $('#zoomIn').addEventListener('click', () => zoomAt(1.5));
  $('#zoomOut').addEventListener('click', () => zoomAt(1 / 1.5));
  $('#fitBtn').addEventListener('click', () => { state.soloTenant ? fitSolo(state.soloTenant) : fitView(); });
  function zoomAt(factor) {
    const rect = els.canvas.getBoundingClientRect();
    const px = rect.width / 2, py = rect.height / 2;
    const ns = Math.min(64, Math.max(0.05, state.view.scale * factor));
    const wx = state.view.cx + (px - rect.width / 2) / state.view.scale;
    const wy = state.view.cy + (py - rect.height / 2) / state.view.scale;
    state.view.scale = ns;
    state.view.cx = wx - (px - rect.width / 2) / ns;
    state.view.cy = wy - (py - rect.height / 2) / ns;
    draw();
  }
  // 图层
  document.querySelectorAll('#layerToggles input').forEach((el) => {
    el.addEventListener('change', () => { state.layers[el.dataset.layer] = el.checked; draw(); });
  });
  // 租户开关
  els.tenantToggles.addEventListener('change', (e) => {
    if (e.target.matches('input[data-tenant]')) {
      state.tenantsOn[e.target.dataset.tenant] = e.target.checked;
      draw();
    }
  });
  // 租户卡片点击（事件委托）：点击同租户取消聚焦回全局；点击不同租户聚焦
  els.tenantCards.addEventListener('click', (e) => {
    const card = e.target.closest('.tenant-card');
    if (card) toggleSolo(card.dataset.tenant);
  });
  // 视图切换
  els.viewGlobal.addEventListener('click', () => { state.soloTenant = null; fitView(); renderTenantCards(); els.viewGlobal.classList.add('active'); });
  els.viewFit.addEventListener('click', () => { state.soloTenant ? fitSolo(state.soloTenant) : fitView(); });
  // 官方商店 / 兑换码
  els.redeemBtn.addEventListener('click', openRedeem);
  els.redeemClose.addEventListener('click', () => els.redeemDialog.close());
  els.cookieSave.addEventListener('click', saveShopCookie);
  els.cookieTest.addEventListener('click', async () => {
    if (els.shopCookie.value.trim()) localStorage.setItem(SHOP_COOKIE_KEY, els.shopCookie.value.trim());
    await refreshAccount();
  });
  els.shopCookie.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveShopCookie(); } });
  // 窗口
  window.addEventListener('resize', () => { resizeCanvas(); draw(); });
}

/* ---------- 启动 ---------- */
async function boot() {
  bindEvents();
  resizeCanvas();
  tickClock();
  setInterval(tickClock, 1000);
  renderLegend();
  renderTenantToggles();
  await loadSprites();
  await poll();
  markRefresh(true);
  pollStreams();
  setInterval(async () => {
    await poll();
    markRefresh(true);
  }, POLL_MS);
  setInterval(() => { pollStreams(); }, POLL_MS);
  let lastAnim = 0;
  const animLoop = (ts) => {
    if (ts - lastAnim > 300 && state.beacons.length && state.layers.beacon) {
      lastAnim = ts;
      draw();
    }
    requestAnimationFrame(animLoop);
  };
  requestAnimationFrame(animLoop);
}
function renderLegend() {
  els.legendList.innerHTML = `
    <li><span class="sw core"></span>核心</li>
    <li><span class="sw unit"></span>单位</li>
    <li><span class="sw resource"></span>资源</li>
    <li><span class="sw obstacle"></span>障碍</li>
    <li><span class="sw beacon"></span>冠军信标</li>`;
}
boot().catch((err) => {
  console.error('boot failed', err);
  els.badge.className = 'badge err';
  els.badge.textContent = '启动失败';
});
