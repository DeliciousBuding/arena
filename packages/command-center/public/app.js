/* Arena 指挥面板前端 — 零依赖原生 JS + Canvas（官方素材渲染） */
import { SPRITE, hash2, fmt, shortId, ageText, hexA, EASE_OUT_CUBIC, EASE_OUT_QUART, maxUnitHp, unitSpritePath, escapeHtml, pKey, samePos } from './js/utils.js';
import { getJSON } from './js/api.js';

const TENANTS = ['t1', 't2', 't3', 't4'];
const TENANT_COLORS = { t1: '#69b3d8', t2: '#57bd84', t3: '#a892d6', t4: '#dd626d' };
const TENANT_LABEL = { t1: '租户 1', t2: '租户 2', t3: '租户 3', t4: '租户 4' };
const POLL_MS = 3000;
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
  layers: { obstacle: true, resource: true, unit: true, core: true, beacon: true, survey: true, patrol: true, plan: true, trail: true },
  tenantsOn: { t1: true, t2: true, t3: true, t4: true },
  soloTenant: null,     // null=全局联盟；'t1'..'t4'=单租户
  tab: 'all',           // all | t1 | t2 | t3 | t4 | events
  cellIndex: new Map(),
  cells: [],
  beacons: [],
  bounds: null,
  lastRefresh: 0,
  /** 单位上一次轮询位置（smooth 插值：poll 之间单位按 POLL_MS 渐变移动）。 */
  unitPrev: new Map(),
  /** 世界 tick 周期估计（官方 ~15s/tick）：由 overview tick/mtime 差分推算。 */
  tickMeter: { period: 15000, lastMtime: 0, lastTick: 0, lastPollMtime: 0, lastPollTick: 0 },
  drag: null,
  hover: null,
  streamCollapsed: false,
  viewAnim: null,
  cc: { tick: null, anchor: 0 }, // 命令窗口：最近观测到的计划 tick + 观测时刻（15s 倒计时）
  terrainSig: 0,               // 障碍/资源测绘签名：仅地形变化时重建底图缓存
  tactical: {
    surveys: {},      // tenant -> { obstacleCells, resourceCells, ... }（累积测绘）
    worlds: {},       // tenant -> { state, tick }
    plans: {},        // tenant -> { tick, plan } 最新决策计划（全局联盟 4 租户算法决策虚线）
    selected: null,   // { tenant, obj }
    mode: null,       // null | MOVE | SHOOT | SWEEP
    moveGoals: {},    // objId -> [x, y]（演练移动目标）
    moveRoute: null,  // { tenant, obj, path }
    attackTarget: null, // { tenant, obj }
    plan: null,       // { tick, plan } 最新决策计划（待执行命令 + 计划箭头）
    routePreview: null, // { path } MOVE 悬停预览路线
    eventFx: [],      // 回放/事件特效 [{ x, y, kind, text, born }]
    debris: [],       // 销毁碎片 [{ x, y, vx, vy, color, born, life }]
    fxSeq: 0,
  },
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
  viewGlobal: $('#viewGlobal'), viewFit: $('#viewFit'), streamToggle: $('#streamToggle'), streamPane: $('#streamPane'), streamCount: $('#streamCount'),
  actionDialog: $('#actionDialog'), inspectPanel: $('#inspectPanel'),
  beaconIndicator: $('#beaconIndicator'), pendingPanel: $('#pendingPanel'),
  replayBar: $('#replayBar'), rbTick: $('#rbTick'), rbMaxTick: $('#rbMaxTick'),
  rbFill: $('#rbFill'), rbCountdown: $('#rbCountdown'),
  rbPlay: $('#rbPlay'), rbPrev: $('#rbPrev'), rbNext: $('#rbNext'), rbSpeed: $('#rbSpeed'),
  fleetHud: $('#fleetHud'), assetPanel: $('#assetPanel'), assetList: $('#assetList'),
  activityPanel: $('#resourceActivity'), activityList: $('#activityList'),
  commandCountdown: $('#commandCountdown'), ccTime: $('#ccTime'), ccFill: $('#ccFill'),
  tickLabel: $('#tickLabel'), tickFill: $('#tickFill'),
  respawnOverlay: $('#respawnOverlay'), roTick: $('#roTick'),
};

let ctx = els.canvas.getContext('2d');
const images = {};

/* ---------- 静态地形缓存（缩放性能核心） ----------
 * 慢层（租户疆域 / 测绘 / 障碍 / 资源）按"缩放桶"离屏预渲染；
 * 缩放 / 平移期间每帧只贴一次底图 + 重绘少量动态层（单位/核心/信标/轨迹/特效），
 * 避免全量重绘卡顿。参考 MDN Optimizing canvas / Mozilla pinch-zoom 最佳实践：
 * 离屏预渲染、按比例桶重栅格化、动画期间降级（关 shadowBlur 与高成本细节）。 */
const STATIC_PAD = 1.6;                 // 缓存比视口大 60%：小范围平移免重建
const staticCache = { canvas: null, cctx: null, cssW: 0, cssH: 0, scale: 0, cx: 0, cy: 0, ready: false };
let staticDirty = true;
let LQ = false; // 缩放/平移动画期间：低质量模式（关 shadowBlur / 高成本细节）
function bucketScale(s) {
  const k = Math.round(Math.log2(Math.max(0.05, Math.min(64, s))) * 2) / 2;
  return Math.pow(2, k);
}
function invalidateStatic() { staticDirty = true; }
function staticNeedsRebuild(bs) {
  if (staticDirty || !staticCache.ready || staticCache.scale !== bs) return true;
  // 可平移余量 = 缓存覆盖半宽 - 视口半宽（随当前缩放自适应，保证视口不越出缓存）
  const mw = W() / 2 / bs * STATIC_PAD - W() / 2 / state.view.scale;
  const mh = H() / 2 / bs * STATIC_PAD - H() / 2 / state.view.scale;
  return Math.abs(state.view.cx - staticCache.cx) > mw || Math.abs(state.view.cy - staticCache.cy) > mh;
}
function renderStaticCache(bs) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(W() * STATIC_PAD)), h = Math.max(1, Math.round(H() * STATIC_PAD));
  if (!staticCache.canvas) { staticCache.canvas = document.createElement('canvas'); staticCache.cctx = staticCache.canvas.getContext('2d'); }
  const dw = Math.max(1, Math.round(w * dpr)), dh = Math.max(1, Math.round(h * dpr));
  if (staticCache.canvas.width !== dw) staticCache.canvas.width = dw;
  if (staticCache.canvas.height !== dh) staticCache.canvas.height = dh;
  staticCache.cssW = w; staticCache.cssH = h;
  const cctx = staticCache.cctx;
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cctx.clearRect(0, 0, w, h);
  const ax = state.view.cx, ay = state.view.cy;
  const prevCtx = ctx, prevView = state.view;
  ctx = cctx;
  // 缓存画布即"视口"：vw/vh 覆盖使 project/visibleCells 以画布中心为锚（内容铺满画布，blit 对齐画布中心）
  state.view = { ...prevView, cx: ax, cy: ay, scale: bs, vw: w, vh: h };
  try {
    const s = bs;
    if (!state.soloTenant) drawTenantRegions(s);
    tactSurveyLayer(s);
    const cells = visibleCells();
    const buckets = { obstacle: [], resource: [] };
    for (const c of cells) if (buckets[c.type]) buckets[c.type].push(c);
    drawObstacles(buckets.obstacle, s);
    drawResources(buckets.resource, s);
  } finally {
    ctx = prevCtx;
    state.view = prevView;
  }
  staticCache.scale = bs;
  staticCache.cx = ax;
  staticCache.cy = ay;
  staticCache.ready = true;
  staticDirty = false;
}
function blitStatic() {
  if (!staticCache.ready) return;
  const c = staticCache;
  const k = state.view.scale / c.scale;
  const sx = (c.cx - state.view.cx) * state.view.scale + W() / 2;
  const sy = (c.cy - state.view.cy) * state.view.scale + H() / 2;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.scale(k, k);
  ctx.drawImage(c.canvas, -c.cssW / 2, -c.cssH / 2, c.cssW, c.cssH);
  ctx.restore();
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
    // 静态层脏检查：仅当障碍/资源测绘变化才重建底图缓存（单位移动不触发重建）
    let sig = 0, n = 0;
    for (const c of state.cells) {
      if (c.type === 'obstacle' || c.type === 'resource') { sig = (sig + c.x * 73856093 + c.y * 19349663 + (c.type === 'obstacle' ? 1 : 2)) >>> 0; n++; }
    }
    sig = (sig ^ (n * 2654435761)) >>> 0;
    if (sig !== state.terrainSig) { state.terrainSig = sig; invalidateStatic(); }
    if (overview?.dataRoot) els.dataRoot.textContent = overview.dataRoot;
    // 单位平滑插值：记录上一轮位置，poll 之间 draw 时按 POLL_MS 渐变移动
    captureUnitPrev();
    // 世界 tick 周期估计（~15s）：采样 (tick, mtime) 序列，取窗口跨度斜率——
    // 单次 poll 差分噪声大（tick 可能跨多档/漏档），窗口两端差分最稳
    const t0 = overview?.tenants?.[0];
    if (t0 && Number.isFinite(t0.mtime) && Number.isFinite(t0.latest?.tick)) {
      const m = state.tickMeter;
      const tick = t0.latest.tick;
      const mt = t0.mtime;
      m.samples = m.samples || [];
      const last = m.samples[m.samples.length - 1];
      if (!last || last.tick !== tick) {
        m.samples.push({ tick, mt });
        if (m.samples.length > 24) m.samples.shift();
        if (m.samples.length >= 3) {
          const a = m.samples[0], b = m.samples[m.samples.length - 1];
          const dM = b.mt - a.mt, dT = b.tick - a.tick;
          if (dM > 0 && dT > 0) m.period = Math.max(3000, Math.min(60000, dM / dT)); // mtime 已是 epoch ms，周期 = dM/dT (ms)
        }
      }
      m.lastMtime = mt; m.lastTick = tick;
    }
    if (!state.view.ready && state.bounds && state.cells.length) fitView();
    renderTenantCards();
    renderTenantToggles();
    draw();
    if (state.soloTenant) tactRefreshLive(state.soloTenant);
    else loadGlobalPlans();
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
  invalidateStatic();
}
function W() { return state.view.vw ?? els.canvas.getBoundingClientRect().width; }
function H() { return state.view.vh ?? els.canvas.getBoundingClientRect().height; }

function fitView() {
  if (!state.bounds || !state.cells.length) return;
  const b = state.bounds;
  const w = Math.max(1, W()), h = Math.max(1, H());
  const spanX = Math.max(1, b.maxX - b.minX + 2);
  const spanY = Math.max(1, b.maxY - b.minY + 2);
  const scale = Math.min(64, Math.max(0.05, Math.min(w / spanX, h / spanY)));
  state.view.ready = true;
  animateView({ cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale });
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
  const scale = Math.min(64, Math.max(0.05, Math.min(w / spanX, h / spanY)));
  state.view.ready = true;
  animateView({ cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale });
}
/** 视口补间动画：easeOutCubic 非线性过渡（聚焦/全局切换、双击适应） */
function animateView(to, duration = 680) {
  state.viewAnim = { from: { cx: state.view.cx, cy: state.view.cy, scale: state.view.scale }, to, t0: performance.now(), duration };
}
function applyViewAnim(ts) {
  const a = state.viewAnim;
  if (!a) return;
  const p = Math.min(1, (ts - a.t0) / a.duration);
  const e = 1 - Math.pow(1 - p, 3);
  state.view.cx = a.from.cx + (a.to.cx - a.from.cx) * e;
  state.view.cy = a.from.cy + (a.to.cy - a.from.cy) * e;
  state.view.scale = a.from.scale + (a.to.scale - a.from.scale) * e;
  if (p >= 1) state.viewAnim = null;
}
function project(x, y) {
  return { sx: (x - state.view.cx) * state.view.scale + W() / 2, sy: (y - state.view.cy) * state.view.scale + H() / 2 };
}
function visibleCells(pad = 1) {
  const cx = state.view.cx, cy = state.view.cy, s = state.view.scale;
  const vw = W() / 2 / s * pad + 2, vh = H() / 2 / s * pad + 2;
  return state.cells.filter((c) =>
    Math.abs(c.x - cx) <= vw && Math.abs(c.y - cy) <= vh &&
    state.tenantsOn[c.tenant] !== false && (state.soloTenant === null || c.tenant === state.soloTenant) &&
    state.layers[c.type] !== false);
}

/** 单位平滑插值快照（2026-08-07）：poll 拿到新单位位置时保留旧位置
 *  （px,py → x,y），draw 之间按 POLL_MS 渐变移动——tick ~15s、poll 3s，
 *  单位移动不再"跳格子"，而是非线性（ease-out）滑动。 */
function captureUnitPrev() {
  const now = performance.now();
  const seen = new Set();
  for (const c of state.cells) {
    if (c.type !== 'unit') continue;
    const k = c.tenant + ':' + c.id;
    seen.add(k);
    const prev = state.unitPrev.get(k);
    if (!prev) state.unitPrev.set(k, { x: c.x, y: c.y, px: c.x, py: c.y, ts: now });
    else if (prev.x !== c.x || prev.y !== c.y) {
      prev.px = prev.x; prev.py = prev.y; prev.x = c.x; prev.y = c.y; prev.ts = now;
    }
  }
  // 清理已消失的单位（防 Map 无限增长）
  for (const k of state.unitPrev.keys()) if (!seen.has(k)) state.unitPrev.delete(k);
}
/** 单位当前绘制位置：插值（ease-out）或精确格。 */
function unitDrawPos(c) {
  const m = state.unitPrev.get(c.tenant + ':' + c.id);
  if (m && (m.px !== m.x || m.py !== m.y) && performance.now() - m.ts < POLL_MS * 2) {
    const t = Math.min(1, (performance.now() - m.ts) / POLL_MS);
    const e = 1 - Math.pow(1 - t, 2); // ease-out：起步快、收尾缓（丝滑）
    return { x: m.px + (m.x - m.px) * e, y: m.py + (m.y - m.py) * e };
  }
  return { x: c.x, y: c.y };
}

