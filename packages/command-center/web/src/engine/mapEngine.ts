// 保持 JS 语义，全量类型化列为独立迁移项（见 DESIGN.md §7 技术债）。
/* Arena 指挥面板前端引擎 — 由 React（command-center/web）挂载到地图宿主容器。
 * 由 legacy app.js（2026-08-09 退役删除）移植：chrome（顶栏/侧栏/决策流/对话框）剥离到 React 组件，
 * 地图/战术/回放/覆盖层保持原生 Canvas + DOM。入口 createMapEngine(host)。 */
import { SPRITE, hash2, fmt, shortId, ageText, hexA, EASE_OUT_CUBIC, EASE_OUT_QUART, maxUnitHp, unitSpritePath, escapeHtml, pKey, samePos, bucketScale, gridStepFor, extendScreen, replayInterp } from './utils.js';
import { CANVAS_FONT, setCtx, ring, drawMeterBar, drawUnitHealth, drawWorkerCargo, drawCoreOwnerLabel, drawStackBadge } from './canvas.js';
import { createMinimap } from './minimap.ts';
let minimap: ReturnType<typeof createMinimap> | null = null; // createMapEngine 时初始化
import { getJSON, fetchJSONWithETag } from './api.js';
import { TENANT_COLORS, TENANT_LABEL, DECISION_KIND_CN, EVENT_KIND_CN, TACT_UNIT_BASE_COST, TACT_UNIT_CN, TACT_ACTION_CN, TACT_DIRECTION_ACTIONS, TACT_TARGET_ACTIONS, TACT_STEPS, TACT_RANGER_RAYS, TACT_ACTION_ICON, INTENT_LABEL_CN, intentLabelCn, tactCoreCapacity, tactUnitCost, tactObjectNear, tactObjectAt, tactTerrain, tactHostileAt, tactMoveTargets, tactRangerRange, tactRangerTargets, tactVisibility, tactAvailability } from './tactical.js';
import { findPath } from './pathfind.ts';
import { createReplayState, replayAdvance, replayLoad, replayStep, replayToggle, replayCycleSpeed, updateReplayUI, replayDrawLayer as replayDrawImpl } from './replay.js';
import { renderStars, renderVignette, renderGrid, renderGridLabels, renderGlobalChunks, renderTenantRegions, type EnvRenderDeps } from './render.ts';
import { spawnEventFx, drawEventFx } from './fx.js';
import { commandTelemetryDeltas as teleDeltas, commandGoalOf as cmdGoalOf, commandActionOf as cmdActionOf, unitHumanCommandOf as cmdHumanOf, commandStatusText as cmdStatusText, unitTelemetryOf as cmdUnitTelemetry, unitCommandLabel as cmdLabel, squadSummary as cmdSquad } from './commands.js';

const TENANTS = ['t1', 't2', 't3', 't4'];
const POLL_MS = 3000;
const UNIT_ICONS: Record<string, string> = { resource: '/assets/ui/icons/resource.png', population: '/assets/ui/icons/population.png' };
/** Canvas font: bold sans stack - Geist for latin, PingFang/YaHei/Noto Sans CJK for CJK (never SimSun). */
/* ============================================================
 * 内部数据接口：官方快照/事件为 legacy JSON 结构，核心公共 API 类型见 types.ts。
 * 字段以运行时为准，索引签名兜底（渐进类型化：结构 + 常用字段精确，其余宽松）。
 * ============================================================ */
interface Jsonish { [key: string]: any }
interface ViewState extends Jsonish { cx: number; cy: number; scale: number; ready: boolean; vw?: number; vh?: number }
interface MapCell extends Jsonish { x: number; y: number }
interface TickMeterState extends Jsonish { period: number; lastMtime: number; lastTick: number; lastPollMtime: number; lastPollTick: number }
interface ZoomState extends Jsonish { active: boolean; tx: number; ty: number; ts: number; lastTs: number }
interface TacticalState extends Jsonish {
  surveys: Record<string, Jsonish>;
  worlds: Record<string, Jsonish>;
  plans: Record<string, Jsonish>;
  selected: Jsonish | null;
  multi: Set<string>;        // 多选：单位 id 集合（Shift 框选/点击），主选中仍在 selected
  boxSelect: Jsonish | null; // 框选拖拽：{ x0, y0, x1, y1 }（世界坐标）
  queues: Record<string, Jsonish[]>; // 命令队列：unitId -> [{ kind:'goto'|'mine', target:[x,y] }]
  mode: string | null;
  moveGoals: Record<string, [number, number]>;
  moveRoute: Jsonish | null;
  attackTarget: Jsonish | null;
  plan: Jsonish | null;
  routePreview: Jsonish | null;
  eventFx: Jsonish[];
  debris: Jsonish[];
  fxSeq: number;
  cmdTelemetry: Record<string, Jsonish>;
}
interface ArenaState extends Jsonish {
  map: Jsonish | null;
  overview: Jsonish | null;
  streams: Record<string, Jsonish[]>;
  events: Record<string, Jsonish[]>;
  view: ViewState;
  layers: Record<string, boolean>;
  tenantsOn: Record<string, boolean>;
  soloTenant: string | null;
  tab: string;
  cellIndex: Map<string, MapCell>;
  cells: MapCell[];
  chunks: Jsonish[];
  beacons: Jsonish[];
  coreTrails: Jsonish[];
  intel: Jsonish | null;
  enemyMemoryHits: Jsonish[];
  surveyHits: Map<string, Jsonish>;
  enemyHeat: Jsonish | null;
  enemyHeatMax: number;
  threatRose: Jsonish | null;
  threatRoseAt: number;
  jumpMark: { x: number; y: number; at: number } | null;
  jumpPins: Jsonish[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  lastRefresh: number;
  unitPrev: Map<string, Jsonish>;
  tickMeter: TickMeterState;
  drag: Jsonish | null;
  hover: Jsonish | null;
  hoverKey: string;
  streamCollapsed: boolean;
  streamHeight: number;
  streamFilterQuiet: boolean;
  streamLive: Jsonish | null;
  viewAnim: Jsonish | null;
  zoom: ZoomState;
  cc: { tick: number | null; anchor: number };
  terrainSig: number;
  tactical: TacticalState;
}

const state: ArenaState = {
  map: null,
  overview: null,
  streams: {},          // tenant -> rows
  events: {},           // tenant -> events
  view: { cx: 0, cy: 0, scale: 8, ready: false },
  layers: { obstacle: true, resource: true, unit: true, core: true, beacon: true, beaconTrail: true, survey: true, patrol: true, plan: true, trail: true, beaconEdge: true, coreTrail: true, enemyMemory: true, enemyHeat: true },
  tenantsOn: { t1: true, t2: true, t3: true, t4: true },
  soloTenant: null,     // null=全局联盟；'t1'..'t4'=单租户
  tab: 'all',           // all | t1 | t2 | t3 | t4 | events
  cellIndex: new Map(),
  cells: [],
  chunks: [],
  beacons: [],
  coreTrails: [],
  intel: null,
  enemyMemoryHits: [],  // 敌情记忆命中点（drawEnemyMemory 构建，hover 用）：{sx,sy,kind,...}
  enemyHeat: null,      // 敌情热区（/api/intel/heat）：16×16 桶敌方目击密度/兵力构成
  enemyHeatMax: 0,      // 热区桶 count 最大值（归一化强度）
  threatRose: null,     // 威胁扇区玫瑰（/api/alliance/snapshot threatSummaries，全局联盟）
  threatRoseAt: 0,      // 上次拉取时间戳（20s 节流）
  jumpMark: null,       // 跳转定位标记（目击/扇区/事迹跳图后短暂脉冲圈，防丢失目标）
  jumpPins: [],          // 跳图定位标记集合（持久可见，点击/Esc 可清除）
  surveyHits: new Map(), // 测绘记忆命中（tactSurveyLayer 构建）：cellKey -> {kind,tick,state,seenCount,firstSeen}
  bounds: null,
  lastRefresh: 0,
  /** 单位上一次轮询位置（smooth 插值：poll 之间单位按 POLL_MS 渐变移动）。 */
  unitPrev: new Map(),
  /** 世界 tick 周期估计（官方 ~15s/tick）：由 overview tick/mtime 差分推算。 */
  tickMeter: { period: 15000, lastMtime: 0, lastTick: 0, lastPollMtime: 0, lastPollTick: 0 },
  drag: null,
  hover: null, hoverKey: '',
  streamCollapsed: false,
  streamHeight: 244,             // 决策流高度（可拖拽 140-460px，持久化）
  streamFilterQuiet: false, // 「只看决策」：隐藏无需决策行
  streamLive: null, // 折叠态胶囊：最新一条决策摘要
  viewAnim: null,
  zoom: { active: false, tx: 0, ty: 0, ts: 1, lastTs: 0 }, // 滚轮缩放阻尼目标视图
  cc: { tick: null, anchor: 0 }, // 命令窗口：最近观测到的计划 tick + 观测时刻（15s 倒计时）
  terrainSig: 0,               // 障碍/资源测绘签名：仅地形变化时重建底图缓存
  tactical: {
    surveys: {},      // tenant -> { obstacleCells, resourceCells, ... }（累积测绘）
    worlds: {},       // tenant -> { state, tick }
    plans: {},        // tenant -> { tick, plan } 最新决策计划（全局联盟 4 租户算法决策虚线）
    selected: null,   // { tenant, obj }
    multi: new Set(), // 多选单位 id（Shift 框选/点击；主选中在 selected）
    boxSelect: null,  // 框选拖拽矩形（世界坐标）
    queues: {},       // 命令队列：unitId -> [{ kind:'goto'|'mine', target:[x,y] }]
    mode: null,       // null | MOVE | SHOOT | SWEEP
    moveGoals: {},    // objId -> [x, y]（演练移动目标）
    moveRoute: null,  // { tenant, obj, path }
    attackTarget: null, // { tenant, obj }
    plan: null,       // { tick, plan } 最新决策计划（待执行命令 + 计划箭头）
    routePreview: null, // { path } MOVE 悬停预览路线
    eventFx: [],      // 回放/事件特效 [{ x, y, kind, text, born }]
    debris: [],       // 销毁碎片 [{ x, y, vx, vy, color, born, life }]
    fxSeq: 0,
    // 人类指令遥测追踪：{ tenant -> { sig, lastAppliedAt } }（拒绝/满足 toast 去重）
    cmdTelemetry: {},
    batchLast: null, // 批量命令最近提交：{ n, type, at, applied, rejected }（编队 HUD 反馈）
  },
};

/** 高刷/高分适配：DPR 上限（4K/5K 屏 dpr 可达 2-3，canvas 像素 = css×dpr²，
 *  175Hz 下满 DPR 会撑爆 fill-rate；cap 2.0 平衡清晰度与帧率——业界常见做法）。
 *  动画/缩放期间再降到 1.5（LQ 降级）：静止恢复全清晰度。 */
const DPR_CAP = 2.0;
const DPR_ANIM = 1.5;
function effDpr() {
  const dpr = window.devicePixelRatio || 1;
  return Math.min(dpr, LQ ? DPR_ANIM : DPR_CAP);
}

let ROOT: HTMLElement = document.body; // 挂载时替换为地图宿主容器（createMapEngine(host)）
const $ = (sel: string): HTMLElement | null => ROOT.querySelector(sel);
/** DOM 元素引用（buildEls 填充；元素由 React 渲染，缺失时置 null 并在使用处保护）。 */
let els: any = {};
function buildEls() {
  return {
  canvas: $('#map'), minimap: $('#minimap'), clock: $('#clock'), dataRoot: $('#dataRoot'), badge: $('#refreshBadge'),
  tenantCards: $('#tenantCards'), legendList: $('#legendList'), tenantToggles: $('#tenantToggles'),
  streamTabs: $('#streamTabs'), streamBody: $('#streamBody'), streamJump: $('#streamJump'),
  tooltip: $('#mapTooltip'), hint: $('#mapHint'),
  redeemBtn: $('#redeemBtn'), redeemDialog: $('#redeemDialog'), redeemClose: $('#redeemClose'),
  intelBtn: $('#intelBtn'), intelDialog: $('#intelDialog'), intelClose: $('#intelClose'), intelTabs: $('#intelTabs'), intelBody: $('#intelBody'), intelMeta: $('#intelMeta'),
  redeemResult: $('#redeemResult'), redeemHistory: $('#redeemHistory'), streamGrip: $('#streamGrip'),
  shopCookie: $('#shopCookie'), cookieSave: $('#cookieSave'), cookieTest: $('#cookieTest'),
  shopAccount: $('#shopAccount'), shopList: $('#shopList'),
  zoomLevel: $('#zoomLevel'), mapGlobal: $('#mapGlobal'), soloBadge: $('#soloBadge'), viewGlobal: $('#viewGlobal'), viewFit: $('#viewFit'), streamToggle: $('#streamToggle'), streamPane: $('#streamPane'), streamCount: $('#streamCount'), streamLive: $('#streamLive'), streamFilter: $('#streamFilter'),
  actionDialog: $('#actionDialog'), ctxMenu: $('#ctxMenu'), inspectPanel: $('#inspectPanel'), featurePanel: $('#featurePanel'),
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
}



/* ---------- 偏好持久化（本机 localStorage，非敏感） ---------- */
const PREFS_KEY = 'arena-cc.prefs';
const PREFS_TABS = ['all', 't1', 't2', 't3', 't4', 'events'];
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') || {}; } catch { return {}; }
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      streamCollapsed: state.streamCollapsed,
      streamHeight: state.streamHeight,
      streamFilterQuiet: state.streamFilterQuiet,
      tab: state.tab,
      layers: state.layers,
    }));
  } catch { /* 隐私模式等场景忽略 */ }
}
/** 启动时恢复持久化偏好：折叠/只看决策/标签页/图层开关。 */
function applyPrefs() {
  const p = loadPrefs();
  if (p.layers && typeof p.layers === 'object') {
    for (const k of Object.keys(state.layers)) if (typeof p.layers[k] === 'boolean') state.layers[k] = p.layers[k];
  }
}
/** 图层复选框与 state.layers 同步（恢复持久化后调用一次）。 */
function syncLayerToggles() {
  document.querySelectorAll<HTMLInputElement>('#layerToggles input').forEach((el) => { el.checked = !!state.layers[el.dataset.layer ?? '']; });
}

let ctx: any = null; // createMapEngine 时初始化（CanvasRenderingContext2D；legacy 动态数据流，宽松标注）
/** 环境渲染层依赖（render.ts 注入）：ctx/state.view 在静态缓存渲染期间会被
 *  临时替换，故全部经 getter 调用时解析；state 为模块级对象（const），
 *  闭包直接引用，无 per-instance 拷贝。 */
let envDeps: EnvRenderDeps | null = null;
function envDepsOf(): EnvRenderDeps {
  if (!envDeps) {
    envDeps = {
      getCtx: () => ctx,
      W, H, project,
      getView: () => state.view,
      getCells: () => state.cells,
      getChunks: () => state.chunks,
      getTenantsOn: () => state.tenantsOn,
      lq: () => LQ,
    };
  }
  return envDeps;
}
const images: Record<string, HTMLImageElement> = {};
/* 地图提示自动淡出：交互时重现，闲置 4.5s 后淡出（画布更干净） */
let hintTimer: ReturnType<typeof setTimeout> | null = null;
function pokeHint() {
  if (!els.hint) return;
  els.hint.classList.remove('map-hint-fade');
  clearTimeout(hintTimer ?? undefined);
  hintTimer = setTimeout(() => els.hint.classList.add('map-hint-fade'), 4500);
}
/* tick 数字闪亮：tick 前进时短暂白闪（"世界在走"的呼吸感） */
let lastTickLabelTick = -1;

/* ---------- 静态地形缓存（缩放性能核心） ----------
 * 慢层（租户疆域 / 测绘 / 障碍 / 资源）按"缩放桶"离屏预渲染；
 * 缩放 / 平移期间每帧只贴一次底图 + 重绘少量动态层（单位/核心/信标/轨迹/特效），
 * 避免全量重绘卡顿。参考 MDN Optimizing canvas / Mozilla pinch-zoom 最佳实践：
 * 离屏预渲染、按比例桶重栅格化、动画期间降级（关 shadowBlur 与高成本细节）。 */