/* ---------- 渲染 ---------- */
function draw() {
  const w = W(), h = H();
  ctx.clearRect(0, 0, w, h);
  drawGrid(w, h);
  const s = state.view.scale;
  LQ = false; // 底图缓存始终全质量渲染（重建频率低）
  const bs = bucketScale(s);
  if (staticNeedsRebuild(bs)) renderStaticCache(bs);
  blitStatic();
  LQ = !!state.viewAnim; // 动画期间仅动态层降级：关 shadowBlur / 高成本细节
  const replayActive = replay.data && replay.loadedFor === state.soloTenant;
  tactPatrolLayer(s);
  tactPlanLayer(s);
  tactDrawEventFx(s);
  const drawCells = visibleCells();
  const buckets = { unit: [], core: [] };
  for (const c of drawCells) {
    if (replayActive && (c.type === 'unit' || c.type === 'core')) continue; // 回放接管单位/核心
    if (buckets[c.type]) buckets[c.type].push(c);
  }
  if (!replayActive && state.layers.trail) drawMovementDashes(buckets.unit, s);
  if (!replayActive) drawUnits(buckets.unit, s);
  if (!replayActive) drawCores(buckets.core, s);
  if (!replayActive) drawLiveTrails(s);
  drawBeacons(s);
  tactDrawLayer(s);
  if (replayActive) replayDrawLayer(s);
  const ztxt = `×${state.view.scale.toFixed(1)}`;
  if (els.hint.dataset.zoom !== ztxt) { els.hint.dataset.zoom = ztxt; els.hint.textContent = `拖拽平移 · 滚轮缩放 · 双击适应 · ${ztxt}`; }
  if (!state.cells.length) {
    ctx.fillStyle = '#56626c'; ctx.font = '13px "Geist Mono", ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('等待测绘数据…', w / 2, h / 2);
  }
}
/** 全局联盟地图：每租户疆域色晕 + 核心标签（大联盟地图"完全设计"：一眼区分 4 租户领地）。 */
function drawTenantRegions(s) {
  const groups = {};
  for (const c of state.cells) {
    if (state.tenantsOn[c.tenant] === false) continue;
    (groups[c.tenant] = groups[c.tenant] || []).push(c);
  }
  ctx.save();
  for (const t of TENANTS) {
    const cells = groups[t];
    if (!cells || !cells.length) continue;
    const color = TENANT_COLORS[t];
    const xs = cells.map((c) => c.x), ys = cells.map((c) => c.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const span = Math.max(30, Math.max(maxX - minX, maxY - minY));
    const p = project(cx, cy);
    const radius = Math.max(60, span * s * 0.62);
    const grad = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, radius);
    grad.addColorStop(0, hexA(color, 0.10));
    grad.addColorStop(0.55, hexA(color, 0.045));
    grad.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, radius, 0, Math.PI * 2); ctx.fill();
    // 疆域标签：贴在核心/最密点上方
    const core = cells.find((c) => c.type === 'core');
    const lx = core ? core.x : cx, ly = core ? core.y : cy;
    const lp = project(lx, ly);
    if (s >= 2.5) {
      const label = `${t.toUpperCase()} · ${TENANT_LABEL[t]}`;
      ctx.font = '600 ' + Math.max(9, Math.min(13, s * 0.34)) + 'px "Geist Mono", ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width;
      const pad = 6, hh = 13;
      const bx = lp.sx, by = lp.sy - Math.max(22, s * 0.9);
      ctx.fillStyle = 'rgba(5,6,8,.78)';
      ctx.beginPath(); ctx.roundRect(bx - tw / 2 - pad, by - hh / 2, tw + pad * 2, hh, 5); ctx.fill();
      ctx.strokeStyle = hexA(color, 0.5); ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 6;
      ctx.fillText(label, bx, by + 0.5);
      ctx.shadowBlur = 0;
    }
  }
  ctx.restore();
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
/* ---------- 官方风格绘制助手（对照 arena-hero-web WorldCanvas/unitArt 等） ---------- */
/** 新鲜度 -> 透明度：fresh=1 全亮；stale 按距最新 tick 步数淡出（探测记忆效果） */
function cellAlpha(c, floor = 0.45) {
  if (!c || c.fresh) return 1;
  if (!state.soloTenant) return floor + 0.18; // 全局地图记忆层略亮
  return floor;
}
function drawMeterBar(s, x, y, cell, value, maximum, color, labelColor, displayLabel) {
  const gap = Math.max(1.5, cell * 0.04), maxWidth = cell * 0.9, barHeight = Math.max(2, cell * 0.06);
  const ratio = maximum > 0 ? Math.max(0, Math.min(1, value / maximum)) : 0;
  let fontSize = Math.max(6, cell * 0.15);
  ctx.save();
  ctx.font = '600 ' + fontSize + 'px "Geist Mono", ui-monospace, Consolas, monospace';
  ctx.textBaseline = 'middle';
  let labelWidth = ctx.measureText(displayLabel).width;
  const preferredBarWidth = cell * 0.35;
  if (labelWidth + gap + preferredBarWidth > maxWidth) {
    fontSize = Math.max(cell * 0.1, fontSize * (maxWidth - gap - preferredBarWidth) / labelWidth);
    ctx.font = '600 ' + fontSize + 'px "Geist Mono", ui-monospace, Consolas, monospace';
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
function drawUnitHealth(s, x, y, cell, hp, maxHp) {
  if (maxHp <= 0 || hp >= maxHp) return;
  drawMeterBar(s, x, y, cell, hp, maxHp, hp > 1 ? '#76b889' : '#c66370', '#e4e4e7', `${hp}/${maxHp}`);
}
function drawWorkerCargo(s, x, y, cell, cargo) {
  if (!cargo) return;
  drawMeterBar(s, x, y, cell, cargo, 2, '#76b889', '#b2d2ba', `×${cargo}`);
}
function drawCoreOwnerLabel(s, x, y, cell, username, controlled) {
  const label = '@' + (username || '?');
  let fontSize = Math.max(6, Math.min(9, cell * 0.17));
  const maxWidth = cell * 0.95;
  ctx.save();
  ctx.font = '600 ' + fontSize + 'px "Geist Mono", ui-monospace, Consolas, monospace';
  const measured = ctx.measureText(label).width;
  if (measured > maxWidth) { fontSize = Math.max(5.5, fontSize * maxWidth / measured); ctx.font = '600 ' + fontSize + 'px "Geist Mono", ui-monospace, Consolas, monospace'; }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.6, fontSize * 0.28); ctx.strokeStyle = 'rgba(0,0,0,.9)';
  ctx.strokeText(label, x, y);
  ctx.fillStyle = controlled ? '#a8c8dd' : '#e9a0aa';
  ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 2; ctx.shadowOffsetY = 1;
  ctx.fillText(label, x, y);
  ctx.restore();
}
function drawStackBadge(s, x, y, cell, count, color) {
  const fontSize = Math.max(6, cell * 0.13), label = '×' + count, padding = Math.max(1, cell * 0.045);
  const height = fontSize + padding * 2;
  ctx.save();
  ctx.font = '600 ' + fontSize + 'px "Geist Mono", ui-monospace, Consolas, monospace';
  const width = ctx.measureText(label).width + padding * 2;
  ctx.fillStyle = 'rgba(0,0,0,.92)'; ctx.strokeStyle = color; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(x - width / 2, y - height / 2, width, height, height / 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fafafa'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y + 0.25);
  ctx.restore();
}
/** 选中波纹（官方 SELECTION_RIPPLE 900ms，双波非线性扩散） */
const SELECTION_RIPPLE_MS = 900;
const selectionRipples = new Map(); // objId -> born
function startSelectionRipple(id) { if (id) selectionRipples.set(id, performance.now()); }
function drawSelectionRipple(s, x, y, cell, size, id) {
  const born = selectionRipples.get(id);
  if (born === undefined) return;
  const progress = (performance.now() - born) / SELECTION_RIPPLE_MS;
  if (progress >= 1) { selectionRipples.delete(id); return; }
  const gold = '#f6c453';
  ctx.save(); ctx.strokeStyle = gold; ctx.shadowColor = gold;
  ctx.lineWidth = Math.max(1, cell * 0.025);
  for (let wave = 0; wave < 2; wave++) {
    const delay = wave * 0.18;
    if (progress < delay) continue;
    const wp = Math.min(1, (progress - delay) / (1 - delay));
    const eased = 1 - Math.pow(1 - wp, 3);
    ctx.globalAlpha = (1 - wp) * (0.62 - wave * 0.14);
    ctx.shadowBlur = cell * (0.06 + eased * 0.06);
    ctx.beginPath();
    ctx.arc(x, y, size * (1.04 + eased * 0.35), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
/** 石头：低缩放批量实心格（一次 path，性能好、看得清）；高缩放用官方 asteroid 素材。
 *  探测记忆：非最新 tick 的障碍格按新鲜度淡出（交替地形留痕但不喧宾夺主）。 */
function drawObstacles(cells, s) {
  if (!cells.length) return;
  if (s >= 8) {
    for (const c of cells) {
      const p = project(c.x, c.y);
      ctx.save();
      ctx.globalAlpha = cellAlpha(c, 0.5);
      const path = SPRITE.obstacle[hash2(c.x, c.y, 7) % SPRITE.obstacle.length];
      if (images[path]) sprite(images[path], p.sx, p.sy, s * 0.86);
      else { ctx.fillStyle = '#4a525a'; roundRect(p.sx - s / 2, p.sy - s / 2, s, s, 3); }
      ctx.restore();
    }
    return;
  }
  const cell = Math.max(2, s);
  ctx.save();
  ctx.fillStyle = '#454c54';
  ctx.beginPath();
  for (const c of cells) {
    const p = project(c.x, c.y);
    ctx.globalAlpha = cellAlpha(c, 0.42);
    ctx.rect(p.sx - cell / 2, p.sy - cell / 2, cell, cell);
  }
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(139,183,212,.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
}
/** 矿物：始终可见；高缩放 crystal 素材 + 绿色发光，低缩放亮点。
 *  探测记忆：被采完（非最新 tick 出现）的资源淡出，避免"绿色区域"堆积。 */
function drawResources(cells, s) {
  if (!cells.length) return;
  if (s >= 6) {
    for (const c of cells) {
      const p = project(c.x, c.y);
      ctx.save();
      ctx.globalAlpha = cellAlpha(c, 0.55);
      if (!LQ) { ctx.shadowColor = 'rgba(87,189,132,.35)'; ctx.shadowBlur = 3; }
      const path = SPRITE.crystal[hash2(c.x, c.y, 13) % SPRITE.crystal.length];
      if (images[path]) sprite(images[path], p.sx, p.sy, Math.max(7, s * 0.92));
      else { ctx.fillStyle = '#57bd84'; ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(2.5, s * 0.3), 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
    return;
  }
  ctx.save();
  ctx.fillStyle = 'rgba(87,189,132,.7)';
  ctx.beginPath();
  for (const c of cells) {
    const p = project(c.x, c.y);
    ctx.globalAlpha = cellAlpha(c, 0.5);
    const r = Math.max(1.6, s * 0.3);
    ctx.moveTo(p.sx + r, p.sy); // 断连，避免批量 arc 连线
    ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.restore();
}
function ring(x, y, r, color, width = 1.5, dash = []) {
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
}
/** 全局联盟：加载 4 租户最新决策计划（算法 MOVE/SHOOT 虚线），不阻塞 poll。 */
async function loadGlobalPlans() {
  const results = await Promise.allSettled(TENANTS.map((t) => getJSON('/api/plan?tenant=' + t)));
  results.forEach((r, i) => {
    const t = TENANTS[i];
    if (r.status === 'fulfilled' && r.value && r.value.plan) T().plans[t] = { tick: r.value.tick, plan: r.value.plan };
  });
}
/** 单位移动方向虚线（实时 + 算法决策）：单位在 poll 之间插值移动时，
 *  从上一轮位置到当前插值位置画虚线 + 箭头，直观显示"正在往哪走"。 */
/** 屏幕线段保底长度：低缩放时太短的线段按方向拉长到 minLen（方向夸张但保持语义）。 */
function extendScreen(a, b, minLen) {
  const dx = b.sx - a.sx, dy = b.sy - a.sy;
  const len = Math.hypot(dx, dy);
  if (len >= minLen || len < 1e-3) return b;
  const k = minLen / len;
  return { sx: a.sx + dx * k, sy: a.sy + dy * k };
}
function drawMovementDashes(cells, s) {
  if (!cells.length || s < 1.2) return;
  const now = performance.now();
  ctx.save();
  ctx.lineWidth = Math.max(1, s * 0.09);
  for (const c of cells) {
    const m = state.unitPrev.get(c.tenant + ':' + c.id);
    if (!m) continue;
    const dist = Math.hypot(m.x - m.px, m.y - m.py);
    if (dist < 0.4 || now - m.ts >= POLL_MS * 2) continue;
    const pos = unitDrawPos(c);
    const to = project(pos.x, pos.y);
    // 单位当前插值位置 → 移动方向上的可见方向矢量（低缩放保底 10px）
    const dx = pos.x - m.px, dy = pos.y - m.py;
    const wl = Math.hypot(dx, dy) || 1;
    const ext = Math.max(10, s * 1.1);
    const tip = { sx: to.sx + dx / wl * ext, sy: to.sy + dy / wl * ext };
    const color = c.controlled ? (TENANT_COLORS[c.tenant] ?? '#999') : '#c66370';
    ctx.save();
    ctx.strokeStyle = color; ctx.globalAlpha = 0.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(to.sx, to.sy); ctx.lineTo(tip.sx, tip.sy); ctx.stroke();
    ctx.setLineDash([]);
    const ang = Math.atan2(tip.sy - to.sy, tip.sx - to.sx);
    const sz = Math.max(3, Math.min(10, s * 0.26));
    ctx.fillStyle = color; ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(tip.sx, tip.sy);
    ctx.lineTo(tip.sx - Math.cos(ang - 0.45) * sz, tip.sy - Math.sin(ang - 0.45) * sz);
    ctx.lineTo(tip.sx - Math.cos(ang + 0.45) * sz, tip.sy - Math.sin(ang + 0.45) * sz);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}
/** 单位：高缩放素材+色环；低缩放紧凑租户色圆点（不放大图标遮挡地图）。
 *  官方细节：WORKER 载货条（绿）、受伤单位 HP 条、同格堆叠 ×2 徽章、选中波纹。 */
function drawUnits(cells, s) {
  if (!cells.length) return;
  const pulse = 1 + 0.1 * Math.sin(performance.now() / 380 + hash2(cells[0].x, cells[0].y, 7) * 0.01);
  if (s >= 6) {
    const byCell = new Map();
    for (const c of cells) {
      const k = c.x + ',' + c.y;
      const arr = byCell.get(k) || [];
      arr.push(c); byCell.set(k, arr);
    }
    for (const c of cells) {
      const pos = unitDrawPos(c);
      const p = project(pos.x, pos.y);
      const size = s * (c.unitType === 'RANGER' ? 0.68 : 0.62);
      const color = c.controlled ? (TENANT_COLORS[c.tenant] ?? '#999') : '#c66370';
      ctx.save();
      ctx.globalAlpha = cellAlpha(c, 0.55);
      ring(p.sx, p.sy, size * 0.72 * pulse, c.controlled ? color : 'rgba(198,99,112,.55)', c.controlled ? 1.8 : 1.2, c.controlled ? [] : [3, 3]);
      const path = unitSpritePath(c.unitType);
      if (images[path]) sprite(images[path], p.sx, p.sy, size);
      else {
        ctx.fillStyle = c.controlled ? color : '#7c858d';
        ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(2, size * 0.25), 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      if (state.soloTenant && T().selected && T().selected.obj && T().selected.obj.id === c.id) {
        drawSelectionRipple(s, p.sx, p.sy, s, size, c.id);
      }
      if (c.unitType === 'WORKER' && s >= 8 && !LQ) drawWorkerCargo(s, p.sx, p.sy, s, c.cargo ?? 0);
      if (typeof c.hp === 'number' && s >= 10 && !LQ) drawUnitHealth(s, p.sx, p.sy + size * 0.5, s, c.hp, maxUnitHp(c.unitType));
      const stack = byCell.get(c.x + ',' + c.y) || [];
      if (stack.length > 1 && !LQ) drawStackBadge(s, p.sx, p.sy - size * 0.7, s, stack.length, color);
    }
    return;
  }
  for (const c of cells) {
    const pos = unitDrawPos(c);
    const p = project(pos.x, pos.y);
    const color = c.controlled ? (TENANT_COLORS[c.tenant] ?? '#999') : '#c66370';
    ctx.save();
    ctx.globalAlpha = cellAlpha(c, 0.55);
    ctx.fillStyle = c.controlled ? color : 'rgba(198,99,112,.7)';
    ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(1.8, s * 0.42 * pulse), 0, Math.PI * 2); ctx.fill();
    if (c.controlled) { ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.restore();
  }
}
/** 实时移动轨迹：live 视图（非回放）用该租户 replay 的 trail 画最近 5 个 tick 的位置轨迹，
 *  让"单位在动"肉眼可见（回放引擎插值动画之外，live 也有运动感）。 */
const TRAIL_POINTS = 5;
function drawLiveTrails(s) {
  if (!state.layers.trail || !state.soloTenant || !replay.data || replay.data.loadedFor !== state.soloTenant) return;
  if (s < 3) return; // 全局/极低缩放不画轨迹，避免噪声
  const color = TENANT_COLORS[state.soloTenant] ?? '#4591c5';
  for (const u of replay.data.units) {
    const trail = u.trail;
    if (!trail || trail.length < 2) continue;
    const pts = trail.slice(-TRAIL_POINTS);
    const last = pts[pts.length - 1];
    // 与当前 live 位置一致才画（避免回放旧 run 轨迹错位）
    const liveCell = state.cellIndex.get(`${last.x},${last.y}`);
    if (liveCell && liveCell.tenant !== state.soloTenant) continue;
    ctx.save();
    ctx.lineWidth = Math.max(1, s * 0.08);
    for (let i = 0; i < pts.length; i++) {
      const p = project(pts[i].x, pts[i].y);
      const f = (i + 1) / pts.length;
      ctx.globalAlpha = 0.12 + 0.3 * f;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(1.4, s * 0.16 * f), 0, Math.PI * 2); ctx.fill();
      if (i > 0) {
        const q = project(pts[i - 1].x, pts[i - 1].y);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.08 + 0.2 * f;
        ctx.beginPath(); ctx.moveTo(q.sx, q.sy); ctx.lineTo(p.sx, p.sy); ctx.stroke();
      }
    }
    ctx.restore();
  }
}

/** 核心：高缩放素材+光环+拥有者标签+盾条/血条；低缩放租户色大点+白描边。
 *  官方细节：drawCoreOwnerLabel / drawCoreShieldBar / drawHealthBar / 选中波纹。 */
function drawCores(cells, s) {
  if (!cells.length) return;
  if (s >= 6) {
    for (const c of cells) drawCoreSprite(c, s);
    return;
  }
  for (const c of cells) {
    const p = project(c.x, c.y);
    const color = coreColor(c);
    ctx.save();
    ctx.globalAlpha = cellAlpha(c, 0.8);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(3, s * 0.6), 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = c.controlled ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.6)'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.restore();
    if (state.soloTenant && T().selected && T().selected.obj && T().selected.obj.id === c.id) {
      drawSelectionRipple(s, p.sx, p.sy, s, s * 0.72, c.id);
    }
  }
}
function coreColor(c) {
  // 我方核心=租户色；敌方核心=珊瑚红（官方 hostile 语义）
  return c.controlled ? (TENANT_COLORS[c.tenant] ?? '#4591c5') : '#c66370';
}
function drawCoreSprite(c, s) {
  const p = project(c.x, c.y);
  const size = s * 0.72;
  const color = coreColor(c);
  ctx.save();
  ctx.globalAlpha = cellAlpha(c, 0.85);
  if (c.controlled) {
    if (!LQ) { ctx.shadowColor = color; ctx.shadowBlur = 12; }
  } else {
    ctx.globalAlpha *= 0.85;
    if (!LQ) { ctx.shadowColor = color; ctx.shadowBlur = 6; }
  }
  if (images[SPRITE.core]) sprite(images[SPRITE.core], p.sx, p.sy, size);
  else {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(3, size * 0.3), 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = cellAlpha(c, 0.9);
  ring(p.sx, p.sy, size * 0.62, color, c.controlled ? 2 : 1.6, c.controlled ? [] : [3, 3]);
  ctx.restore();
  // 敌方核心加"×"标识
  if (!c.controlled) {
    ctx.strokeStyle = 'rgba(198,99,112,.85)';
    ctx.lineWidth = 2;
    const d = Math.max(4, size * 0.2);
    ctx.beginPath();
    ctx.moveTo(p.sx - d, p.sy - d); ctx.lineTo(p.sx + d, p.sy + d);
    ctx.moveTo(p.sx + d, p.sy - d); ctx.lineTo(p.sx - d, p.sy + d);
    ctx.stroke();
  }
  if (state.soloTenant && T().selected && T().selected.obj && T().selected.obj.id === c.id) {
    drawSelectionRipple(s, p.sx, p.sy, s, size, c.id);
  }
  // 拥有者标签（官方 @username）
  if (s >= 10 && c.owner && !LQ) drawCoreOwnerLabel(s, p.sx, p.sy - size * 0.86, s, c.owner, c.controlled);
  // 盾条 + 血条（官方 drawMeterBar；携带冠军信标时盾上限 10）
  const shieldMax = 10;
  if (typeof c.shield === 'number' && s >= 8 && !LQ) {
    drawMeterBar(s, p.sx, p.sy + size * 0.56, s, c.shield, shieldMax, '#8f91c7', '#c7c8e7', `${c.shield} SHD`);
  }
  if (typeof c.hp === 'number' && s >= 8 && !LQ) {
    const color2 = c.hp > 3 ? '#76b889' : c.hp > 1 ? '#d8b64e' : '#c66370';
    drawMeterBar(s, p.sx, p.sy + size * 0.72, s, c.hp, 5, color2, '#d4d4d8', `${c.hp}/${5}`);
  }
}
/** 信标：视野内脉冲；视野外屏幕边缘方向指示（不撑爆自适应）。
 *  全局视图下按位置去重（4 租户共享同一世界信标，避免 4 个金色精灵叠在同一格）。 */
function drawBeacons(s) {
  const seenPos = new Set();
  for (const b of state.beacons) {
    if (state.tenantsOn[b.tenant] === false) continue;
    if (state.soloTenant !== null && b.tenant !== state.soloTenant) continue;
    const key = b.x + ',' + b.y;
    if (!state.soloTenant && seenPos.has(key)) continue;
    seenPos.add(key);
    const p = project(b.x, b.y);
    const w = W(), h = H();
    const offscreen = p.sx < -70 || p.sx > w + 70 || p.sy < -70 || p.sy > h + 70;
    if (offscreen) {
      // 边缘方向指示只在聚焦单一租户时显示（全局 4 信标同时指向会太吵）
      if (state.soloTenant) drawEdgeBeacon(b, p);
      continue;
    }
    const size = Math.max(14, s * (b.status === 'CARRIED' ? 0.58 : 0.98));
    if (state.soloTenant && state.layers.beacon) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 420);
      ring(p.sx, p.sy, size * 0.9, `rgba(224,185,79,${0.18 + 0.22 * pulse})`, 1.6);
    } else {
      ring(p.sx, p.sy, size * 0.9, 'rgba(224,185,79,.14)', 1.2);
    }
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
/** 悬浮信息框（官方 MapFeatureInfo 移植）：图标头 + 坐标 + 动态行 + 指向箭头定位。 */
function showTooltip(px, py, cell) {
  if (!cell) { els.tooltip.hidden = true; return; }
  const color = TENANT_COLORS[cell.tenant] ?? '#999';
  const iconFor = (t) => t === 'core' ? SPRITE.core
    : t === 'unit' ? (cell.unitType === 'VANGUARD' ? SPRITE.vanguard : cell.unitType === 'RANGER' ? SPRITE.ranger : SPRITE.worker)
    : t === 'resource' ? SPRITE.crystal[0] : t === 'beacon' ? SPRITE.beacon : null;
  const head = cell.type === 'obstacle' ? '障碍' : cell.type === 'resource' ? '资源' : cell.type === 'core' ? '核心' : '单位';
  const lines = [];
  lines.push(`<div class="tt-title" style="color:${color}">${head} · ${cell.tenant.toUpperCase()}</div>`);
  lines.push(`<div class="tt-row"><span>坐标</span><b>${cell.x}, ${cell.y}</b></div>`);
  lines.push(`<div class="tt-row"><span>tick</span><b>${fmt(cell.tick)}</b></div>`);
  if (cell.type === 'unit') {
    lines.push(`<div class="tt-row"><span>类型</span><b>${TACT_UNIT_CN[cell.unitType] ?? cell.unitType ?? '—'}</b></div>`);
    lines.push(`<div class="tt-row"><span>HP</span><b>${fmt(cell.hp)}</b></div>`);
    if (cell.cargo > 0) lines.push(`<div class="tt-row"><span>载货</span><b>${fmt(cell.cargo)}</b></div>`);
    lines.push(`<div class="tt-row"><span>归属</span><b>${cell.controlled ? '我方' : '敌方'}</b></div>`);
  }
  if (cell.type === 'core') {
    lines.push(`<div class="tt-row"><span>HP / 盾</span><b>${fmt(cell.hp)} / ${fmt(cell.shield)}</b></div>`);
    lines.push(`<div class="tt-row"><span>控制</span><b>${cell.controlled ? '我方' : '敌方'}</b></div>`);
    if (cell.owner) lines.push(`<div class="tt-row"><span>拥有者</span><b>${cell.owner}</b></div>`);
  }
  if (!cell.fresh) lines.push(`<div class="tt-row"><span>记忆</span><b style="color:var(--amber)">已探索 · 非当前 tick</b></div>`);
  if (cell.id) lines.push(`<div class="tt-row"><span>ID</span><b>${shortId(cell.id)}</b></div>`);
  const icon = iconFor(cell.type);
  els.tooltip.innerHTML = `<span class="tt-arrow" aria-hidden="true"></span>
    <div class="tt-head">${icon ? `<img class="tt-icon" src="${icon}" alt="" draggable="false" />` : ''}<div class="tt-head-text">${lines.slice(0, 2).join('')}</div></div>
    ${lines.slice(2).join('')}`;
  els.tooltip.hidden = false;
  const tw = els.tooltip.offsetWidth, th = els.tooltip.offsetHeight;
  const rect = els.canvas.getBoundingClientRect();
  let left = px + 16, top = py + 16, side = 'left';
  if (left + tw > rect.width - 8) { left = px - tw - 16; side = 'right'; }
  if (top + th > rect.height - 8) top = py - th - 16;
  els.tooltip.style.left = `${left}px`;
  els.tooltip.style.top = `${top}px`;
  els.tooltip.dataset.side = side;
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
  state.prevMetrics = state.prevMetrics || {};
  const nextMetrics = {};
  const html = state.overview.tenants.map((t) => {
    const color = TENANT_COLORS[t.tenant] ?? '#999';
    const st = statusOf(t.tenant);
    const L = t.latest ?? {};
    const prev = state.prevMetrics[t.tenant] || {};
    const flash = (k, v) => (prev[k] !== undefined && prev[k] !== v ? ' flash' : '');
    const delta = typeof L.resourceDelta === 'number' ? L.resourceDelta : null;
    const deltaCls = delta === null ? '' : delta > 0 ? 'delta-pos' : delta < 0 ? 'delta-neg' : '';
    const deltaTxt = delta === null ? '—' : (delta > 0 ? '+' : '') + fmt(delta);
    const solo = state.soloTenant === t.tenant;
    nextMetrics[t.tenant] = { resources: L.resources, workers: L.workers, events: L.events, tick: L.tick };
    return `<div class="tenant-card${solo ? ' solo' : ''}" data-tenant="${t.tenant}" style="--tc:${color}" role="button" tabindex="0">
      <div class="row1">
        <span class="dot ${st.cls}" title="${st.label}"></span>
        <span class="tenant-name">${t.tenant.toUpperCase()}</span>
        <span class="tenant-tag">${TENANT_LABEL[t.tenant] ?? ''}</span>
      </div>
      <div class="metrics">
        <div class="metric"><img src="${UNIT_ICONS.resource}" alt="" /><span class="v${flash('resources', L.resources)}">${fmt(L.resources)}</span><span class="k">资源</span></div>
        <div class="metric"><span class="v ${deltaCls}">${deltaTxt}</span><span class="k">增量</span></div>
        <div class="metric"><img src="${UNIT_ICONS.population}" alt="" /><span class="v${flash('workers', L.workers)}">${fmt(L.workers)}</span><span class="k">工人</span></div>
        <div class="metric"><span class="v${flash('events', L.events)}">${fmt(L.events)}</span><span class="k">事件</span></div>
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
  state.prevMetrics = nextMetrics;
  // 点击事件用容器委托（见 bindEvents），避免 poll 重建 DOM 时丢失/重复绑定
}
function renderTenantToggles() {
  els.tenantToggles.innerHTML = TENANTS.map((t) =>
    `<label><input type="checkbox" data-tenant="${t}" ${state.tenantsOn[t] ? 'checked' : ''} /><span style="color:${TENANT_COLORS[t]}">${t.toUpperCase()}</span></label>`
  ).join('');
}
function toggleSolo(tenant) {
  state.soloTenant = state.soloTenant === tenant ? null : tenant;
  invalidateStatic();
  if (state.soloTenant) {
    fitSolo(state.soloTenant);
    tactShowTenant(tenant);
  } else {
    fitView();
    tactClear();
  }
  renderTenantCards();
  const global = state.soloTenant === null;
  els.viewGlobal.classList.toggle('active', global);
}
/** 重生覆盖层（官方 RespawnOverlay 移植）：世界 status=RESPAWNING 时全屏提示。 */
function tactRenderRespawn(tenant) {
  const world = T().worlds[tenant];
  const respawning = world && world.state && world.state.status === 'RESPAWNING';
  els.respawnOverlay.hidden = !respawning;
  if (respawning) {
    const rt = world.state.respawn_at_tick;
    els.roTick.textContent = `重生 tick · ${Number.isFinite(rt) ? fmt(rt) : '待定'}`;
  }
}
async function tactShowTenant(tenant) {
  const [world, expl, rp, plan] = await Promise.all([
    tactLoadWorld(tenant), tactLoadExploration(tenant), replayLoad(tenant), tactLoadPlan(tenant),
  ]);
  if (!world) return;
  T().plan = plan;
  if (plan && Number.isFinite(plan.tick)) setCommandWindowTick(plan.tick);
  tactRenderAssets(tenant);
  tactRenderHud(tenant);
  tactRenderPending();
  tactRefreshActivity(tenant);
  tactRenderRespawn(tenant);
  invalidateStatic();
  draw();
}
/** 战术层实时刷新（2026-08-07）：聚焦单租户时每轮 poll 重取世界+计划，
 *  待执行命令面板/计划箭头/单位位置跟随最新 tick；按 id 重解析选中对象保持选中态。 */
async function tactRefreshLive(tenant) {
  try {
    const [world, plan] = await Promise.all([
      tactLoadWorld(tenant, true),
      getJSON('/api/plan?tenant=' + tenant),
    ]);
    if (world) T().worlds[tenant] = world;
    if (plan && plan.plan) { T().plan = { tick: plan.tick, plan: plan.plan }; if (Number.isFinite(plan.tick)) setCommandWindowTick(plan.tick); }
    tactRefreshActivity(tenant);
    const sel = T().selected;
    if (sel && sel.tenant === tenant && world) {
      const byId = world.state.objects.find((x) => x.id === sel.obj.id);
      if (byId) sel.obj = byId;
    }
    tactRenderPending();
    tactRenderRespawn(tenant);
    draw();
  } catch { /* 保持上次快照，下次重试 */ }
}
async function tactLoadPlan(tenant) {
  try {
    const r = await getJSON('/api/plan?tenant=' + tenant);
    return r && r.plan ? { tick: r.tick, plan: r.plan } : null;
  } catch { return null; }
}
async function tactLoadExploration(tenant) {
  if (T().surveys[tenant]) return T().surveys[tenant];
  try {
    const e = await getJSON(`/api/exploration?tenant=${tenant}`);
    if (e.survey) { T().surveys[tenant] = e.survey; return e.survey; }
    return null;
  } catch { return null; }
}

/* ---------- 决策流 ---------- */
/** 决策流条数更新：折叠时新行到达 → 圆点琥珀提醒（展开后清除）。 */
function setStreamCount(text, hasNew = false) {
  els.streamCount.textContent = text;
  if (state.streamCollapsed && hasNew) {
    const dot = els.streamToggle.querySelector('.st-dot');
    if (dot) dot.classList.add('has-new');
  }
}
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
    if (!all.length) { els.streamBody.innerHTML = '<div class="stream-empty">暂无事件数据</div>'; setStreamCount('0 条'); return; }
    state.rowKeys = state.rowKeys || {};
    const eprev = state.rowKeys.events || new Set();
    const ecur = new Set();
    let eNew = 0;
    const ehtml = all.slice(0, 120).map((e) => {
      const color = TENANT_COLORS[e.tenant] ?? '#999';
      const evColor = e.kind.startsWith('SHOT') || e.kind.includes('DESTROYED') || e.kind.includes('FAILED') ? '#dd626d'
        : e.kind.includes('SUCCEEDED') || e.kind === 'SPAWN' || e.kind === 'PICKUP_BEACON' || e.kind === 'HEAL' ? '#57bd84' : '#d3ad55';
      const detail = [e.actor ? `actor ${shortId(e.actor)}` : '', e.target ? `target ${shortId(e.target)}` : '', e.amount != null ? `×${e.amount}` : ''].filter(Boolean).join(' ');
      const key = `${e.tenant}:${e.tick}:${e.kind}:${e.actor ?? ''}:${e.target ?? ''}:${e.amount ?? ''}`;
      ecur.add(key);
      if (!eprev.has(key)) eNew++;
      return `<div class="stream-line${eprev.has(key) ? '' : ' st-new'}" style="--tc:${color}">
        <span class="st-tenant">${e.tenant.toUpperCase()}</span>
        <span class="st-tick">${fmt(e.tick)}</span>
        <span class="st-kind" style="color:${evColor}">${e.kind}</span>
        <span class="st-detail">${detail}</span>
      </div>`;
    }).join('');
    state.rowKeys.events = ecur;
    els.streamBody.innerHTML = ehtml;
    setStreamCount(`${all.length} 条`, eNew > 0);
    return;
  }
  const rows = [];
  for (const t of (state.tab === 'all' ? TENANTS : [state.tab])) {
    for (const r of state.streams[t] ?? []) rows.push({ tenant: t, ...r });
  }
  rows.sort((a, b) => (b.tick ?? 0) - (a.tick ?? 0));
  if (!rows.length) { els.streamBody.innerHTML = '<div class="stream-empty">暂无决策数据</div>'; return; }
  state.rowKeys = state.rowKeys || {};
  const rprev = state.rowKeys[state.tab] || new Set();
  const rcur = new Set();
  let rNew = 0;
  const rhtml = rows.slice(0, 120).map((r) => {
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
    const key = `${r.tenant}:${r.tick}:${outcome}:${submit}:${r.agentLatencyMs ?? ''}:${r.selectionLatencyMs ?? ''}`;
    rcur.add(key);
    if (!rprev.has(key)) rNew++;
    return `<div class="stream-line${rprev.has(key) ? '' : ' st-new'}" style="--tc:${color}">
      <span class="st-tenant">${r.tenant.toUpperCase()}</span>
      <span class="st-tick">${fmt(r.tick)}</span>
      <span class="st-kind" style="color:${color}">${outcome !== '' ? outcome.replace(/_/g, ' ') : 'decision'}</span>
      <span class="st-detail">${detail}</span>
      <span class="st-badge ${outCls}">${badge}</span>
    </div>`;
  }).join('');
  state.rowKeys[state.tab] = rcur;
  els.streamBody.innerHTML = rhtml;
  setStreamCount(`${rows.length} 条`, rNew > 0);
}

/* ---------- 顶部状态 ---------- */
function tickClock() {
  els.clock.textContent = timeFmt.format(new Date());
  const m = state.tickMeter;
  if (m.lastMtime > 0 && m.period > 0) {
    const elapsed = Math.max(0, Date.now() - m.lastMtime);
    const frac = Math.min(1, elapsed / m.period);
    els.tickFill.style.transform = `scaleX(${frac.toFixed(3)})`;
    els.tickLabel.textContent = `tick ${fmt(m.lastTick)} · ${Math.round(m.period / 1000)}s`;
    const meter = els.tickLabel.closest('.tick-meter');
    if (meter) meter.classList.toggle('warn', frac > 0.82);
  }
}
function markRefresh(ok) {
  els.badge.className = ok ? 'badge ok' : 'badge err';
  els.badge.textContent = ok ? '实时' : '离线';
}

/* ---------- 官方商店 / 兑换码 ---------- */
const SHOP_COOKIE_KEY = 'arena-cc.shop-cookie';
function shopCookieValue() { return (localStorage.getItem(SHOP_COOKIE_KEY) ?? '').trim(); }
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
    state.viewAnim = null;
    state.drag = { x: e.clientX, y: e.clientY, cx: state.view.cx, cy: state.view.cy };
  });
  // 点击判定：抬起时位移 < 6px 视为点击（选中/战术目标），否则为拖拽
  els.canvas.addEventListener('pointerup', (e) => {
    if (!state.drag) return;
    const d = state.drag;
    state.drag = null;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (moved < 6) {
      const rect = els.canvas.getBoundingClientRect();
      handleCanvasClick(e.clientX - rect.left, e.clientY - rect.top);
    }
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
      // MOVE 模式：悬停任意格实时预览远距离路线（含雾区绕行 + ETA）
      const tac = T();
      if (tac.mode === 'MOVE' && tac.selected && tac.worlds[tac.selected.tenant]) {
        const sel = tac.selected, world = tac.worlds[sel.tenant];
        const wx = Math.round(state.view.cx + (px - rect.width / 2) / state.view.scale);
        const wy = Math.round(state.view.cy + (py - rect.height / 2) / state.view.scale);
        const path = tactFindPath(world, sel.obj.position, [wx, wy], sel.tenant);
        const key = path ? path.length + ':' + wx + ',' + wy : 'none';
        if (key !== tac.previewKey) {
          tac.previewKey = key;
          tac.routePreview = path ? { path } : null;
          draw();
        }
      }
    }, 40);
  });
  const endDrag = (e) => { if (state.drag) { state.drag = null; } };
  els.canvas.addEventListener('pointerup', endDrag);
  els.canvas.addEventListener('pointercancel', endDrag);
  els.canvas.addEventListener('pointerleave', () => { els.tooltip.hidden = true; });
/** 向光标平滑缩放（官方 wheelZoomCell + ZOOM_SETTLE 语义）：easeOutCubic 短补间，丝滑不跳变。 */
  function zoomTo(sx, sy, factor) {
    const rect = els.canvas.getBoundingClientRect();
    const ns = Math.min(64, Math.max(0.05, state.view.scale * factor));
    const wx = state.view.cx + (sx - rect.width / 2) / state.view.scale;
    const wy = state.view.cy + (sy - rect.height / 2) / state.view.scale;
    const tx = wx - (sx - rect.width / 2) / ns;
    const ty = wy - (sy - rect.height / 2) / ns;
    animateView({ cx: tx, cy: ty, scale: ns }, 150);
  }
  els.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = els.canvas.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.0012);
    zoomTo(e.clientX - rect.left, e.clientY - rect.top, factor);
  }, { passive: false });
  els.canvas.addEventListener('dblclick', () => { state.soloTenant ? fitSolo(state.soloTenant) : fitView(); });
  $('#zoomIn').addEventListener('click', () => { const r = els.canvas.getBoundingClientRect(); zoomTo(r.width / 2, r.height / 2, 1.5); });
  $('#zoomOut').addEventListener('click', () => { const r = els.canvas.getBoundingClientRect(); zoomTo(r.width / 2, r.height / 2, 1 / 1.5); });
  $('#fitBtn').addEventListener('click', () => { state.soloTenant ? fitSolo(state.soloTenant) : fitView(); });
  // 图层
  document.querySelectorAll('#layerToggles input').forEach((el) => {
    el.addEventListener('change', () => { state.layers[el.dataset.layer] = el.checked; invalidateStatic(); draw(); });
  });
  // 租户开关
  els.tenantToggles.addEventListener('change', (e) => {
    if (e.target.matches('input[data-tenant]')) {
      state.tenantsOn[e.target.dataset.tenant] = e.target.checked;
      invalidateStatic();
      draw();
    }
  });
  // 租户卡片点击（事件委托）：点击同租户取消聚焦回全局；点击不同租户聚焦
  els.tenantCards.addEventListener('click', (e) => {
    const card = e.target.closest('.tenant-card');
    if (card) toggleSolo(card.dataset.tenant);
  });
  // 视图切换
  els.viewGlobal.addEventListener('click', () => { state.soloTenant = null; invalidateStatic(); fitView(); renderTenantCards(); els.viewGlobal.classList.add('active'); });
  els.viewFit.addEventListener('click', () => { state.soloTenant ? fitSolo(state.soloTenant) : fitView(); });
  // 回放控制
  els.rbPlay.addEventListener('click', replayToggle);
  els.rbPrev.addEventListener('click', () => replayStepFrame(-1));
  els.rbNext.addEventListener('click', () => replayStepFrame(1));
  els.rbSpeed.addEventListener('click', replayCycleSpeed);
  // 决策流折叠
  els.streamToggle.addEventListener('click', () => {
    state.streamCollapsed = !state.streamCollapsed;
    els.streamPane.classList.toggle('collapsed', state.streamCollapsed);
    els.streamToggle.setAttribute('aria-expanded', String(!state.streamCollapsed));
    if (!state.streamCollapsed) {
      const dot = els.streamToggle.querySelector('.st-dot');
      if (dot) dot.classList.remove('has-new');
    }
  });
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
  // 容器尺寸变化（折叠决策流/侧栏宽度变化等）：rAF 合帧重设画布，防 CSS 拉伸
  if (typeof ResizeObserver !== 'undefined') {
    let resizeRaf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => { resizeCanvas(); draw(); });
    }).observe(els.canvas);
  }
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
    updateCommandCountdown();
    // 视图动画与回放可并行：回放自动播放不再饿死 fitSolo/zoom 动画（修复聚焦时视图冻结在半路）
    const animating = !!state.viewAnim;
    if (animating) applyViewAnim(ts);
    if (replay.data && replay.playing) {
      const elapsed = ts - replay.tickStart;
      replay.progress = Math.min(1, elapsed / (TICK_MS / replay.speed));
      if (elapsed >= TICK_MS / replay.speed) {
        replay.frame++;
        if (replay.frame >= replay.data.ticks.length) { replay.playing = false; replay.frame = replay.data.ticks.length - 1; }
        replay.tickStart = ts; replay.progress = 0;
      }
      updateReplayUI();
      draw();
    } else if (animating) {
      draw();
    } else if (ts - lastAnim > 120 && ((state.cells.length && state.layers.unit) || (state.beacons.length && state.layers.beacon) || state.tactical.selected || state.tactical.mode)) {
      lastAnim = ts;
      draw();
    }
    requestAnimationFrame(animLoop);
  };
  requestAnimationFrame(animLoop);
  // 战术层：Esc 取消；信标方向指示器定时刷新
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.tactical.mode || state.tactical.selected) tactClear();
    else if (els.redeemDialog.open) els.redeemDialog.close();
  });
  updateBeaconIndicator();
  setInterval(updateBeaconIndicator, 500);
}
/* ============ 战术交互层（官方 Arena Hero 移植 · 只读演练模式） ============ */
const TACT_UNIT_BASE_COST = { WORKER: 5, VANGUARD: 10, RANGER: 12 };
const TACT_UNIT_CN = { WORKER: '工人', VANGUARD: '先锋', RANGER: '游侠', CORE: '核心' };
const TACT_ACTION_CN = {
  MOVE: '移动', HARVEST: '采集', DEPOSIT: '回仓', SWEEP: '清扫', SHOOT: '攻击',
  PICKUP_BEACON: '拾取信标', DROP_BEACON: '放置信标', SELF_DESTRUCT: '自毁',
  HEAL: '维修', WAIT: '等待', REPAIR_SHIELD: '修复护盾',
  START_MOVE: '开始移动', CANCEL_MOVE: '取消移动',
};
const TACT_STEPS = [{ d: 'UP', dx: 0, dy: -1 }, { d: 'RIGHT', dx: 1, dy: 0 }, { d: 'DOWN', dx: 0, dy: 1 }, { d: 'LEFT', dx: -1, dy: 0 }];
/* 回放引擎：同一 run 连续 tick 快照 → 单位/核心移动动画 + 15s tick 读条 */
const TICK_MS = 15000;
const replay = { data: null, frame: 0, playing: false, speed: 1, loadedFor: null, tickStart: 0, progress: 0 };
const TACT_RANGER_RAYS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
const T = () => state.tactical;
function tactCoreCapacity(pop) { return Math.max(10, Math.max(0, pop) * 5); }
function tactUnitCost(unitType, pop) {
  const base = TACT_UNIT_BASE_COST[unitType];
  const exp = pop < 20 ? 0 : Math.floor((pop - 20) / 5) + 1;
  return Math.round(base * Math.pow(1.3, exp));
}
async function tactLoadWorld(tenant, force) {
  if (!force && T().worlds[tenant]) return T().worlds[tenant];
  try {
    const w = await getJSON(`/api/world?tenant=${tenant}`);
    if (w.state) { const world = { state: w.state, tick: w.tick, caseFile: w.caseFile, tenant }; T().worlds[tenant] = world; return world; }
    return null;
  } catch { return null; }
}
function tactObjectAt(world, x, y) {
  if (!world) return null;
  for (const o of world.state.objects) {
    if (o.kind === 'OBSTACLE' || o.kind === 'RESOURCE') continue;
    const p = o.position;
    if (p && p[0] === x && p[1] === y) return o;
  }
  return null;
}
function tactTerrain(world, kind) {
  const s = new Set();
  if (!world) return s;
  for (const o of world.state.objects) if (o.kind === kind) for (const p of o.positions ?? []) s.add(pKey(p));
  return s;
}
function tactHostileAt(world, pos, includeOwnCore) {
  for (const o of world.state.objects) {
    if (o.kind !== 'UNIT' && o.kind !== 'CORE') continue;
    const p = o.position; if (!p || p[0] !== pos[0] || p[1] !== pos[1]) continue;
    if (o.controlled === false) return true;
    if (includeOwnCore && o.kind === 'CORE') return true;
  }
  return false;
}
function tactMoveTargets(world, obj) {
  if (!obj || obj.controlled !== true || !obj.position) return [];
  if (obj.kind !== 'UNIT' && obj.kind !== 'CORE') return [];
  const obstacles = tactTerrain(world, 'OBSTACLE'), resources = tactTerrain(world, 'RESOURCE');
  const out = [];
  for (const { dx, dy } of TACT_STEPS) {
    const t = [obj.position[0] + dx, obj.position[1] + dy], k = pKey(t);
    if (obstacles.has(k)) continue;
    if (obj.kind === 'CORE') {
      if (resources.has(k)) continue;
      if (tactHostileAt(world, t, true)) continue;
    } else if (tactHostileAt(world, t, false)) continue;
    out.push(t);
  }
  return out;
}
function tactFindPath(world, from, to, tenant) {
  const obstacles = tactTerrain(world, 'OBSTACLE');
  // 合并测绘层已知障碍（雾区记忆）：远距离移动应绕开探索过的石头，而非直线穿雾
  const tac = T();
  if (tenant && tac.surveys[tenant]) {
    for (const cell of tac.surveys[tenant].obstacleCells) obstacles.add(pKey(cell.x, cell.y));
  }
  if (obstacles.has(pKey(to))) return null;
  const entities = new Set();
  for (const o of world.state.objects) {
    if (o.kind !== 'UNIT' && o.kind !== 'CORE') continue;
    const p = o.position; if (p) entities.add(pKey(p));
  }
  entities.delete(pKey(from));
  const goalK = pKey(to);
  const queue = [[from]], visited = new Set([pKey(from)]);
  const LIMIT = 20000;
  while (queue.length) {
    const path = queue.shift();
    const cur = path[path.length - 1];
    if (pKey(cur) === goalK) return path;
    if (path.length >= LIMIT) return null;
    for (const { dx, dy } of TACT_STEPS) {
      const n = [cur[0] + dx, cur[1] + dy], k = pKey(n);
      if (visited.has(k) || obstacles.has(k)) continue;
      if (k !== goalK && entities.has(k)) continue;
      visited.add(k);
      queue.push([...path, n]);
    }
  }
  return null;
}
function tactRangerRange(world, obj) {
  const obstacles = tactTerrain(world, 'OBSTACLE');
  const out = [];
  for (const [dx, dy] of TACT_RANGER_RAYS) {
    for (let d = 1; d <= 3; d++) {
      const p = [obj.position[0] + dx * d, obj.position[1] + dy * d];
      if (obstacles.has(pKey(p))) break;
      out.push(p);
    }
  }
  return out;
}
function tactRangerTargets(world, obj) {
  const out = [];
  for (const o of world.state.objects) {
    if (!o.id || o.controlled !== false || !o.position) continue;
    const dx = o.position[0] - obj.position[0], dy = o.position[1] - obj.position[1];
    const dist = Math.max(Math.abs(dx), Math.abs(dy));
    if (dist < 1 || dist > 3) continue;
    if (dx !== 0 && dy !== 0 && Math.abs(dx) !== Math.abs(dy)) continue;
    out.push(o);
  }
  return out;
}
function tactVisibility(world) {
  const radiusFor = (o) => o.kind === 'CORE' ? 5 : o.unit_type === 'WORKER' ? 3 : o.unit_type === 'VANGUARD' ? 4 : 5;
  const out = [];
  for (const o of world.state.objects) {
    if (o.controlled !== true || !o.position) continue;
    if (o.kind !== 'CORE' && o.kind !== 'UNIT') continue;
    out.push({ x: o.position[0], y: o.position[1], r: radiusFor(o) });
  }
  return out;
}
function tactAvailability(world, obj) {
  const actions = { SELF_DESTRUCT: true, WAIT: true }, spawns = {};
  if (!obj || obj.controlled !== true || !obj.position) return { actions, spawns };
  const beacon = world.state.champion_beacon ?? {};
  const carries = beacon.status === 'CARRIED' && beacon.carrier_id === obj.id;
  const atGround = beacon.status === 'GROUND' && samePos(beacon.position, obj.position);
  if (obj.kind === 'CORE') {
    const normal = obj.state !== 'MOVING';
    actions.HEAL = normal; actions.REPAIR_SHIELD = normal;
    actions.START_MOVE = normal && tactMoveTargets(world, obj).length > 0;
    actions.CANCEL_MOVE = !normal;
    actions.PICKUP_BEACON = normal && atGround;
    actions.DROP_BEACON = normal && carries;
    spawns.WORKER = normal; spawns.VANGUARD = normal; spawns.RANGER = normal;
    return { actions, spawns };
  }
  const canMove = tactMoveTargets(world, obj).length > 0;
  const atOwnCore = world.state.objects.some((o) => o.kind === 'CORE' && o.controlled === true && o.position && samePos(o.position, obj.position));
  const atResource = world.state.objects.some((o) => o.kind === 'RESOURCE' && (o.positions ?? []).some((p) => samePos(p, obj.position)));
  actions.MOVE = canMove;
  if (obj.unit_type === 'WORKER') {
    actions.HARVEST = (obj.cargo ?? 0) === 0 && atResource;
    actions.DEPOSIT = (obj.cargo ?? 0) > 0 && atOwnCore;
    actions.HEAL = atOwnCore;
  } else if (obj.unit_type === 'VANGUARD') {
    actions.SWEEP = true; actions.HEAL = atOwnCore;
  } else if (obj.unit_type === 'RANGER') {
    actions.SHOOT = true; actions.HEAL = atOwnCore;
  }
  actions.PICKUP_BEACON = atGround;
  actions.DROP_BEACON = carries;
  return { actions, spawns };
}
async function tactSelect(tenant, obj) {
  const world = await tactLoadWorld(tenant);
  if (!world) return;
  const tac = T();
  tac.selected = { tenant, obj };
  tac.mode = null; tac.moveRoute = null; tac.routePreview = null; tac.attackTarget = null;
  startSelectionRipple(obj.id);
  tactRenderActionDialog();
  tactRenderInspect();
  tactRenderAssets(tenant);
  tactRenderHud(tenant);
  draw();
}
function tactClear() {
  const tac = T();
  tac.selected = null; tac.mode = null; tac.moveRoute = null; tac.routePreview = null; tac.attackTarget = null;
  els.actionDialog.hidden = true; els.inspectPanel.hidden = true;
  els.assetPanel.hidden = true; els.fleetHud.hidden = true;
  els.replayBar.hidden = true;
  els.activityPanel.hidden = true; els.commandCountdown.hidden = true;
  els.respawnOverlay.hidden = true;
  draw();
}
function tactActionTypes(obj) {
  const world = T().worlds[T().selected.tenant];
  const av = tactAvailability(world, obj);
  const isCore = obj.kind === 'CORE';
  const types = isCore ? (obj.state === 'MOVING' ? ['CANCEL_MOVE'] : ['HEAL', 'REPAIR_SHIELD', 'START_MOVE'])
    : obj.unit_type === 'WORKER' ? ['MOVE', 'HARVEST', 'DEPOSIT']
    : obj.unit_type === 'VANGUARD' ? ['MOVE', 'SWEEP']
    : ['MOVE', 'SHOOT'];
  if (av.actions.PICKUP_BEACON) types.push('PICKUP_BEACON');
  if (av.actions.DROP_BEACON) types.push('DROP_BEACON');
  if (!isCore) types.push('HEAL');
  types.push('SELF_DESTRUCT', 'WAIT');
  return { types, av };
}
function tactRenderActionDialog() {
  const tac = T(), sel = tac.selected;
  if (!sel) { els.actionDialog.hidden = true; return; }
  const world = tac.worlds[sel.tenant];
  if (!world) return;
  const obj = sel.obj;
  const { types, av } = tactActionTypes(obj);
  const isCore = obj.kind === 'CORE';
  const art = isCore ? 'CORE' : (obj.unit_type ?? 'WORKER');
  const artPath = art === 'CORE' ? SPRITE.core : unitSpritePath(art);
  const name = isCore ? '核心' : (TACT_UNIT_CN[obj.unit_type] ?? obj.unit_type);
  const pop = world.state.population ?? 0;
  const costHtml = isCore ? `<div class="act-spawn-row"><span class="act-spawn-label">生产单位 · 资源 ${world.state.resources ?? 0} / ${tactCoreCapacity(pop)}</span><div class="act-spawn-grid">${['WORKER','VANGUARD','RANGER'].map((u) => {
    const cost = tactUnitCost(u, pop);
    return `<button class="act-spawn" data-spawn="${u}" title="演练：生产 ${TACT_UNIT_CN[u]}（${cost} 资源）"><img src="${unitSpritePath(u)}" alt="" /><span>${TACT_UNIT_CN[u]}</span><b>${cost}</b></button>`;
  }).join('')}</div></div>` : '';
  const goal = tac.moveGoals[obj.id];
  const goalRow = goal ? `<div class="act-goal"><span>演练路线 → [${goal[0]}, ${goal[1]}]</span><button data-cancel-goal>清除</button></div>` : '';
  const modeBadge = tac.mode ? `<div class="act-mode-badge">${tac.mode === 'MOVE' ? '点击地图选择移动目标…' : tac.mode === 'SHOOT' ? '点击敌方单位选择攻击目标…' : '点击相邻格选择清扫方向…'}</div>` : '';
  els.actionDialog.innerHTML = `
    <div class="act-head">
      <span class="act-icon"><img src="${artPath}" alt="" /></span>
      <div class="act-id">
        <b>${name} · ${sel.tenant.toUpperCase()}</b>
        <span class="mono">${obj.hp} HP${obj.shield !== undefined ? ` · ${obj.shield} SHD` : ''}${(obj.cargo ?? 0) > 0 ? ` · 载货 ${obj.cargo}` : ''}</span>
        <span class="mono dim">[${obj.position[0]}, ${obj.position[1]}]${obj.controlled ? '' : ' · 敌方'}</span>
      </div>
      <button class="act-close" data-close aria-label="关闭">✕</button>
    </div>
    ${modeBadge}
    <div class="act-grid">${types.map((t2) => {
      const available = av.actions[t2] === true;
      const danger = t2 === 'SELF_DESTRUCT';
      return `<button class="act-btn ${danger ? 'danger' : ''}" data-action="${t2}" ${available ? '' : 'disabled'} title="${available ? '演练：' + TACT_ACTION_CN[t2] : '当前不可用'}">${TACT_ACTION_CN[t2] ?? t2}</button>`;
    }).join('')}</div>
    ${costHtml}
    ${goalRow}
    <div class="act-note">只读演练 · 不提交到 Arena</div>
  `;
  const p = project(obj.position[0], obj.position[1]);
  const rect = els.canvas.getBoundingClientRect();
  els.actionDialog.hidden = false;
  els.actionDialog.style.left = '0px'; els.actionDialog.style.top = '0px';
  const dw = els.actionDialog.offsetWidth, dh = els.actionDialog.offsetHeight;
  let left = p.sx + 18, top = p.sy - dh / 2;
  if (left + dw > rect.width - 8) left = p.sx - dw - 18;
  if (top < 8) top = 8;
  if (top + dh > rect.height - 8) top = rect.height - dh - 8;
  els.actionDialog.style.left = `${left}px`;
  els.actionDialog.style.top = `${top}px`;
  els.actionDialog.querySelector('[data-close]')?.addEventListener('click', tactClear);
  els.actionDialog.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => tactChooseAction(b.dataset.action)));
  els.actionDialog.querySelectorAll('[data-spawn]').forEach((b) => b.addEventListener('click', () => tactSpawn(b.dataset.spawn)));
  els.actionDialog.querySelector('[data-cancel-goal]')?.addEventListener('click', () => { delete tac.moveGoals[obj.id]; tac.moveRoute = null; tac.routePreview = null; tactRenderActionDialog(); draw(); });
}
function tactChooseAction(type) {
  const tac = T(), sel = tac.selected;
  if (!sel) return;
  const world = tac.worlds[sel.tenant];
  if (!world) return;
  const obj = sel.obj;
  const av = tactAvailability(world, obj);
  if (av.actions[type] !== true) return;
  if (type === 'MOVE' || type === 'START_MOVE') { tac.mode = 'MOVE'; tac.routePreview = null; tactRenderActionDialog(); draw(); return; }
  if (type === 'SHOOT') { tac.mode = 'SHOOT'; tactRenderActionDialog(); draw(); return; }
  if (type === 'SWEEP') { tac.mode = 'SWEEP'; tactRenderActionDialog(); draw(); return; }
  if (type === 'SELF_DESTRUCT') {
    if (!window.confirm(`演练：确认 ${obj.kind === 'CORE' ? '核心' : '单位'} 自毁？`)) return;
  }
  tac.mode = null;
  tactRenderActionDialog();
}
function tactSpawn(unitType) {
  const tac = T(), sel = tac.selected;
  if (!sel || sel.obj.kind !== 'CORE') return;
  const world = tac.worlds[sel.tenant];
  const cost = tactUnitCost(unitType, world?.state.population ?? 0);
  if (window.confirm(`演练：核心生产 ${TACT_UNIT_CN[unitType]}（${cost} 资源）？`)) { tac.mode = null; tactRenderActionDialog(); }
}
function tactRenderInspect() {
  const tac = T(), sel = tac.selected;
  if (!sel) { els.inspectPanel.hidden = true; return; }
  const world = tac.worlds[sel.tenant], obj = sel.obj;
  const rows = [
    ['租户', sel.tenant.toUpperCase()],
    ['类型', obj.kind === 'CORE' ? '核心' : (TACT_UNIT_CN[obj.unit_type] ?? obj.unit_type)],
    ['坐标', `[${obj.position[0]}, ${obj.position[1]}]`],
    ['HP', obj.hp],
    ['归属', obj.controlled ? '我方' : '敌方'],
  ];
  if (obj.shield !== undefined) rows.push(['护盾', obj.shield]);
  if (obj.cargo !== undefined) rows.push(['载货', obj.cargo]);
  if (obj.owner_username) rows.push(['拥有者', obj.owner_username]);
  if (obj.state === 'MOVING') rows.push(['状态', `移动中 → [${obj.destination?.[0] ?? '?'}, ${obj.destination?.[1] ?? '?'}]`]);
  const goal = tac.moveGoals[obj.id];
  if (goal) rows.push(['演练路线', `→ [${goal[0]}, ${goal[1]}]`]);
  els.inspectPanel.hidden = false;
  els.inspectPanel.innerHTML = `<h3 class="panel-title">单位详情 · DETAILS</h3>${rows.map(([k, v]) => `<div class="ins-row"><span>${k}</span><b>${v}</b></div>`).join('')}`;
}
function tactRenderAssets(tenant) {
  const world = T().worlds[tenant];
  if (!world) { els.assetPanel.hidden = true; return; }
  const controlled = world.state.objects.filter((o) => o.controlled === true && (o.kind === 'UNIT' || o.kind === 'CORE'));
  els.assetPanel.hidden = false;
  els.assetPanel.querySelector('.panel-title').textContent = `舰队索引 · ${tenant.toUpperCase()} · ${controlled.length}`;
  els.assetList.innerHTML = controlled.map((o) => {
    const art = o.kind === 'CORE' ? 'CORE' : (o.unit_type ?? 'WORKER');
    const artPath = art === 'CORE' ? SPRITE.core : unitSpritePath(art);
    const selected = T().selected?.obj?.id === o.id;
    return `<button class="asset-row ${selected ? 'active' : ''}" data-asset="${o.id}">
      <span class="asset-icon"><img src="${artPath}" alt="" /></span>
      <span class="asset-name">${o.kind === 'CORE' ? '核心' : (TACT_UNIT_CN[o.unit_type] ?? o.unit_type)}</span>
      <span class="mono asset-pos">[${o.position[0]}, ${o.position[1]}]</span>
      <span class="mono asset-hp">${o.hp} HP</span>
    </button>`;
  }).join('') || '<div class="stream-empty">无受控单位</div>';
  els.assetList.querySelectorAll('[data-asset]').forEach((b) => b.addEventListener('click', () => {
    const o = world.state.objects.find((x) => x.id === b.dataset.asset);
    if (o) tactSelect(tenant, o);
  }));
}
function tactRenderHud(tenant) {
  const world = T().worlds[tenant];
  if (!world) { els.fleetHud.hidden = true; return; }
  const st = world.state;
  const cap = tactCoreCapacity(st.population ?? 0);
  els.fleetHud.hidden = false;
  const survey = T().surveys[tenant];
  const surveyRow = survey ? `<div class="hud-row hud-survey">
    <span class="hud-label">测绘</span>
    <span class="hud-val">${survey.obstacleCells.length} 障碍</span>
    <span class="hud-val" style="color:var(--green-resource)">${survey.resourceCells.length} 资源</span>
    <span class="hud-val">${survey.coreCells.length} 核心</span>
    <span class="hud-val dim">${survey.caseCount} case · tick ${survey.tickMax}</span>
  </div>` : '';
  els.fleetHud.innerHTML = `<div class="hud-row">
    <span class="hud-label">${tenant.toUpperCase()} · HUD</span>
    <span class="hud-val"><img src="${UNIT_ICONS.resource}" alt="" /> ${st.resources ?? 0} <i>/ ${cap}</i></span>
    <span class="hud-val"><img src="${UNIT_ICONS.population}" alt="" /> ${st.population ?? 0}</span>
    <span class="hud-val mono">tick ${world.tick ?? st.tick ?? '—'}</span>
  </div>${surveyRow}`;
}
/* ============ 回放引擎（连续 tick 快照 → 单位移动动画 + 15s 读条） ============ */
async function replayLoad(tenant) {
  try {
    const r = await getJSON(`/api/replay?tenant=${tenant}`);
    if (!r.replay || !r.replay.ticks.length) return null;
    replay.data = r.replay;
    replay.frame = 0;
    replay.playing = true;
    replay.speed = 1;
    replay.loadedFor = tenant;
    replay.tickStart = performance.now();
    replay.progress = 0;
    els.replayBar.hidden = false;
    updateReplayUI();
    return replay.data;
  } catch { return null; }
}
function replayStepFrame(delta) {
  if (!replay.data) return;
  replay.frame = Math.max(0, Math.min(replay.data.ticks.length - 1, replay.frame + delta));
  replay.progress = 0;
  replay.tickStart = performance.now();
  updateReplayUI();
  draw();
}
function replayToggle() {
  if (!replay.data) return;
  if (replay.playing) { replay.playing = false; }
  else {
    if (replay.frame >= replay.data.ticks.length - 1) replay.frame = 0;
    replay.playing = true;
    replay.tickStart = performance.now();
    replay.progress = 0;
  }
  updateReplayUI();
}
function replayCycleSpeed() {
  replay.speed = replay.speed >= 4 ? 1 : replay.speed * 2;
  replay.tickStart = performance.now(); replay.progress = 0;
  updateReplayUI();
}
/** 插值：frame-1 → frame 之间按 progress(0-1) 平滑移动 */
function replayInterp(obj, frame, progress) {
  if (!obj.trail || !obj.trail.length) return null;
  const b = obj.trail[Math.min(frame, obj.trail.length - 1)];
  const a = obj.trail[Math.max(0, frame - 1)];
  if (!b) return null;
  const x = a ? a.x + (b.x - a.x) * progress : b.x;
  const y = a ? a.y + (b.y - a.y) * progress : b.y;
  return { x, y, hp: b.hp, shield: b.shield, cargo: b.cargo, t: b.t };
}
function replayDrawLayer(s) {
  const f = replay.frame;
  const prog = replay.playing ? replay.progress : 1;
  if (T().fxFrame !== f) { T().fxFrame = f; tactSpawnEventFx(replay.data.ticks[f]); }
  // 核心（含敌我区分）
  for (const c of replay.data.cores) {
    const p = replayInterp(c, f, prog);
    if (!p) continue;
    const color = c.controlled ? (TENANT_COLORS[state.soloTenant] ?? '#4591c5') : '#c66370';
    const size = Math.max(8, s * 0.72);
    const pr = project(p.x, p.y);
    if (c.controlled) { ctx.shadowColor = color; ctx.shadowBlur = 10; }
    if (images[SPRITE.core]) sprite(images[SPRITE.core], pr.sx, pr.sy, size);
    else { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(pr.sx, pr.sy, Math.max(3, size * 0.3), 0, Math.PI * 2); ctx.fill(); }
    ctx.shadowBlur = 0;
    ring(pr.sx, pr.sy, size * 0.62, color, c.controlled ? 2 : 1.6, c.controlled ? [] : [3, 3]);
    if (!c.controlled) {
      ctx.strokeStyle = 'rgba(198,99,112,.85)'; ctx.lineWidth = 2;
      const d = Math.max(4, size * 0.2);
      ctx.beginPath();
      ctx.moveTo(pr.sx - d, pr.sy - d); ctx.lineTo(pr.sx + d, pr.sy + d);
      ctx.moveTo(pr.sx + d, pr.sy - d); ctx.lineTo(pr.sx - d, pr.sy + d);
      ctx.stroke();
    }
    if (typeof p.hp === 'number') {
      const bw = Math.max(14, size * 1.1), bh = 3;
      const bx = pr.sx - bw / 2, by = pr.sy + size * 0.62 + 4;
      ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = p.hp > 3 ? '#76b889' : p.hp > 1 ? '#d8b64e' : '#c66370';
      ctx.fillRect(bx, by, bw * Math.max(0, Math.min(1, p.hp / 5)), bh);
    }
  }
  // 单位
  for (const u of replay.data.units) {
    const p = replayInterp(u, f, prog);
    if (!p) continue;
    const color = u.controlled ? (TENANT_COLORS[state.soloTenant] ?? '#4591c5') : '#c66370';
    const size = Math.max(6, s * (u.type === 'RANGER' ? 0.68 : 0.62));
    const pr = project(p.x, p.y);
    if (s >= 6) {
      ring(pr.sx, pr.sy, size * 0.72, u.controlled ? color : 'rgba(198,99,112,.55)', u.controlled ? 1.6 : 1.1, u.controlled ? [] : [3, 3]);
      const path = unitSpritePath(u.type);
      if (images[path]) sprite(images[path], pr.sx, pr.sy, size);
      else { ctx.fillStyle = u.controlled ? color : '#c66370'; ctx.beginPath(); ctx.arc(pr.sx, pr.sy, Math.max(2, size * 0.25), 0, Math.PI * 2); ctx.fill(); }
    } else {
      ctx.fillStyle = u.controlled ? color : 'rgba(198,99,112,.7)';
      ctx.beginPath(); ctx.arc(pr.sx, pr.sy, Math.max(1.8, s * 0.42), 0, Math.PI * 2); ctx.fill();
    }
    // 载货小点
    if ((p.cargo ?? 0) > 0 && s >= 8) {
      ctx.fillStyle = '#76b889';
      ctx.beginPath(); ctx.arc(pr.sx, pr.sy - size * 0.62, Math.max(1.6, s * 0.14), 0, Math.PI * 2); ctx.fill();
    }
  }
}
function updateReplayUI() {
  const d = replay.data;
  if (!d) return;
  els.rbTick.textContent = d.ticks[replay.frame] ?? '—';
  els.rbMaxTick.textContent = d.ticks[d.ticks.length - 1];
  const overall = (replay.frame + replay.progress) / d.ticks.length;
  els.rbFill.style.width = `${Math.round(overall * 100)}%`;
  const remain = Math.max(0, (TICK_MS / replay.speed - (performance.now() - replay.tickStart)) / 1000);
  els.rbCountdown.textContent = `${replay.playing ? remain.toFixed(1) : '—'}s`;
  els.rbPlay.textContent = replay.playing ? '⏸' : '▶';
  els.rbSpeed.textContent = `×${replay.speed}`;
}

/** 测绘层：聚焦租户时，把该 run 全部 case 累积的已知地形（障碍/资源）以半透明显示，
    当前 case 可见的物体由上层 cells 全亮覆盖 —— 即"探索过的范围"的记忆测绘。 */
/** 路线绘制（官方 plannedMoveArrows 移植）：首步实线（当前 tick 执行）+ 未来步虚线 +
 *  分段方向箭头 + 目标旗 + ETA（步数 = tick 数）。opts.faint = 悬停预览半透明。 */
function tactDrawRoute(path, opts = {}) {
  if (!path || path.length < 2) return;
  const alpha = opts.faint ? 0.4 : 1;
  const s = state.view.scale;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const seg = (i, color, width, dash) => {
    const a = project(path[i][0], path[i][1]);
    const b = project(path[i + 1][0], path[i + 1][1]);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
    ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
    ctx.setLineDash([]);
    // 分段中点方向箭头（小三角）
    const mx = (a.sx + b.sx) / 2, my = (a.sy + b.sy) / 2;
    const ang = Math.atan2(b.sy - a.sy, b.sx - a.sx);
    const size = Math.max(3.5, s * 0.16);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(mx + Math.cos(ang) * size, my + Math.sin(ang) * size);
    ctx.lineTo(mx + Math.cos(ang + 2.5) * size, my + Math.sin(ang + 2.5) * size);
    ctx.lineTo(mx + Math.cos(ang - 2.5) * size, my + Math.sin(ang - 2.5) * size);
    ctx.closePath(); ctx.fill();
  };
  // 首步实线（当前 tick 将执行）
  seg(0, opts.faint ? 'rgba(118,184,137,.8)' : '#76b889', opts.faint ? 1.6 : 2.6, []);
  // 未来步虚线
  for (let i = 1; i < path.length - 1; i++) seg(i, 'rgba(118,184,137,.9)', 2, [5, 4]);
  // 目标旗（菱形）
  const end = project(path[path.length - 1][0], path[path.length - 1][1]);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = opts.faint ? 'rgba(118,184,137,.8)' : '#8fd6a3';
  const d = Math.max(4, s * 0.36);
  ctx.beginPath();
  ctx.moveTo(end.sx, end.sy - d); ctx.lineTo(end.sx + d, end.sy);
  ctx.lineTo(end.sx, end.sy + d); ctx.lineTo(end.sx - d, end.sy);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1; ctx.stroke();
  // ETA 徽标（步数 = 到 tick）
  if (opts.eta !== undefined && !opts.faint) {
    const label = (opts.eta === 0 ? '已到' : opts.eta + ' tick');
    ctx.font = '600 11px "Geist Mono", ui-monospace, Consolas, monospace';
    const tw = ctx.measureText(label).width;
    const bx = end.sx - tw / 2 - 4, by = end.sy - d - 22;
    ctx.fillStyle = 'rgba(10,14,18,.88)';
    ctx.beginPath(); ctx.roundRect(bx, by, tw + 8, 17, 4); ctx.fill();
    ctx.fillStyle = '#8fd6a3'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + tw / 2 + 4, by + 9);
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function tactSurveyLayer(s) {
  if (!state.soloTenant || !state.layers.survey) return;
  const survey = T().surveys[state.soloTenant];
  if (!survey) return;
  const cell = Math.max(2, s);
  const maxTick = survey.tickMax ?? 0;
  const ageAlpha = (tick) => {
    if (!maxTick) return 0.5;
    const age = Math.max(0, maxTick - (tick ?? maxTick));
    return age <= 1 ? 0.55 : age <= 8 ? 0.4 : 0.24; // 越久越淡（探测记忆）
  };
  if (survey.obstacleCells.length) {
    ctx.save();
    for (const c of survey.obstacleCells) {
      const p = project(c.x, c.y);
      ctx.globalAlpha = ageAlpha(c.tick);
      ctx.fillStyle = 'rgba(96,106,116,.32)';
      ctx.fillRect(p.sx - cell / 2, p.sy - cell / 2, cell, cell);
    }
    ctx.restore();
  }
  if (survey.resourceCells.length) {
    ctx.save();
    for (const c of survey.resourceCells) {
      const p = project(c.x, c.y);
      ctx.globalAlpha = ageAlpha(c.tick) * 0.85;
      ctx.fillStyle = 'rgba(118,184,137,.45)';
      const r = Math.max(2, s * 0.26);
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
function tactDrawLayer(s) {
  const tac = T();
  if (!tac.selected) return;
  const sel = tac.selected, world = tac.worlds[sel.tenant], obj = sel.obj;
  if (!world || !obj.position) return;
  const color = TENANT_COLORS[sel.tenant] ?? '#4591c5';
  const p = project(obj.position[0], obj.position[1]);
  const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);
  ring(p.sx, p.sy, 16 + 3 * pulse, color, 2.5);
  for (const v of tactVisibility(world)) {
    const vp = project(v.x, v.y);
    ctx.save();
    ctx.fillStyle = 'rgba(69,145,197,.05)';
    ctx.beginPath(); ctx.arc(vp.sx, vp.sy, v.r * s, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(69,145,197,.16)';
    ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
  }
  if (tac.mode === 'MOVE') {
    for (const t of tactMoveTargets(world, obj)) {
      const tp = project(t[0], t[1]);
      ctx.fillStyle = 'rgba(118,184,137,.55)';
      ctx.beginPath(); ctx.arc(tp.sx, tp.sy, Math.max(3, s * 0.3), 0, Math.PI * 2); ctx.fill();
    }
  }
  if (tac.routePreview) tactDrawRoute(tac.routePreview.path, { faint: true });
  if (tac.moveRoute) tactDrawRoute(tac.moveRoute.path, { eta: tac.moveRoute.path.length - 1 });
  if (tac.mode === 'SHOOT' && obj.unit_type === 'RANGER') {
    for (const t of tactRangerRange(world, obj)) {
      const tp = project(t[0], t[1]);
      ctx.fillStyle = 'rgba(198,99,112,.26)';
      ctx.beginPath(); ctx.arc(tp.sx, tp.sy, Math.max(2.5, s * 0.28), 0, Math.PI * 2); ctx.fill();
    }
    for (const tg of tactRangerTargets(world, obj)) {
      const tp = project(tg.position[0], tg.position[1]);
      ring(tp.sx, tp.sy, 12, '#c66370', 2);
    }
  }
  if (tac.mode === 'SWEEP' && obj.unit_type === 'VANGUARD') {
    for (const { dx, dy } of TACT_STEPS) {
      const tp = project(obj.position[0] + dx, obj.position[1] + dy);
      ctx.fillStyle = 'rgba(216,182,78,.35)';
      ctx.beginPath(); ctx.arc(tp.sx, tp.sy, Math.max(3, s * 0.3), 0, Math.PI * 2); ctx.fill();
    }
  }
  if (tac.attackTarget) {
    const tp = project(tac.attackTarget.obj.position[0], tac.attackTarget.obj.position[1]);
    ring(tp.sx, tp.sy, 14, '#c66370', 2.5);
  }
}
/** 巡逻环（arena-hero-guide SQUAD_PATROL_RADII=(12,19,26,32) 移植）：聚焦租户时
 *  以 Core 为圆心画方环（切比雪夫移动 = 方环语义），弱化虚线。 */
function tactPatrolLayer(s) {
  if (!state.soloTenant || !state.layers.patrol) return;
  const world = T().worlds[state.soloTenant];
  if (!world) return;
  const core = world.state.objects.find((o) => o.kind === 'CORE' && o.controlled === true && o.position);
  if (!core) return;
  const cp = project(core.position[0], core.position[1]);
  const rings = [12, 19, 26, 32];
  ctx.save();
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    const pr = r * s;
    ctx.strokeStyle = i === 0 ? 'rgba(69,145,197,.18)' : 'rgba(69,145,197,.11)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.rect(cp.sx - pr, cp.sy - pr, pr * 2, pr * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(122,160,198,.55)';
    ctx.font = '9px "Geist Mono", ui-monospace, Consolas, monospace';
    ctx.fillText(String(r), cp.sx - pr + 3, cp.sy - pr + 10);
  }
  ctx.restore();
}

/** 计划箭头（官方 plannedMoveArrows/plannedSweepMarkers/plannedShotMarkers 移植）：
 *  从最新决策计划绘制每个受控单位的 MOVE/SWEEP/SHOOT 标记 + Core START_MOVE 方向——
 *  让"单位在动/在打"无需点选即可在地图上可见。 */
function tactPlanLayer(s) {
  if (!state.layers.plan) return;
  const tac = T();
  const solo = state.soloTenant;
  const scopes = solo ? [solo] : TENANTS;
  const colorOf = (t) => TENANT_COLORS[t] ?? '#4591c5';
  const stepOf = (dir) => TACT_STEPS.find((t) => t.d === dir);
  const dash = (from, to, color, alpha, width) => {
    ctx.save();
    ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = width;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(from.sx, from.sy); ctx.lineTo(to.sx, to.sy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  };
  const arrow = (from, to, color) => {
    const ang = Math.atan2(to.sy - from.sy, to.sx - from.sx);
    const sz = Math.max(3, s * 0.2);
    ctx.save();
    ctx.fillStyle = color; ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(to.sx, to.sy);
    ctx.lineTo(to.sx - Math.cos(ang - 0.5) * sz, to.sy - Math.sin(ang - 0.5) * sz);
    ctx.lineTo(to.sx - Math.cos(ang + 0.5) * sz, to.sy - Math.sin(ang + 0.5) * sz);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  };
  let drew = false;
  for (const tenant of scopes) {
    const plan = solo ? tac.plan?.plan : tac.plans?.[tenant];
    if (!plan) continue;
    // byId：优先精确 world（单租户）；全局用合并测绘 cells 的单位/核心位置
    let byId = new Map();
    const world = tac.worlds[tenant];
    if (world && world.state?.objects) {
      for (const o of world.state.objects) if ((o.kind === 'UNIT' || o.kind === 'CORE') && o.id && o.position) byId.set(o.id, o);
    } else {
      for (const c of state.cells) {
        if (c.tenant !== tenant || !c.id) continue;
        if (c.type === 'unit') byId.set(c.id, { id: c.id, position: [c.x, c.y], controlled: c.controlled, kind: 'UNIT' });
        else if (c.type === 'core') byId.set(c.id, { id: c.id, position: [c.x, c.y], controlled: c.controlled, kind: 'CORE' });
      }
    }
    const color = colorOf(tenant);
    const unitActions = plan.unitActions ?? plan.unit_actions ?? {};
    for (const [id, action] of Object.entries(unitActions)) {
      const o = byId.get(id);
      if (!o || o.controlled !== true || !o.position) continue;
      const from = project(o.position[0], o.position[1]);
      if (action.type === 'MOVE' && action.direction) {
        const st = stepOf(action.direction);
        if (!st) continue;
        // 虚线 2 格（低缩放保底 9px）+ 箭头：算法决策的移动方向一眼可见
        const to = extendScreen(from, project(o.position[0] + st.dx * 2, o.position[1] + st.dy * 2), 9);
        dash(from, to, color, 0.65, 1.5);
        arrow(from, to, color);
        drew = true;
      } else if (action.type === 'SWEEP' && action.direction) {
        const st = stepOf(action.direction);
        if (!st) continue;
        const tp = project(o.position[0] + st.dx, o.position[1] + st.dy);
        ring(tp.sx, tp.sy, Math.max(4, s * 0.32), 'rgba(216,182,78,.85)', 1.8);
        drew = true;
      } else if (action.type === 'SHOOT' && action.expectedCell) {
        const to = extendScreen(from, project(action.expectedCell[0], action.expectedCell[1]), 9);
        dash(from, to, 'rgba(198,99,112,.9)', 0.9, 1.5);
        ring(to.sx, to.sy, Math.max(4, s * 0.32), 'rgba(198,99,112,.9)', 1.6);
        drew = true;
      }
    }
    const coreAction = plan.coreAction ?? plan.core_action;
    if (coreAction && (coreAction.type === 'START_MOVE' || coreAction.type === 'MOVE') && coreAction.direction) {
      const st = stepOf(coreAction.direction);
      const coreObj = [...byId.values()].find((o) => o.kind === 'CORE' && o.controlled === true);
      if (st && coreObj && coreObj.position) {
        const from = project(coreObj.position[0], coreObj.position[1]);
        const to = extendScreen(from, project(coreObj.position[0] + st.dx * 2, coreObj.position[1] + st.dy * 2), 12);
        dash(from, to, '#d9a62e', 0.9, 2);
        arrow(from, to, '#d9a62e');
        drew = true;
      }
    }
  }
  if (!drew) return;
}

/** 资源活动面板（官方 ResourceActivity 移植）：最近资源/战斗/信标事件，左下角悬浮，不挡交互。 */
const ACTIVITY_KIND_META = {
  HARVEST_SUCCEEDED: { icon: '⛏', color: 'var(--green-resource)', label: (e) => `采集 +${e.amount ?? ''}` },
  DEPOSIT_SUCCEEDED: { icon: '◆', color: 'var(--cyan-signal)', label: (e) => `交付 +${e.amount ?? ''} 资源` },
  DEPOSIT_FAILED: { icon: '⚠', color: 'var(--amber)', label: (e) => `交付失败${e.reason ? ' · ' + e.reason : ''}` },
  UNIT_HEAL_SUCCEEDED: { icon: '✚', color: 'var(--green-resource)', label: (e) => `治疗 +${e.amount ?? ''} HP` },
  CORE_HEAL_SUCCEEDED: { icon: '✚', color: 'var(--green-resource)', label: (e) => `核心治疗 +${e.amount ?? ''} HP` },
  UNIT_HEAL_FAILED: { icon: '⚠', color: 'var(--amber)', label: () => '治疗失败' },
  CORE_HEAL_FAILED: { icon: '⚠', color: 'var(--amber)', label: () => '核心治疗失败' },
  CORE_RESOURCES_CAPTURED: { icon: '◈', color: 'var(--green-resource)', label: (e) => `敌方资源被夺取 ${e.amount ?? ''}` },
  WORKER_CARGO_DROPPED: { icon: '▤', color: 'var(--violet)', label: (e) => `掉落载货 ${e.amount ?? ''}` },
  CORE_RESOURCE_OVERFLOW_DESTROYED: { icon: '✕', color: 'var(--coral)', label: (e) => `溢出资源销毁 ${e.amount ?? ''}` },
  SHOT_HIT: { icon: '➶', color: 'var(--coral)', label: (e) => `射击命中${e.amount ? ' · ' + e.amount : ''}` },
  SWEEP_RESOLVED: { icon: '⚔', color: 'var(--amber)', label: () => '清扫解除' },
  SPAWN_SUCCEEDED: { icon: '✦', color: 'var(--cyan-signal)', label: () => '生产单位' },
  SPAWN_FAILED: { icon: '⚠', color: 'var(--amber)', label: (e) => `生产失败${e.reason ? ' · ' + e.reason : ''}` },
  PICKUP_BEACON_SUCCEEDED: { icon: '◎', color: '#d9a62e', label: () => '拾取冠军信标' },
  DROP_BEACON_SUCCEEDED: { icon: '◎', color: '#d9a62e', label: () => '放置冠军信标' },
  UNIT_DESTROYED: { icon: '✕', color: 'var(--coral)', label: () => '单位被摧毁' },
  CORE_DESTROYED: { icon: '☠', color: 'var(--coral)', label: () => '核心被摧毁!' },
  CORE_DAMAGED: { icon: '⚔', color: 'var(--coral)', label: (e) => `核心受损 ${e.amount ?? ''}` },
  RESPAWN: { icon: '↻', color: 'var(--cyan-signal)', label: () => '重生' },
};
const ACTIVITY_KINDS = Object.keys(ACTIVITY_KIND_META);
async function tactRefreshActivity(tenant) {
  if (!state.soloTenant) { els.activityPanel.hidden = true; return; }
  try {
    const r = await getJSON(`/api/events?tenant=${tenant}&n=60`);
    const rows = (r.events ?? []).filter((e) => ACTIVITY_KINDS.includes(e.kind)).slice(0, 6);
    if (!rows.length) { els.activityPanel.hidden = true; return; }
    els.activityPanel.hidden = false;
    els.activityList.innerHTML = rows.map((e) => {
      const m = ACTIVITY_KIND_META[e.kind];
      const label = typeof m.label === 'function' ? m.label(e) : '';
      const pos = e.position ? `[${e.position[0]}, ${e.position[1]}]` : '';
      return `<li class="act-row"><span class="act-ic" style="color:${m.color}">${m.icon}</span><span class="act-txt">${escapeHtml(label)}</span><span class="mono act-pos">${pos}</span></li>`;
    }).join('');
  } catch { /* 忽略，下次刷新重试 */ }
}
/** 命令窗口倒计时（官方 CommandCountdown 移植）：最近观测计划 tick 起 15s，≤5s 变红。 */
function setCommandWindowTick(tick) {
  if (!Number.isFinite(tick)) return;
  if (state.cc.tick !== tick) { state.cc.tick = tick; state.cc.anchor = performance.now(); }
}
function updateCommandCountdown() {
  const el = els.commandCountdown;
  if (!state.soloTenant || state.cc.tick === null) { el.hidden = true; return; }
  const remaining = Math.max(0, 15000 - (performance.now() - state.cc.anchor));
  const progress = remaining / 15000;
  const urgent = remaining <= 5000;
  el.hidden = false;
  els.ccTime.textContent = `${(remaining / 1000).toFixed(1)}s`;
  els.ccFill.style.transform = `scaleX(${progress.toFixed(3)})`;
  el.classList.toggle('urgent', urgent);
}

/** 待执行命令面板（官方 PendingCommands 移植）：最新计划的核心/单位动作列表，
 *  显示 actor（类型·id）、动作中文名、方向/目标格，可折叠。 */
function tactRenderPending() {
  const tac = T();
  const plan = tac.plan && tac.plan.plan;
  if (!plan || !state.soloTenant) { els.pendingPanel.hidden = true; return; }
  const world = tac.worlds[state.soloTenant];
  const byId = new Map();
  if (world) for (const o of world.state.objects) if (o.id && (o.kind === 'UNIT' || o.kind === 'CORE')) byId.set(o.id, o);
  const stepOf = (dir) => TACT_STEPS.find((t) => t.d === dir);
  const dirCN = { UP: '上', DOWN: '下', LEFT: '左', RIGHT: '右' };
  const actCN = (a) => {
    if (!a) return '';
    const base = TACT_ACTION_CN[a.type] ?? a.type;
    const parts = [base];
    if (a.direction && stepOf(a.direction)) parts.push(dirCN[a.direction] ?? a.direction);
    if (a.expectedCell) parts.push('[' + a.expectedCell.join(',') + ']');
    else if (a.targetId) parts.push(shortId(a.targetId));
    return parts.join(' · ');
  };
  const rows = [];
  const coreAction = plan.coreAction ?? plan.core_action;
  if (coreAction) rows.push({ key: 'core', actor: '核心 · CORE', act: actCN(coreAction) });
  const unitActions = plan.unitActions ?? plan.unit_actions ?? {};
  const entries = Object.entries(unitActions).sort(([a], [b]) => a.localeCompare(b));
  for (const [id, action] of entries) {
    const o = byId.get(id);
    const type = o && o.unit_type ? TACT_UNIT_CN[o.unit_type] : '单位';
    rows.push({ key: id, actor: type + ' · ' + shortId(id), act: actCN(action) });
  }
  if (!rows.length) { els.pendingPanel.hidden = true; return; }
  const collapsed = tac.pendingCollapsed === true;
  const body = rows.map((r) => '<li class="pp-row"><span class="pp-actor">' + escapeHtml(r.actor) + '</span><span class="pp-src src-agent">AGENT</span><span class="pp-act">' + escapeHtml(r.act) + '</span></li>').join('');
  els.pendingPanel.innerHTML = '<button type="button" class="pp-toggle" data-pp-toggle aria-expanded="' + (collapsed ? 'false' : 'true') + '">' +
    '<span class="pp-dot"></span><span class="pp-title">待执行命令 · tick ' + tac.plan.tick + '</span>' +
    '<span class="pp-count mono" title="有效指令数">' + rows.length + '</span><span class="pp-chev">' + (collapsed ? '▸' : '▾') + '</span></button>' +
    '<div class="pp-body"' + (collapsed ? ' hidden' : '') + '><ul class="pp-list">' + body + '</ul></div>';
  els.pendingPanel.hidden = false;
  els.pendingPanel.querySelector('[data-pp-toggle]')?.addEventListener('click', () => {
    tac.pendingCollapsed = !tac.pendingCollapsed;
    tactRenderPending();
  });
}

/** 回放事件特效：当前回放帧的事件（战斗/资源活动）弹出浮字+光晕，2.5s 淡出上浮。 */
const FX_LIFE_MS = 2500;
const FX_KIND_CN = {
  HARVEST_SUCCEEDED: { text: '+', color: '#76b889', size: 13 },
  DEPOSIT_SUCCEEDED: { text: '¥', color: '#5fd4e8', size: 13 },
  SHOT_HIT: { text: '✚', color: '#c66370', size: 13 },
  SWEEP_RESOLVED: { text: '⚔', color: '#d8b64e', size: 13 },
  CORE_DAMAGED: { text: '⚔', color: '#ff6b6b', size: 14 },
  CORE_DESTROYED: { text: '摧毁!', color: '#ff5560', size: 18 },
  CORE_SPAWN_SUCCEEDED: { text: '产', color: '#5fd4e8', size: 12 },
  UNIT_HEAL_SUCCEEDED: { text: '✚', color: '#76b889', size: 12 },
};
function tactSpawnEventFx(frameTick) {
  const d = replay.data;
  if (!d || !d.eventFrames) return;
  const frame = d.eventFrames.find((f) => f.tick === frameTick);
  if (!frame) return;
  const tac = T();
  for (const ev of frame.events) {
    const spec = FX_KIND_CN[ev.t] ?? null;
    if (!spec) continue;
    const amount = ev.v ? (ev.v.amount !== undefined ? ev.v.amount : ev.v.damage !== undefined ? ev.v.damage : ev.v.hp !== undefined ? ev.v.hp : '') : '';
    tac.eventFx.push({ x: ev.p[0], y: ev.p[1], kind: ev.t, text: spec.text + (amount !== '' ? amount : ''), color: spec.color, size: spec.size, born: performance.now(), seq: ++tac.fxSeq });
    // 销毁碎片：单位/核心被摧毁时迸溅
    if (ev.t === 'UNIT_DESTROYED' || ev.t === 'CORE_DESTROYED') {
      const n = ev.t === 'CORE_DESTROYED' ? 14 : 8;
      const color = ev.t === 'CORE_DESTROYED' ? '#ff5560' : '#d8b64e';
      for (let i = 0; i < n; i++) {
        const ang = Math.random() * Math.PI * 2, sp = 0.6 + Math.random() * 1.7;
        tac.debris.push({ x: ev.p[0], y: ev.p[1], vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 0.4, color, born: performance.now(), life: 900 + Math.random() * 600 });
      }
    }
  }
  if (tac.eventFx.length > 80) tac.eventFx.splice(0, tac.eventFx.length - 80);
  if (tac.debris.length > 240) tac.debris.splice(0, tac.debris.length - 240);
}
function tactDrawEventFx(s) {
  const tac = T();
  if (!tac.eventFx.length) return;
  const now = performance.now();
  const alive = [];
  for (const fx of tac.eventFx) {
    const age = now - fx.born;
    if (age > FX_LIFE_MS) continue;
    alive.push(fx);
    const t = age / FX_LIFE_MS;
    const fade = 1 - t * t;
    const p = project(fx.x, fx.y);
    ctx.save();
    ctx.globalAlpha = Math.max(0, fade);
    ctx.fillStyle = fx.color;
    ctx.font = '700 ' + fx.size + 'px "Geist Mono", ui-monospace, Consolas, monospace';
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
    const now2 = performance.now();
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

async function handleCanvasClick(px, py) {
  const tac = T();
  const cell = nearestCell(px, py);
  if (tac.mode === 'MOVE' && tac.selected) {
    const world = tac.worlds[tac.selected.tenant];
    if (world) {
      // 移动目标可为任意格（世界坐标反算），不需要命中已测绘 cell
      const wx = Math.round(state.view.cx + (px - W() / 2) / state.view.scale);
      const wy = Math.round(state.view.cy + (py - H() / 2) / state.view.scale);
      const path = tactFindPath(world, tac.selected.obj.position, [wx, wy], tac.selected.tenant);
      if (path) {
        tac.moveGoals[tac.selected.obj.id] = [wx, wy];
        tac.moveRoute = { path };
        tac.routePreview = null;
        tac.mode = null;
        tactRenderActionDialog(); tactRenderInspect(); draw();
      }
    }
    return;
  }
  if (tac.mode === 'SHOOT' && tac.selected && cell) {
    const world = tac.worlds[tac.selected.tenant];
    if (world) {
      const target = tactObjectAt(world, cell.x, cell.y);
      if (target && target.controlled === false) {
        tac.attackTarget = { obj: target };
        tac.mode = null;
        tactRenderActionDialog(); tactRenderInspect(); draw();
      }
    }
    return;
  }
  if (tac.mode === 'SWEEP' && tac.selected && cell) {
    tac.mode = null;
    tactRenderActionDialog(); draw();
    return;
  }
  if (cell && (cell.type === 'unit' || cell.type === 'core')) {
    const world = await tactLoadWorld(cell.tenant);
    const obj = world ? tactObjectAt(world, cell.x, cell.y) : null;
    if (obj) { await tactSelect(cell.tenant, obj); return; }
  }
  tactClear();
}
function updateBeaconIndicator() {
  const els2 = els.beaconIndicator;
  const b = state.soloTenant ? state.beacons.find((x) => x.tenant === state.soloTenant) : null;
  if (!b || !state.view.ready) { els2.hidden = true; return; }
  const p = project(b.x, b.y);
  const w = W(), h = H();
  if (p.sx >= 0 && p.sx <= w && p.sy >= 0 && p.sy <= h) { els2.hidden = true; return; }
  const cx = w / 2, cy = h / 2;
  const dx = p.sx - cx, dy = p.sy - cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const inset = 40;
  const k = Math.min((w / 2 - inset) / Math.abs(ux || 1e-9), (h / 2 - inset) / Math.abs(uy || 1e-9));
  const ex = cx + ux * k, ey = cy + uy * k;
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  els2.hidden = false;
  els2.style.left = `${ex}px`;
  els2.style.top = `${ey}px`;
  els2.innerHTML = `<button class="beacon-arrow" title="定位信标 [${b.x}, ${b.y}]" style="transform:rotate(${angle + 90}deg)"></button>`;
  els2.querySelector('.beacon-arrow').addEventListener('click', () => {
    state.view.cx = b.x; state.view.cy = b.y;
    draw();
  });
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