const STATIC_PAD = 1.6;                 // 缓存比视口大 60%：小范围平移免重建
const staticCache: { canvas: HTMLCanvasElement | null; cctx: CanvasRenderingContext2D | null; cssW: number; cssH: number; scale: number; cx: number; cy: number; ready: boolean } = { canvas: null, cctx: null, cssW: 0, cssH: 0, scale: 0, cx: 0, cy: 0, ready: false };
let staticDirty = true;
let LQ = false; // 动画/缩放阻尼期间降级渲染
let surveySkipped = false; // 动画期间跳过测绘层后，结束需补一次全质量重建 // 缩放/平移动画期间：低质量模式（关 shadowBlur / 高成本细节）
function invalidateStatic() { staticDirty = true; }
function staticNeedsRebuild(bs: number): boolean {
  if (staticDirty || !staticCache.ready || staticCache.scale !== bs) return true;
  // 可平移余量 = 缓存覆盖半宽 - 视口半宽（随当前缩放自适应，保证视口不越出缓存）
  const mw = W() / 2 / bs * STATIC_PAD - W() / 2 / state.view.scale;
  const mh = H() / 2 / bs * STATIC_PAD - H() / 2 / state.view.scale;
  return Math.abs(state.view.cx - staticCache.cx) > mw || Math.abs(state.view.cy - staticCache.cy) > mh;
}
function renderStaticCache(bs: any) {
  const dpr = effDpr();
  const w = Math.max(1, Math.round(W() * STATIC_PAD)), h = Math.max(1, Math.round(H() * STATIC_PAD));
  if (!staticCache.canvas) { staticCache.canvas = document.createElement('canvas'); staticCache.cctx = staticCache.canvas.getContext('2d', { alpha: false }) ?? staticCache.canvas.getContext('2d'); }
  const dw = Math.max(1, Math.round(w * dpr)), dh = Math.max(1, Math.round(h * dpr));
  if (staticCache.canvas.width !== dw) staticCache.canvas.width = dw;
  if (staticCache.canvas.height !== dh) staticCache.canvas.height = dh;
  staticCache.cssW = w; staticCache.cssH = h;
  const cctx = staticCache.cctx!;
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cctx.clearRect(0, 0, w, h);
  const ax = state.view.cx, ay = state.view.cy;
  const prevCtx = ctx, prevView = state.view;
  ctx = cctx;
  // 缓存画布即"视口"：vw/vh 覆盖使 project/visibleCells 以画布中心为锚（内容铺满画布，blit 对齐画布中心）
  state.view = { ...prevView, cx: ax, cy: ay, scale: bs, vw: w, vh: h };
  try {
    const s = bs;
    if (!state.soloTenant) renderTenantRegions(envDepsOf(), s);
    renderGlobalChunks(envDepsOf(), s); // 全局探索分区底纹（/api/map chunks，跨租户合并）
    renderGrid(envDepsOf(), W(), H()); // 网格线并入静态缓存：平移/缩放重建一次，不再每帧画
    if (!LQ) tactSurveyLayer(s); else surveySkipped = true; // 动画期间跳过最贵的测绘记忆层，结束补建
    const cells = visibleCells();
    const buckets: Record<string, any[]> = { obstacle: [], resource: [] };
    for (const c of cells) {
      if (!buckets[c.type]) continue;
      // solo 视图：记忆层由 tactSurveyLayer 负责（chunks 底纹 + 状态着色），
      // 全局层只画当前帧（fresh），避免同源数据双画重叠（2026-08-08 链路打通）
      if (state.soloTenant && !c.fresh) continue;
      buckets[c.type].push(c);
    }
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
function loadImage(url: any): Promise<any> {
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
  [SPRITE.core, SPRITE.worker, SPRITE.vanguard, SPRITE.ranger].forEach((u, i) => { if (results[i].status === 'fulfilled') images[u] = (results[i] as PromiseFulfilledResult<any>).value; });
  SPRITE.crystal.forEach((u, i) => { if (results[i + 4].status === 'fulfilled') images[u] = (results[i + 4] as PromiseFulfilledResult<any>).value; });
  SPRITE.obstacle.forEach((u, i) => { if (results[i + 6].status === 'fulfilled') images[u] = (results[i + 6] as PromiseFulfilledResult<any>).value; });
  if (results[8].status === 'fulfilled') images[SPRITE.beacon] = (results[8] as PromiseFulfilledResult<any>).value;
  [UNIT_ICONS.resource, UNIT_ICONS.population].forEach((u, i) => { if (results[i + 9].status === 'fulfilled') images[u] = (results[i + 9] as PromiseFulfilledResult<any>).value; });
}

/* ---------- 数据拉取 ---------- */

async function poll() {
  // 逐端点容错（2026-08-08）：单个端点慢/失败不再整轮 abort——并行 agent 高 CPU 时
  // overview/map 可能 >8s，原来 Promise.all 一挂全挂导致"界面卡住/单位冻结"。
  // 成功才覆盖 state，失败保留上一轮数据（地图/单位不闪没）。
  const [oR, mR, iR] = await Promise.allSettled([
    getJSON('/api/overview', 30000), fetchJSONWithETag('/api/map', 30000), getJSON('/api/intel', 30000),
  ]);
  const overview = oR.status === 'fulfilled' ? oR.value : null;
  const map = mR.status === 'fulfilled' ? mR.value : null;
  const intel = iR.status === 'fulfilled' ? iR.value : null;
  const pollOk = !!overview; // 退避信号：overview 拿到=成功（map/intel 容错降级不算失败）
  try {
    if (overview) state.overview = overview;
    if (intel) { state.intel = intel; emit('intel', intel); }
    loadEnemyHeat();
    if (!map) {
      // 地图端点失败：保留上一轮 cells 继续渲染（插值/动画不中断），下轮 poll 恢复
      captureUnitPrev();
      if (!state.view.ready && state.bounds && state.cells.length) fitView();
      emit('overview', state.overview);
      draw();
      return pollOk;
    }
    state.map = map;
    state.cells = map.cells ?? [];
    state.chunks = map.chunks ?? [];
    state.beacons = map.beacons ?? [];
    state.coreTrails = map.coreTrails ?? [];
    state.bounds = map.bounds ?? null;
    state.cellIndex = new Map();
    // 索引键 = `tenant:x,y`（与后端 loadMergedMap 对齐，2026-08-08）：
    // 多租户同格各自保留，查目标格时带上当前租户，避免误判他租户的地形/单位。
    // 地形按共享世界全局去重后（后端合并键 `type:x,y`），额外注册全局 `x,y` 键
    // 供 hover/命令模式回退（solo 租户未必是地形最后观测租户）。
    for (const c of state.cells) {
      state.cellIndex.set(`${c.tenant}:${c.x},${c.y}`, c);
      if (c.type === 'obstacle' || c.type === 'resource') state.cellIndex.set(`${c.x},${c.y}`, c);
    }
    // 静态层脏检查：仅当障碍/资源测绘变化才重建底图缓存（单位移动不触发重建）
    let sig = 0, n = 0;
    for (const c of state.cells) {
      if (c.type === 'obstacle' || c.type === 'resource') { sig = (sig + c.x * 73856093 + c.y * 19349663 + (c.type === 'obstacle' ? 1 : 2)) >>> 0; n++; }
    }
    sig = (sig ^ (n * 2654435761)) >>> 0;
    if (sig !== state.terrainSig) { state.terrainSig = sig; invalidateStatic(); }
    if (overview?.dataRoot) emit('dataRoot', overview.dataRoot);
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
    // 单位平滑插值（先更新 tickMeter 再 capture：动画窗口对齐 tick 边界，见 captureUnitPrev）
    captureUnitPrev();
    if (!state.view.ready && state.bounds && state.cells.length) fitView();
    emit('overview', state.overview);
    draw();
    if (state.soloTenant) tactRefreshLive(state.soloTenant);
    else { loadGlobalPlans(); refreshAllCommands(); loadThreatRose(); }
  } catch (err) {
    emit('refresh', false);
    console.warn('poll failed', err);
    return false;
  }
  return pollOk;
}

let pollStreamsTick = 0;
let lastStreamSig = "";
/** 决策流轮询（2026-08-10 优化）：世界 tick ~15s，决策/事件本质按 tick 变化——
 *  3s 轮询 5 次里 4 次冗余（trace 实测主线程 93% busy 的轮询风暴源头之一）。
 *  15s 对齐 tick + emit 前签名去重：同一 tick 段重复响应不触发 React 重渲。 */
async function pollStreams() {
  pollStreamsTick++;
  // events 与 stream 同频 15s（事件非实时决策数据，此前 3s→15s 的降频由同 tick 覆盖）
  const active = state.tab === 'all' ? TENANTS : state.tab === 'events' ? [] : [state.tab];
  if (state.tab === 'events') {
    const results = await Promise.allSettled(TENANTS.map((t) => getJSON(`/api/events?tenant=${t}&n=80`)));
    state.events = {};
    results.forEach((r, i) => { if (r.status === 'fulfilled') state.events[TENANTS[i]] = r.value.events ?? []; });
  } else {
    const results = await Promise.allSettled(active.map((t) => getJSON(`/api/stream?tenant=${t}&n=80`)));
    results.forEach((r, i) => { if (r.status === 'fulfilled') state.streams[active[i]] = r.value.rows ?? []; });
    // 统一决策页预取事件：事件页徽标即时显示 + 切页秒开
    if (state.tab === 'all' && pollStreamsTick % 2 === 1) {
      const evResults = await Promise.allSettled(TENANTS.map((t) => getJSON(`/api/events?tenant=${t}&n=80`)));
      state.events = {};
      evResults.forEach((r, i) => { if (r.status === 'fulfilled') state.events[TENANTS[i]] = r.value.events ?? []; });
    }
  }
  // 签名去重：内容未变（同 tick 段）不 emit，StreamPane 不重渲
  const sig = TENANTS.map((t) => {
    const rows = state.streams[t] ?? [];
    const first = rows[0];
    return `${t}:${rows.length}:${first?.tick ?? 0}:${first?.deadlineOutcome ?? ""}`;
  }).join("|") + `|ev:${TENANTS.reduce((a, t) => a + (state.events[t]?.length ?? 0), 0)}`;
  if (sig === lastStreamSig) return;
  lastStreamSig = sig;
  emit('streams', { tab: state.tab, streams: state.streams, events: state.events });
}

/* ---------- 地图投影 / 交互 ---------- */
function resizeCanvas() {
  const dpr = effDpr();
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
function fitSolo(tenant: any) {
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
function animateView(to: any, duration = 680) {
  state.viewAnim = { from: { cx: state.view.cx, cy: state.view.cy, scale: state.view.scale }, to, t0: performance.now(), duration };
  state.zoom.active = false; // fit/双击接管：取消缩放阻尼
}
/** 滚轮缩放阻尼（惯性，2026-08-07）：每帧按 dt 指数趋近目标视图——帧率无关、
 *  连续跟手（参考地图工具最佳实践：target + exponential smoothing，事件驱动目标，
 *  动画帧驱动趋近）。快速滚轮/触控板捏合不再逐格重启动画，停止后自然惯性收敛。 */
function stepZoom(ts: any) {
  const z = state.zoom;
  const dt = Math.min(120, Math.max(1, ts - z.lastTs));
  z.lastTs = ts;
  const k = 1 - Math.exp(-dt / 88); // ~88ms 时间常数（2026-08-08 跟手性微调：收敛更快，滚轮/缩放更跟手；指数趋近无过冲）
  const v = state.view;
  v.cx += (z.tx - v.cx) * k;
  v.cy += (z.ty - v.cy) * k;
  v.scale += (z.ts - v.scale) * k;
  // 收敛阈值放宽（scale 0.001→0.01、位置 0.02→0.2）：指数渐近尾部慢拖是"缩放不跟手"主因，
  // <1% 视觉差异提前停住，动画 ~2 时间常数更快收敛（2026-08-08）
  const settled = Math.abs(z.ts - v.scale) < 0.01 && Math.hypot(z.tx - v.cx, z.ty - v.cy) < 0.2;
  if (settled) {
    v.cx = z.tx; v.cy = z.ty; v.scale = z.ts;
    z.active = false;
  }
}
function applyViewAnim(ts: any) {
  const a = state.viewAnim;
  if (!a) return;
  const p = Math.min(1, (ts - a.t0) / a.duration);
  const e = 1 - Math.pow(1 - p, 3);
  state.view.cx = a.from.cx + (a.to.cx - a.from.cx) * e;
  state.view.cy = a.from.cy + (a.to.cy - a.from.cy) * e;
  state.view.scale = a.from.scale + (a.to.scale - a.from.scale) * e;
  if (p >= 1) state.viewAnim = null;
}
function project(x: any, y: any) {
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

/** 单位移动动画窗口 = tick 周期（~15s，与顶部读条同步）：poll 3s 只做数据
 *  采样，动画跨整个 tick——"tick 走完 = 单位到位"，单位全程可见移动，
 *  不再出现"读条还有 12s 单位已停在终点"的观感矛盾。 */
function movementWindowMs() {
  const p = state.tickMeter.period;
  return Number.isFinite(p) && p > 0 ? p : 15000;
}
/** 单位平滑插值快照（2026-08-07）：poll 拿到新单位位置时保留旧位置
 *  （px,py → x,y），draw 之间按 movementWindowMs() 渐变移动（与 tick 同步）。 */
function captureUnitPrev() {
  const now = performance.now();
  const seen = new Set();
  const m = state.tickMeter;
  const win = movementWindowMs();
  // 动画终点对齐 tick 边界：overview mtime ≈ 最新 case 写入时刻（tick 起点）。
  // 窗口 = 发现时刻 → 本 tick 结束（rem），线性走完 = 单位到位，不提前/不拖尾。
  const boundary = Number.isFinite(m.lastMtime) && m.lastMtime > 0 ? m.lastMtime : null;
  const rem = boundary == null ? null : (boundary + win) - Date.now();
  for (const c of state.cells) {
    if (c.type !== 'unit') continue;
    const k = c.tenant + ':' + c.id;
    seen.add(k);
    const prev = state.unitPrev.get(k);
    if (!prev) state.unitPrev.set(k, { x: c.x, y: c.y, px: c.x, py: c.y, ts: now, win });
    else if (prev.x !== c.x || prev.y !== c.y) {
      prev.px = prev.x; prev.py = prev.y; prev.x = c.x; prev.y = c.y; prev.ts = now;
      prev.win = rem == null ? win : Math.max(500, Math.min(win, rem));
    }
  }
  // 清理已消失的单位（防 Map 无限增长）
  for (const k of state.unitPrev.keys()) if (!seen.has(k)) state.unitPrev.delete(k);
}
/** 单位当前绘制位置：插值（ease-out）或精确格。 */
function unitDrawPos(c: any) {
  const m = state.unitPrev.get(c.tenant + ':' + c.id);
  if (m && (m.px !== m.x || m.py !== m.y)) {
    const win = m.win || movementWindowMs();
    const elapsed = performance.now() - m.ts;
    if (elapsed < win) {
      const t = Math.min(1, elapsed / win); // 线性：单位进度 = tick 读条进度（不提前到终点）
      return { x: m.px + (m.x - m.px) * t, y: m.py + (m.y - m.py) * t };
    }
  }
  return { x: c.x, y: c.y };
}

// 调试观测钩子（本地指挥面板）：暴露引擎内部状态，供 Playwright/控制台精确验证动画/测绘。
// 仅在浏览器环境启用；不影响绘制逻辑。
if (typeof window !== 'undefined') {
  (window as any).__arena = {
    get state() { return state; },
    unitDrawPos,
    movementWindowMs,
    captureUnitPrev,
    tactSelect,
    tactClear,
    tactChooseAction,
    draw,
    tactShowFeature,
    get tac() { return T(); },
  };
}
/* ---------- 渲染 ---------- */
function draw() {
  const w = W(), h = H();
  ctx.clearRect(0, 0, w, h);
  renderStars(envDepsOf(), w, h); // 氛围层（星点+暗角）离屏缓存 blit
  const s = state.view.scale;
  const animating = !!state.viewAnim || state.zoom.active;
  LQ = animating; // 动画/缩放阻尼期间降级：静态缓存跳过测绘记忆层，动态层关 shadowBlur
  if (!animating && surveySkipped) { surveySkipped = false; invalidateStatic(); } // 动画结束补一次全质量重建
  const bs = bucketScale(s);
  if (staticNeedsRebuild(bs)) renderStaticCache(bs);
  blitStatic();
  LQ = animating;
  if (!LQ) renderGridLabels(envDepsOf(), w, h); // 坐标刻度（动态层：动画期间跳过）
  const replayActive = replay.data && replay.loadedFor === state.soloTenant;
  if (state.layers.enemyHeat !== false) drawEnemyHeat(s); // 敌情热区（单位之下，威胁先验）
  tactPatrolLayer(s);
  tactPlanLayer(s);
  drawEventFx(ctx, T(), project, ring, CANVAS_FONT, s, performance.now());
  const drawCells = visibleCells();
  const buckets: Record<string, any[]> = { unit: [], core: [] };
  for (const c of drawCells) {
    if (replayActive && (c.type === 'unit' || c.type === 'core')) continue; // 回放接管单位/核心
    if (buckets[c.type]) buckets[c.type].push(c);
  }
  if (!replayActive && state.layers.trail) drawMovementDashes(buckets.unit, s);
  if (!replayActive) drawUnits(buckets.unit, s);
  if (!replayActive) drawCores(buckets.core, s);
  if (!replayActive && state.layers.coreTrail !== false) drawEnemyCoreTrails(s);
  if (!replayActive && state.layers.coreTrail !== false) drawThreatArrows(s);
  if (!replayActive && !state.soloTenant && state.layers.enemyHeat !== false) drawThreatRose(s); // 威胁扇区玫瑰（全局，敌情热区层同开关）
  if (state.layers.enemyMemory !== false) drawEnemyMemory(s); // 敌情记忆 = 情报层：回放模式也画（非当前帧实体）
  if (!replayActive) drawLiveTrails(s);
  drawBeacons(s);
  if (state.hover && !state.drag) drawHoverCell(state.hover, s);
  tactDrawLayer(s);
  drawMultiSelection(s); // 多选单位环（编队可视）
  drawBoxSelection(s);   // 框选矩形
  drawJumpMark(s);
  drawJumpPins(s);
  if (replayActive) replayDrawImpl(replay, replayRenderDeps, s);
  const ztxt = `×${state.view.scale.toFixed(1)}`;
  if (!state.tactical.mode && els.hint.dataset.zoom !== ztxt) { els.hint.dataset.zoom = ztxt; els.hint.textContent = `拖拽/方向键平移 · 滚轮缩放 · 双击适应 · G 全局 · ${ztxt}`; }
  if (els.zoomLevel && els.zoomLevel.textContent !== ztxt) {
    els.zoomLevel.textContent = ztxt;
    els.zoomLevel.classList.remove('pop');
    void els.zoomLevel.offsetWidth;
    els.zoomLevel.classList.add('pop');
  }
  renderVignette(envDepsOf(), w, h); // 最后画暗角：收拢视觉焦点
  if (!state.cells.length) {
    ctx.fillStyle = '#56626c'; ctx.font = '600 12px ' + CANVAS_FONT;
    ctx.textAlign = 'center';
    // 空态诊断（2026-08-08）：地图端点已返回（tenants 有 run 信息）但 0 格 →
    // 显示各租户 case 水位，一眼看出是"数据还没生成"还是"管线断了"；
    // 地图端点还没返回（首屏）→ 显示"正在连接指挥中心"。
    const tenants = state.map?.tenants as Array<{ tenant?: string; caseCount?: number; runId?: string | null; latestTick?: number | null }> | undefined;
    if (tenants && tenants.length > 0) {
      ctx.font = '600 12px ' + CANVAS_FONT;
      ctx.fillText('等待测绘数据…', w / 2, h / 2 - 26);
      ctx.font = '500 10px ' + CANVAS_FONT;
      ctx.fillStyle = '#8a949c';
      const parts = tenants.map((t) => {
        const run = t.runId ? '·' + String(t.caseCount ?? 0) + ' case' : '';
        return `${String(t.tenant ?? '').toUpperCase()}${t.caseCount ? ' ' + t.caseCount : ''}${run}`;
      });
      ctx.fillText(parts.join('  '), w / 2, h / 2 - 8);
      ctx.fillText('数据尚未生成或测绘管线未写入，正在等待…', w / 2, h / 2 + 8);
    } else {
      ctx.fillText('正在连接指挥中心…', w / 2, h / 2);
    }
  }
  minimap?.draw();
}

function sprite(img: any, sx: any, sy: any, size: any) {
  if (!img) return;
  const dw = size, dh = size * (img.height / Math.max(1, img.width));
  ctx.drawImage(img, sx - dw / 2, sy - dh / 2, dw, dh);
}
/* ---------- 官方风格绘制助手（对照 arena-hero-web WorldCanvas/unitArt 等） ---------- */
/** 新鲜度 -> 透明度：fresh=1 全亮；stale 按距最新 tick 步数淡出（探测记忆效果） */
function cellAlpha(c: any, floor = 0.45) {
  if (!c || c.fresh) return 1;
  if (!state.soloTenant) return floor + 0.18; // 全局地图记忆层略亮
  return floor;
}
/** 选中波纹（官方 SELECTION_RIPPLE 900ms，双波非线性扩散） */
const SELECTION_RIPPLE_MS = 900;
const selectionRipples = new Map(); // objId -> born
function startSelectionRipple(id: any) { if (id) selectionRipples.set(id, performance.now()); }
/** 多选单位环 + 编队连接线（编队可视）：multi 中非主选中的单位画淡白细环；
 *  主选中 → 各成员画星形虚线（编队拓扑直观可见，一眼看出编队锚点与成员分布）。 */
function drawMultiSelection(s: any) {
  const tac = T();
  if (tac.multi.size < 2) return;
  const selId = tac.selected?.obj?.id;
  const world = tac.selected ? tac.worlds[tac.selected.tenant] : null;
  if (!world) return;
  ctx.save();
  // 编队连接线（2026-08-08）：主选中 → 成员（虚线，淡白）
  const selObj = tac.selected?.obj;
  if (selObj && selObj.position) {
    const sp = project(selObj.position[0], selObj.position[1]);
    ctx.strokeStyle = 'rgba(255,255,255,.30)';
    ctx.lineWidth = Math.max(1, s * 0.03);
    ctx.setLineDash([4, 4]);
    for (const o of world.state.objects) {
      if (!tac.multi.has(o.id) || o.id === selId || o.kind === 'CORE' || !o.position) continue;
      const p = project(o.position[0], o.position[1]);
      ctx.beginPath(); ctx.moveTo(sp.sx, sp.sy); ctx.lineTo(p.sx, p.sy); ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = 'rgba(255,255,255,.55)';
  ctx.lineWidth = Math.max(1, s * 0.045);
  ctx.setLineDash([3, 3]);
  for (const o of world.state.objects) {
    if (!tac.multi.has(o.id) || o.id === selId || o.kind === 'CORE' || !o.position) continue;
    const p = project(o.position[0], o.position[1]);
    const r = Math.max(5, s * 0.5);
    ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}
/** 框选矩形（Shift 拖拽中）：白线半透明填充。 */
function drawBoxSelection(s: any) {
  const box = T().boxSelect;
  if (!box) return;
  const p0 = project(box.x0, box.y0);
  const p1 = project(box.x1, box.y1);
  const x = Math.min(p0.sx, p1.sx), y = Math.min(p0.sy, p1.sy);
  const w = Math.abs(p1.sx - p0.sx), h = Math.abs(p1.sy - p0.sy);
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,.08)';
  ctx.strokeStyle = 'rgba(255,255,255,.7)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.fill(); ctx.stroke();
  ctx.restore();
}
function drawSelectionRipple(s: any, x: any, y: any, cell: any, size: any, id: any) {
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
 *  障碍是永久地形（官方 web 探索记忆永不淡出）：全局视图全亮，不做新鲜度淡出。 */
function drawObstacles(cells: any, s: any) {
  if (!cells.length) return;
  if (s >= 8) {
    for (const c of cells) {
      const p = project(c.x, c.y);
      ctx.save();
      ctx.globalAlpha = 1;
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
    ctx.globalAlpha = 1;
    ctx.rect(p.sx - cell / 2, p.sy - cell / 2, cell, cell);
  }
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(139,183,212,.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
}
/** 矿物：高缩放 crystal 素材 + 绿色发光，低缩放亮点。
 *  矿状态着色（对齐测绘记忆层 tactSurveyLayer）：
 *  visible=亮绿活跃 / stale=暗绿待确认 / harvested=空心（采过）/ empty=暗块（确认空）。 */
function drawResources(cells: any, s: any) {
  if (!cells.length) return;
  const visible = cells.filter((c: any) => (c.state ?? 'visible') !== 'empty');
  if (!visible.length) return;
  if (s >= 6) {
    for (const c of visible) {
      const st = c.state ?? 'visible';
      const p = project(c.x, c.y);
      ctx.save();
      if (st === 'harvested') {
        // 采过：空心菱形（弱轮廓，表示已采空/记忆负态）
        const r = Math.max(4, s * 0.35);
        ctx.strokeStyle = 'rgba(140,150,160,.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.sx, p.sy - r);
        ctx.lineTo(p.sx + r * 0.72, p.sy);
        ctx.lineTo(p.sx, p.sy + r);
        ctx.lineTo(p.sx - r * 0.72, p.sy);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
        continue;
      }
      ctx.globalAlpha = st === 'visible' ? 1 : 0.4;
      if (!LQ && st === 'visible') { ctx.shadowColor = 'rgba(87,189,132,.35)'; ctx.shadowBlur = 3; }
      const path = SPRITE.crystal[hash2(c.x, c.y, 13) % SPRITE.crystal.length];
      if (images[path]) sprite(images[path], p.sx, p.sy, Math.max(7, s * 0.92));
      else { ctx.fillStyle = st === 'visible' ? '#8fce9f' : 'rgba(118,184,137,.5)'; ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(2.5, s * 0.3), 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
    return;
  }
  ctx.save();
  ctx.fillStyle = 'rgba(87,189,132,.7)';
  ctx.beginPath();
  for (const c of visible) {
    const st = c.state ?? 'visible';
    if (st === 'harvested' || st === 'empty') continue;
    const p = project(c.x, c.y);
    ctx.globalAlpha = st === 'visible' ? 0.75 : 0.3;
    const r = Math.max(1.6, s * 0.3);
    ctx.moveTo(p.sx + r, p.sy); // 断连，避免批量 arc 连线
    ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.restore();
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
/** 是否有单位正在 poll 间插值移动（提升 idle 重绘帧率 → 插值/虚线流更丝滑）。 */
function anyUnitsMoving() {
  const now = performance.now();
  for (const m of state.unitPrev.values()) {
    if (Math.hypot(m.x - m.px, m.y - m.py) >= 0.4 && now - m.ts < (m.win || movementWindowMs())) return true;
  }
  return false;
}
function drawMovementDashes(cells: any, s: any) {
  if (!cells.length || s < 1.2) return;
  const now = performance.now();
  const cell = s; // 缩放 = 格子像素尺寸，几何对齐官方 WorldCanvas drawMoveArrow
  const lineW = Math.max(1.5, cell * 0.035);
  const dash = [Math.max(4, cell * 0.12), Math.max(3, cell * 0.09)];
  const dashLen = dash[0] + dash[1];
  const startOff = cell * 0.29, endOff = cell * 0.25;
  const head = Math.max(7, cell * 0.18);
  const flow = (now / 70) % dashLen; // 虚线流动：向移动方向滚动（流水感 = 正在移动）
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const c of cells) {
    const m = state.unitPrev.get(c.tenant + ':' + c.id);
    if (!m) continue;
    const dist = Math.hypot(m.x - m.px, m.y - m.py);
    if (dist < 0.4 || now - m.ts >= (m.win || movementWindowMs())) continue;
    const from = project(m.px, m.py);
    const to = project(m.x, m.y);
    const dx = to.sx - from.sx, dy = to.sy - from.sy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    // 官方几何：线从起点格内缩进、终点格内收；箭头 tip 再内收 cell*.12
    const sx = from.sx + ux * startOff, sy = from.sy + uy * startOff;
    const ex = to.sx - ux * endOff, ey = to.sy - uy * endOff;
    const tipX = to.sx - ux * cell * 0.12, tipY = to.sy - uy * cell * 0.12;
    const wingX = -uy, wingY = ux;
    const color = c.controlled ? (TENANT_COLORS[c.tenant] ?? '#999') : '#e0625d';
    // ① 起点标记：实心点 + 白描边环（"从哪里出发"）
    ctx.save();
    ctx.globalAlpha = 0.9; ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(from.sx, from.sy, Math.max(1.6, cell * 0.07), 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.65)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(from.sx, from.sy, Math.max(2.6, cell * 0.11), 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    // ② 虚线连接（原版 dash pattern + 柔和辉光，流动动画）
    ctx.save();
    ctx.strokeStyle = color; ctx.globalAlpha = 0.55; ctx.lineWidth = lineW;
    ctx.setLineDash(dash); ctx.lineDashOffset = -flow;
    ctx.shadowColor = color; ctx.shadowBlur = 3;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.setLineDash([]); ctx.lineDashOffset = 0; ctx.shadowBlur = 0;
    // ③ 箭头（官方几何：head 内收 + 垂直翼 .42）
    ctx.globalAlpha = 0.9; ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(ex - ux * head + wingX * head * 0.42, ey - uy * head + wingY * head * 0.42);
    ctx.lineTo(ex - ux * head - wingX * head * 0.42, ey - uy * head - wingY * head * 0.42);
    ctx.closePath(); ctx.fill();
    // ④ 终点标记：目标环 + 中心点（"到哪里去"）
    ctx.strokeStyle = color; ctx.lineWidth = lineW;
    ctx.beginPath(); ctx.arc(to.sx, to.sy, Math.max(3, cell * 0.14), 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(to.sx, to.sy, Math.max(1.2, cell * 0.04), 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}
/** 悬停格高亮（地图响应感）：白 4.5% 底 + 22% 描边圆角格，不挡内容。 */
function drawHoverCell(c: any, s: any) {
  const p = project(c.x, c.y);
  const inset = Math.max(1.5, s * 0.06);
  const x = p.sx - s / 2 + inset, y = p.sy - s / 2 + inset;
  const w = s - inset * 2, h = s - inset * 2;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,.045)';
  ctx.strokeStyle = 'rgba(255,255,255,.22)';
  ctx.lineWidth = Math.max(1, s * 0.03);
  ctx.beginPath(); ctx.roundRect(x, y, w, h, Math.min(6, s * 0.12)); ctx.fill(); ctx.stroke();
  ctx.restore();
}
/** 单位：高缩放素材+色环；低缩放紧凑租户色圆点（不放大图标遮挡地图）。
 *  官方细节：WORKER 载货条（绿）、受伤单位 HP 条、同格堆叠 ×2 徽章、选中波纹。 */
function drawUnits(cells: any, s: any) {
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
      const color = c.controlled ? (TENANT_COLORS[c.tenant] ?? '#999') : '#e0625d';
      ctx.save();
      ctx.globalAlpha = cellAlpha(c, 0.55);
      ring(p.sx, p.sy, size * 0.72 * pulse, c.controlled ? color : 'rgba(198,99,112,.55)', c.controlled ? 1.8 : 1.2, c.controlled ? ([] as number[]) : [3, 3]);
      const path = unitSpritePath(c.unitType);
      if (images[path]) sprite(images[path], p.sx, p.sy, size);
      else {
        ctx.fillStyle = c.controlled ? color : '#7c858d';
        ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(2, size * 0.25), 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      const sel = T().selected;
    if (state.soloTenant && sel && sel.obj && sel.obj.id === c.id) {
        drawSelectionRipple(s, p.sx, p.sy, s, size, c.id);
      }
      if (c.unitType === 'WORKER' && s >= 8 && !LQ) drawWorkerCargo(s, p.sx, p.sy, s, c.cargo ?? 0);
      if (typeof c.hp === 'number' && s >= 10 && !LQ) drawUnitHealth(s, p.sx, p.sy + size * 0.5, s, c.hp, maxUnitHp(c.unitType));
      const stack = byCell.get(c.x + ',' + c.y) || [];
      if (stack.length > 1 && !LQ) drawStackBadge(s, p.sx, p.sy - size * 0.7, s, stack.length, color);
      const human = unitHumanCommandOf(c.tenant, c.id);
      if (human && !LQ) drawHumanMarker(s, p.sx, p.sy, size, c.id);
    }
    return;
  }
  for (const c of cells) {
    const pos = unitDrawPos(c);
    const p = project(pos.x, pos.y);
    const color = c.controlled ? (TENANT_COLORS[c.tenant] ?? '#999') : '#e0625d';
    ctx.save();
    ctx.globalAlpha = cellAlpha(c, 0.55);
    ctx.fillStyle = c.controlled ? color : 'rgba(198,99,112,.7)';
    ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(1.8, s * 0.42 * pulse), 0, Math.PI * 2); ctx.fill();
    if (c.controlled) { ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.restore();
    if (unitHumanCommandOf(c.tenant, c.id)) drawHumanMarker(s, p.sx, p.sy, Math.max(3, s * 0.8), c.id);
  }
}
/** 人类指挥中标记（2026-08-08）：受控单位有活跃人类 goal/action 时画琥珀色虚线环 +
 *  头部小 H 标签——指挥官一眼看到哪些单位已被人工接管（区别于 agent 自动的租户色环）。
 *  琥珀 = 指挥中状态语义（与待执行面板 src-manual 蓝不同：地图上用 warn 色更醒目，
 *  且不与其他租户色（蓝/绿/紫/红）撞色）。 */
function drawHumanMarker(s: any, sx: any, sy: any, cell: any, id: any) {
  ctx.save();
  const r = Math.max(5, cell * 0.85);
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.lineWidth = Math.max(1.2, cell * 0.06);
  ctx.setLineDash([Math.max(3, cell * 0.14), Math.max(2, cell * 0.1)]);
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  // 头部 H 标签（仅缩放到够大显示，避免低缩放噪点）
  if (s >= 6) {
    const fs = Math.max(9, Math.round(s * 0.34));
    ctx.font = `700 ${fs}px ${CANVAS_FONT}`;
    const tw = ctx.measureText('H').width;
    const bx = sx + r + 2, by = sy - r - fs;
    ctx.fillStyle = 'rgba(8,8,8,.78)';
    ctx.beginPath(); ctx.roundRect(bx - 2, by - 1, tw + 5, fs + 4, 4); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('H', bx + 0.5, by + (fs + 4) / 2 + 0.5);
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
}
/** 实时移动轨迹（动线持久化 2026-08-08）：live 视图用该租户 replay 的 trail 画
 *  最近 12 个 tick 的连续移动折线——旧段低透明持久、近 3 点提亮 + 端点头/尾点，
 *  单位"从哪走到哪"的动线一眼可见（回放插值动画之外，live 也有持久动线感）。 */
const TRAIL_POINTS = 12;
const TRAIL_NEAR = 3;
function drawLiveTrails(s: any) {
  if (!state.layers.trail || !state.soloTenant || !replay.data || replay.data.loadedFor !== state.soloTenant) return;
  if (s < 3) return; // 全局/极低缩放不画轨迹，避免噪声
  const color = TENANT_COLORS[state.soloTenant!] ?? '#69b3d8';
  const lw = Math.max(1, s * 0.09);
  for (const u of replay.data.units) {
    const trail = u.trail;
    if (!trail || trail.length < 2) continue;
    const pts = trail.slice(-TRAIL_POINTS);
    const last = pts[pts.length - 1];
    // 与当前 live 位置一致才画（避免回放旧 run 轨迹错位）；地形全局去重后租户键
    // 可能 miss，回退全局 `x,y` 键（2026-08-08 数据链路打通）
    const liveCell = state.cellIndex.get(`${state.soloTenant}:${last.x},${last.y}`) ?? state.cellIndex.get(`${last.x},${last.y}`);
    if (!liveCell) continue;
    const scr = pts.map((t: any) => project(t.x, t.y));
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // ① 整条动线：连续折线 + 均匀低透明（持久底）
    ctx.strokeStyle = color; ctx.globalAlpha = 0.16; ctx.lineWidth = lw;
    ctx.beginPath();
    for (let i = 0; i < scr.length; i++) { if (i === 0) ctx.moveTo(scr[i].sx, scr[i].sy); else ctx.lineTo(scr[i].sx, scr[i].sy); }
    ctx.stroke();
    // ② 近段提亮（最近 3 点）：动线"活"的部分
    const near = scr.slice(-TRAIL_NEAR);
    if (near.length > 1) {
      ctx.strokeStyle = color; ctx.globalAlpha = 0.5; ctx.lineWidth = lw * 1.15;
      ctx.beginPath();
      for (let i = 0; i < near.length; i++) { if (i === 0) ctx.moveTo(near[i].sx, near[i].sy); else ctx.lineTo(near[i].sx, near[i].sy); }
      ctx.stroke();
    }
    // ③ 端点标记：起点小点 + 当前头点（空心环）
    const first = scr[0], head = scr[scr.length - 1];
    ctx.fillStyle = color; ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.arc(first.sx, first.sy, Math.max(1.2, s * 0.12), 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.85; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(head.sx, head.sy, Math.max(1.8, s * 0.18), 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}

/** 核心：高缩放素材+光环+拥有者标签+盾条/血条；低缩放租户色大点+白描边。
 *  官方细节：drawCoreOwnerLabel / drawCoreShieldBar / drawHealthBar / 选中波纹。 */
function drawCores(cells: any, s: any) {
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
    const sel = T().selected;
    if (state.soloTenant && sel && sel.obj && sel.obj.id === c.id) {
      drawSelectionRipple(s, p.sx, p.sy, s, s * 0.72, c.id);
    }
  }
}
function coreColor(c: any) {
  // 我方核心=租户色；敌方核心=珊瑚红（官方 hostile 语义）
  return c.controlled ? (TENANT_COLORS[c.tenant] ?? '#69b3d8') : '#e0625d';
}
function drawCoreSprite(c: any, s: any) {
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
  ring(p.sx, p.sy, size * 0.62, color, c.controlled ? 2 : 1.6, c.controlled ? ([] as number[]) : [3, 3]);
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
  const sel = T().selected;
    if (state.soloTenant && sel && sel.obj && sel.obj.id === c.id) {
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
    const color2 = c.hp > 3 ? '#8fce9f' : c.hp > 1 ? '#ffffff' : '#e0625d';
    drawMeterBar(s, p.sx, p.sy + size * 0.72, s, c.hp, 5, color2, '#d4d4d8', `${c.hp}/${5}`);
  }
}
/** 信标：视野内脉冲；视野外屏幕边缘方向指示（不撑爆自适应）。
 *  全局视图下按位置去重（4 租户共享同一世界信标，避免 4 个金色精灵叠在同一格）。 */
function drawBeacons(s: any) {
  // 全局视图：4 租户共享同一世界信标，按位置去重，轨迹用"最长历史"的那份绘制；
  // 单租户视图：直接绘制。
  if (state.soloTenant === null) {
    const byPos = new Map();
    for (const b of state.beacons) {
      if (state.tenantsOn[b.tenant] === false) continue;
      const key = b.x + ',' + b.y;
      const cur = byPos.get(key);
      const curLen = cur && Array.isArray(cur.trail) ? cur.trail.length : 0;
      const bLen = Array.isArray(b.trail) ? b.trail.length : 0;
      if (!cur || bLen > curLen) byPos.set(key, b);
    }
    for (const b of byPos.values()) drawBeaconAt(s, b);
    return;
  }
  for (const b of state.beacons) {
    if (b.tenant !== state.soloTenant) continue;
    drawBeaconAt(s, b);
  }
}

/** 单个信标：历史轨迹虚线（越旧越淡）+ 头部方向箭头 + 原位脉冲/精灵。 */
function drawBeaconAt(s: any, b: any) {
  const p = project(b.x, b.y);
  const w = W(), h = H();
  const offscreen = p.sx < -70 || p.sx > w + 70 || p.sy < -70 || p.sy > h + 70;
  if (offscreen) {
    // 边缘方向指示只在聚焦单一租户时显示（全局 4 信标同时指向会太吵）
    if (state.soloTenant && state.layers.beaconEdge !== false) drawEdgeBeacon(b, p);
    return;
  }
  if (state.layers.beaconTrail !== false) drawBeaconTrail(s, b);
  const size = Math.max(14, s * (b.status === 'CARRIED' ? 0.58 : 0.98));
  if (state.soloTenant && state.layers.beacon) {
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 420);
    ring(p.sx, p.sy, size * 0.9, `rgba(240,136,62,${0.18 + 0.22 * pulse})`, 1.6);
  } else {
    ring(p.sx, p.sy, size * 0.9, 'rgba(240,136,62,.14)', 1.2);
  }
  if (images[SPRITE.beacon]) sprite(images[SPRITE.beacon], p.sx, p.sy, size);
  else {
    ctx.fillStyle = '#f0883e';
    ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(3, size * 0.3), 0, Math.PI * 2); ctx.fill();
  }
}

/** 信标移动历史：虚线轨迹（租户配色、旧→新渐变透明、线段缓流）+ 头部方向箭头。
 *  数据源：/api/map beacons[].trail（服务端从 calibration case 增量提取）。 */
function drawBeaconTrail(s: any, b: any) {
  const trail = Array.isArray(b.trail) ? b.trail : null;
  if (!trail || trail.length < 2) return;
  const color = TENANT_COLORS[b.tenant] ?? '#f0883e';
  const w = W(), h = H();
  const pts = [];
  for (const pt of trail) {
    const q = project(pt.x, pt.y);
    if (q.sx < -400 || q.sx > w + 400 || q.sy < -400 || q.sy > h + 400) continue; // 离屏极远不画
    pts.push(q);
  }
  if (pts.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const dashPhase = (Date.now() / 90) % 12; // 虚线缓流（marching ants）
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], z = pts[i];
    const t = i / pts.length; // 0 旧 → 1 新
    ctx.globalAlpha = 0.10 + 0.50 * t;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, 1.3 + 0.7 * t);
    ctx.setLineDash([6, 5]);
    ctx.lineDashOffset = -dashPhase;
    ctx.beginPath();
    ctx.moveTo(a.sx, a.sy);
    ctx.lineTo(z.sx, z.sy);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // 头部箭头：最新两段方向
  const last = pts[pts.length - 1], prev = pts[pts.length - 2];
  const dx = last.sx - prev.sx, dy = last.sy - prev.sy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const al = Math.min(15, Math.max(6, s * 0.55));
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(last.sx + ux * al, last.sy + uy * al);
  ctx.lineTo(last.sx - uy * al * 0.45, last.sy + ux * al * 0.45);
  ctx.lineTo(last.sx + uy * al * 0.45, last.sy - ux * al * 0.45);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** 敌方核心历史轨迹（2026-08-08）：与信标轨迹同机制——虚线 + 旧→新渐变 +
 *  头部方向箭头 + 用户名标签。面板直接看到谁在迁移/逼近（如 jerkman 核心带
 *  信标东移）；数据源 /api/map coreTrails（服务端跨 run 增量提取）。 */
function drawEnemyCoreTrails(s: any) {
  const trails = state.coreTrails;
  if (!Array.isArray(trails) || trails.length === 0) return;
  const w = W(), h = H();
  for (const t of trails) {
    const trail = Array.isArray(t.trail) ? t.trail : null;
    if (!trail || trail.length < 2) continue;
    const color = '#e0625d'; // 敌红（与 enemy/contested 同色系）
    const pts = [];
    for (const pt of trail) {
      const q = project(pt.x, pt.y);
      if (q.sx < -400 || q.sx > w + 400 || q.sy < -400 || q.sy > h + 400) continue; // 离屏极远不画
      pts.push(q);
    }
    if (pts.length < 2) continue;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const dashPhase = (Date.now() / 110) % 12; // 虚线缓流（比信标慢，低调）
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], z = pts[i];
      const tt = i / pts.length;
      ctx.globalAlpha = 0.08 + 0.35 * tt;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, 1.2 + 0.6 * tt);
      ctx.setLineDash([5, 6]);
      ctx.lineDashOffset = -dashPhase;
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(z.sx, z.sy);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // 头部箭头
    const last = pts[pts.length - 1], prev = pts[pts.length - 2];
    const dx = last.sx - prev.sx, dy = last.sy - prev.sy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const al = Math.min(13, Math.max(5, s * 0.5));
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(last.sx + ux * al, last.sy + uy * al);
    ctx.lineTo(last.sx - uy * al * 0.45, last.sy + ux * al * 0.45);
    ctx.lineTo(last.sx + uy * al * 0.45, last.sy - ux * al * 0.45);
    ctx.closePath();
    ctx.fill();
    // 用户名标签（缩放到够大才显示）
    if (s >= 9 && t.username) {
      ctx.globalAlpha = 0.85;
      ctx.font = `600 ${Math.max(10, Math.round(s * 0.8))}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = '#f0b0b6';
      ctx.textAlign = 'center';
      ctx.fillText(t.username, last.sx, last.sy - al - 3);
    }
    ctx.restore();
  }
}
/** 威胁雷达（2026-08-08）：从 HIGH/MEDIUM 风险敌核心画红色虚线箭头指向我方
 *  核心 + 距离标签——面板一眼看到谁在压过来（数据 /api/intel）。 */
function drawThreatArrows(s: any) {
  const intel = state.intel;
  if (!intel || !Array.isArray(intel.tenants)) return;
  const w = W(), h = H();
  ctx.save();
  ctx.lineCap = 'round';
  for (const t of intel.tenants) {
    if (state.soloTenant !== null && t.tenant !== state.soloTenant) continue;
    if (!Array.isArray(t.ourCore) || !Array.isArray(t.enemyCores)) continue;
    const home = project(t.ourCore[0], t.ourCore[1]);
    for (const e of t.enemyCores) {
      if (e.raidRisk !== 'HIGH' && e.raidRisk !== 'MEDIUM') continue;
      const p = project(e.position[0], e.position[1]);
      const off = p.sx < -200 || p.sx > w + 200 || p.sy < -200 || p.sy > h + 200;
      if (off) continue;
      const dx = home.sx - p.sx, dy = home.sy - p.sy;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      // 虚线箭头（源→我方核心），HIGH 更亮
      const strong = e.raidRisk === 'HIGH';
      ctx.setLineDash([7, 6]);
      ctx.lineDashOffset = -(Date.now() / 140) % 13;
      ctx.strokeStyle = strong ? 'rgba(255,90,90,.85)' : 'rgba(255,150,120,.55)';
      ctx.lineWidth = strong ? 2 : 1.4;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(p.sx, p.sy);
      ctx.lineTo(home.sx - ux * 14, home.sy - uy * 14);
      ctx.stroke();
      ctx.setLineDash([]);
      // 箭头尖（靠近我方核心侧）
      const tipX = home.sx - ux * 18, tipY = home.sy - uy * 18;
      ctx.fillStyle = strong ? '#ff5a5a' : 'rgba(255,150,120,.7)';
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - ux * 10 + uy * 5, tipY - uy * 10 - ux * 5);
      ctx.lineTo(tipX - ux * 10 - uy * 5, tipY - uy * 10 + ux * 5);
      ctx.closePath();
      ctx.fill();
      // 距离标签（箭尾附近）
      if (s >= 8 && typeof e.distanceToFriendlyCore === 'number') {
        ctx.font = `600 ${Math.max(10, Math.round(s * 0.7))}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = strong ? '#ff8f8f' : 'rgba(255,180,160,.75)';
        ctx.fillText(`${e.raidRisk} ${e.distanceToFriendlyCore}`, p.sx, p.sy - 10);
      }
    }
  }
  ctx.restore();
}
/** 敌情记忆层（2026-08-08）：出视野的敌方核心/战斗单位画半透明标记——
 *  新鲜度（距 lastSeenTick）决定透明度：≤300 tick 实色 / 300-2000 线性衰减 /
 *  >2000 tick 敌核保留极淡底线、敌单位不再绘制（动态目标记忆过期快）。
 *  数据源 /api/intel（30s 缓存）：tenants[].enemyCores + enemyUnitMemory。
 *  hover 命中点写入 state.enemyMemoryHits（lastSeen 详情 tooltip）。 */
const ENEMY_MEM_FRESH_WINDOW = 300;
const ENEMY_MEM_MAX_AGE = 2000;
function enemyMemAlpha(age: any, freshAlpha: any, minAlpha: any) {
  if (age <= ENEMY_MEM_FRESH_WINDOW) return freshAlpha;
  if (age >= ENEMY_MEM_MAX_AGE) return minAlpha;
  const t = (age - ENEMY_MEM_FRESH_WINDOW) / (ENEMY_MEM_MAX_AGE - ENEMY_MEM_FRESH_WINDOW);
  return freshAlpha - (freshAlpha - minAlpha) * t;
}
/** 敌情热区层（2026-08-08）：survey-db units_seen 聚合的 16×16 桶敌方活动密度——
 *  桶强度 = count/maxCount（红 alpha 0.04-0.34 渐变），战斗单位占比高的桶更红更亮；
 *  最后目击越旧越淡（新鲜度）。画在单位之下，一眼看出"哪片区域敌方活动最密集"。
 *  数据源 /api/intel/heat?tenant=all&window=2000（服务端 30s 缓存，前端 30s 节流）。 */
const HEAT_CHUNK = 16;
let heatLastLoad = 0;
/** 威胁扇区玫瑰（全局联盟，数据 /api/alliance/snapshot threatSummaries）：每个己方核心
 *  周围按 8 方向画敌情扇区条（长度/透明度 ∝ score），<32 格显示最近距离（黄）、<18 红。
 *  一眼看出"哪个方向敌核在逼近我方哪颗核心"。随敌情热区层开关显示。 */
const ROSE_DIRS: Record<string, [number, number]> = { N: [0, -1], NE: [1, -1], E: [1, 0], SE: [1, 1], S: [0, 1], SW: [-1, 1], W: [-1, 0], NW: [-1, -1] };
async function loadThreatRose() {
  const now = Date.now();
  if (now - state.threatRoseAt < 20_000 && state.threatRose) return; // 服务端缓存 + 前端同频节流
  state.threatRoseAt = now;
  try {
    const r = await getJSON('/api/alliance/snapshot', 20000);
    if (Array.isArray(r?.threatSummaries)) state.threatRose = r.threatSummaries;
  } catch { /* 端点暂不可用：保留上次玫瑰 */ }
}
/** 跳转定位标记：jumpTo 后目标位置画短暂脉冲定位圈（3.2s 淡出+外扩），
 *  让"点击目击/扇区/事迹跳图"后不丢失目标。数据/状态语义，白描边 + 琥珀脉冲。 */
function drawJumpMark(s: any) {
  const jm = state.jumpMark;
  if (!jm) return;
  const age = performance.now() - jm.at;
  const LIFE = 3200;
  if (age >= LIFE) { state.jumpMark = null; return; }
  const p = project(jm.x, jm.y);
  const pr = Math.max(3, s * 0.14);
  const a = 1 - age / LIFE;
  const pulse = 0.5 + 0.5 * Math.sin(age / 90);
  const grow = 1 + (age / LIFE) * 0.7;
  ctx.save();
  ctx.globalAlpha = a * (0.5 + 0.4 * pulse);
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.lineWidth = Math.max(1.2, s * 0.03);
  ctx.beginPath(); ctx.arc(p.sx, p.sy, pr * grow, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = a * 0.85;
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.lineWidth = 1.2;
  const r2 = pr * (0.55 + 0.15 * pulse);
  ctx.beginPath(); ctx.arc(p.sx, p.sy, r2, 0, Math.PI * 2); ctx.stroke();
  const cr = pr * 0.22;
  ctx.beginPath();
  ctx.moveTo(p.sx - cr, p.sy); ctx.lineTo(p.sx + cr, p.sy);
  ctx.moveTo(p.sx, p.sy - cr); ctx.lineTo(p.sx, p.sy + cr);
  ctx.stroke();
  ctx.restore();
}
/** 跳图定位标记（jumpPins）：目击/扇区/事迹跳图后目标持久可见（不再只有 3.2s 脉冲），
 *  带标签徽标 + 入场动效；点击 pin 或 Esc 清除——解决「跳图后卡住/关不掉/不知如何取消」。 */
function drawJumpPins(s: any) {
  const pins = state.jumpPins;
  if (!pins.length) return;
  const now = performance.now();
  ctx.save();
  ctx.font = '600 11px ' + CANVAS_FONT;
  for (const pin of pins) {
    const age = now - pin.at;
    const p = project(pin.x, pin.y);
    const pr = Math.max(3, s * 0.15);
    const t = Math.min(1, age / 350);
    const scale = 0.6 + 0.4 * (1 - Math.pow(1 - t, 3));
    const r = pr * scale;
    const isNew = age < 5000;
    const pulse = isNew ? 0.5 + 0.5 * Math.sin(age / 120) : 0;
    ctx.globalAlpha = 0.55 + 0.3 * pulse;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = Math.max(1.2, s * 0.03);
    ctx.beginPath(); ctx.arc(p.sx, p.sy, r * (1 + 0.12 * pulse), 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, r * 0.6, 0, Math.PI * 2); ctx.stroke();
    const cr = r * 0.18;
    ctx.beginPath();
    ctx.moveTo(p.sx - cr, p.sy); ctx.lineTo(p.sx + cr, p.sy);
    ctx.moveTo(p.sx, p.sy - cr); ctx.lineTo(p.sx, p.sy + cr);
    ctx.stroke();
    if (pin.label && s >= 3) {
      const label = String(pin.label).slice(0, 18);
      const tw = ctx.measureText(label).width;
      const bx = p.sx + r + 5, by = p.sy - r - 4;
      ctx.fillStyle = 'rgba(10,14,18,.85)';
      ctx.beginPath(); ctx.roundRect(bx - 3, by - 12, tw + 8, 17, 4); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, bx, by - 3);
      ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    }
  }
  ctx.restore();
}
function drawThreatRose(s: any) {
  const rose = state.threatRose;
  if (!Array.isArray(rose) || !rose.length) return;
  const k = Math.max(0.55, Math.min(1.4, s / 12));
  const w = W(), h = H();
  ctx.save();
  ctx.lineCap = 'round';
  for (const ts of rose) {
    const color = TENANT_COLORS[ts.tenantId] ?? '#999';
    const cp = ts.corePosition;
    if (!Array.isArray(cp) || cp.length < 2) continue;
    const p = project(cp[0], cp[1]);
    if (p.sx < -140 || p.sx > w + 140 || p.sy < -140 || p.sy > h + 140) continue;
    for (const sec of ts.sectors ?? []) {
      const dir = ROSE_DIRS[sec.direction];
      if (!dir || !sec.entityCount) continue;
      const len = Math.max(6, Math.min(64, 8 + (sec.score ?? 0) * 90)) * k;
      const nx = p.sx + dir[0] * len, ny = p.sy + dir[1] * len;
      const alpha = Math.max(0.12, Math.min(0.55, 0.15 + (sec.score ?? 0) * 0.5));
      ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = Math.max(1.2, s * 0.03);
      ctx.beginPath(); ctx.moveTo(p.sx + dir[0] * 3, p.sy + dir[1] * 3); ctx.lineTo(nx, ny); ctx.stroke();
      ctx.globalAlpha = Math.min(1, alpha + 0.25);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(nx, ny, Math.max(1.5, s * 0.045), 0, Math.PI * 2); ctx.fill();
      const nd = sec.nearestDistance;
      if (typeof nd === 'number' && nd < 32) {
        ctx.globalAlpha = 0.95; ctx.fillStyle = nd < 18 ? '#dd626d' : '#f0883e';
        ctx.font = '600 9px ' + CANVAS_FONT;
        ctx.fillText(String(nd), nx + 2, ny - 2);
      }
    }
  }
  ctx.restore();
}
async function loadEnemyHeat() {
  if (state.layers.enemyHeat === false) return;
  const now = Date.now();
  if (now - heatLastLoad < 30_000 && state.enemyHeat) return; // 服务端 30s 缓存，前端同频节流
  heatLastLoad = now;
  try {
    const r = await getJSON('/api/intel/heat?tenant=all&window=2000', 20000);
    const buckets = Array.isArray(r?.buckets) ? r.buckets : [];
    state.enemyHeat = buckets;
    state.enemyHeatMax = buckets.reduce((m: number, b: any) => Math.max(m, Number(b.count) || 0), 0) || 1;
  } catch { /* 端点暂不可用：保留上次热区 */ }
}
function drawEnemyHeat(s: any) {
  const buckets = state.enemyHeat;
  if (!Array.isArray(buckets) || !buckets.length || !state.enemyHeatMax) return;
  const w = W(), h = H();
  const cell = HEAT_CHUNK * s; // 16×16 世界格 → 屏幕尺寸
  const baseTick = state.tickMeter.lastTick || 0;
  ctx.save();
  for (const b of buckets) {
    const p = project(b.bx * HEAT_CHUNK, b.by * HEAT_CHUNK);
    if (p.sx + cell < 0 || p.sy + cell < 0 || p.sx > w || p.sy > h) continue; // 视口外跳过
    const intensity = Math.max(0, Math.min(1, (Number(b.count) || 0) / state.enemyHeatMax));
    // 新鲜度：最后目击距今越远越淡（2000 tick 窗口内线性衰减）
    const age = Math.max(0, baseTick - (Number(b.lastTick) || 0));
    const fresh = Math.max(0.25, 1 - age / 2000);
    const combatRatio = (Number(b.combatCount) || 0) / Math.max(1, Number(b.count) || 1);
    const alpha = (0.05 + 0.29 * intensity) * fresh;
    ctx.fillStyle = `rgba(198, ${Math.round(80 + combatRatio * 60)}, ${Math.round(88 + (1 - combatRatio) * 20)}, ${alpha.toFixed(3)})`;
    ctx.fillRect(p.sx, p.sy, cell, cell);
    // 高密度桶加细描边（读图辅助，非装饰）
    if (intensity > 0.6) {
      ctx.strokeStyle = `rgba(221,98,109,${(0.18 * fresh).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.strokeRect(p.sx + 0.5, p.sy + 0.5, cell - 1, cell - 1);
    }
  }
  ctx.restore();
}
function drawEnemyMemory(s: any) {
  state.enemyMemoryHits = [];
  const intel = state.intel;
  if (!intel || !Array.isArray(intel.tenants) || state.layers.enemyMemory === false) return;
  const w = W(), h = H();
  const baseTick = state.tickMeter.lastTick || 0;
  const hits = [];
  for (const t of intel.tenants) {
    if (state.soloTenant !== null && t.tenant !== state.soloTenant) continue;
    if (state.tenantsOn[t.tenant] === false) continue;
    // 敌核记忆：菱形（与 drawEnemyCoreTrails 同色系，半透明区分可见敌核）
    for (const e of (t.enemyCores ?? [])) {
      const px = e.position[0], py = e.position[1];
      const p = project(px, py);
      if (p.sx < -400 || p.sx > w + 400 || p.sy < -400 || p.sy > h + 400) continue;
      const age = Math.max(0, baseTick - (e.lastSeenTick ?? 0));
      const alpha = enemyMemAlpha(age, 0.5, 0.12);
      const r = Math.max(6, s * 0.42);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.sx, p.sy);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#e0625d';
      ctx.fillRect(-r / 2, -r / 2, r, r);
      ctx.strokeStyle = 'rgba(255,160,160,.85)';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(-r / 2, -r / 2, r, r);
      ctx.restore();
      if (s >= 8 && e.username) {
        ctx.save();
        ctx.globalAlpha = Math.min(0.9, alpha * 1.6);
        ctx.font = `600 ${Math.max(10, Math.round(s * 0.72))}px ${CANVAS_FONT}`;
        ctx.fillStyle = '#f0b0b6';
        ctx.textAlign = 'center';
        ctx.fillText(e.username, p.sx, p.sy - r - 3);
        ctx.restore();
      }
      hits.push({ sx: p.sx, sy: p.sy, x: px, y: py, kind: 'core', tenant: t.tenant, username: e.username ?? null, lastSeenTick: e.lastSeenTick ?? null, raidRisk: e.raidRisk ?? null, distance: e.distanceToFriendlyCore ?? null });
    }
    // 敌单位记忆：圆点（>2000 tick 不画）
    for (const u of (t.enemyUnitMemory ?? [])) {
      const age = Math.max(0, baseTick - (u.lastSeenTick ?? 0));
      if (age > ENEMY_MEM_MAX_AGE) continue;
      const px = u.position[0], py = u.position[1];
      const p = project(px, py);
      if (p.sx < -400 || p.sx > w + 400 || p.sy < -400 || p.sy > h + 400) continue;
      const alpha = enemyMemAlpha(age, 0.42, 0.1);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ff8d84';
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, Math.max(2.5, s * 0.16), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      hits.push({ sx: p.sx, sy: p.sy, x: px, y: py, kind: 'unit', tenant: t.tenant, unitType: u.unitType ?? 'VANGUARD', lastSeenTick: u.lastSeenTick ?? null });
    }
  }
  state.enemyMemoryHits = hits;
}
function drawEdgeBeacon(b: any, p: any) {
  const w = W(), h = H();
  const cx = w / 2, cy = h / 2;
  const dx = p.sx - cx, dy = p.sy - cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const margin = 36;
  const k = Math.min((w / 2 - margin) / Math.abs(ux || 1e-9), (h / 2 - margin) / Math.abs(uy || 1e-9));
  const ex = cx + ux * k, ey = cy + uy * k;
  const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);
  ctx.fillStyle = `rgba(240,136,62,${0.4 + 0.45 * pulse})`;
  ctx.beginPath(); ctx.arc(ex, ey, 5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(240,136,62,.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(cx + ux * 12, cy + uy * 12); ctx.lineTo(ex - ux * 4, ey - uy * 4); ctx.stroke();
}
function roundRect(x: any, y: any, w: any, h: any, r: any) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath(); ctx.fill();
}

/* ---------- 悬浮提示 ---------- */
function nearestCell(px: any, py: any) {
  let best = null, bestD = Infinity;
  for (const c of visibleCells()) {
    const p = project(c.x, c.y);
    const d = Math.hypot(px - p.sx, py - p.sy);
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= Math.max(18, state.view.scale) ? best : null;
}
/** 敌情记忆命中：最近 12px 内的记忆点（敌核/敌单位），无则 null。 */
function nearestEnemyMemory(px: any, py: any) {
  let best = null, bestD = Infinity;
  for (const m of state.enemyMemoryHits) {
    const d = Math.hypot(px - m.sx, py - m.sy);
    if (d < bestD) { bestD = d; best = m; }
  }
  return bestD <= 12 ? best : null;
}
/** 测绘记忆命中（聚焦租户）：surveyHits 中与指针同格的点，无则 null。 */
function nearestSurveyMemory(px: any, py: any) {
  if (!state.soloTenant || state.surveyHits.size === 0) return null;
  const wx = Math.round(state.view.cx + (px - W() / 2) / state.view.scale);
  const wy = Math.round(state.view.cy + (py - H() / 2) / state.view.scale);
  return state.surveyHits.get(`${wx},${wy}`) ?? null;
}
/** 悬浮信息框（官方 MapFeatureInfo 移植）：图标头 + 坐标 + 动态行 + 指向箭头定位。 */
function showTooltip(px: any, py: any, cell: any) {
  if (!cell) { els.tooltip.hidden = true; return; }
  const color = TENANT_COLORS[cell.tenant] ?? '#999';
  const iconFor = (t: any) => t === 'core' ? SPRITE.core
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
    // 当前指令（hover 即见：人类指挥白 / 算法决策青）——便于人观察“单位正在干什么”
    if (cell.controlled) {
      const plan = state.soloTenant === cell.tenant ? T().plan?.plan : T().plans?.[cell.tenant];
      const cmdLine = cmdLabel(T(), cell.tenant, cell.id, plan);
      if (cmdLine) lines.push(`<div class="tt-row"><span>当前</span><b style="color:${cmdHumanOf(T(), cell.tenant, cell.id) ? '#ffffff' : 'var(--cyan)'}">${cmdLine}</b></div>`);
      // 编队成员标签（2026-08-08）：与编队连接线呼应，hover 即知所属编队
      if (T().multi.has(cell.id)) {
        lines.push(`<div class="tt-row"><span>编队</span><b style="color:var(--warn)">编队成员 · 共 ${T().multi.size}</b></div>`);
      }
    }
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

/** 纯坐标提示（2026-08-08）：指针悬停空地图/雾区时显示世界坐标——
 *  官方 web HUD 同款 cursor 坐标常显；无格命中不再是"无反馈"。 */
function showPlainCoordTooltip(px: any, py: any) {
  const rect = els.canvas.getBoundingClientRect();
  const wx = Math.round(state.view.cx + (px - rect.width / 2) / state.view.scale);
  const wy = Math.round(state.view.cy + (py - rect.height / 2) / state.view.scale);
  const cx = Math.floor(wx / 16), cy = Math.floor(wy / 16);
  els.tooltip.innerHTML = `<span class="tt-arrow" aria-hidden="true"></span>
    <div class="tt-head"><div class="tt-head-text">
      <div class="tt-title" style="color:#9aa3ad">坐标</div>
      <div class="tt-row"><span>世界</span><b>${wx}, ${wy}</b></div>
    </div></div>
    <div class="tt-row"><span>区块</span><b>${cx}, ${cy}</b></div>
    <div class="tt-row"><span>缩放</span><b>${state.view.scale.toFixed(1)}x</b></div>`;
  els.tooltip.hidden = false;
  const tw = els.tooltip.offsetWidth, th = els.tooltip.offsetHeight;
  let left = px + 16, top = py + 16, side = 'left';
  if (left + tw > rect.width - 8) { left = px - tw - 16; side = 'right'; }
  if (top + th > rect.height - 8) top = py - th - 16;
  els.tooltip.style.left = `${left}px`;
  els.tooltip.style.top = `${top}px`;
  els.tooltip.dataset.side = side;
}

/* ---------- 记忆层 tooltip（敌情记忆 / 测绘记忆） ---------- */
function positionTooltip(px: any, py: any, html: any) {
  els.tooltip.innerHTML = `<span class="tt-arrow" aria-hidden="true"></span>${html}`;
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
function lastSeenText(lastSeenTick: any) {
  if (!lastSeenTick) return '未知';
  const base = state.tickMeter.lastTick || 0;
  const age = base - lastSeenTick;
  return `t${fmt(lastSeenTick)}${age > 0 ? ` · ${age} tick 前` : ''}`;
}
/** 敌情记忆 tooltip：敌核/敌单位的最后目击详情。 */
function showMemoryTooltip(px: any, py: any, mem: any) {
  const color = '#e0625d';
  const lines = [];
  if (mem.kind === 'core') {
    lines.push(`<div class="tt-title" style="color:${color}">敌核 · ${escapeHtml(mem.username ?? '未知')}</div>`);
    lines.push(`<div class="tt-row"><span>坐标</span><b>${mem.x}, ${mem.y}</b></div>`);
    lines.push(`<div class="tt-row"><span>最后目击</span><b>${lastSeenText(mem.lastSeenTick)}</b></div>`);
    if (mem.raidRisk) {
      const rc = mem.raidRisk === 'CRITICAL' ? 'var(--danger)' : mem.raidRisk === 'HIGH' ? 'var(--warn)' : 'var(--text-dim)';
      lines.push(`<div class="tt-row"><span>威胁</span><b style="color:${rc}">${mem.raidRisk}</b></div>`);
    }
    if (mem.distance != null) lines.push(`<div class="tt-row"><span>距我方核心</span><b>${mem.distance} 格</b></div>`);
  } else {
    lines.push(`<div class="tt-title" style="color:${color}">敌方 ${TACT_UNIT_CN[mem.unitType] ?? mem.unitType}</div>`);
    lines.push(`<div class="tt-row"><span>坐标</span><b>${mem.x}, ${mem.y}</b></div>`);
    lines.push(`<div class="tt-row"><span>最后目击</span><b>${lastSeenText(mem.lastSeenTick)}</b></div>`);
  }
  lines.push(`<div class="tt-row"><span>归属租户</span><b>${mem.tenant.toUpperCase()}</b></div>`);
  lines.push(`<div class="tt-row"><span>记忆</span><b style="color:var(--amber)">出视野 · 非当前 tick</b></div>`);
  positionTooltip(px, py, lines.join(''));
}
/** 测绘记忆 tooltip：聚焦租户的矿/障碍记忆详情（状态/首次看到/seen 次数）。 */
function showSurveyTooltip(px: any, py: any, info: any) {
  const lines = [];
  if (info.kind === 'resource') {
    const st = info.state ?? 'visible';
    const stCn = st === 'visible' ? '活跃' : st === 'stale' ? '待确认' : st === 'harvested' ? '采过' : st === 'empty' ? '已确认空' : st;
    const stColor = st === 'visible' ? 'var(--green-resource)' : st === 'stale' ? 'var(--text-dim)' : 'var(--text-faint)';
    lines.push(`<div class="tt-title" style="color:var(--green-resource)">矿 · 记忆</div>`);
    lines.push(`<div class="tt-row"><span>坐标</span><b>${info.x}, ${info.y}</b></div>`);
    lines.push(`<div class="tt-row"><span>状态</span><b style="color:${stColor}">${stCn}</b></div>`);
    if (info.seenCount != null) lines.push(`<div class="tt-row"><span>见过</span><b>${info.seenCount} 次</b></div>`);
    lines.push(`<div class="tt-row"><span>最后看到</span><b>${lastSeenText(info.tick)}</b></div>`);
    if (info.firstSeen != null) lines.push(`<div class="tt-row"><span>首次看到</span><b>t${fmt(info.firstSeen)}</b></div>`);
  } else {
    lines.push(`<div class="tt-title" style="color:var(--text-dim)">障碍 · 记忆</div>`);
    lines.push(`<div class="tt-row"><span>坐标</span><b>${info.x}, ${info.y}</b></div>`);
    lines.push(`<div class="tt-row"><span>最后看到</span><b>${lastSeenText(info.tick)}</b></div>`);
  }
  lines.push(`<div class="tt-row"><span>归属租户</span><b>${info.tenant.toUpperCase()}</b></div>`);
  lines.push(`<div class="tt-row"><span>记忆</span><b style="color:var(--amber)">已探索 · 非当前 tick</b></div>`);
  positionTooltip(px, py, lines.join(''));
}

/* ---------- 租户卡片 ---------- */
function statusOf(t: any) {
  const s = state.overview?.tenants?.find((x: any) => x.tenant === t);
  if (!s) return { cls: 'stale', label: '无数据' };
  if (s.live) return { cls: 'live', label: '在线' };
  if (s.fileFresh) return { cls: 'fresh', label: '数据新鲜' };
  return { cls: 'stale', label: '离线' };
}
function toggleSolo(tenant: any) {
  state.soloTenant = state.soloTenant === tenant ? null : tenant;
  invalidateStatic();
  if (state.soloTenant) {
    fitSolo(state.soloTenant);
    tactShowTenant(tenant);
    toast(`已聚焦 ${tenant.toUpperCase()} · 再点卡片 / 点「✕ 返回全局」 / 按 G 或 Esc 返回全局`, 'info');
  } else {
    fitView();
    els.respawnOverlay.hidden = true; // 退出聚焦：重生横幅一并收起
    tactClear();
    const sb = document.getElementById('sidebar');
    if (sb) sb.scrollTo({ top: 0, behavior: 'smooth' });
    lastRevealSolo = null;
  }
  emit('solo', state.soloTenant);
  emit('overview', state.overview);
  const global = state.soloTenant === null;
  els.mapGlobal.hidden = global;
  syncSoloBadge();
}
/** 重生覆盖层（官方 RespawnOverlay 移植）：世界 status=RESPAWNING 时全屏提示，
 *  并显示摧毁者（官方读 events[].values.destroyed_by，自毁 reason=SELF_DESTRUCT）。 */
let respawnDestroys: Record<string, any> = {}; // tenant -> { destroyedBy, selfDestructed }（缓存，避免每次 poll 重拉）
async function tactRenderRespawn(tenant: any) {
  const world = T().worlds[tenant];
  const respawning = world && world.state && world.state.status === 'RESPAWNING';
  // 仅聚焦租户重生时显示横幅；全局视图/他租户聚焦时隐藏——避免退出聚焦后横幅常显
  // （"一打开就是一直核心被摧毁"根因，2026-08-08）。
  els.respawnOverlay.hidden = !(state.soloTenant === tenant && respawning);
  if (!respawning || state.soloTenant !== tenant) return;
  const rt = world.state.respawn_at_tick;
  const title = els.respawnOverlay.querySelector('.ro-title');
  const sub = els.respawnOverlay.querySelector('#roTick');
  if (sub) sub.textContent = `重生 tick · ${Number.isFinite(rt) ? fmt(rt) : '待定'}`;
  // 摧毁者信息（缓存于本次会话；失败静默降级为通用提示）
  if (title && !respawnDestroys[tenant]) {
    respawnDestroys[tenant] = { pending: true };
    try {
      const r = await getJSON(`/api/events?tenant=${tenant}&n=200`);
      const evs = Array.isArray(r.events) ? r.events : [];
      const coreDestroyed = [...evs].reverse().find((e) => e.kind === 'CORE_DESTROYED');
      if (coreDestroyed) {
        const by = coreDestroyed.destroyedBy;
        const self = coreDestroyed.reason === 'SELF_DESTRUCT';
        const byName = Array.isArray(by) ? by.filter(Boolean).join('、') : (typeof by === 'string' && by.trim() ? by.trim() : null);
        respawnDestroys[tenant] = { destroyedBy: byName, selfDestructed: self };
        title.textContent = self ? '核心自毁 · 等待重生' : (byName ? `核心被 ${byName} 摧毁 · 等待重生` : '核心被摧毁 · 等待重生');
      } else {
        respawnDestroys[tenant] = { destroyedBy: null, selfDestructed: false };
      }
    } catch { respawnDestroys[tenant] = { destroyedBy: null, selfDestructed: false }; }
  } else if (title && respawnDestroys[tenant] && !respawnDestroys[tenant].pending) {
    const d = respawnDestroys[tenant];
    title.textContent = d.selfDestructed ? '核心自毁 · 等待重生' : (d.destroyedBy ? `核心被 ${d.destroyedBy} 摧毁 · 等待重生` : '核心被摧毁 · 等待重生');
  }
}
/** 聚焦单租户后侧栏自动滚动到 HUD/舰队索引：侧栏内容高（租户卡+图例+图层+视图）
 *  会把 fleetHud/assetPanel 推到可视区外（实测 relY≈1326/1516 vs 可视 751）——
 *  用户聚焦后看不到资源/测绘/舰队信息。聚焦时自动 reveal（退出/重聚焦才触发，非每 poll）。 */
let lastRevealSolo: string | null = null;
function revealSidebarHud() {
  const sb = document.getElementById('sidebar');
  if (!sb || !state.soloTenant) return;
  const fh = document.getElementById('fleetHud');
  if (!fh || fh.hidden) return;
  const fhTop = fh.offsetTop;
  const sbH = sb.clientHeight;
  // 目标滚动位置：让 fleetHud 顶部进入可视区（留 12px padding）
  const target = Math.max(0, fhTop - 12);
  if (sb.scrollTop > target) { sb.scrollTo({ top: target, behavior: 'smooth' }); }
  else if (fhTop + fh.offsetHeight > sb.scrollTop + sbH) {
    sb.scrollTo({ top: Math.min(sb.scrollHeight, target), behavior: 'smooth' });
  }
}
async function tactShowTenant(tenant: any) {
  const [world, expl, rp, plan] = await Promise.all([
    tactLoadWorld(tenant), tactLoadExploration(tenant), replayLoad(replay, replayDeps, tenant), tactLoadPlan(tenant),
  ]);
  if (!world) return;
  T().plan = plan;
  if (plan && Number.isFinite(plan.tick)) setCommandWindowTick(plan.tick);
  tactRenderAssets(tenant);
  tactRenderHud(tenant);
  tactRenderPending();
  tactRefreshActivity(tenant);
  tactRenderRespawn(tenant);
  tactRefreshCommands(tenant);
  // 租户切换过渡：内容更新后让单租户面板丝滑重现（不依赖首次插入动画）
  popPanel(els.fleetHud); popPanel(els.assetPanel); popPanel(els.pendingPanel); popPanel(els.activityPanel);
  // 聚焦后自动滚动侧栏到 HUD（用户默认可见资源/测绘/舰队信息）
  if (lastRevealSolo !== tenant) { lastRevealSolo = tenant; setTimeout(revealSidebarHud, 60); }
  invalidateStatic();
  draw();
}
/** 战术层实时刷新（2026-08-07）：聚焦单租户时每轮 poll 重取世界+计划，
 *  待执行命令面板/计划箭头/单位位置跟随最新 tick；按 id 重解析选中对象保持选中态。 */
async function tactRefreshLive(tenant: any) {
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
      const byId = world.state.objects.find((x: any) => x.id === sel.obj.id);
      if (byId) sel.obj = byId;
    }
    tactRenderPending();
    tactRenderRespawn(tenant);
    // 每 poll 刷新人类指令状态（goal 被服务端对账清除/新指令落地后，待执行面板与
    // 资产行 H 徽章即时跟随；此前 solo 模式 poll 不刷 commands，外部清除后残留）
    await tactRefreshCommands(tenant);
    tactRenderAssets(tenant);
    draw();
  } catch { /* 保持上次快照，下次重试 */ }
}
async function tactLoadPlan(tenant: any) {
  try {
    const r = await getJSON('/api/plan?tenant=' + tenant);
    return r && r.plan ? { tick: r.tick, plan: r.plan } : null;
  } catch { return null; }
}
async function tactLoadExploration(tenant: any) {
  if (T().surveys[tenant]) return T().surveys[tenant];
  try {
    const e = await getJSON(`/api/exploration?tenant=${tenant}`);
    if (e.survey) { T().surveys[tenant] = e.survey; if (e.lifecycle) T().surveys[tenant].lifecycle = e.lifecycle; return e.survey; }
    return null;
  } catch { return null; }
}

/* ---------- 决策流（React 组件渲染） ---------- */
/* ---------- 顶部状态 ---------- */
function tickClock() {
  const m = state.tickMeter;
  const has = m.lastMtime > 0 && m.period > 0;
  const elapsed = has ? Math.max(0, Date.now() - m.lastMtime) : 0;
  const frac = has ? Math.min(1, elapsed / m.period) : 0;
  const remain = has ? Math.max(0, (m.period - elapsed) / 1000) : null; // 剩余秒数（2026-08-08：读条显示距下一 tick 还剩几秒）
  emit('tick', { clock: timeFmt.format(new Date()), tick: m.lastTick, period: m.period, frac, remain });
}
function markRefresh(ok: any) {
  emit('refresh', ok);
}

/** 光标锚定缩放（阻尼目标版）：连续滚轮/键盘/按钮在 target 上累积，逐帧由 stepZoom 平滑趋近。 */
function zoomTo(sx: any, sy: any, factor: any) {
  const rect = els.canvas.getBoundingClientRect();
  const base = state.zoom.active ? { cx: state.zoom.tx, cy: state.zoom.ty, scale: state.zoom.ts } : { cx: state.view.cx, cy: state.view.cy, scale: state.view.scale };
  const ns = Math.min(64, Math.max(0.05, base.scale * factor));
  const wx = base.cx + (sx - rect.width / 2) / base.scale;
  const wy = base.cy + (sy - rect.height / 2) / base.scale;
  state.zoom.tx = wx - (sx - rect.width / 2) / ns;
  state.zoom.ty = wy - (sy - rect.height / 2) / ns;
  state.zoom.ts = ns;
  state.zoom.active = true;
  state.zoom.lastTs = performance.now();
  state.viewAnim = null; // 阻尼接管
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  // 地图交互
  els.canvas.addEventListener('pointerdown', (e: any) => {
    els.canvas.setPointerCapture(e.pointerId);
    // 仅左键参与拖拽/框选/点击：右键全权交给 contextmenu（openCtxMenu），
    // 不再污染 drag 状态（右键触发左键逻辑与右键菜单竞态 = 右键菜单偶发红根因）
    if (e.button !== 0) return;
    state.viewAnim = null;
    state.zoom.active = false; // 拖拽接管
    // shiftKey：框选模式（拖拽画矩形，不平移）；否则平移
    state.drag = { x: e.clientX, y: e.clientY, cx: state.view.cx, cy: state.view.cy, shift: e.shiftKey };
    if (e.shiftKey) {
      const rect = els.canvas.getBoundingClientRect();
      const wx = state.view.cx + (e.clientX - rect.left - rect.width / 2) / state.view.scale;
      const wy = state.view.cy + (e.clientY - rect.top - rect.height / 2) / state.view.scale;
      const tac = T();
      tac.boxSelect = { x0: wx, y0: wy, x1: wx, y1: wy };
    }
  });
  // 点击判定：抬起时位移 < 6px 视为点击（选中/战术目标），否则为拖拽
  els.canvas.addEventListener('pointerup', (e: any) => {
    if (!state.drag) return;
    // 仅左键"抬起"算点击：右键的 pointerup 仅清 drag（点击逻辑走 contextmenu）
    if (e.button !== 0) { state.drag = null; return; }
    const d = state.drag;
    state.drag = null;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    const rect = els.canvas.getBoundingClientRect();
    if (d.shift && moved >= 6) {
      // Shift 拖拽 = 框选：矩形内同租户受控单位加入多选
      finishBoxSelect();
      return;
    }
    if (moved < 6) {
      handleCanvasClick(e.clientX - rect.left, e.clientY - rect.top, d.shift);
    }
  });
  // 框选拖拽实时更新矩形（不平移）
  els.canvas.addEventListener('pointermove', (e: any) => {
    const tac = T();
    if (state.drag && state.drag.shift) {
      const rect = els.canvas.getBoundingClientRect();
      const wx = state.view.cx + (e.clientX - rect.left - rect.width / 2) / state.view.scale;
      const wy = state.view.cy + (e.clientY - rect.top - rect.height / 2) / state.view.scale;
      if (tac.boxSelect) { tac.boxSelect.x1 = wx; tac.boxSelect.y1 = wy; }
      draw();
      return;
    }
  });
  // 右键指挥菜单（群星式）：命中单位/核心弹命令菜单，空白处取消选中
  els.canvas.addEventListener('contextmenu', (e: MouseEvent) => {
    pokeHint();
    e.preventDefault();
    const rect = els.canvas.getBoundingClientRect();
    openCtxMenu(e.clientX - rect.left, e.clientY - rect.top);
  });
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  els.canvas.addEventListener('pointermove', (e: any) => {
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
      // 敌情记忆优先：命中敌核/敌单位记忆点则显示 lastSeen 详情，不走格子 hover
      const mem = nearestEnemyMemory(px, py);
      if (mem) {
        if (state.hover) { state.hover = null; state.hoverKey = ''; }
        showMemoryTooltip(px, py, mem);
        return;
      }
      const cell = nearestCell(px, py);
      state.hover = cell;
      const hk = cell ? cell.tenant + ':' + cell.type + ':' + cell.x + ',' + cell.y : '';
      if (hk !== state.hoverKey) { state.hoverKey = hk; draw(); } // 悬停格变化才重绘（低开销）
      if (cell) {
        showTooltip(px, py, cell);
      } else {
        // 无可见格命中 → 测绘记忆（聚焦租户的矿/障碍记忆详情）
        const surveyMem = nearestSurveyMemory(px, py);
        if (surveyMem) {
          showSurveyTooltip(px, py, surveyMem);
        } else {
          // 纯坐标提示（2026-08-08）：指针悬停任意地图位置都显示世界坐标——
          // 官方 web 同款（HUD 常显 cursor 坐标），空地图/雾区不再是"无反馈"
          showPlainCoordTooltip(px, py);
        }
      }
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
  const endDrag = (e: any) => { if (state.drag) { state.drag = null; } };
  els.canvas.addEventListener('pointerup', endDrag);
  els.canvas.addEventListener('pointercancel', endDrag);
  els.canvas.addEventListener('pointerleave', () => {
    els.tooltip.hidden = true;
    if (state.hover) { state.hover = null; state.hoverKey = ''; draw(); }
  });
  els.canvas.addEventListener('pointerdown', () => pokeHint());
  els.canvas.addEventListener('wheel', (e: any) => {
    pokeHint();
    e.preventDefault();
    const rect = els.canvas.getBoundingClientRect();
    // 触控板捏合缩放（ctrlKey+wheel）：delta 很小，×4 灵敏度补偿（触控板两指滚动不按 ctrl，走常规路径）
    const d0 = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // lines→px（部分触控板/浏览器）
    const d = e.ctrlKey ? d0 * 4 : d0;
    const factor = Math.exp(-d * 0.0012);
    zoomTo(e.clientX - rect.left, e.clientY - rect.top, factor);
  }, { passive: false });
  els.canvas.addEventListener('dblclick', () => { pokeHint(); state.soloTenant ? fitSolo(state.soloTenant) : fitView(); });
  $('#zoomIn')!.addEventListener('click', () => { const r = els.canvas.getBoundingClientRect(); zoomTo(r.width / 2, r.height / 2, 1.5); });
  $('#zoomOut')!.addEventListener('click', () => { const r = els.canvas.getBoundingClientRect(); zoomTo(r.width / 2, r.height / 2, 1 / 1.5); });
  $('#fitBtn')!.addEventListener('click', () => { state.soloTenant ? fitSolo(state.soloTenant) : fitView(); });
  // 视图切换（mapGlobal 在地图控件内；viewGlobal/viewFit 在 React 侧栏，走 api）
  els.mapGlobal.addEventListener('click', exitSolo);
  // 回放控制
  els.rbPlay.addEventListener('click', () => replayToggle(replay, replayDeps));
  els.rbPrev.addEventListener('click', () => replayStep(replay, replayDeps, -1));
  els.rbNext.addEventListener('click', () => replayStep(replay, replayDeps, 1));
  els.rbSpeed.addEventListener('click', () => replayCycleSpeed(replay, replayDeps));
  // 回放进度条可拖拽 seek（2026-08-09）：mousedown on rb-track → ratio → replayStep。
  // 拖拽期间 window mousemove 跟随，mouseup 解绑；复用 replayStep（写 frame + updateUI + draw）。
  {
    const rbTrack = els.rbFill?.parentElement;
    if (rbTrack) {
      const seekTo = (clientX: number) => {
        if (!replay.data) return;
        const rect = rbTrack.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
        const targetFrame = Math.round(ratio * (replay.data.ticks.length - 1));
        if (targetFrame !== replay.frame) replayStep(replay, replayDeps, targetFrame - replay.frame);
      };
      rbTrack.addEventListener('mousedown', (e: MouseEvent) => {
        e.preventDefault();
        pokeHint();
        seekTo(e.clientX);
        const move = (ev: MouseEvent) => seekTo(ev.clientX);
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
    }
  }
  // 聚焦徽章可点击：返回全局联盟（悬停 title 提示）
  if (els.soloBadge) {
    els.soloBadge.addEventListener('click', () => { if (state.soloTenant) exitSolo(); });
    els.soloBadge.title = '点击返回全局联盟';
  }
  // 信标边缘指示：事件委托（DOM 重建不丢点击）；点箭头跳到信标（保留当前缩放，不再被 fitSolo 覆盖）
  els.beaconIndicator.addEventListener('click', (e: any) => {
    const close = e.target.closest('.beacon-close');
    if (close) {
      state.layers.beaconEdge = false;
      savePrefs();
      syncLayerToggles();
      els.beaconIndicator.hidden = true;
      els.beaconIndicator.classList.remove('show');
      toast('已关闭信标边缘指示（图层「信标指示」或 T 键可恢复）');
      return;
    }
    const arrow = e.target.closest('.beacon-arrow');
    if (!arrow || !state.soloTenant) return;
    const b = state.beacons.find((x) => x.tenant === state.soloTenant);
    if (b) {
      state.view.cx = b.x; state.view.cy = b.y;
      state.viewAnim = null; state.zoom.active = false;
      draw();
      toast(`已跳转到信标 [${b.x}, ${b.y}]`);
    }
  });
  // 窗口
  // 容器尺寸变化（折叠决策流/侧栏宽度变化等）：同步重设位图——
  // 之前 rAF 延迟一帧，折叠/展开的 550ms 过渡里每一帧都会出现"旧位图被 CSS 拉伸"的鬼影。
  // 同步 + 仅尺寸真变才重建（canvas.width 赋值会清空画布，no-op 必须跳过）。
  let lastCssW = 0, lastCssH = 0;
  const syncResizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const rect = els.canvas.getBoundingClientRect();
    const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
    if (w === lastCssW && h === lastCssH) return;
    lastCssW = w; lastCssH = h;
    resizeCanvas();
    draw();
  };
  // 折叠/展开决策流等 CSS 尺寸过渡：RO 可能合帧（低帧率/低功耗会少触发），
  // 过渡期间额外每帧同步位图 → 任何时刻位图都等于 CSS 盒子，杜绝"旧位图被拉伸"
  const trackCanvasResize = (ms = 700) => {
    const t0 = performance.now();
    const loop = (ts: any) => {
      syncResizeCanvas();
      if (ts - t0 < ms) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  };
  window.addEventListener('resize', syncResizeCanvas);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncResizeCanvas).observe(els.canvas);
  }
}

/* ---------- 启动 ---------- */
async function boot() {
  applyPrefs();
  queueLoad(); // 恢复命令队列（localStorage，前端调度）
  bindEvents();
  pokeHint();
  resizeCanvas();
  tickClock();
  setInterval(tickClock, 1000);
  await loadSprites();
  await poll();
  emit('refresh', true);
  pollStreams();
  // 退避调度（2026-08-09）：连续失败指数退避 3s→6→12→24→30s 上限；
  // 成功归零。setInterval 改 setTimeout 递归，间隔随失败次数动态增长。
  let pollFailCount = 0;
  async function pollLoop() {
    const ok = await poll();
    emit('refresh', ok);
    pollFailCount = ok ? 0 : pollFailCount + 1;
    const delay = pollFailCount === 0 ? POLL_MS : Math.min(30000, POLL_MS * 2 ** pollFailCount);
    setTimeout(pollLoop, delay);
  }
  pollLoop();
  // 决策流 15s 对齐世界 tick（2026-08-10：3s 轮询冗余，见 pollStreams 注释）
  setInterval(() => { pollStreams(); }, 15000);
  // 高刷/低耗调度（175Hz 显示器）：有动画/回放/单位移动/命令倒计时时 rAF 全速
  // （~175fps），空闲时降频 setTimeout（~8fps）只做轻量检查——175Hz 下 rAF 每帧
  // 回调（5.7ms 一次）即使不 draw 也会空转 CPU，降频后显著省电/省 CPU。
  let frameMode = 'idle'; // idle | active
  let lastAnim = 0;
  let lastCountdown = 0;
  const scheduleFrame = () => {
    if (frameMode === 'active') requestAnimationFrame(animLoop);
    else setTimeout(animLoop, 120);
  };
  const animLoop = (rawTs: any) => {
    const ts = rawTs ?? performance.now(); // setTimeout 回调无 rAF 时间戳
    const animating = !!state.viewAnim;
    const zooming = state.zoom.active;
    const replaying = !!(replay.data && replay.playing);
    const moving = anyUnitsMoving();
    // 命令倒计时不算 active（100ms 节流更新即可，不必撑 175fps）
    // 选中静态环不需要 175fps：仅选中波纹窗口（selectionRipples）与命令模式才撑 rAF 全速；
    // 拖拽/框选/hover 均显式 draw()，不依赖本调度。
    const active = animating || zooming || replaying || moving || !!state.tactical.moveRoute || !!state.tactical.routePreview || !!state.tactical.mode || selectionRipples.size > 0;
    // 模式切换：idle→active 立即补一帧（避免切换延迟）；active→idle 自然降频
    if (active && frameMode !== 'active') { frameMode = 'active'; }
    else if (!active && frameMode !== 'idle') { frameMode = 'idle'; }
    // 命令窗口倒计时节流：100ms 更新一次（175Hz 下不用每帧写 DOM）
    if (active || state.soloTenant) {
      if (ts - lastCountdown >= 100) { lastCountdown = ts; updateCommandCountdown(); }
    }
    if (animating) applyViewAnim(ts);
    if (zooming) stepZoom(ts);
    if (replaying) {
      replayAdvance(replay, ts);
      updateReplayUI(replay, els);
      draw();
    } else if (animating || zooming) {
      draw();
    } else if (active && ts - lastAnim > (moving ? 16 : 120)) {
      lastAnim = ts;
      draw();
    }
    scheduleFrame();
  };
  requestAnimationFrame(animLoop);
  // 键盘导航：方向键平移 / +/- 缩放 / F 适应视口 / G 返回全局 / Esc 取消
  window.addEventListener('keydown', (e) => {
    const tag = ((e.target as HTMLElement | null)?.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const panStep = () => Math.max(1, W() / 2 / state.view.scale * 0.25);
    const pan = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (pan) {
      pokeHint();
      e.preventDefault();
      const st = panStep();
      state.view.cx += pan[0] * st; state.view.cy += pan[1] * st;
      state.viewAnim = null; // 手动平移接管
      draw();
      return;
    }
    if (e.key === '+' || e.key === '=') { const r = els.canvas.getBoundingClientRect(); zoomTo(r.width / 2, r.height / 2, 1.5); return; }
    if (e.key === '-' || e.key === '_') { const r = els.canvas.getBoundingClientRect(); zoomTo(r.width / 2, r.height / 2, 1 / 1.5); return; }
    if (e.key === 'f' || e.key === 'F') { state.soloTenant ? fitSolo(state.soloTenant) : fitView(); return; }
    if (e.key === 'g' || e.key === 'G') {
      exitSolo();
      return;
    }
    // 快捷键补齐（2026-08-09）：数字 1-4 切租户 / 0 全局 / E 事件 / Space 回放暂停 / ? 帮助
    if (e.key >= '1' && e.key <= '4') {
      state.tab = `t${e.key}`; savePrefs(); pollStreams(); pokeHint(); e.preventDefault();
      toast(`切换到 ${e.key} 号租户视图`, 'info');
      return;
    }
    if (e.key === '0') { state.tab = 'all'; savePrefs(); pollStreams(); pokeHint(); e.preventDefault(); toast('切换到全局联盟视图', 'info'); return; }
    if (e.key === 'e' || e.key === 'E') { state.tab = 'events'; savePrefs(); pollStreams(); pokeHint(); e.preventDefault(); toast('切换到事件流', 'info'); return; }
    if (e.key === ' ') { replayToggle(replay, replayDeps); e.preventDefault(); return; }
    if (e.key === '?' || (e.shiftKey && e.key === '/')) {
      toast('快捷键：1-4 租户 / 0 全局 / E 事件 / Space 回放 / F 居中 / G 返回 / T 信标 / +/- 缩放 / 方向键 平移', 'info');
      e.preventDefault();
      return;
    }
    if (e.key === 't' || e.key === 'T') {
      state.layers.beaconEdge = !state.layers.beaconEdge;
      savePrefs();
      syncLayerToggles();
      updateBeaconIndicator();
      toast(state.layers.beaconEdge ? '信标边缘指示已恢复' : '信标边缘指示已隐藏（图层「信标指示」或再按 T 恢复）');
      return;
    }
    // 快捷键指挥（群星式）：选中单位后 M=移动/S=清扫/H=维修/D=回仓/C=采集/P=生产，一键进入对应命令
    const tactKey = { m: 'MOVE', s: 'SWEEP', h: 'HEAL', d: 'DEPOSIT', c: 'HARVEST', p: 'SPAWN', a: 'SHOOT', r: 'REPAIR_SHIELD' }[e.key.toLowerCase()];
    if (tactKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const tac = T();
      // 编队多选：M/S/A/D/C/H 等快捷键直接走批量命令
      if (tac.multi.size >= 2 && ['m', 's', 'a', 'd', 'c', 'h'].includes(e.key.toLowerCase())) {
        const mapBatch: Record<string, string> = { m: 'MOVE', s: 'SWEEP', a: 'SHOOT', d: 'DEPOSIT', c: 'HARVEST', h: 'HEAL' };
        const act = mapBatch[e.key.toLowerCase()];
        const counts = batchActionCounts(tac.selected ? tac.selected.tenant : state.soloTenant);
        if (counts[act]) { batchChooseAction(act); e.preventDefault(); return; }
        else { toast(`组内没有可执行「${TACT_ACTION_CN[act]}」的单位`, 'warn'); return; }
      }
      const sel = tac.selected;
      if (sel && !tac.mode) {
        const obj = sel.obj;
        const isCore = obj.kind === 'CORE';
        let type = tactKey;
        if (isCore) {
          if (tactKey === 'MOVE') type = 'START_MOVE';
          else if (tactKey === 'REPAIR_SHIELD') type = 'REPAIR_SHIELD';
          else if (tactKey === 'SPAWN') { // 核心生产：聚焦生产区
            const spawnBtn = els.actionDialog && !els.actionDialog.hidden ? els.actionDialog.querySelector('[data-spawn]') : null;
            if (spawnBtn) { spawnBtn.scrollIntoView({ block: 'center' }); spawnBtn.focus(); }
            else toast('核心未选中（动作面板未打开）', 'info');
            return;
          }
        }
        if (type) {
          const { types, av } = tactActionTypes(obj);
          // 该类型不拥有的动作（如工人按 S 清扫）不响应；拥有的才校验可用性
          if (!types.includes(type)) return;
          if (av.actions[type] !== true) { toast(av.reasons?.[type] || `动作「${TACT_ACTION_CN[type] ?? type}」当前不可用`, 'warn'); return; }
          tactChooseAction(type);
          e.preventDefault();
          return;
        }
      }
    }
    if (e.key === 'Escape') {
      if (state.jumpPins.length) { state.jumpPins = []; state.jumpMark = null; draw(); toast('已清除全部定位标记'); }
      else if (els.ctxMenu && !els.ctxMenu.hidden) { hideCtxMenu(); return; }
      else if (state.tactical.mode || state.tactical.selected) tactClear();
      else if (els.featurePanel && !els.featurePanel.hidden) { els.featurePanel.hidden = true; }
      else if (state.soloTenant) exitSolo();
    }
  });
  updateBeaconIndicator();
  setInterval(updateBeaconIndicator, 500);
}
/* ============ 战术交互层（官方 Arena Hero 移植 · 只读演练模式） ============ */
/* 回放引擎：同一 run 连续 tick 快照 → 单位/核心移动动画 + 15s tick 读条
 * （状态/推进/UI 核心在 replay.ts，可单测；本文件持有状态实例 + 渲染层） */
const replay = createReplayState();
const replayDeps = { getJSON, draw, getEls: () => els };
const T = () => state.tactical;
async function tactLoadWorld(tenant: any, force?: any) {
  if (!force && T().worlds[tenant]) return T().worlds[tenant];
  try {
    const w = await getJSON(`/api/world?tenant=${tenant}`);
    if (w.state) { const world = { state: w.state, tick: w.tick, caseFile: w.caseFile, tenant }; T().worlds[tenant] = world; return world; }
    return null;
  } catch { return null; }
}
function tactFindPath(world: any, from: any, to: any, tenant: any) {
  // 合并测绘层已知障碍（雾区记忆）：远距离移动应绕开探索过的石头，而非直线穿雾；
  // BFS 核心在 pathfind.ts（纯函数，可单测）。
  const tac = T();
  const extra = new Set<string>();
  if (tenant && tac.surveys[tenant]) {
    for (const cell of tac.surveys[tenant].obstacleCells) extra.add(pKey([cell.x, cell.y]));
  }
  return findPath(world, from, to, extra);
}
/* ============ 多选 + 批量命令 + 命令队列（群星式编队指挥，2026-08-08） ============ */
const QUEUES_KEY = 'arena-cc.queues';
function multiObjects(tenant: any): any[] {
  const world = T().worlds[tenant];
  if (!world) return [];
  return world.state.objects.filter((o: any) => T().multi.has(o.id) && o.kind !== 'CORE');
}
function multiSync(tenant?: any) {
  const tac = T();
  const t = tenant ?? (tac.selected ? tac.selected.tenant : state.soloTenant);
  if (t) { tactRenderAssets(t); tactRenderHud(t); }
  draw();
}
/** 框选结算：矩形内同租户受控单位加入多选（主选中=矩形内第一个）。 */
function finishBoxSelect() {
  const tac = T();
  const box = tac.boxSelect;
  tac.boxSelect = null;
  if (!box || !state.soloTenant) return;
  const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1);
  const y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);
  const world = tac.worlds[state.soloTenant];
  if (!world) return;
  const hits = world.state.objects.filter((o: any) =>
    o.controlled === true && o.kind === 'UNIT' && o.position &&
    o.position[0] >= x0 - 0.5 && o.position[0] <= x1 + 0.5 &&
    o.position[1] >= y0 - 0.5 && o.position[1] <= y1 + 0.5);
  if (!hits.length) { multiSync(); return; }
  for (const o of hits) tac.multi.add(o.id);
  // 主选中 = 矩形内第一个（未选中的），保持 selected 有值
  const first = hits[0];
  if (!tac.selected || tac.selected.obj.id !== first.id) {
    tac.selected = { tenant: state.soloTenant, obj: first };
    tactRenderActionDialog(); tactRenderInspect();
  }
  toast(`已框选 ${hits.length} 个单位（共 ${tac.multi.size} 选中）`, 'info');
  multiSync();
}
/** 批量命令菜单（多选 ≥2 时右键任意成员弹出）：组内可执行数 ×N 显示。 */
function batchActionCounts(tenant: any) {
  const tac = T();
  const world = tac.worlds[tenant];
  const objs = multiObjects(tenant);
  if (!world || !objs.length) return {};
  const counts: Record<string, number> = {};
  const isCoreGroup = false;
  for (const o of objs) {
    const av = tactAvailability(world, o);
    for (const [act, ok] of Object.entries(av.actions)) {
      if (ok) counts[act] = (counts[act] ?? 0) + 1;
    }
  }
  return counts;
}
function renderBatchCtxMenu(tenant: any, px: any, py: any) {
  const tac = T();
  const n = tac.multi.size;
  const counts = batchActionCounts(tenant);
  const items = [
    ['MOVE', '移动', counts.MOVE ?? 0],
    ['HARVEST', '采集', counts.HARVEST ?? 0],
    ['DEPOSIT', '回仓', counts.DEPOSIT ?? 0],
    ['HEAL', '维修', counts.HEAL ?? 0],
    ['SHOOT', '攻击', counts.SHOOT ?? 0],
    ['WAIT', '等待', counts.WAIT ?? 0],
  ];
  els.ctxMenu.innerHTML = `
    <div class="ctx-head"><span class="ctx-icon">⛶</span><b>批量命令 · ${n} 个单位</b><button class="ctx-close" data-ctx-close type="button" title="关闭（Esc）">✕</button></div>
    ${items.map(([act, cn, cnt]) => Number(cnt) > 0
      ? `<button class="ctx-item" data-action="${act}"><span class="ctx-ico">${TACT_ACTION_ICON[act] ?? ''}</span>${cn} <span class="ctx-cnt">×${cnt}</span></button>`
      : '').join('')}
    <div class="ctx-foot">Shift 拖拽框选 / Shift 点击加选 · Esc 取消</div>`;
  const rect = els.canvas.getBoundingClientRect();
  els.ctxMenu.hidden = false;
  const mw = els.ctxMenu.offsetWidth, mh = els.ctxMenu.offsetHeight;
  let left = px + 12, top = py - 8;
  if (left + mw > rect.width - 8) left = px - mw - 12;
  if (top + mh > rect.height - 8) top = rect.height - mh - 8;
  if (top < 8) top = 8;
  els.ctxMenu.style.left = `${left}px`;
  els.ctxMenu.style.top = `${top}px`;
  ctxMenuOpenFor = '__batch__';
  els.ctxMenu.querySelector('[data-ctx-close]')?.addEventListener('click', hideCtxMenu);
  els.ctxMenu.querySelectorAll('[data-action]').forEach((b: any) => b.addEventListener('click', () => {
    hideCtxMenu();
    batchChooseAction(b.dataset.action);
  }));
}
/** 批量动作入口：MOVE 走批量目标模式；其余按组内可用性过滤后逐单位提交。 */
function batchChooseAction(type: any) {
  const tac = T();
  const tenant = tac.selected ? tac.selected.tenant : state.soloTenant;
  if (!tenant) return;
  const world = tac.worlds[tenant];
  const objs = multiObjects(tenant);
  if (!world || !objs.length) return;
  if (type === 'MOVE') {
    tac.mode = 'BATCH_MOVE';
    enterTargetingMode('🎯 批量移动：点目标格，整组前往 · Shift+点击=排队 · Esc 取消');
    draw(); return;
  }
  if (type === 'SHOOT') {
    tac.mode = 'BATCH_SHOOT';
    enterTargetingMode('🎯 批量攻击：点敌方目标，组内游侠开火 · Esc 取消');
    draw(); return;
  }
  // 一键动作：逐单位过滤可用性后提交
  let done = 0;
  for (const o of objs) {
    const av = tactAvailability(world, o);
    if (av.actions[type] !== true) continue;
    submitCommand(tenant, o.id, { type }, `${TACT_ACTION_CN[type] ?? type}（批量）`);
    done++;
  }
  if (!done) toast('组内没有可执行该动作的单位', 'warn');
  else toast(`批量命令已提交：${TACT_ACTION_CN[type] ?? type} ×${done}`, 'ok');
  multiSync();
}
/** 批量目标落点：MOVE 组内逐个寻路提交 goto；SHOOT 组内游侠提交攻击。 */
function batchSubmitTarget(wx: any, wy: any, enqueue: boolean) {
  const tac = T();
  const tenant = tac.selected ? tac.selected.tenant : state.soloTenant;
  if (!tenant) return;
  const world = tac.worlds[tenant];
  const objs = multiObjects(tenant);
  if (!world || !objs.length) return;
  let done = 0;
  const batchType = tac.mode === 'BATCH_MOVE' ? '移动' : '攻击'; // 先保存（mode 随后置 null）
  for (const o of objs) {
    if (tac.mode === 'BATCH_MOVE') {
      const path = tactFindPath(world, o.position, [wx, wy], tenant);
      if (!path) continue;
      if (enqueue) { queuePush(tenant, o.id, 'goto', [wx, wy]); }
      else { submitGoal(tenant, o.id, 'goto', [wx, wy], `移动 → [${wx}, ${wy}]（批量）`); }
    } else if (tac.mode === 'BATCH_SHOOT') {
      submitCommand(tenant, o.id, { type: 'SHOOT', targetId: null, expectedCell: [wx, wy] }, `朝 [${wx}, ${wy}] 开火（批量）`);
    }
    done++;
  }
  if (!done) toast(tac.mode === 'BATCH_MOVE' ? '组内单位均无法到达该目标' : '组内没有可射击单位', 'warn');
  else {
    toast(tac.mode === 'BATCH_MOVE' ? (enqueue ? `已入队 ${done} 个单位` : `批量移动 ×${done}`) : `批量攻击 ×${done}`, 'ok');
    // 批量反馈（2026-08-08）：HUD 持续显示批量提交/生效/被拒汇总（toast 短暂）
    if (!enqueue) tac.batchLast = { n: done, type: batchType, at: Date.now(), applied: 0, rejected: 0 };
  }
  tac.mode = null;
  multiSync();
}
/** 队列持久化：localStorage（前端调度，服务端仍单条 goal 活跃）。 */
function queueSave() {
  try {
    const plain: Record<string, any[]> = {};
    for (const [k, v] of Object.entries(T().queues)) plain[k] = v;
    localStorage.setItem(QUEUES_KEY, JSON.stringify(plain));
  } catch { /* 忽略 */ }
}
function queueLoad() {
  try {
    const p = JSON.parse(localStorage.getItem(QUEUES_KEY) ?? '{}') || {};
    T().queues = {};
    for (const [k, v] of Object.entries(p)) if (Array.isArray(v) && v.length) T().queues[k] = v as any[];
  } catch { /* 忽略 */ }
}
function queuePush(tenant: any, unitId: any, kind: any, target: any) {
  const tac = T();
  tac.queues[unitId] = tac.queues[unitId] ?? [];
  tac.queues[unitId].push({ kind, target });
  queueSave();
  const q = tac.queues[unitId];
  toast(`已加入队列（第 ${q.length} 段）· 当前段完成后自动执行下一段`, 'info');
  // 单位无活跃指令时立即提交首段
  if (q.length === 1 && !commandGoalOf(tenant, unitId) && !commandActionOf(tenant, unitId)) {
    submitGoal(tenant, unitId, kind, target, `${kind === 'mine' ? '采矿' : '移动'} → [${target[0]}, ${target[1]}]（队列 1/${q.length}）`);
  }
  tactRenderActionDialog();
}
function queueAdvance(tenant: any, unitId: any) {
  const tac = T();
  const q = tac.queues[unitId];
  if (!q || !q.length) return;
  const next = q.shift();
  if (next && q.length) {
    submitGoal(tenant, unitId, next.kind, next.target, `${next.kind === 'mine' ? '采矿' : '移动'} → [${next.target[0]}, ${next.target[1]}]（队列 ${q.length + 1}/${q.length + 1}）`);
  } else {
    delete tac.queues[unitId];
  }
  queueSave();
  tactRenderActionDialog();
}
function queueClearUnit(unitId: any) {
  const tac = T();
  delete tac.queues[unitId];
  queueSave();
  tactRenderActionDialog();
}
function queueOf(unitId: any): any[] | null {
  const q = T().queues[unitId];
  return q && q.length ? q : null;
}
/** 队列状态行（HTML）：当前段 + 剩余段，供动作面板展示。 */
function queueStatusHtml(unitId: any): string {
  const q = queueOf(unitId);
  if (!q) return '';
  const segLabel = (s: any) => (s.kind === 'mine' ? '采矿' : '移动') + ` [${s.target[0]}, ${s.target[1]}]`;
  return `<div class="act-goal act-queue"><span class="q-title">命令队列 · ${q.length} 段</span>
    ${q.map((s, i) => `<span class="q-seg ${i === 0 ? 'q-cur' : ''}">${i + 1}. ${segLabel(s)}</span>`).join('')}
    <button data-queue-clear>清空队列</button></div>`;
}
/** 遥测 satisfied → 队列推进（当前段完成，提交下一段）。 */
function queueOnSatisfied(tenant: any, unitId: any) {
  if (queueOf(unitId)) queueAdvance(tenant, unitId);
}
/** 选中即定位（2026-08-08）：单位不在当前视口（含边距）时平滑移入视野，
 *  复用 animateView 指数缓动——解决“点卡片/点画布选中屏外单位看不到”。
 *  已在视野内则不平移（避免打扰正在观察的上下文）。 */
function revealUnit(tenant: any, obj: any) {
  if (!obj || !Array.isArray(obj.position) || obj.position.length < 2) return;
  const s = state.view.scale;
  const p = project(obj.position[0], obj.position[1]);
  const mx = 90, my = 70; // 边距：避开左/右面板与顶/底栏（侧栏 291 / 决策流 339）
  const w = W(), h = H();
  const l = mx, r = w - mx, t = my, b = h - my;
  if (p.sx >= l && p.sx <= r && p.sy >= t && p.sy <= b) return;
  const tx = state.view.cx + (p.sx - (l + r) / 2) / s;
  const ty = state.view.cy + (p.sy - (t + b) / 2) / s;
  animateView({ cx: tx, cy: ty, scale: state.view.scale }, 420);
}
async function tactSelect(tenant: any, obj: any) {
  const world = await tactLoadWorld(tenant);
  if (!world) return;
  const tac = T();
  tac.selected = { tenant, obj };
  if (els.featurePanel) els.featurePanel.hidden = true;
  tac.mode = null; tac.moveRoute = null; tac.routePreview = null; tac.attackTarget = null;
  panelDrag = {}; // 新选中：卡片回到默认锚点
  startSelectionRipple(obj.id);
  revealUnit(tenant, obj); // 选中即定位：屏外单位平滑移入视野
  tactRenderActionDialog();
  tactRenderInspect();
  tactRenderAssets(tenant);
  tactRenderHud(tenant);
  draw();
}
function tactClear() {
  const tac = T();
  tac.selected = null; tac.mode = null; tac.moveRoute = null; tac.routePreview = null; tac.attackTarget = null;
  tac.multi = new Set(); tac.boxSelect = null; // 清除多选/框选
  els.actionDialog.hidden = true; els.inspectPanel.hidden = true; els.featurePanel.hidden = true;
  els.ctxMenu.hidden = true; ctxMenuOpenFor = null;
  els.assetPanel.hidden = true; els.fleetHud.hidden = true;
  replay.playing = false; // 停掉回放引擎：退出单租户后不再 60fps 空转重绘
  els.replayBar.hidden = true;
  els.activityPanel.hidden = true; els.commandCountdown.hidden = true;
  els.respawnOverlay.hidden = true;
  if (els.hint) els.hint.dataset.zoom = ''; // 触发 draw() 恢复默认提示
  if (els.mapGlobal) els.mapGlobal.hidden = !state.soloTenant;
  draw();
}
/** 全局轻提示：每次点击/操作都有反馈（解决"点了没反应"）。 */
let toastTimer: number | null = null;
let toastState: { priority: number; expiresAt: number } | null = null;
/** 全局轻提示：每次点击/操作都有反馈（解决"点了没反应"）。
 *  优先级（priority，越大越重要）：交互反馈 0 / 后台通知 -1。
 *  正在展示的高优先级 toast 不被低优先级覆盖（防卡死提示刷屏顶掉用户反馈）。 */
function toast(msg: any, tone = 'info', priority = 0) {
  let el = document.getElementById('uiToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'uiToast';
    document.body.appendChild(el);
  }
  const now = Date.now();
  const showing = el.classList.contains('show') && toastState && toastState.expiresAt > now;
  if (showing && (toastState?.priority ?? 0) > priority) return; // 低优先级不顶高优先级
  el.textContent = msg;
  el.className = `ui-toast ${tone}`;
  void el.offsetWidth;
  el.classList.add('show');
  const life = priority < 0 ? 1600 : 2400;
  toastState = { priority, expiresAt: now + life };
  clearTimeout(toastTimer ?? undefined);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), life);
}
/** 信标边缘指示由图层开关 state.layers.beaconEdge 控制（持久化见 savePrefs）。 */
/** 重新触发面板入场动画（租户切换时内容已变，让面板丝滑重现）。 */
function popPanel(el: any) {
  if (!el || el.hidden) return;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
}
/** 单租户聚焦徽章：显示当前聚焦租户（T1·聚焦），全局时隐藏。 */
function syncSoloBadge() {
  const t = state.soloTenant;
  if (!t) { els.soloBadge.hidden = true; return; }
  els.soloBadge.hidden = false;
  els.soloBadge.style.setProperty('--tc', TENANT_COLORS[t] ?? '#69b3d8');
  els.soloBadge.textContent = t.toUpperCase() + ' · 聚焦 ✕';
}
/** 退出单租户回全局联盟：清空战术层/回放 + 视图适应 + UI 同步（viewGlobal / mapGlobal / G 键共用）。 */
function exitSolo() {
  state.soloTenant = null;
  els.respawnOverlay.hidden = true; // 退出聚焦：重生横幅一并收起
  tactClear();
  invalidateStatic();
  fitView();
  lastRevealSolo = null;
  const sb = document.getElementById('sidebar');
  if (sb) sb.scrollTo({ top: 0, behavior: 'smooth' });
  emit('solo', state.soloTenant);
  emit('overview', state.overview);
  els.mapGlobal.hidden = true;
  syncSoloBadge();
}
function tactActionTypes(obj: any) {
  const sel = T().selected;
  const world = sel ? T().worlds[sel.tenant] : null;
  const av = tactAvailability(world, obj);
  const isCore = obj.kind === 'CORE';
  // 按单位类型列全「官方可用动作集」（含位置类动作），交给 tactChooseAction 统一处理：
  // 需要方向（MOVE/SWEEP/START_MOVE）与需要目标（SHOOT）的走地图选点，其余一键提交。
  // 信标/维修等条件动作不依赖 av.actions 判读（始终列出，可用性由按钮态表达），
  // 避免"有动作但按钮不显示"的盲区。
  const types = isCore
    ? (obj.state === 'MOVING' ? ['CANCEL_MOVE'] : ['HEAL', 'REPAIR_SHIELD', 'START_MOVE', 'PICKUP_BEACON', 'DROP_BEACON'])
    : obj.unit_type === 'WORKER' ? ['MOVE', 'HARVEST', 'DEPOSIT', 'PICKUP_BEACON', 'DROP_BEACON', 'HEAL']
    : obj.unit_type === 'VANGUARD' ? ['MOVE', 'SWEEP', 'PICKUP_BEACON', 'DROP_BEACON', 'HEAL']
    : ['MOVE', 'SHOOT', 'PICKUP_BEACON', 'DROP_BEACON', 'HEAL'];
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
    return `<button class="act-spawn" data-spawn="${u}" title="提交：生产 ${TACT_UNIT_CN[u]}（${cost} 资源，人类指挥）"><img src="${unitSpritePath(u)}" alt="" /><span>${TACT_UNIT_CN[u]}</span><b>${cost}</b></button>`;
  }).join('')}</div></div>` : '';
  const sgoal = commandGoalOf(sel.tenant, obj.id);
  const goalRow = sgoal
    ? `<div class="act-goal"><span>${sgoal.kind === 'mine' ? '采矿任务' : '移动任务'} → [${sgoal.target[0]}, ${sgoal.target[1]}] · 人类指挥</span><button data-cancel-goal>清除指令</button></div>`
    : (tac.moveGoals[obj.id] ? `<div class="act-goal"><span>本地路线 → [${tac.moveGoals[obj.id][0]}, ${tac.moveGoals[obj.id][1]}]</span></div>` : '');
  const queueRow = obj.kind !== 'CORE' ? queueStatusHtml(obj.id) : '';
  const unitTele = unitTelemetryOf(sel.tenant, obj.id);
  const cmdStatus = commandStatusText(sel.tenant);
  const modeBadge = tac.mode ? `<div class="act-mode-badge">${tac.mode === 'MOVE' ? '点矿=自动采矿任务 · 点空地=移动任务 · Shift+点击=追加队列' : tac.mode === 'BATCH_MOVE' ? '批量移动：点目标格整组前往 · Shift+点击=入队' : tac.mode === 'BATCH_SHOOT' ? '批量攻击：点目标格，组内游侠开火' : tac.mode === 'SHOOT' ? '点击敌方单位 → 锁定并提交攻击' : '点击单位相邻格选择清扫方向并提交'}</div>` : '';
  els.actionDialog.innerHTML = `
    <div class="act-head">
      <span class="act-icon"><img src="${artPath}" alt="" /></span>
      <div class="act-id">
        <b>${name} · ${sel.tenant.toUpperCase()}</b>
        <span class="mono">${obj.hp} HP${obj.shield != null ? ` · ${obj.shield} SHD` : ''}${(obj.cargo ?? 0) > 0 ? ` · 载货 ${obj.cargo}` : ''}</span>
        <span class="mono dim">[${obj.position[0]}, ${obj.position[1]}]${obj.controlled ? '' : ' · 敌方'}</span>
      </div>
      <button class="act-close" data-close aria-label="关闭">✕</button>
    </div>
    ${modeBadge}
    <div class="act-grid">${types.map((t2) => {
      const available = av.actions[t2] === true;
      const danger = t2 === 'SELF_DESTRUCT';
      const reason = av.reasons?.[t2];
      if (!available && !reason) return `<button class="act-btn ${danger ? 'danger' : ''}" data-action="${t2}" disabled title="当前不可用"><span class="act-ico">${TACT_ACTION_ICON[t2] ?? ''}</span>${TACT_ACTION_CN[t2] ?? t2}</button>`;
      if (!available) return `<button class="act-btn blocked" data-blocked="${t2}" data-reason="${escapeHtml(reason)}" title="${escapeHtml(reason)}"><span class="act-ico">${TACT_ACTION_ICON[t2] ?? ''}</span>${TACT_ACTION_CN[t2] ?? t2}</button>`;
      return `<button class="act-btn ${danger ? 'danger' : ''}" data-action="${t2}" title="提交：${TACT_ACTION_CN[t2]}（人类指挥）"><span class="act-ico">${TACT_ACTION_ICON[t2] ?? ''}</span>${TACT_ACTION_CN[t2] ?? t2}</button>`;
    }).join('')}</div>
    ${costHtml}
    ${goalRow}
    ${queueRow}
    ${unitTele ? `<div class="act-goal act-tele">${unitTele}</div>` : ''}
    ${cmdStatus ? `<div class="act-mode-badge cmd-status">${cmdStatus}</div>` : ''}
    <div class="act-note">${isCore ? '核心 · 生产/移动为真实命令' : obj.unit_type === 'RANGER' ? '游侠 · 远程射击：点敌方目标提交攻击' : obj.unit_type === 'VANGUARD' ? '先锋 · 近战：点相邻格提交清扫' : '工人 · 点矿=自动采矿（到达挖、满仓回）'} · 人类指挥最高优先</div>
  `;
  const p = project(obj.position[0], obj.position[1]);
  const rect = els.canvas.getBoundingClientRect();
  els.actionDialog.hidden = false;
  els.actionDialog.style.left = '0px'; els.actionDialog.style.top = '0px';
  const dw = els.actionDialog.offsetWidth, dh = els.actionDialog.offsetHeight;
  const saved = panelDrag.actionDialog;
  let left = saved ? saved.left : p.sx + 18;
  let top = saved ? saved.top : p.sy - dh / 2;
  if (!saved) {
    if (left + dw > rect.width - 8) left = p.sx - dw - 18;
    if (top < 8) top = 8;
    if (top + dh > rect.height - 8) top = rect.height - dh - 8;
  }
  els.actionDialog.style.left = `${left}px`;
  els.actionDialog.style.top = `${top}px`;
  els.actionDialog.querySelector('[data-close]')?.addEventListener('click', tactClear);
  els.actionDialog.querySelectorAll('[data-action]').forEach((b: any) => b.addEventListener('click', () => tactChooseAction(b.dataset.action)));
  makeDraggable(els.actionDialog, '.act-head', 'actionDialog');
  els.actionDialog.querySelectorAll('[data-blocked]').forEach((b: any) => b.addEventListener('click', () => {
    toast(b.dataset.reason || '当前不可用', 'warn');
    b.classList.add('shake');
    setTimeout(() => b.classList.remove('shake'), 400);
  }));
  els.actionDialog.querySelectorAll('[data-spawn]').forEach((b: any) => b.addEventListener('click', () => tactSpawn(b.dataset.spawn)));
  els.actionDialog.querySelector('[data-cancel-goal]')?.addEventListener('click', () => { delete tac.moveGoals[obj.id]; tac.moveRoute = null; tac.routePreview = null; clearUnitCommands(sel.tenant, obj.id); tactRenderActionDialog(); draw(); });
  els.actionDialog.querySelector('[data-queue-clear]')?.addEventListener('click', () => { queueClearUnit(obj.id); toast('已清空命令队列', 'info'); draw(); });
}
function tactChooseAction(type: any) {
  const tac = T(), sel = tac.selected;
  if (!sel) return;
  const world = tac.worlds[sel.tenant];
  if (!world) return;
  const obj = sel.obj;
  const av = tactAvailability(world, obj);
  if (av.actions[type] !== true) return;
  if (type === 'MOVE' || type === 'START_MOVE') {
    tac.mode = type; // MOVE=单位移动目标 / START_MOVE=核心迁移方向（核心移动在选点后提交）
    tac.routePreview = null;
    enterTargetingMode(type === 'START_MOVE' ? '🎯 选择核心迁移方向（点相邻格） · Esc 取消' : '🎯 选择目标：点矿=采矿任务 · 点空地=移动任务 · Esc 取消');
    draw(); return;
  }
  if (type === 'SHOOT') {
    if (obj.unit_type !== 'RANGER') { toast('近战单位无法远程攻击：先锋可清扫相邻格，游侠才能射击', 'warn'); return; }
    const inRange = tactRangerRange(world, obj).some((t) => tactObjectAt(world, t[0], t[1])?.controlled === false);
    if (!inRange) { toast('射程内无敌方目标', 'warn'); return; }
    tac.mode = 'SHOOT'; enterTargetingMode('🎯 点击敌方单位锁定并提交攻击 · Esc 取消'); draw(); return;
  }
  if (type === 'SWEEP') { tac.mode = 'SWEEP'; enterTargetingMode('点击单位相邻格选择清扫方向并提交 · Esc 取消'); draw(); return; }
  // 一键动作：直接提交真实命令（人类最高控制权）
  if (type === 'SELF_DESTRUCT') {
    if (!window.confirm(`确认让 ${obj.kind === 'CORE' ? '核心' : '单位'} 自毁？此命令将提交到 Arena`)) return;
  }
  tac.mode = null;
  const isCore = obj.kind === 'CORE';
  const coreId = world.state?.objects?.find((o: any) => o.kind === 'CORE' && o.controlled === true)?.id ?? null;
  const unitId = isCore ? coreId : obj.id;
  const action: Record<string, any> = { type };
  if (type === 'MOVE' || type === 'START_MOVE') action.direction = 'UP'; // 不应到达这里
  if (unitId) submitCommand(sel.tenant, unitId, action, TACT_ACTION_CN[type] ?? type);
  tactRenderActionDialog();
}
/** 面板拖拽位置（拖动后持久到本次选中；新选中重置回默认锚点）。 */
let panelDrag: Record<string, any> = {};
/** 卡片拖拽（2026-08-08）：按住头部可挪开卡片，不再挡地图选点。 */
function makeDraggable(el: any, handleSel: any, key: any) {
  if (!el || !el.querySelector) return;
  const handle = el.querySelector(handleSel) || el;
  handle.style.cursor = 'grab';
  handle.style.touchAction = 'none';
  let start: { x: number; y: number; l: number; t: number; moved: boolean } | null = null;
  const onDown = (e: any) => {
    if (e.target.closest && e.target.closest('button, a, input, select, [data-action], [data-close], [data-spawn]')) return;
    start = { x: e.clientX, y: e.clientY, l: el.offsetLeft, t: el.offsetTop, moved: false };
    if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch { /* 忽略 */ } }
    e.preventDefault();
  };
  const onMove = (e: any) => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 4) return;
    start.moved = true;
    const left = Math.max(0, start.l + dx), top = Math.max(0, start.t + dy);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    if (el.id === 'inspectPanel') el.style.right = 'auto';
    if (key) panelDrag[key] = { left, top };
  };
  const onUp = () => { start = null; };
  // 事件挂 window：setPointerCapture 会把后续事件重定向到 el，handle 上收不到 → 拖拽失效（实测）
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  handle.addEventListener('pointerdown', onDown);
}
/** 进入地图选点模式：收起动作卡（不挡地图），提示条引导点击。 */
function enterTargetingMode(tip: any) {
  const sel = T().selected;
  if (sel && sel.obj && sel.obj.position) {
    // 紧凑目标模式条（2026-08-08）：MOVE/SHOOT/SWEEP 后保留在选中单位旁的可见指令条
    // + 取消按钮——解决"点了没反应/不知道怎么取消"（旧行为直接隐藏动作框只剩底部小字）。
    const p = project(sel.obj.position[0], sel.obj.position[1]);
    els.actionDialog.innerHTML = `
      <div class="act-targeting">
        <span class="at-dot"></span>
        <span class="at-text">${escapeHtml(tip)}</span>
        <button class="at-cancel" data-cancel-target type="button">✕ 取消</button>
      </div>`;
    els.actionDialog.hidden = false;
    // 固定底部居中（不跟随单位）：目标区是整张地图，条放边缘不挡选点；
    // .act-targeting pointer-events:none 只让取消按钮可点，画布点击全部穿透。
    const rect = els.canvas.getBoundingClientRect();
    const dw = els.actionDialog.offsetWidth, dh = els.actionDialog.offsetHeight;
    els.actionDialog.style.left = `${Math.max(8, (rect.width - dw) / 2)}px`;
    els.actionDialog.style.top = `${Math.max(8, rect.height - dh - 44)}px`;
    els.actionDialog.querySelector('[data-cancel-target]')?.addEventListener('click', tactClear);
  } else {
    els.actionDialog.hidden = true;
  }
  if (els.hint) { els.hint.textContent = tip; els.hint.classList.remove('map-hint-fade'); }
}

/* ============ 右键指挥菜单（群星式 Context Command Menu） ============
 * 群星指挥核心交互：左键选中/目标，右键命令。
 * 右键命中单位/核心 → 选中并弹出该单位可用命令菜单（与动作面板同源）；
 * 右键空白 → 取消选中。SELF_DESTRUCT/WAIT 不入菜单（危险/无意义动作只在动作面板）。 */
let ctxMenuOpenFor = null; // 菜单当前所属单位 id（防菜单过期渲染）
function hideCtxMenu() {
  if (els.ctxMenu) els.ctxMenu.hidden = true;
  ctxMenuOpenFor = null;
}
function renderCtxMenu(tenant: any, obj: any, px: any, py: any) {
  const tac = T(), sel = tac.selected;
  if (!sel || sel.obj.id !== obj.id || tac.mode) { hideCtxMenu(); return; }
  const world = tac.worlds[tenant];
  if (!world) return;
  const { types, av } = tactActionTypes(obj);
  const isCore = obj.kind === 'CORE';
  const art = isCore ? 'CORE' : (obj.unit_type ?? 'WORKER');
  const artPath = art === 'CORE' ? SPRITE.core : unitSpritePath(art);
  const name = isCore ? '核心' : (TACT_UNIT_CN[obj.unit_type] ?? obj.unit_type);
  const items = types
    .filter((t) => t !== 'SELF_DESTRUCT' && t !== 'WAIT')
    .map((t) => {
      const available = av.actions[t] === true;
      const reason = av.reasons?.[t];
      if (available) return `<button class="ctx-item" data-action="${t}"><span class="ctx-ico">${TACT_ACTION_ICON[t] ?? ''}</span>${TACT_ACTION_CN[t] ?? t}</button>`;
      if (reason) return `<button class="ctx-item blocked" data-action="${t}" data-reason="${escapeHtml(reason)}" title="${escapeHtml(reason)}"><span class="ctx-ico">${TACT_ACTION_ICON[t] ?? ''}</span>${TACT_ACTION_CN[t] ?? t}</button>`;
      return '';
    }).join('');
  els.ctxMenu.innerHTML = `
    <div class="ctx-head"><span class="ctx-icon"><img src="${artPath}" alt="" /></span><b>${name} · ${tenant.toUpperCase()}</b><button class="ctx-close" data-ctx-close type="button" title="关闭（Esc）">✕</button></div>
    ${items}
    <div class="ctx-foot">${isCore ? '核心 · 生产/迁移走动作面板' : obj.unit_type === 'RANGER' ? '游侠 · 攻击需选敌方目标' : obj.unit_type === 'VANGUARD' ? '先锋 · 清扫需选相邻方向' : '工人 · 采集需站在资源格'}</div>
  `;
  // 定位：鼠标旁，右缘/下缘翻转防溢出
  const rect = els.canvas.getBoundingClientRect();
  els.ctxMenu.hidden = false;
  const mw = els.ctxMenu.offsetWidth, mh = els.ctxMenu.offsetHeight;
  let left = px + 12, top = py - 8;
  if (left + mw > rect.width - 8) left = px - mw - 12;
  if (top + mh > rect.height - 8) top = rect.height - mh - 8;
  if (top < 8) top = 8;
  els.ctxMenu.style.left = `${left}px`;
  els.ctxMenu.style.top = `${top}px`;
  ctxMenuOpenFor = obj.id;
  els.ctxMenu.querySelector('[data-ctx-close]')?.addEventListener('click', hideCtxMenu);
  els.ctxMenu.querySelectorAll('[data-action]').forEach((b: any) => b.addEventListener('click', () => {
    const act = b.dataset.action;
    if (b.classList.contains('blocked')) {
      toast(b.dataset.reason || '当前不可用', 'warn');
      b.classList.add('shake');
      setTimeout(() => b.classList.remove('shake'), 400);
      return;
    }
    hideCtxMenu();
    tactChooseAction(act);
  }));
}
async function openCtxMenu(px: any, py: any) {
  const tac = T();
  // 选点模式中右键：先取消当前模式再开菜单（避免模式悬空）
  if (tac.mode) tactClear();
  // 实时命中校正（2026-08-08 结构性统一）：与左键共用 resolveLiveTarget（半径 3、
  // 写回真实坐标、含 solo 租户兜底）——轮询陈旧窗口下右键脱靶（右键菜单回归偶发红）
  // 与左键同源根治：单位位移后其渲染格可能已不在最近命中，统一走同一套实时命中。
  // 命中单位/核心 → 弹命令菜单；空白/资源/障碍 → 取消选中（与旧语义一致）。
  const hit = await resolveLiveTarget(px, py);
  const obj = hit?.obj ?? null;
  if (obj && (obj.kind === 'UNIT' || obj.kind === 'CORE')) {
    const tenant = hit.cell?.tenant ?? tac.selected?.tenant ?? state.soloTenant;
    if (!tenant) { hideCtxMenu(); return; }
    if (obj.controlled !== true) { toast('敌方单位无法指挥（可左键选中查看情报）', 'warn'); return; }
    // 多选 ≥2 且命中编队成员：弹批量命令菜单
    if (tac.multi.size >= 2 && tac.multi.has(obj.id)) {
      renderBatchCtxMenu(tenant, px, py);
      return;
    }
    const selected = tac.selected && tac.selected.obj.id === obj.id;
    const open = () => renderCtxMenu(tenant, obj, px, py);
    if (selected) open();
    else tactSelect(tenant, obj).then(open);
    return;
  }
  // 右键空白/非单位：取消选中（群星右键空白 = 取消目标/收镜）
  if (tac.selected) { tactClear(); return; }
  hideCtxMenu();
}

function tactSpawn(unitType: any) {
  const tac = T(), sel = tac.selected;
  if (!sel || sel.obj.kind !== 'CORE') return;
  const world = tac.worlds[sel.tenant];
  if (!world) return;
  const cost = tactUnitCost(unitType, world?.state.population ?? 0);
  if (!window.confirm(`确认核心生产 ${TACT_UNIT_CN[unitType]}（${cost} 资源）？此命令将提交到 Arena`)) return;
  const coreId = world.state?.objects?.find((o: any) => o.kind === 'CORE' && o.controlled === true)?.id ?? null;
  if (!coreId) { toast('找不到己方核心', 'warn'); return; }
  tac.mode = null;
  submitCommand(sel.tenant, coreId, { type: 'SPAWN', unitType }, `生产 ${TACT_UNIT_CN[unitType]}`);
  tactRenderActionDialog();
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
  if (obj.shield != null) rows.push(['护盾', obj.shield]);
  if (obj.cargo != null) rows.push(['载货', obj.cargo]);
  if (obj.owner_username) rows.push(['拥有者', obj.owner_username]);
  if (obj.state === 'MOVING') rows.push(['状态', `移动中 → [${obj.destination?.[0] ?? '?'}, ${obj.destination?.[1] ?? '?'}]`]);
  const sgoal = commandGoalOf(sel.tenant, obj.id);
  if (sgoal) rows.push(['指挥任务', `${sgoal.kind === 'mine' ? '采矿' : '移动'} → [${sgoal.target[0]}, ${sgoal.target[1]}] · 人类`]);
  else { const goal = tac.moveGoals[obj.id]; if (goal) rows.push(['本地路线', `→ [${goal[0]}, ${goal[1]}]`]); }
  els.inspectPanel.hidden = false;
  els.inspectPanel.innerHTML = `<h3 class="panel-title">单位详情 · DETAILS</h3>${rows.map(([k, v]) => `<div class="ins-row"><span>${k}</span><b>${v}</b></div>`).join('')}`;
  const svd = panelDrag.inspectPanel;
  if (svd) { els.inspectPanel.style.left = `${svd.left}px`; els.inspectPanel.style.top = `${svd.top}px`; els.inspectPanel.style.right = 'auto'; }
  makeDraggable(els.inspectPanel, '.panel-title', 'inspectPanel');
}
function tactRenderAssets(tenant: any) {
  const world = T().worlds[tenant];
  if (!world) { els.assetPanel.hidden = true; return; }
  const controlled = world.state.objects.filter((o: any) => o.controlled === true && (o.kind === 'UNIT' || o.kind === 'CORE'));
  els.assetPanel.hidden = false;
  els.assetPanel.querySelector('.panel-title').textContent = `舰队索引 · ${tenant.toUpperCase()} · ${controlled.length}`;
  // 群星式 Outliner：按类型分组（核心/工人/先锋/游侠），组头计数 + 可折叠（localStorage 记忆）
  const groups = [
    ['CORE', '核心'], ['WORKER', '工人'], ['VANGUARD', '先锋'], ['RANGER', '游侠'],
  ];
  let collapsed: Record<string, boolean> = {};
  try { collapsed = JSON.parse(localStorage.getItem('arena-cc.assetGroups') ?? '{}') || {}; } catch { /* 忽略 */ }
  els.assetList.innerHTML = groups.map(([gtype, gcn]) => {
    const members = controlled.filter((o: any) => o.kind === 'CORE' ? gtype === 'CORE' : (o.unit_type ?? '') === gtype);
    if (!members.length) return '';
    const isCollapsed = collapsed[gtype] === true;
    const rows = members.map((o: any) => {
      const art = o.kind === 'CORE' ? 'CORE' : (o.unit_type ?? 'WORKER');
      const artPath = art === 'CORE' ? SPRITE.core : unitSpritePath(art);
      const selected = T().selected?.obj?.id === o.id;
      const inSquad = !selected && T().multi.has(o.id); // 编队成员高亮（与画布连接线呼应）
      const human = unitHumanCommandOf(tenant, o.id);
      const plan = state.soloTenant === tenant ? T().plan?.plan : T().plans?.[tenant];
      const cmdLine = cmdLabel(T(), tenant, o.id, plan); // 当前指令标签（人类指挥/算法决策）
      // 核心无标准 HP 上限：以 hp/shield 当前最大值为基准（满状态=满条，受损即缩短）
      const hpMax = art === 'CORE' ? Math.max(o.hp ?? 0, o.shield ?? 0, 1) : maxUnitHp(art);
      const hpVal = art === 'CORE' ? Math.max(o.hp ?? 0, o.shield ?? 0) : (o.hp ?? 0);
      const hpPct = hpMax > 0 ? Math.max(0, Math.min(100, (hpVal / hpMax) * 100)) : 100;
      return `<button class="asset-row ${selected ? 'active' : ''}${inSquad ? ' squad' : ''}${human ? ' human' : ''}" data-asset="${o.id}" ${human ? 'title="人类指挥中 · 点击查看/清除指令"' : inSquad ? 'title="编队成员"' : ''}>
        <span class="asset-icon"><img src="${artPath}" alt="" /></span>
        ${human ? '<span class="asset-h" title="人类指挥中">H</span>' : ''}
        <span class="asset-name">${o.kind === 'CORE' ? '核心' : (TACT_UNIT_CN[o.unit_type] ?? o.unit_type)}</span>
        ${cmdLine ? `<span class="asset-cmd${human ? ' human' : ''}" title="${cmdLine}">${cmdLine}</span>` : ''}
        <span class="asset-hpbar" title="${o.hp}/${hpMax} HP"><span class="asset-hpfill ${hpPct <= 35 ? 'low' : ''}" style="width:${hpPct}%"></span></span>
        <span class="mono asset-pos">[${o.position[0]}, ${o.position[1]}]</span>
      </button>`;
    }).join('');
    return `<div class="asset-group${isCollapsed ? ' closed' : ''}" data-grp="${gtype}">
      <button class="asset-group-head" data-grp-head="${gtype}" type="button" title="${isCollapsed ? '展开' : '折叠'}${gcn}组">
        <span class="ag-chev">${isCollapsed ? '▸' : '▾'}</span>
        <span class="ag-name">${gcn}</span>
        <span class="ag-count">${members.length}</span>
      </button>
      <div class="asset-group-body"${isCollapsed ? ' hidden' : ''}>${rows}</div>
    </div>`;
  }).join('') || '<div class="stream-empty">无受控单位</div>';
  els.assetList.querySelectorAll('[data-asset]').forEach((b: any) => b.addEventListener('click', () => {
    const o = world.state.objects.find((x: any) => x.id === b.dataset.asset);
    if (!o) return;
    // 官方 selectFromAssetList：选中并平滑定位到该单位（统一走 tactSelect 内的 revealUnit，不再硬跳）
    tactSelect(tenant, o);
  }));
  els.assetList.querySelectorAll('[data-grp-head]').forEach((h: any) => h.addEventListener('click', () => {
    const g = h.dataset.grpHead;
    const grp = els.assetList.querySelector(`[data-grp="${g}"]`);
    if (!grp) return;
    const closed = grp.classList.toggle('closed');
    grp.querySelector('.asset-group-body').hidden = closed;
    grp.querySelector('.ag-chev').textContent = closed ? '▸' : '▾';
    try { const p = JSON.parse(localStorage.getItem('arena-cc.assetGroups') ?? '{}') || {}; p[g] = closed; localStorage.setItem('arena-cc.assetGroups', JSON.stringify(p)); } catch { /* 忽略 */ }
  }));
}
function tactRenderHud(tenant: any) {
  const world = T().worlds[tenant];
  if (!world) { els.fleetHud.hidden = true; return; }
  const st = world.state;
  const cap = tactCoreCapacity(st.population ?? 0);
  els.fleetHud.hidden = false;
  const survey = T().surveys[tenant] ?? { resourceCells: [], obstacleCells: [], coreCells: [], caseCount: 0, tickMax: 0, fromDb: false };
  const resCount = (survey.resourceCells ?? []).length;
  const activeMines = (survey.resourceCells ?? []).filter((r: any) => r.state === "visible" || r.state === undefined).length;
  const minedOut = (survey.resourceCells ?? []).filter((r: any) => r.state === "harvested" || r.state === "empty").length;
  const staleMines = resCount - activeMines - minedOut;
  const surveyRow = survey ? `<div class="hud-row hud-survey">
    <span class="hud-label">测绘${survey.fromDb ? '·库' : ''}</span>
    <span class="hud-val">${survey.obstacleCells.length} 障碍</span>
    <span class="hud-val" style="color:var(--green-resource)">${resCount} 矿</span>
    <span class="hud-val" style="color:#8fce9f" title="活跃（最近确认存在）">${activeMines}●</span>
    <span class="hud-val" style="color:#5a7a64" title="待确认（见过但未确认）">${staleMines}◐</span>
    <span class="hud-val" style="color:#6b7280" title="采空/已确认空">${minedOut}○</span>
    <span class="hud-val">${survey.coreCells.length} 敌核</span>
    <span class="hud-val dim">${survey.caseCount} case · tick ${survey.tickMax}</span>
  </div>` : '';
  const lc = survey?.lifecycle;
  let lcRow = '';
  if (lc) {
    const spendTotal = (lc.spends ?? []).reduce((s: any, x: any) => s + (x.total ?? 0), 0);
    const spawnTotal = (lc.spends ?? []).find((x: any) => x.kind === 'spawn')?.total ?? 0;
    const healTotal = (lc.spends ?? []).find((x: any) => x.kind === 'core_heal')?.total ?? 0;
    const units = lc.units ?? [];
    const alive = units.filter((u: any) => u.state === 'alive').reduce((s: any, u: any) => s + u.count, 0);
    const dead = units.filter((u: any) => u.state !== 'alive').reduce((s: any, u: any) => s + u.count, 0);
    const unitLabel = ['WORKER', 'VANGUARD', 'RANGER'].map((t) => {
      const c = units.find((u: any) => u.state === 'alive' && u.type === t)?.count ?? 0;
      return c ? c + (t === 'WORKER' ? '工' : t === 'VANGUARD' ? '锋' : '射') : '';
    }).filter(Boolean).join('/');
    lcRow = '<div class="hud-row hud-survey">' +
      '<span class="hud-label">生命</span>' +
      '<span class="hud-val" style="color:var(--green-resource)" title="累计产兵消耗">产 ' + spawnTotal + '</span>' +
      '<span class="hud-val" title="治疗/修复消耗">疗 ' + healTotal + '</span>' +
      '<span class="hud-val dim" title="累计消费总额">耗 ' + spendTotal + '</span>' +
      '<span class="hud-val" title="存活单位">存 ' + alive + (unitLabel ? ' · ' + unitLabel : '') + '</span>' +
      '<span class="hud-val" style="color:var(--danger)" title="累计阵亡单位">亡 ' + dead + '</span>' +
      '<span class="hud-val dim">采 ' + (lc.harvestCount ?? 0) + '</span>' +
      '</div>';
  }
  const cmdStatus = commandStatusText(tenant);
  const tele = T().commands && T().commands.telemetry;
  const hudCmd = cmdStatus
    ? `<div class="hud-row hud-survey"><span class="hud-label">指挥</span><span class="hud-val" style="color:var(--warn)">${cmdStatus}</span>${
        tele && (tele.applied ?? []).length ? `<span class="hud-val" style="color:var(--success)" title="已生效单位">${tele.applied.length}✓</span>` : ''
      }${
        tele && (tele.satisfied ?? []).length ? `<span class="hud-val" style="color:var(--cyan-signal, #5fd4e8)" title="已完成意图">${tele.satisfied.length}✓</span>` : ''
      }${
        tele && (tele.rejected ?? []).length ? `<span class="hud-val" style="color:var(--danger)" title="被拒指令">${tele.rejected.length}✗</span>` : ''
      }</div>`
    : '';
  // 编队多选 HUD（2026-08-08）：Shift 多选 ≥2 时显示编队构成 + 平均/最低 HP
  const sq = cmdSquad(T(), world);
  const squadRow = sq
    ? `<div class="hud-row hud-survey"><span class="hud-label" style="color:var(--warn)">编队 ${sq.count}</span><span class="hud-val">${sq.parts}</span><span class="hud-val" style="color:${sq.hpMin <= 2 ? 'var(--danger)' : 'var(--success)'}" title="平均/最低 HP">HP ${sq.hpAvg}/${sq.hpMin}</span></div>`
    : '';
  // 批量命令反馈（2026-08-08）：最近提交的批量补交（生效/被拒由 telemetry 累计）
  const bl = T().batchLast;
  const batchRow = bl && (Date.now() - bl.at) < 10000
    ? `<div class="hud-row hud-survey"><span class="hud-label" style="color:var(--warn)">批量 ${bl.type}</span><span class="hud-val">${bl.applied}/${bl.n} 生效</span>${bl.rejected ? `<span class="hud-val" style="color:var(--danger)">${bl.rejected} 被拒</span>` : ''}</div>`
    : '';
  els.fleetHud.innerHTML = `<div class="hud-row">
    <span class="hud-label">${tenant.toUpperCase()} · HUD</span>
    <span class="hud-val"><img src="${UNIT_ICONS.resource}" alt="" /> ${st.resources ?? 0} <i>/ ${cap}</i></span>
    <span class="hud-val"><img src="${UNIT_ICONS.population}" alt="" /> ${st.population ?? 0}</span>
    <span class="hud-val mono">tick ${world.tick ?? st.tick ?? '—'}</span>
  </div>${surveyRow}${lcRow}${hudCmd}${squadRow}${batchRow}`;
}
/* ============ 回放引擎（连续 tick 快照 → 单位移动动画 + 15s 读条） ============ */
/** 回放渲染依赖注入（replay.ts replayDrawLayer 用）：画布/投影/精灵/状态提供给回放模块，
 *  无 mapEngine 循环依赖。 */
const replayRenderDeps = {
  getCtx: () => ctx,
  project,
  images,
  sprite,
  drawHumanMarker,
  soloTenant: () => state.soloTenant,
  tac: T,
  spawnFx: (tac2: any, data: any, tick: any, now: number) => spawnEventFx(tac2, data, tick, now),
};

/** 测绘层：聚焦租户时，把该 run 全部 case 累积的已知地形（障碍/资源）以半透明显示，
    当前 case 可见的物体由上层 cells 全亮覆盖 —— 即"探索过的范围"的记忆测绘。 */
/** 路线绘制（官方 plannedMoveArrows 移植）：首步实线（当前 tick 执行）+ 未来步虚线 +
 *  分段方向箭头 + 目标旗 + ETA（步数 = tick 数）。opts.faint = 悬停预览半透明。 */
function tactDrawRoute(path: any, opts: Record<string, any> = {}) {
  if (!path || path.length < 2) return;
  const alpha = opts.faint ? 0.4 : 1;
  const s = state.view.scale;
  // 动线配色：默认 agent 规划绿；人类指令 mine=琥珀 / goto=青（一眼区分谁在指挥）
  const C = opts.human === 'mine'
    ? { line: '#ffffff', lineA: 'rgba(255,255,255,.9)', flag: '#ffffff', pulse: '#ffffff', glow: '#ffffff', eta: '#ffffff' }
    : opts.human === 'goto'
      ? { line: '#5fd4e8', lineA: 'rgba(95,200,232,.9)', flag: '#8fdcf5', pulse: '#e8f9ff', glow: '#5fd4e8', eta: '#8fdcf5' }
      : { line: '#8fce9f', lineA: 'rgba(118,184,137,.9)', flag: '#8fd6a3', pulse: '#eafff1', glow: '#8fce9f', eta: '#8fd6a3' };
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const seg = (i: any, color: any, width: any, dash: any) => {
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
  seg(0, opts.faint ? C.lineA : C.line, opts.faint ? 1.6 : 2.6, []);
  // 未来步虚线
  for (let i = 1; i < path.length - 1; i++) seg(i, C.lineA, 2, [5, 4]);
  // 目标旗（菱形）
  const end = project(path[path.length - 1][0], path[path.length - 1][1]);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = opts.faint ? C.lineA : C.flag;
  const d = Math.max(4, s * 0.36);
  // 行进脉冲：命令沿路线从起点流向终点的光点（~1.8s 循环），让演练路线"活"起来
  if (!opts.faint) {
    const now = performance.now();
    const t = (now / 1800) % 1;
    const total = path.length - 1;
    const fi = Math.min(total - 0.0001, t * total);
    const i0 = Math.floor(fi), frac = fi - i0;
    const A = project(path[i0][0], path[i0][1]);
    const B = project(path[i0 + 1][0], path[i0 + 1][1]);
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = C.pulse;
    ctx.shadowColor = C.glow; ctx.shadowBlur = 9;
    ctx.beginPath(); ctx.arc(A.sx + (B.sx - A.sx) * frac, A.sy + (B.sy - A.sy) * frac, Math.max(2.2, s * 0.1), 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.beginPath();
  ctx.moveTo(end.sx, end.sy - d); ctx.lineTo(end.sx + d, end.sy);
  ctx.lineTo(end.sx, end.sy + d); ctx.lineTo(end.sx - d, end.sy);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1; ctx.stroke();
  // ETA 徽标（步数 = 到 tick）
  if (opts.eta !== undefined && !opts.faint) {
    const label = (opts.eta === 0 ? '已到' : opts.eta + ' tick');
    ctx.font = '600 11px ' + CANVAS_FONT;
    const tw = ctx.measureText(label).width;
    const bx = end.sx - tw / 2 - 4, by = end.sy - d - 22;
    ctx.fillStyle = 'rgba(10,14,18,.88)';
    ctx.beginPath(); ctx.roundRect(bx, by, tw + 8, 17, 4); ctx.fill();
    ctx.fillStyle = C.eta; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + tw / 2 + 4, by + 9);
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function tactSurveyLayer(s: any) {
  if (!state.soloTenant || !state.layers.survey) return;
  const survey = T().surveys[state.soloTenant];
  if (!survey) return;
  state.surveyHits = new Map(); // 记忆命中索引（hover 详情）
  const cell = Math.max(2, s);
  // 探索分区底纹（2026-08-08，chunks 表）：已探索 16×16 分区淡蓝底——
  // "探索过的范围"一眼可见（用户反馈"地图只能看见当前范围"的 Fog 层解），
  // 未探索区自然暗色。只画视口内 chunk（性能）。
  if (survey.chunks && survey.chunks.length) {
    ctx.save();
    const chunkPx = 16 * state.view.scale;
    ctx.fillStyle = 'rgba(64,110,160,.09)';
    const cap = Math.min(survey.chunks.length, 500);
    for (let i = 0; i < cap; i++) {
      const ch = survey.chunks[i];
      if (!Number.isFinite(ch.cx) || !Number.isFinite(ch.cy)) {
        const kv = String(ch.key).split(',').map(Number);
        ch.cx = kv[0]; ch.cy = kv[1];
      }
      if (!Number.isFinite(ch.cx) || !Number.isFinite(ch.cy)) continue;
      const p = project(ch.cx * 16, ch.cy * 16);
      if (p.sx + chunkPx < 0 || p.sy + chunkPx < 0 || p.sx > W() || p.sy > H()) continue;
      ctx.fillRect(p.sx, p.sy, chunkPx, chunkPx);
    }
    ctx.restore();
  }
  const maxTick = survey.tickMax ?? 0;
  const ageAlpha = (tick: any) => {
    if (!maxTick) return 0.5;
    const age = Math.max(0, maxTick - (tick ?? maxTick));
    return age <= 1 ? 0.55 : age <= 8 ? 0.4 : 0.24; // 越久越淡（探测记忆）
  };
  if (survey.obstacleCells.length) {
    ctx.save();
    const cap = Math.min(survey.obstacleCells.length, 1200);
    for (let i = 0; i < cap; i++) {
      const c = survey.obstacleCells[i];
      const p = project(c.x, c.y);
      ctx.globalAlpha = ageAlpha(c.tick);
      ctx.fillStyle = 'rgba(96,106,116,.28)';
      ctx.fillRect(p.sx - cell / 2, p.sy - cell / 2, cell, cell);
      state.surveyHits.set(`${c.x},${c.y}`, { kind: 'obstacle', x: c.x, y: c.y, tick: c.tick, tenant: state.soloTenant });
    }
    ctx.restore();
  }
  if (survey.resourceCells.length) {
    ctx.save();
    // 资源记忆用菱形晶体标记（比圆点更有"资源"语义，避免绿色圆球堆叠成怪团）；
    // 低缩放只画描边小点，高缩放才是可辨认晶体。
    // 状态着色（2026-08-08 survey-db）：visible=活跃亮绿 / stale=暗绿待确认 /
    // harvested=空心灰（采过）/ empty=暗方块（确认空）；无 state（旧 calibration
    // 扫描数据）= 兼容旧样式。
    const cap = Math.min(survey.resourceCells.length, 1200);
    for (let i = 0; i < cap; i++) {
      const c = survey.resourceCells[i];
      const p = project(c.x, c.y);
      const st = c.state ?? "visible";
      const r = Math.max(2, s * 0.17);
      ctx.globalAlpha = ageAlpha(c.tick) * (st === "visible" ? 0.95 : 0.55);
      state.surveyHits.set(`${c.x},${c.y}`, { kind: 'resource', x: c.x, y: c.y, tick: c.tick, state: st, seenCount: c.seenCount, firstSeen: c.firstSeenTick, tenant: state.soloTenant });
      if (st === "empty") {
        // 已确认空：暗色小方块 + X 语义（不误导成矿）
        ctx.fillStyle = 'rgba(80,86,92,.55)';
        const half = Math.max(1.5, s * 0.09);
        ctx.fillRect(p.sx - half, p.sy - half, half * 2, half * 2);
        continue;
      }
      if (st === "harvested") {
        // 采过：空心菱形（轮廓弱，表示已采空/记忆负态）
        ctx.strokeStyle = 'rgba(140,150,160,.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.sx, p.sy - r);
        ctx.lineTo(p.sx + r * 0.72, p.sy);
        ctx.lineTo(p.sx, p.sy + r);
        ctx.lineTo(p.sx - r * 0.72, p.sy);
        ctx.closePath();
        ctx.stroke();
        continue;
      }
      ctx.fillStyle = st === "visible"
        ? 'rgba(126,224,160,.85)'
        : 'rgba(118,184,137,.30)';
      ctx.beginPath();
      ctx.moveTo(p.sx, p.sy - r);
      ctx.lineTo(p.sx + r * 0.72, p.sy);
      ctx.lineTo(p.sx, p.sy + r);
      ctx.lineTo(p.sx - r * 0.72, p.sy);
      ctx.closePath();
      ctx.fill();
      if (r >= 3) {
        ctx.strokeStyle = st === "visible" ? 'rgba(170,240,200,.55)' : 'rgba(150,210,170,.38)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
function tactDrawLayer(s: any) {
  const tac = T();
  if (!tac.selected) return;
  const sel = tac.selected, world = tac.worlds[sel.tenant], obj = sel.obj;
  if (!world || !obj.position) return;
  const color = TENANT_COLORS[sel.tenant] ?? '#69b3d8';
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
  if (tac.moveRoute) {
    tactDrawRoute(tac.moveRoute.path, { eta: tac.moveRoute.path.length - 1 });
    // 演练幽灵单位：沿路线逐格循环移动（2s 一圈），直观展示"它会走到哪"
    const path = tac.moveRoute.path;
    if (path.length >= 2) {
      const total = path.length - 1;
      const t = (Date.now() / 2000) % 1;
      const fi = t * total;
      const i0 = Math.min(Math.floor(fi), total - 1), frac = fi - i0;
      const A = path[i0], B = path[Math.min(i0 + 1, total)];
      const gp = project(A[0] + (B[0] - A[0]) * frac, A[1] + (B[1] - A[1]) * frac);
      ctx.save();
      ctx.globalAlpha = 0.32;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(gp.sx, gp.sy, Math.max(4, s * 0.5), 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.9;
      ring(gp.sx, gp.sy, Math.max(6, s * 0.6), color, 1.6);
      const ang = Math.atan2(B[1] - A[1], B[0] - A[0]);
      const glen = Math.max(6, s * 0.35);
      ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.5, s * 0.06);
      ctx.beginPath(); ctx.moveTo(gp.sx + Math.cos(ang) * glen, gp.sy + Math.sin(ang) * glen); ctx.lineTo(gp.sx, gp.sy); ctx.stroke();
      ctx.restore();
    }
  }
  if (tac.mode === 'SHOOT' && obj.unit_type === 'RANGER') {
    for (const t of tactRangerRange(world, obj)) {
      const tp = project(t[0], t[1]);
      ctx.fillStyle = 'rgba(198,99,112,.26)';
      ctx.beginPath(); ctx.arc(tp.sx, tp.sy, Math.max(2.5, s * 0.28), 0, Math.PI * 2); ctx.fill();
    }
    for (const tg of tactRangerTargets(world, obj)) {
      const tp = project(tg.position[0], tg.position[1]);
      ring(tp.sx, tp.sy, 12, '#e0625d', 2);
    }
  }
  if (tac.mode === 'SWEEP' && obj.unit_type === 'VANGUARD') {
    for (const { dx, dy } of TACT_STEPS) {
      const tp = project(obj.position[0] + dx, obj.position[1] + dy);
      ctx.fillStyle = 'rgba(255,255,255,.28)';
      ctx.beginPath(); ctx.arc(tp.sx, tp.sy, Math.max(3, s * 0.3), 0, Math.PI * 2); ctx.fill();
    }
  }
  if (tac.attackTarget) {
    const tp = project(tac.attackTarget.obj.position[0], tac.attackTarget.obj.position[1]);
    ring(tp.sx, tp.sy, 14, '#e0625d', 2.5);
  }
}
/** 巡逻环（arena-hero-guide SQUAD_PATROL_RADII=(12,19,26,32) 移植）：聚焦租户时
 *  以 Core 为圆心画方环（切比雪夫移动 = 方环语义），弱化虚线。 */
function tactPatrolLayer(s: any) {
  if (!state.soloTenant || !state.layers.patrol) return;
  const world = T().worlds[state.soloTenant];
  if (!world) return;
  const core = world.state.objects.find((o: any) => o.kind === 'CORE' && o.controlled === true && o.position);
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
    ctx.font = '600 9px ' + CANVAS_FONT;
    ctx.fillText(String(r), cp.sx - pr + 3, cp.sy - pr + 10);
  }
  ctx.restore();
}

/** 计划箭头（官方 plannedMoveArrows/plannedSweepMarkers/plannedShotMarkers 移植）：
 *  从最新决策计划绘制每个受控单位的 MOVE/SWEEP/SHOOT 标记 + Core START_MOVE 方向——
 *  让"单位在动/在打"无需点选即可在地图上可见。 */
/** 全局联盟视图的伪世界（合并测绘 cells → 障碍/单位/核心），供 tactFindPath 算人类目标路径。 */
function mergedWorldFor(tenant: any) {
  const objects = [];
  for (const c of state.cells) {
    if (c.tenant !== tenant) continue;
    if (c.type === 'obstacle') objects.push({ kind: 'OBSTACLE', position: [c.x, c.y] });
    else if (c.type === 'unit') objects.push({ kind: 'UNIT', position: [c.x, c.y], controlled: c.controlled, id: c.id });
    else if (c.type === 'core') objects.push({ kind: 'CORE', position: [c.x, c.y], controlled: c.controlled, id: c.id });
  }
  return { state: { objects } };
}
/** 全局模式：4 租户人类指令/遥测刷新（动线 + 待执行面板数据源）。 */
async function refreshAllCommands() {
  for (const t of TENANTS) await tactRefreshCommands(t);
}
/** 人类指令目标动线（2026-08-08）：待执行 goal（mine/goto）从单位当前位置到目标的
 *  完整寻路路径，跨 tick 持续可见（缓存 key = tick+起点+目标，每 tick/移动重算一次）。
 *  全局联盟视图 + 聚焦视图都画；goal 被服务端对账清理（satisfied/unknown）后自然消失。 */
function drawHumanGoalPaths(s: any) {
  const tac = T();
  if (!state.layers.plan) return;
  const solo = state.soloTenant;
  const scopes = solo ? [solo] : TENANTS;
  for (const tenant of scopes) {
    const store = tac.commandsByTenant ? tac.commandsByTenant[tenant] : (solo === tenant ? tac.commands : null);
    const goals = store && Array.isArray(store.goals) ? store.goals.filter((g: any) => Array.isArray(g.target) && g.target.length >= 2) : [];
    if (!goals.length) continue;
    const world = tac.worlds[tenant] || mergedWorldFor(tenant);
    if (!world || !world.state || !Array.isArray(world.state.objects)) continue;
    for (const g of goals) {
      const cell = state.cells.find((c) => c.tenant === tenant && c.type === 'unit' && c.id === g.unitId);
      if (!cell) continue; // 单位不存在（已销毁/失联，服务端会清 goal）
      const key = `${state.tickMeter.lastTick}:${cell.x},${cell.y}:${g.target[0]},${g.target[1]}`;
      const ck = tenant + ':' + g.id;
      let rec = tac.goalPaths ? tac.goalPaths[ck] : null;
      if (!rec || rec.key !== key) {
        const path = tactFindPath(world, [cell.x, cell.y], g.target, tenant);
        if (!path || path.length < 2) { if (tac.goalPaths) delete tac.goalPaths[ck]; continue; }
        rec = { key, path, kind: g.kind };
        tac.goalPaths = tac.goalPaths || {};
        tac.goalPaths[ck] = rec;
      }
      tactDrawRoute(rec.path, { human: rec.kind, eta: rec.path.length - 1 });
      // 目标标签（采矿/移动）
      const end = rec.path[rec.path.length - 1];
      const p = project(end[0], end[1]);
      const label = rec.kind === 'mine' ? '采矿' : '移动';
      const color = rec.kind === 'mine' ? '#ffffff' : '#5fd4e8';
      ctx.save();
      ctx.font = '600 11px ' + CANVAS_FONT;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(10,14,18,.88)';
      ctx.beginPath(); ctx.roundRect(p.sx - tw / 2 - 4, p.sy - s * 0.55 - 20, tw + 8, 17, 4); ctx.fill();
      ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, p.sx, p.sy - s * 0.55 - 11);
      ctx.restore();
    }
  }
}

/** 算法分配采矿/回仓完整路线（2026-08-08）：intents 为 go_harvest 系 / DEPOSIT 的受控单位，
 *  从当前位置到目标（最近未采资源格 / 己方核心）寻路并画完整动线——计划只给当前步方向，
 *  目标经测绘记忆推断（agent 绿，tactDrawRoute 默认配色），缓存 key=tick+起点+目标，
 *  跨 tick 持续可见（与 drawHumanGoalPaths 同构）。单位有人类指令时跳过（人类动线优先）。 */
function drawAgentGoalPaths(s: any) {
  const tac = T();
  if (!state.layers.plan) return;
  const solo = state.soloTenant;
  const scopes = solo ? [solo] : TENANTS;
  for (const tenant of scopes) {
    const plan = solo ? tac.plan?.plan : tac.plans?.[tenant];
    if (!plan || !plan.intents) continue;
    const world = tac.worlds[tenant] || mergedWorldFor(tenant);
    if (!world || !world.state || !Array.isArray(world.state.objects)) continue;
    // 单位定位表（与 tactPlanLayer 同源）：精确 world 优先，全局回退合并测绘 cells
    const byId = new Map();
    if (world.state.objects) {
      for (const o of world.state.objects) if ((o.kind === 'UNIT' || o.kind === 'CORE') && o.id && o.position) byId.set(o.id, o);
    } else {
      for (const c of state.cells) {
        if (c.tenant !== tenant || !c.id) continue;
        if (c.type === 'unit') byId.set(c.id, { id: c.id, position: [c.x, c.y], controlled: c.controlled, kind: 'UNIT' });
        else if (c.type === 'core') byId.set(c.id, { id: c.id, position: [c.x, c.y], controlled: c.controlled, kind: 'CORE' });
      }
    }
    // 人类指令单位：跳过（人类动线在 drawHumanGoalPaths 已画，避免双线叠层）
    const store = tac.commandsByTenant ? tac.commandsByTenant[tenant] : (solo === tenant ? tac.commands : null);
    const humanUnits = new Set(store && Array.isArray(store.goals) ? store.goals.map((g: any) => g.unitId).filter(Boolean) : []);
    // 资源格候选：优先测绘记忆（过滤已采/空），全局回退当前帧 cells（去重）
    const survey = tac.surveys[tenant];
    const mines = (survey && Array.isArray(survey.resourceCells) ? survey.resourceCells : [])
      .filter((r: any) => r.state !== 'harvested' && r.state !== 'empty')
      .map((r: any) => [Number(r.x), Number(r.y)])
      .filter((p: any) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (!solo) {
      for (const c of state.cells) {
        if (c.tenant === tenant && c.type === 'resource' && c.fresh !== false) {
          const has = mines.some((p: any) => p[0] === c.x && p[1] === c.y);
          if (!has) mines.push([c.x, c.y]);
        }
      }
    }
    const coreObj = world.state.objects.find((o: any) => o.kind === 'CORE' && o.controlled === true && o.position);
    const corePos = coreObj ? [coreObj.position[0], coreObj.position[1]] : null;
    for (const [id, intentRaw] of Object.entries(plan.intents)) {
      if (humanUnits.has(id)) continue;
      const intent = String(intentRaw);
      const base = intent.split(':')[0];
      const o = byId.get(id);
      if (!o || o.controlled !== true || !o.position) continue;
      let target: any = null;
      if (base === 'go_harvest' || base === 'go_harvest_mem') {
        if (!mines.length) continue;
        let best: any = null, bd = Infinity;
        for (const m of mines) {
          const d = Math.abs(m[0] - o.position[0]) + Math.abs(m[1] - o.position[1]);
          if (d < bd) { bd = d; best = m; }
        }
        target = best;
      } else if (intent === 'DEPOSIT') {
        target = corePos;
      }
      if (!target) continue;
      const key = `${state.tickMeter.lastTick}:${o.position[0]},${o.position[1]}:${target[0]},${target[1]}`;
      const ck = tenant + ':' + id;
      let rec = tac.agentPaths ? tac.agentPaths[ck] : null;
      if (!rec || rec.key !== key) {
        const path = tactFindPath(world, [o.position[0], o.position[1]], target, tenant);
        if (!path || path.length < 2) { if (tac.agentPaths) delete tac.agentPaths[ck]; continue; }
        rec = { key, path, kind: intent === 'DEPOSIT' ? 'deposit' : 'mine' };
        tac.agentPaths = tac.agentPaths || {};
        tac.agentPaths[ck] = rec;
      }
      tactDrawRoute(rec.path, { eta: rec.path.length - 1 });
    }
  }
}

function tactPlanLayer(s: any) {
  if (!state.layers.plan) return;
  const tac = T();
  const solo = state.soloTenant;
  const scopes = solo ? [solo] : TENANTS;
  const colorOf = (t: any) => TENANT_COLORS[t] ?? '#69b3d8';
  const stepOf = (dir: any) => TACT_STEPS.find((t) => t.d === dir);
  const dash = (from: any, to: any, color: any, alpha: any, width: any) => {
    ctx.save();
    ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = width;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(from.sx, from.sy); ctx.lineTo(to.sx, to.sy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  };
  const arrow = (from: any, to: any, color: any) => {
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
    const unitActions = (plan.unitActions ?? plan.unit_actions ?? {}) as Record<string, any>;
    for (const [id, action] of Object.entries(unitActions)) {
      const o = byId.get(id);
      if (!o || o.controlled !== true || !o.position) continue;
      const from = project(o.position[0], o.position[1]);
      if (action.type === 'MOVE' && action.direction) {
        const st = stepOf(action.direction);
        if (!st) continue;
        // 起点=本 tick 起点（unitPrev.px），终点=当前实时位（unitPrev.x）：after.state 下计划已执行完，
        // 画"实际走的这一步"而非从当前位置外推旧方向（避免误导假线）；未移动则跳过。
        const pv = state.unitPrev.get(tenant + ':' + id);
        const sx = pv ? pv.px : o.position[0] - st.dx;
        const sy = pv ? pv.py : o.position[1] - st.dy;
        const ex = pv ? pv.x : o.position[0];
        const ey = pv ? pv.y : o.position[1];
        const f0 = project(sx, sy);
        const t0 = extendScreen(f0, project(ex, ey), 9);
        if (Math.hypot(t0.sx - f0.sx, t0.sy - f0.sy) < 1) continue;
        dash(f0, t0, color, 0.65, 1.5);
        arrow(f0, t0, color);
        // 起点/终点标记：与官方 moveArrow 一致，一眼看出"从哪到哪"
        ctx.save();
        ctx.fillStyle = color; ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.arc(f0.sx, f0.sy, Math.max(1.6, s * 0.06), 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.7;
        ctx.beginPath(); ctx.arc(t0.sx, t0.sy, Math.max(3, s * 0.12), 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        drew = true;
      } else if (action.type === 'SWEEP' && action.direction) {
        const st = stepOf(action.direction);
        if (!st) continue;
        const tp = project(o.position[0] + st.dx, o.position[1] + st.dy);
        ring(tp.sx, tp.sy, Math.max(4, s * 0.32), 'rgba(255,255,255,.85)', 1.8);
        drew = true;
      } else if (action.type === 'SHOOT' && action.expectedCell) {
        const to = extendScreen(from, project(action.expectedCell[0], action.expectedCell[1]), 9);
        dash(from, to, 'rgba(198,99,112,.9)', 0.9, 1.5);
        ring(to.sx, to.sy, Math.max(4, s * 0.32), 'rgba(198,99,112,.9)', 1.6);
        drew = true;
      }
    }
    // 决策意图标签：有意图的受控单位头顶画短中文标签（zoom 过低跳过防噪）
    if (s >= 5 && plan.intents) {
      for (const [id, intent] of Object.entries(plan.intents)) {
        const o = byId.get(id);
        if (!o || o.controlled !== true || !o.position) continue;
        const label = intentLabelCn(intent);
        if (!label) continue;
        const p = project(o.position[0], o.position[1]);
        if (p.sx < -40 || p.sx > W() + 40 || p.sy < -40 || p.sy > H() + 40) continue;
        ctx.save();
        const fs = Math.max(9, Math.round(s * 0.5));
        ctx.font = `600 ${fs}px ${CANVAS_FONT}`;
        const tw = ctx.measureText(label).width;
        const bx = p.sx - tw / 2 - 4, by = p.sy - s * 0.62 - fs - 8;
        ctx.fillStyle = 'rgba(6,6,6,.72)';
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(bx, by, tw + 8, fs + 5, 4);
        else ctx.rect(bx, by, tw + 8, fs + 5);
        ctx.fill();
        ctx.fillStyle = color; ctx.globalAlpha = 0.95;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, p.sx, by + (fs + 5) / 2 + 0.5);
        ctx.restore();
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
  drawHumanGoalPaths(s);
  drawAgentGoalPaths(s); // 算法分配采矿/回仓完整路线（目标经测绘记忆推断）
  if (!drew) return;
}

/** 资源活动面板（官方 ResourceActivity 移植）：最近资源/战斗/信标事件，左下角悬浮，不挡交互。 */
const ACTIVITY_KIND_META: Record<string, any> = {
  UNIT_MOVE_SUCCEEDED: { icon: "➔", color: "var(--cyan-signal, #5fd4e8)", label: (e: any) => `单位移动 → [` + (Array.isArray(e.position) ? e.position.join(",") : "?") + `]` },
  HARVEST_SUCCEEDED: { icon: '⛏', color: 'var(--green-resource)', label: (e: any) => `采集 +${e.amount ?? ''}` },
  DEPOSIT_SUCCEEDED: { icon: '◆', color: 'var(--cyan-signal)', label: (e: any) => `交付 +${e.amount ?? ''} 资源` },
  DEPOSIT_FAILED: { icon: '⚠', color: 'var(--amber)', label: (e: any) => `交付失败${e.reason ? ' · ' + e.reason : ''}` },
  UNIT_HEAL_SUCCEEDED: { icon: '✚', color: 'var(--green-resource)', label: (e: any) => `治疗 +${e.amount ?? ''} HP` },
  CORE_HEAL_SUCCEEDED: { icon: '✚', color: 'var(--green-resource)', label: (e: any) => `核心治疗 +${e.amount ?? ''} HP` },
  UNIT_HEAL_FAILED: { icon: '⚠', color: 'var(--amber)', label: () => '治疗失败' },
  CORE_HEAL_FAILED: { icon: '⚠', color: 'var(--amber)', label: () => '核心治疗失败' },
  CORE_RESOURCES_CAPTURED: { icon: '◈', color: 'var(--green-resource)', label: (e: any) => `敌方资源被夺取 ${e.amount ?? ''}` },
  WORKER_CARGO_DROPPED: { icon: '▤', color: 'var(--violet)', label: (e: any) => `掉落载货 ${e.amount ?? ''}` },
  CORE_RESOURCE_OVERFLOW_DESTROYED: { icon: '✕', color: 'var(--coral)', label: (e: any) => `溢出资源销毁 ${e.amount ?? ''}` },
  SHOT_HIT: { icon: '➶', color: 'var(--coral)', label: (e: any) => `射击命中${e.amount ? ' · ' + e.amount : ''}` },
  SWEEP_RESOLVED: { icon: '⚔', color: 'var(--amber)', label: () => '清扫解除' },
  SPAWN_SUCCEEDED: { icon: '✦', color: 'var(--cyan-signal)', label: () => '生产单位' },
  SPAWN_FAILED: { icon: '⚠', color: 'var(--amber)', label: (e: any) => `生产失败${e.reason ? ' · ' + e.reason : ''}` },
  PICKUP_BEACON_SUCCEEDED: { icon: '◎', color: '#d9a62e', label: () => '拾取冠军信标' },
  DROP_BEACON_SUCCEEDED: { icon: '◎', color: '#d9a62e', label: () => '放置冠军信标' },
  UNIT_DESTROYED: { icon: '✕', color: 'var(--coral)', label: () => '单位被摧毁' },
  CORE_DESTROYED: { icon: '☠', color: 'var(--coral)', label: () => '核心被摧毁!' },
  CORE_DAMAGED: { icon: '⚔', color: 'var(--coral)', label: (e: any) => `核心受损 ${e.amount ?? ''}` },
  RESPAWN: { icon: '↻', color: 'var(--cyan-signal)', label: () => '重生' },
};
const ACTIVITY_KINDS = Object.keys(ACTIVITY_KIND_META);
async function tactRefreshActivity(tenant: any) {
  if (!state.soloTenant) { els.activityPanel.hidden = true; return; }
  try {
    const r = await getJSON(`/api/events?tenant=${tenant}&n=60`);
    const rows = (r.events ?? []).filter((e: any) => ACTIVITY_KINDS.includes(e.kind)).slice(0, 6);
    if (!rows.length) { els.activityPanel.hidden = true; return; }
    els.activityPanel.hidden = false;
    els.activityList.innerHTML = rows.map((e: any) => {
      const m = ACTIVITY_KIND_META[e.kind];
      const label = typeof m.label === 'function' ? m.label(e) : '';
      const pos = e.position ? `[${e.position[0]}, ${e.position[1]}]` : '';
      return `<li class="act-row"><span class="act-ic" style="color:${m.color}">${m.icon}</span><span class="act-txt">${escapeHtml(label)}</span><span class="mono act-pos">${pos}</span></li>`;
    }).join('');
  } catch { /* 忽略，下次刷新重试 */ }
}
/** 命令窗口倒计时（官方 CommandCountdown 移植）：最近观测计划 tick 起 15s，≤5s 变红。 */
function setCommandWindowTick(tick: any) {
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
  const stepOf = (dir: any) => TACT_STEPS.find((t) => t.d === dir);
  const dirCN: Record<string, string> = { UP: '上', DOWN: '下', LEFT: '左', RIGHT: '右' };
  const actCN = (a: any) => {
    if (!a) return '';
    const base = TACT_ACTION_CN[a.type] ?? a.type;
    const parts = [base];
    if (a.direction && stepOf(a.direction)) parts.push(dirCN[a.direction] ?? a.direction);
    if (a.expectedCell) parts.push('[' + a.expectedCell.join(',') + ']');
    else if (a.targetId) parts.push(shortId(a.targetId));
    return parts.join(' · ');
  };
  const rows = [];
  const tenant = state.soloTenant;
  const humanUnits = new Set([
    ...(T().commands?.actions ?? []).map((c: any) => c.unitId),
    ...(T().commands?.goals ?? []).map((g: any) => g.unitId),
  ]);
  const coreId = world ? world.state.objects.find((o: any) => o.kind === 'CORE' && o.controlled === true)?.id ?? null : null;
  const coreAction = plan.coreAction ?? plan.core_action;
  if (coreAction) rows.push({ key: 'core', actor: '核心 · CORE', act: actCN(coreAction), human: coreId !== null && humanUnits.has(coreId) });
  const unitActions = (plan.unitActions ?? plan.unit_actions ?? {}) as Record<string, any>;
  const entries = Object.entries(unitActions).sort(([a], [b]) => a.localeCompare(b));
  for (const [id, action] of entries) {
    const o = byId.get(id);
    const type = o && o.unit_type ? TACT_UNIT_CN[o.unit_type] : '单位';
    rows.push({ key: id, actor: type + ' · ' + shortId(id), act: actCN(action), human: humanUnits.has(id) });
  }
  if (!rows.length) { els.pendingPanel.hidden = true; return; }
  const collapsed = tac.pendingCollapsed === true;
  const body = rows.map((r) => '<li class="pp-row"><span class="pp-actor">' + escapeHtml(r.actor) + '</span><span class="pp-src ' + (r.human ? 'src-manual' : 'src-agent') + '">' + (r.human ? 'HUMAN' : 'AGENT') + '</span><span class="pp-act">' + escapeHtml(r.act) + '</span></li>').join('');
  els.pendingPanel.innerHTML = '<button type="button" class="pp-toggle" data-pp-toggle aria-expanded="' + (collapsed ? 'false' : 'true') + '">' +
    '<span class="pp-dot"></span><span class="pp-title">待执行命令 · tick ' + (tac.plan?.tick ?? '?') + '</span>' +
    '<span class="pp-count mono" title="有效指令数">' + rows.length + '</span><span class="pp-chev">' + (collapsed ? '▸' : '▾') + '</span></button>' +
    '<div class="pp-body"' + (collapsed ? ' hidden' : '') + '><ul class="pp-list">' + body + '</ul></div>';
  els.pendingPanel.hidden = false;
  els.pendingPanel.querySelector('[data-pp-toggle]')?.addEventListener('click', () => {
    tac.pendingCollapsed = !tac.pendingCollapsed;
    tactRenderPending();
  });
}

/** 回放事件特效：当前回放帧的事件（战斗/资源活动）弹出浮字+光晕，2.5s 淡出上浮。 */
/** 地图要素信息卡（官方 MapFeatureInfo 移植）：点击信标/资源/障碍弹出。
 *  复用「地图点击有反馈」原则：任何点击都有可见结果，避免"点了没反应"。 */
function tactShowFeature(cell: any, px: any, py: any) {
  const el = els.featurePanel;
  if (!el) return;
  // 判定要素类型：信标优先（beacons 独立于 cells），其次 resource/obstacle cell
  let kind: any = null, status: any = null, pos: any = null, tenant: any = null;
  if (cell) {
    if (cell.type === 'resource' || cell.type === 'obstacle') {
      kind = cell.type === 'resource' ? '资源' : '障碍';
      pos = [cell.x, cell.y];
      tenant = cell.tenant;
    }
  }
  if (!kind && state.beacons.length) {
    const wx = Math.round(state.view.cx + (px - W() / 2) / state.view.scale);
    const wy = Math.round(state.view.cy + (py - H() / 2) / state.view.scale);
    for (const b of state.beacons) {
      if (b.x === wx && b.y === wy) {
        kind = '信标'; status = b.status; pos = [b.x, b.y]; tenant = b.tenant;
        break;
      }
    }
  }
  if (!kind) { el.hidden = true; return; }
  const color = TENANT_COLORS[tenant] ?? '#f0883e';
  const icon = kind === '信标' ? SPRITE.beacon : kind === '资源' ? SPRITE.crystal[0] : null;
  const rows = [];
  rows.push(`<div class="fp-row"><span>坐标</span><b>[${pos[0]}, ${pos[1]}]</b></div>`);
  if (kind === '信标') {
    const st = status === 'CARRIED' ? '被携带' : status === 'GROUND' ? '在地面' : '未知';
    rows.push(`<div class="fp-row"><span>状态</span><b><span class="fp-tag" style="background:${hexA('#d9a62e', 0.16)};color:#f0883e">${st}</span></b></div>`);
    rows.push(`<div class="fp-row"><span>归属租户</span><b style="color:${color}">${tenant.toUpperCase()}</b></div>`);
    rows.push(`<div class="fp-row"><span>冠军奖励</span><b>持续占位 +奖励</b></div>`);
  } else if (kind === '资源') {
    rows.push(`<div class="fp-row"><span>类型</span><b>矿物</b></div>`);
    // 生命周期状态徽标（2026-08-08 闭环）：visible=活跃 / stale=待确认 /
    // harvested=采过 / empty=确认空（survey-sync 事件回写 + refill 恢复）
    const st = cell?.state ?? (cell?.fresh ? 'visible' : 'stale');
    const stMeta: Record<string, { label: string; color: string }> = {
      visible: { label: '活跃', color: 'var(--green-resource)' },
      stale: { label: '待确认', color: 'var(--amber)' },
      harvested: { label: '采过', color: '#8c96a0' },
      empty: { label: '确认空', color: 'var(--text-dim)' },
    };
    const sm = stMeta[st] ?? stMeta.stale;
    rows.push(`<div class="fp-row"><span>状态</span><b><span class="fp-tag" style="background:${hexA(sm.color, 0.14)};color:${sm.color}">${sm.label}</span></b></div>`);
    if (cell && !cell.fresh) rows.push(`<div class="fp-row"><span>记忆</span><b style="color:var(--amber)">已探索 · 非当前</b></div>`);
    rows.push(`<div class="fp-row"><span>生命周期</span><b class="fp-lc">查询中…</b></div>`);
  } else {
    rows.push(`<div class="fp-row"><span>阻挡</span><b>无法通行</b></div>`);
  }
  el.innerHTML = `<div class="fp-head">
      ${icon ? `<img class="fp-icon" src="${icon}" alt="" draggable="false" />` : '<span class="fp-icon" style="color:#a2a2a8;display:grid;place-items:center">▦</span>'}
      <div class="fp-title">${kind}</div>
      <div class="fp-sub">${tenant ? tenant.toUpperCase() : ''} · 地图要素</div>
      <button type="button" class="fp-close" data-fp-close title="关闭（Esc）">✕</button>
    </div>
    <div class="fp-body">${rows.join('')}</div>`;
  el.hidden = false;
  el.querySelector('[data-fp-close]')?.addEventListener('click', () => { el.hidden = true; });
  makeDraggable(el, '.fp-head', 'featurePanel');
  // 矿生命周期摘要（2026-08-08，测绘库 resource_events）：采集/失败次数 + 最近 tick
  if (kind === '资源' && tenant) {
    const lcCell = `${pos[0]},${pos[1]}`;
    fetch(`/api/survey/mine?tenant=${encodeURIComponent(tenant)}&cell=${encodeURIComponent(lcCell)}`)
      .then((r) => r.json())
      .then((d) => {
        const elLc = el.querySelector('.fp-lc');
        if (!elLc) return;
        const tl = d.timeline ?? [];
        const ok = tl.filter((e: any) => e.eventType === 'HARVEST_SUCCEEDED').length;
        const fail = tl.filter((e: any) => e.eventType === 'HARVEST_FAILED').length;
        const last = tl.length ? tl[tl.length - 1].tick : null;
        elLc.textContent = last != null ? `采 ${ok} · 败 ${fail} · 最近 t${last}` : '未开采';
        elLc.title = tl.map((e: any) => `t${e.tick} ${e.eventType}${e.reason ? ' ' + e.reason : ''}${e.amount != null ? ' +' + e.amount : ''}`).join('\n');
        elLc.style.color = ok > 0 ? 'var(--green-resource)' : 'var(--amber)';
      })
      .catch(() => { const elLc = el.querySelector('.fp-lc'); if (elLc) elLc.textContent = '—'; });
  }
}
/** 实时命中（2026-08-08 结构性修复）：nearestCell + live world 校正。
 *  合并地图轮询 3s，tick 边界单位已移位——陈旧 cellIndex 点击落空且静默 tactClear（"点了没反应"根因）。
 *  命中单位/核心格时以 live world 最近邻（≤2 格，贴近视觉瞄准）重定位，并写回 liveObj 真实坐标
 *  （旧实现写点击坐标，下游 tactObjectAt 仍落空）；完全无命中时用聚焦租户 live world 兜底
 *  （覆盖刚出生/刚移位尚未进 cells 的单位）。返回 { cell, world, obj, ghost }。 */
/** 屏幕空间单位命中（视觉瞄准，2026-08-08）：按「画布上看到的插值位置」找最近的单位/核心。
 *  命中后由 resolveLiveTarget 按 id 去 live world 精确定位——tick 插值/测绘轮询滞后导致画布位与
 *  live 位最多差数格，纯位置半径搜索在漂移 >3 格时脱靶（"点了没反应"、回归 6f 第二击 toast 为空根因）。 */
function unitAtScreen(px: number, py: number, maxPx: number) {
  let best: any = null, bestD = Infinity;
  for (const c of visibleCells()) {
    if (c.type !== 'unit' && c.type !== 'core') continue;
    const pos = unitDrawPos(c);
    const p = project(pos.x, pos.y);
    const d = Math.hypot(px - p.sx, py - p.sy);
    if (d <= maxPx && d < bestD) { bestD = d; best = c; }
  }
  return best;
}
async function resolveLiveTarget(px: any, py: any, tenantHint?: any) {
  const wx = Math.round(state.view.cx + (px - W() / 2) / state.view.scale);
  const wy = Math.round(state.view.cy + (py - H() / 2) / state.view.scale);
  const cell = nearestCell(px, py);
  const isUnitCell = !!(cell && (cell.type === 'unit' || cell.type === 'core'));
  // 1) 屏幕空间视觉瞄准：先按画布插值位命中（抗 tick/轮询漂移），再按 id 精确定位 live 单位。
  //    半径：约 3.6~4.2 格（画布位与 live 位最大漂移），低缩放用世界格数上限兜底避免误吞。
  const hitPx = Math.min(Math.max(26, state.view.scale * 3.6), state.view.scale * 4.2);
  const drawn = unitAtScreen(px, py, hitPx);
  if (drawn) {
    const t = drawn.tenant;
    let world: any = T().worlds[t];
    if (!world) world = await tactLoadWorld(t, true);
    if (world) {
      const liveObj = (world.state?.objects ?? []).find((o: any) =>
        (o.kind === 'UNIT' || o.kind === 'CORE') && String(o.id) === String(drawn.id));
      if (liveObj && Array.isArray(liveObj.position)) {
        return {
          cell: { ...drawn, tenant: t, type: liveObj.kind === 'CORE' ? 'core' : 'unit', x: liveObj.position[0], y: liveObj.position[1], fresh: true, id: liveObj.id, controlled: liveObj.controlled },
          world, obj: liveObj, ghost: false,
        };
      }
    }
    // 画布上有但 live 无 → 陈旧 ghost（明确反馈，不静默吞点击）
    return { cell: { ...drawn, fresh: false }, world: null, obj: null, ghost: true };
  }
  // 2) 位置半径兜底（无画布单位命中时）：单位格 3（插值移位可达 2-3 格）；地形格 0；
  //    空白 1（保留 solo 兜底：刚出生/移位未进 cells 的单位）。
  const radius = isUnitCell ? 3 : (cell ? 0 : 1);
  const tenantSet = new Set<string>();
  if (cell?.tenant) tenantSet.add(cell.tenant);
  if (tenantHint) tenantSet.add(tenantHint);
  if (state.soloTenant) tenantSet.add(state.soloTenant);
  for (const t of tenantSet) {
    let world: any = T().worlds[t];
    let liveObj = world ? tactObjectNear(world, wx, wy, radius) : null;
    if (!liveObj) { world = await tactLoadWorld(t, true); liveObj = world ? tactObjectNear(world, wx, wy, radius) : null; }
    if (liveObj && (liveObj.kind === 'UNIT' || liveObj.kind === 'CORE')) {
      return {
        cell: { ...(cell ?? {}), tenant: t, type: liveObj.kind === 'CORE' ? 'core' : 'unit', x: liveObj.position[0], y: liveObj.position[1], fresh: true, id: liveObj.id, controlled: liveObj.controlled },
        world, obj: liveObj, ghost: false,
      };
    }
  }
  // 无 live 单位：渲染位有单位但 live 无 → 陈旧 ghost（下游明确反馈）；否则原 cell 解释
  if (isUnitCell) return { cell: { ...cell, fresh: false }, world: null, obj: null, ghost: true };
  return { cell, world: null, obj: null, ghost: false };
}
async function handleCanvasClick(px: any, py: any, shift = false) {
  const tac = T();
  // 定位标记命中：非命令模式下点击 pin 清除单个（看到即清除，不再卡住关不掉）
  if (!tac.mode && !shift && state.jumpPins.length) {
    const hitIdx = state.jumpPins.findIndex((pin: any) => {
      const pp = project(pin.x, pin.y);
      return Math.hypot(pp.sx - px, pp.sy - py) < Math.max(10, state.view.scale * 0.3);
    });
    if (hitIdx >= 0) {
      const removed = state.jumpPins.splice(hitIdx, 1)[0];
      draw();
      toast(removed?.label ? `已清除定位「${removed.label}」` : '已清除定位标记');
      return;
    }
  }
  const wx = Math.round(state.view.cx + (px - W() / 2) / state.view.scale);
  const wy = Math.round(state.view.cy + (py - H() / 2) / state.view.scale);
  // 命令模式优先（2026-08-08 结构性修复）：瞄准/入队态下点击直接进模式处理——
  // 陈旧单位格（合并地图轮询 3s 落后 tick）不再误走"单位解释"分支而清掉 tac.mode
  // （"点了没反应/指令莫名消失"根因之一）。点单位格 = 移动到该格（RTS 惯例）。
  if (tac.mode) {
    if ((tac.mode === 'BATCH_MOVE' || tac.mode === 'BATCH_SHOOT') && tac.multi.size) {
      batchSubmitTarget(wx, wy, shift);
      return;
    }
    if (tac.mode === 'MOVE' && tac.selected) {
      // 动态地形（周期交替障碍）：人类指令目标校验用最新世界，避免 3s 轮询缓存误拒
      // （"目标 X 是障碍，无法到达"且 /api/world 显示该格畅通的脱靶根因，2026-08-08 实证）。
      let world: any = await tactLoadWorld(tac.selected.tenant, true);
      if (world) {
        // 移动目标可为任意格（世界坐标反算），不需要命中已测绘 cell
        const path = tactFindPath(world, tac.selected.obj.position, [wx, wy], tac.selected.tenant);
        // 地形全局去重后租户键可能 miss：回退全局 `x,y` 键（共享世界地形）
        const key = `${tac.selected.tenant}:${wx},${wy}`;
        const cell = state.cellIndex.get(key) ?? state.cellIndex.get(`${wx},${wy}`);
        const isResource = (cell && cell.type === 'resource') ||
          (world.state?.objects ?? []).some((o: any) => o.kind === 'RESOURCE' && (o.positions ?? []).some((p: any) => p[0] === wx && p[1] === wy));
        const kind = isResource ? 'mine' : 'goto';
        // 意图式指挥：点矿=采矿任务（到达自动挖、满仓回仓）；点空地=移动任务。
        // 人类指挥最高控制权：目标为实时障碍才拒绝；测绘记忆寻路失败只影响虚线预览，不吞命令（服务端权威导航）。
        const onObstacle = (world.state?.objects ?? []).some((o: any) => o.kind === 'OBSTACLE' && (o.positions ?? []).some((p: any) => p[0] === wx && p[1] === wy));
        if (onObstacle) {
          toast(`目标 [${wx}, ${wy}] 是障碍，无法到达`, 'warn');
          draw();
          return;
        }
        tac.moveGoals[tac.selected.obj.id] = [wx, wy];
        tac.moveRoute = path ? { path } : null;
        tac.routePreview = null;
        tac.mode = null;
        if (path && !shift) {
          submitGoal(tac.selected.tenant, tac.selected.obj.id, kind, [wx, wy], kind === 'mine' ? `采矿 → [${wx}, ${wy}]` : `移动 → [${wx}, ${wy}]`);
          tactRenderActionDialog(); tactRenderInspect(); draw();
        } else if (path && shift) {
          // Shift+点击 = 追加命令队列（当前段完成后自动执行下一段）
          queuePush(tac.selected.tenant, tac.selected.obj.id, kind, [wx, wy]);
          tactRenderActionDialog(); draw();
        } else if (!path && shift) {
          queuePush(tac.selected.tenant, tac.selected.obj.id, kind, [wx, wy]);
          tactRenderActionDialog(); draw();
        } else {
          // 记忆寻路不可达（雾区/旧测绘差异）但目标非实时障碍：仍提交，避免"点了没反应"
          submitGoal(tac.selected.tenant, tac.selected.obj.id, kind, [wx, wy], kind === 'mine' ? `采矿 → [${wx}, ${wy}]（记忆不可达，按目标提交）` : `移动 → [${wx}, ${wy}]（记忆不可达，按目标提交）`);
          tactRenderActionDialog(); tactRenderInspect(); draw();
        }
      } else {
        toast('世界数据加载失败，请重试', 'warn');
      }
      return;
    }
    if (tac.mode === 'SHOOT' && tac.selected) {
      const hit = await resolveLiveTarget(px, py, tac.selected.tenant);
      const world = hit?.world ?? tac.worlds[tac.selected.tenant];
      const target = hit?.obj && hit.obj.controlled === false ? hit.obj
        : (hit?.cell && (hit.cell.type === 'unit' || hit.cell.type === 'core') ? tactObjectAt(world, hit.cell.x, hit.cell.y) : null);
      if (target && target.controlled === false) {
        tac.attackTarget = { obj: target };
        tac.mode = null;
        tactRenderActionDialog(); tactRenderInspect(); draw();
        submitCommand(tac.selected.tenant, tac.selected.obj.id,
          { type: 'SHOOT', targetId: target.id ?? null, expectedCell: [target.position[0], target.position[1]] },
          `攻击 [${target.position[0]}, ${target.position[1]}]`);
      } else if (target) {
        toast('只能攻击敌方单位/核心（已探索记忆中的目标已不存在）', 'warn');
      } else {
        // 空格射击：无目标格也提交（官方 cell-fire 语义，targetId=null 合法）
        tac.attackTarget = null;
        tac.mode = null;
        tactRenderActionDialog(); tactRenderInspect(); draw();
        submitCommand(tac.selected.tenant, tac.selected.obj.id,
          { type: 'SHOOT', targetId: null, expectedCell: [wx, wy] },
          `朝 [${wx}, ${wy}] 开火（空格射击）`);
      }
      return;
    }
    if (tac.mode === 'START_MOVE' && tac.selected) {
      // 核心迁移：点相邻格选方向，一次性提交 START_MOVE（官方 start-move 语义）
      const obj = tac.selected.obj;
      if (obj && obj.kind === 'CORE' && obj.position) {
        const dx = wx - obj.position[0], dy = wy - obj.position[1];
        const direction = dx === 1 && dy === 0 ? 'RIGHT' : dx === -1 && dy === 0 ? 'LEFT' : dy === 1 && dx === 0 ? 'DOWN' : dy === -1 && dx === 0 ? 'UP' : null;
        if (direction) {
          tac.mode = null;
          submitCommand(tac.selected.tenant, obj.id, { type: 'START_MOVE', direction }, `核心迁移 ${direction}`);
          tactRenderActionDialog(); tactRenderInspect(); draw();
        } else {
          toast('请点击核心相邻格选择迁移方向', 'warn');
        }
      } else {
        tac.mode = null;
      }
      return;
    }
    if (tac.mode === 'SWEEP' && tac.selected) {
      const obj = tac.selected.obj;
      const dx = wx - obj.position[0], dy = wy - obj.position[1];
      const direction = dx === 1 && dy === 0 ? 'RIGHT' : dx === -1 && dy === 0 ? 'LEFT' : dy === 1 && dx === 0 ? 'DOWN' : dy === -1 && dx === 0 ? 'UP' : null;
      tac.mode = null;
      if (direction) {
        submitCommand(tac.selected.tenant, tac.selected.obj.id, { type: 'SWEEP', direction }, `清扫 ${direction}`);
      } else {
        toast('请点击单位相邻格选择清扫方向', 'warn');
      }
      if (T().multi.size) {
        els.actionDialog.hidden = true; // 多选时隐藏单单位对话框——不挡后续选点（批量命令走右键菜单）
      } else {
        tactRenderActionDialog(); // 单选：命令已提交，刷新对话框（模式徽章消失）
      }
      tactRenderInspect();
      draw();
      return;
    }
    // 其他模式：回落到空闲态解释（清模式防悬空）
    tactClear();
    return;
  }
  // 空闲态：单位/核心实时命中（2026-08-08 结构性修复）——live 校正写入真实坐标，
  // 下游 tactObjectAt 精确命中；陈旧 ghost 明确反馈，不静默吞点击。
  const hit = await resolveLiveTarget(px, py);
  const cell = hit?.cell ?? null;
  if (cell && (cell.type === 'unit' || cell.type === 'core')) {
    const world = hit?.world ?? null;
    const obj = hit?.obj ?? (world ? tactObjectAt(world, cell.x, cell.y) : null);
    if (obj) {
      if (shift && obj.kind !== 'CORE') {
        // Shift 点击 = 加选/减选（编队多选）；主选中跟随
        const tac2 = T();
        if (tac2.multi.has(obj.id)) { tac2.multi.delete(obj.id); toast('已从编队移除', 'info'); }
        else { tac2.multi.add(obj.id); toast(`编队 +1（共 ${tac2.multi.size}）`, 'info'); }
        if (tac2.multi.size) {
          tac2.selected = { tenant: cell.tenant, obj };
          tactRenderActionDialog(); tactRenderInspect();
        } else if (!tac2.selected || tac2.selected.obj.id === obj.id) {
          tactClear();
          return;
        }
        multiSync(cell.tenant);
        return;
      }
      // 普通点击 = 单选：清空编队只留该单位
      if (T().multi.size) { T().multi = new Set([obj.id]); multiSync(cell.tenant); }
      await tactSelect(cell.tenant, obj); return;
    }
    if (hit?.ghost) { toast('该单位/核心已移位（渲染位陈旧），实时命中失败', 'warn'); return; }
    if (!cell.fresh) { toast('该单位/核心为已探索记忆，已不在当前 tick', 'warn'); return; }
  }
  // 地图要素信息卡（官方 MapFeatureInfo 移植）：点击资源/障碍/信标弹卡，不再"点了没反应"
  if (cell && (cell.type === 'resource' || cell.type === 'obstacle')) {
    tactShowFeature(cell, px, py);
    draw();
    return;
  }
  const beaconHit = (() => {
    return state.beacons.some((b) => b.x === wx && b.y === wy);
  })();
  if (beaconHit) {
    tactShowFeature(null, px, py);
    draw();
    return;
  }
  tactClear();
}
function updateBeaconIndicator() {
  const els2 = els.beaconIndicator;
  const b = state.soloTenant ? state.beacons.find((x) => x.tenant === state.soloTenant) : null;
  if (!b || !state.view.ready || state.layers.beaconEdge === false) { els2.hidden = true; els2.classList.remove('show'); return; }
  const p = project(b.x, b.y);
  const w = W(), h = H();
  if (p.sx >= 0 && p.sx <= w && p.sy >= 0 && p.sy <= h) { els2.hidden = true; return; }
  const cx = w / 2, cy = h / 2;
  const dx = p.sx - cx, dy = p.sy - cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const inset = 40;
  const k = Math.min((w / 2 - inset) / Math.abs(ux || 1e-9), (h / 2 - inset) / Math.abs(uy || 1e-9));
  let ex = cx + ux * k, ey = cy + uy * k;
  // 避开右侧控件列（聚焦徽章/「全局联盟」/缩放按钮，纵向整条）：边缘指示箭头不压按钮
  const avoidR = w - 84, avoidBandTop = h - 520, avoidT = 74;
  if (ex > avoidR && (ey > avoidBandTop || ey < avoidT)) ex = Math.max(inset, avoidR - 84);
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  els2.hidden = false;
  els2.classList.add('show');
  // 位置/角度变化才重绘 DOM，否则 500ms 重建会吃掉点击（"关不掉"根因）
  const moved = Math.abs(ex - els2._x) > 1 || Math.abs(ey - els2._y) > 1 || Math.abs(angle - els2._a) > 1;
  if (moved || !els2.querySelector('.beacon-arrow')) {
    els2._x = ex; els2._y = ey; els2._a = angle;
    els2.style.left = `${ex}px`;
    els2.style.top = `${ey}px`;
    els2.innerHTML = `<div class="beacon-arrow-wrap">
      <button class="beacon-arrow" title="定位信标 [${b.x}, ${b.y}]（点击跳转）" style="transform:rotate(${angle + 90}deg)"></button>
      <button class="beacon-close" title="隐藏信标指示（本次聚焦）">✕</button>
    </div>`;
  } else {
    els2.style.left = `${ex}px`;
    els2.style.top = `${ey}px`;
  }
}

/* ---------- 人类最高控制权：真实指挥提交（Manual > Agent > Safety） ---------- */
/** 一键动作/意图提交到指挥面板后端（server.mjs → data/runtime/human-commands/<tenant>.json），
 *  tenant 主循环提交前合并（human-override.ts），人类指令最高优先。 */
async function ccPost(path: any, body: any) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? data.message ?? `HTTP ${res.status}`);
    return data;
  } catch (err) {
    toast(`提交失败：${err instanceof Error ? err.message : String(err)}`, 'err');
    return null;
  }
}
async function ccDelete(path: any, body: any) {
  try {
    const res = await fetch(path, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? data.message ?? `HTTP ${res.status}`);
    return data;
  } catch (err) {
    toast(`操作失败：${err instanceof Error ? err.message : String(err)}`, 'err');
    return null;
  }
}
/** 一键动作（单 tick 覆盖）：如 SHOOT / HARVEST / DEPOSIT / HEAL / SPAWN / SWEEP。 */
async function submitCommand(tenant: any, unitId: any, action: any, note: any) {
  const data = await ccPost('/api/command', { tenant, unitId, action, note });
  if (data) {
    toast(`已提交命令：${note ?? JSON.stringify(action)}（人类指挥）`, 'ok');
    tactRefreshCommands(tenant);
  }
  return data;
}
/** 持续意图（任务）：mine = 去目标采矿（到达自动挖、满仓回仓）；goto = 移动到目标点。 */
async function submitGoal(tenant: any, unitId: any, kind: any, target: any, note: any) {
  const data = await ccPost('/api/command/goal', { tenant, unitId, kind, target, note });
  if (data) {
    toast(kind === 'mine' ? `已下达采矿任务 → [${target[0]}, ${target[1]}]（到达后自动采集，满仓自动回仓）` : `已下达移动任务 → [${target[0]}, ${target[1]}]`, 'ok');
    tactRefreshCommands(tenant);
  }
  return data;
}
async function clearUnitCommands(tenant: any, unitId: any) {
  const data = await ccDelete('/api/command', { tenant, unitId, scope: 'all' });
  if (data) { toast('已取消该单位的指挥指令（交还 agent）', 'info'); tactRefreshCommands(tenant); }
  return data;
}
async function clearTenantCommands(tenant: any) {
  const data = await ccPost('/api/command/clear', { tenant });
  if (data) { toast('已清空该租户全部人类指令', 'info'); tactRefreshCommands(tenant); }
  return data;
}
async function tactRefreshCommands(tenant: any) {
  const tac = T();
  try {
    const r = await getJSON(`/api/commands?tenant=${tenant}`);
    tac.commandsByTenant = tac.commandsByTenant || {};
    // 卡死跳出回报：目标长期无推进被服务端自动取消时 toast 说明（防"指令莫名消失"）
    const stuck = r && Array.isArray(r.stuck) && r.stuck.length ? r.stuck : [];
    if (stuck.length) {
      // 卡死跳出：低优先级 toast（-1，不顶用户交互反馈）+ 每单位 90s 冷却去重
      const now = Date.now();
      tac.stuckToastAt = tac.stuckToastAt || {};
      const fresh = stuck.filter((x: any) => (tac.stuckToastAt[x.unitId] ?? 0) + 90000 <= now);
      fresh.forEach((x: any) => { tac.stuckToastAt[x.unitId] = now; });
      if (fresh.length) {
        toast(`指令自动取消（卡死跳出）：${fresh.length === 1 ? shortId(fresh[0].unitId) + ' · ' + fresh[0].reason : fresh.length + ' 个单位被服务端自动取消'}`, 'warn', -1);
      }
    }
    const prev = tac.commandsByTenant[tenant];
    tac.commandsByTenant[tenant] = r;
    if (state.soloTenant === tenant) {
      tac.commands = r;
      const tele = r && r.telemetry ? r.telemetry : null;
      if (tele) consumeCommandTelemetry(tenant, tele, prev && prev.telemetry ? prev.telemetry : null);
      tactRenderActionDialog();
      tactRenderHud(tenant);
      tactRenderAssets(tenant); // 指令落地/清除后 H 徽章即时出现/消失
    }
  } catch { /* 忽略 */ }
}
/** 消费人类指令遥测：出现新拒绝/新完成时 toast 提示（按签名去重，防重复弹）。 */
function consumeCommandTelemetry(tenant: any, tele: any, prevTele: any) {
  const tac = T();
  const sig = JSON.stringify({ a: tele.applied ?? [], r: tele.rejected ?? [], s: tele.satisfied ?? [] });
  const prevSig = prevTele ? JSON.stringify({ a: prevTele.applied ?? [], r: prevTele.rejected ?? [], s: prevTele.satisfied ?? [] }) : null;
  const seen = tac.cmdTelemetry[tenant];
  if (seen && seen.sig === sig) return; // 同一状态不重复提示
  tac.cmdTelemetry[tenant] = { sig, at: Date.now() };
  if (prevSig === null) return; // 首次加载不弹历史
  const { rejected, satisfied, applied } = teleDeltas(prevTele, tele);

  // 批量命令汇总（2026-08-08）：最近批次的 applied/rejected 累计入 HUD（toast 反馈仍由下文单独提示）
  const bl = tac.batchLast;
  if (bl && (Date.now() - bl.at) < 10000) {
    const changed = applied.length > 0 || rejected.length > 0;
    bl.applied += applied.length;
    bl.rejected += rejected.length;
    if (changed) { tactRenderHud(tenant); draw(); }
  }

  if (rejected.length) {
    const rs = rejected.map((rj: any) => `[${shortId(rj.unitId)}] ${escapeHtml(rj.reason)}`).join('；');
    toast(`指令被拒绝：${rs}`, 'warn');
  }
  if (satisfied.length) {
    toast(`意图完成 · ${satisfied.map((u: any) => shortId(u)).join('、')} 已交还 agent`, 'info');
    // 命令队列推进：当前段完成 → 自动提交下一段
    satisfied.forEach((u: any) => queueOnSatisfied(tenant, u));
  }
  else if (!rejected.length && applied.length) toast(`人类指令已生效 · ${applied.map((u: any) => shortId(u)).join('、')}`, 'info');
}
/** 人类指令状态快照：{ mode, actions:[], goals:[], updatedAt, telemetry }。 */
function commandStatusText(tenant: any) {
  return cmdStatusText(T(), tenant);
}
/** 单位级人类指令遥测状态行（HTML）：已生效 / 已完成 / 被拒+原因。 */
function unitTelemetryOf(tenant: any, unitId: any) {
  return cmdUnitTelemetry(T(), unitId);
}
function commandGoalOf(tenant: any, unitId: any) {
  return cmdGoalOf(T(), tenant, unitId);
}
function commandActionOf(tenant: any, unitId: any) {
  return cmdActionOf(T(), tenant, unitId);
}
/** 单位是否有活跃人类指令（goal 或一键 action）——舰队索引/地图「指挥中」标记。
 *  全局联盟用 commandsByTenant（refreshAllCommands 每 poll 刷新），聚焦用 T().commands。 */
function unitHumanCommandOf(tenant: any, unitId: any): 'goal' | 'cmd' | null {
  return cmdHumanOf(T(), tenant, unitId);
}

/* ---------- React 挂载桥 ---------- */
const _subs = new Set<any>();
function emit(topic: any, payload: any) {
  for (const cb of _subs) { try { cb(topic, payload); } catch (e) { console.error('emit', topic, e); } }
}
export function createMapEngine(host: any) {
  ROOT = host;
  els = buildEls();
  // 高刷/浏览器优化：alpha:false（画布始终不透明，跳过 alpha 合成）+
  // desynchronized（低延迟合成，减少输入到像素延迟；不影响内容绘制）
  ctx = els.canvas.getContext('2d', { alpha: false, desynchronized: true }) ?? els.canvas.getContext('2d');
  setCtx(ctx); // 画布助手层（canvas.ts）共享同一上下文
  minimap = createMinimap({
    getCanvas: () => els.minimap,
    getState: () => state,
    getViewSize: () => ({ w: W(), h: H() }),
    getDpr: () => effDpr(),
    onJump: (wx: number, wy: number, scale: number) => { if (state.soloTenant) exitSolo(); animateView({ cx: wx, cy: wy, scale: Math.max(0.05, scale) }); draw(); },
  });

  minimap.init();
  const api = {
    toggleSolo: (t: any) => toggleSolo(t),
    focusTenant: (t: any) => {
      // 决策流点击联动（2026-08-08）：聚焦该租户并 fitSolo 定位；已聚焦则重置视野到全貌。
      if (state.soloTenant !== t) {
        state.soloTenant = t;
        invalidateStatic();
        fitSolo(t);
        tactShowTenant(t);
        syncSoloBadge();
        emit('solo', state.soloTenant);
        els.respawnOverlay.hidden = true;
        toast(`已定位 ${t.toUpperCase()} · 决策流聚焦（Esc/G 返回全局）`, 'info');
      } else {
        fitSolo(t);
        draw();
      }
    },
    exitSolo: () => exitSolo(),
    fitView: () => fitView(),
    fitSolo: (t: any) => fitSolo(t),
    setLayer: (name: any, on: any) => { state.layers[name] = on; invalidateStatic(); draw(); savePrefs(); emit('layers', { ...state.layers }); },
    setTenantOn: (t: any, on: any) => { state.tenantsOn[t] = on; invalidateStatic(); draw(); },
    setTab: (tab: any) => { state.tab = tab; savePrefs(); pollStreams(); },
    jumpTo: (x: any, y: any, label?: any) => {
      state.view.cx = x; state.view.cy = y; state.viewAnim = null; state.zoom.active = false;
      const now = performance.now();
      state.jumpMark = { x, y, at: now };
      const dup = state.jumpPins.find((p: any) => p.x === x && p.y === y);
      if (dup) dup.at = now;
      else { state.jumpPins.push({ x, y, at: now, label: label ?? null }); if (state.jumpPins.length > 12) state.jumpPins.shift(); }
      draw();
    },
    resize: () => { resizeCanvas(); draw(); },
    getState: () => ({ soloTenant: state.soloTenant, overview: state.overview, view: { ...state.view }, layers: { ...state.layers }, tenantsOn: { ...state.tenantsOn }, cellCount: state.cells.length, jumpPins: state.jumpPins.map((p: any) => ({ x: p.x, y: p.y, at: p.at, label: p.label ?? null })),
      cells: state.cells.map((c: any) => ({ id: c.id ?? null, x: c.x, y: c.y, type: c.type, unitType: c.unitType ?? null, controlled: c.controlled ?? null, tenant: c.tenant, fresh: c.fresh ?? true })),
      multi: [...T().multi], mode: T().mode ?? null,
      selected: (() => { const s = T().selected; return s && s.obj ? { id: s.obj.id ?? null, tenant: s.tenant ?? null, pos: s.obj.position ?? null } : null; })() }),
    subscribe: (cb: any) => {
      _subs.add(cb);
      // catch-up（2026-08-10）：快照型 topic 立即回放当前值——组件重挂载（如右栏
      // 切 tab）时不错过上一轮 emit；pollStreams 已签名去重，重复回放幂等无害。
      try {
        cb('streams', { tab: state.tab, streams: state.streams, events: state.events });
        cb('overview', state.overview);
        cb('solo', state.soloTenant);
      } catch (e) { console.error('subscribe catch-up', e); }
      return () => _subs.delete(cb);
    },
    toast: (msg: any, tone: any) => toast(msg, tone),
  };
  boot().catch((err) => {
    console.error('map engine boot failed', err);
    emit('refresh', false);
  });
  return api;
}






