/* Arena 指挥面板 · 环境/背景渲染层（从 mapEngine.ts 抽取，2026-08-08）
 * 纯绘制函数（无引擎状态持有）：星点/暗角氛围层、坐标系网格与刻度、全局探索分区
 * 底纹、租户疆域色晕与标签。所有运行态经 deps 注入（getCtx/getView/getCells/…），
 * 无 mapEngine 循环依赖——复用 replay.ts 的 ReplayRenderDeps 注入模式。
 * 语义与抽取前逐行等价：静态缓存渲染期间 mapEngine 会临时替换 ctx 与 state.view，
 * 故 ctx/view/cells 等一律经 getter 在调用时解析。 */
import { hexA, gridStepFor } from "./utils.ts";
import { CANVAS_FONT } from "./canvas.ts";
import { TENANT_COLORS, TENANT_LABEL } from "./tactical.ts";

export interface EnvRenderDeps {
  getCtx(): CanvasRenderingContext2D | null;
  W(): number;
  H(): number;
  project(x: number, y: number): { sx: number; sy: number };
  getView(): { cx: number; cy: number; scale: number };
  getCells(): any[];
  getChunks(): any[] | null;
  getTenantsOn(): Record<string, boolean>;
  lq(): boolean;
}

/** 画布氛围层（极淡星点 + 边缘暗角）：确定性伪随机。
 *  高刷优化：星点/暗角预渲染到离屏 canvas，仅 resize 重建一次，
 *  draw 时单次 drawImage blit——不再每帧画 ~N 个 arc + radial gradient
 *  （175Hz 下省掉每帧 canvas 状态切换与渐变创建）。 */
const bgStars: { canvas: HTMLCanvasElement | null; cctx: CanvasRenderingContext2D | null; w: number; h: number } = { canvas: null, cctx: null, w: 0, h: 0 };
const bgVignette: { canvas: HTMLCanvasElement | null; cctx: CanvasRenderingContext2D | null; w: number; h: number } = { canvas: null, cctx: null, w: 0, h: 0 };
function ensureAtmosphere(w: number, h: number) {
  // 星点层（内容之下）
  if (!bgStars.canvas) { bgStars.canvas = document.createElement("canvas"); bgStars.cctx = bgStars.canvas.getContext("2d", { alpha: true }) ?? bgStars.canvas.getContext("2d"); }
  if (bgStars.w !== w || bgStars.h !== h) {
    bgStars.w = w; bgStars.h = h;
    bgStars.canvas.width = Math.max(1, Math.round(w));
    bgStars.canvas.height = Math.max(1, Math.round(h));
    const cctx = bgStars.cctx!;
    cctx.clearRect(0, 0, w, h);
    let seed = 0x9e3779b9;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const n = Math.max(40, Math.floor(w * h / 9000));
    cctx.save();
    cctx.fillStyle = "#cfe0ff";
    for (let i = 0; i < n; i++) {
      const x = rnd() * w, y = rnd() * h, r = rnd() * 1.1 + 0.3, a = rnd() * 0.10 + 0.04;
      cctx.globalAlpha = a;
      cctx.beginPath(); cctx.arc(x, y, r, 0, Math.PI * 2); cctx.fill();
    }
    cctx.restore();
  }
  // 暗角层（内容之上，收拢视觉焦点）
  if (!bgVignette.canvas) { bgVignette.canvas = document.createElement("canvas"); bgVignette.cctx = bgVignette.canvas.getContext("2d", { alpha: true }) ?? bgVignette.canvas.getContext("2d"); }
  if (bgVignette.w !== w || bgVignette.h !== h) {
    bgVignette.w = w; bgVignette.h = h;
    bgVignette.canvas.width = Math.max(1, Math.round(w));
    bgVignette.canvas.height = Math.max(1, Math.round(h));
    const vc = bgVignette.cctx!;
    vc.clearRect(0, 0, w, h);
    const r0 = Math.min(w, h) * 0.34, r1 = Math.max(w, h) * 0.74;
    const g = vc.createRadialGradient(w / 2, h / 2, r0, w / 2, h / 2, r1);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,.34)");
    vc.fillStyle = g;
    vc.fillRect(0, 0, w, h);
  }
}

/** 星点氛围层（draw 顶部，内容之下）。 */
export function renderStars(deps: EnvRenderDeps, w: number, h: number): void {
  ensureAtmosphere(w, h);
  if (bgStars.canvas) deps.getCtx()?.drawImage(bgStars.canvas, 0, 0, w, h);
}
/** 暗角层（draw 末尾，内容之上，收拢视觉焦点）。 */
export function renderVignette(deps: EnvRenderDeps, w: number, h: number): void {
  ensureAtmosphere(w, h);
  if (bgVignette.canvas) deps.getCtx()?.drawImage(bgVignette.canvas, 0, 0, w, h);
}

/** 背景坐标系网格：细格 + 粗格 + 坐标轴（x=0/y=0）。
 *  并入静态缓存（平移/缩放重建一次），坐标数字由 renderGridLabels 动态画。 */
export function renderGrid(deps: EnvRenderDeps, w: number, h: number): void {
  const ctx = deps.getCtx(); if (!ctx) return;
  const view = deps.getView();
  const s = view.scale;
  const minor = gridStepFor(s, 22);
  const major = minor * 4;
  const x0 = view.cx - w / 2 / s, x1 = view.cx + w / 2 / s;
  const y0 = view.cy - h / 2 / s, y1 = view.cy + h / 2 / s;
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(148,163,200,.06)";
  ctx.beginPath();
  for (let x = Math.floor(x0 / minor) * minor; x <= x1; x += minor) { const p = deps.project(x, y0); ctx.moveTo(p.sx, 0); ctx.lineTo(p.sx, h); }
  for (let y = Math.floor(y0 / minor) * minor; y <= y1; y += minor) { const p = deps.project(x0, y); ctx.moveTo(0, p.sy); ctx.lineTo(w, p.sy); }
  ctx.stroke();
  ctx.strokeStyle = "rgba(180,192,224,.13)";
  ctx.beginPath();
  for (let x = Math.floor(x0 / major) * major; x <= x1; x += major) { const p = deps.project(x, y0); ctx.moveTo(p.sx, 0); ctx.lineTo(p.sx, h); }
  for (let y = Math.floor(y0 / major) * major; y <= y1; y += major) { const p = deps.project(x0, y); ctx.moveTo(0, p.sy); ctx.lineTo(w, p.sy); }
  ctx.stroke();
  if (x0 <= 0 && 0 <= x1) {
    ctx.strokeStyle = "rgba(222,230,255,.30)";
    const p = deps.project(0, y0);
    ctx.beginPath(); ctx.moveTo(p.sx, 0); ctx.lineTo(p.sx, h); ctx.stroke();
  }
  if (y0 <= 0 && 0 <= y1) {
    ctx.strokeStyle = "rgba(222,230,255,.30)";
    const p = deps.project(x0, 0);
    ctx.beginPath(); ctx.moveTo(0, p.sy); ctx.lineTo(w, p.sy); ctx.stroke();
  }
}

/** 坐标刻度标签（动态层）：顶边 X 世界坐标 + 左边 Y 世界坐标。动画降级期间跳过。 */
export function renderGridLabels(deps: EnvRenderDeps, w: number, h: number): void {
  if (deps.lq()) return;
  const ctx = deps.getCtx(); if (!ctx) return;
  const view = deps.getView();
  const s = view.scale;
  const major = gridStepFor(s, 22) * 4;
  if (major * s < 52) return;
  const x0 = view.cx - w / 2 / s, x1 = view.cx + w / 2 / s;
  const y0 = view.cy - h / 2 / s, y1 = view.cy + h / 2 / s;
  ctx.save();
  ctx.font = `500 ${Math.max(10, Math.min(13, s * 0.3))}px ${CANVAS_FONT}`;
  ctx.fillStyle = "rgba(196,206,235,.5)";
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  for (let x = Math.floor(x0 / major) * major; x <= x1; x += major) {
    const p = deps.project(x, y0);
    if (p.sx < 12 || p.sx > w - 12) continue;
    ctx.fillText(String(x), p.sx + 4, 13);
  }
  ctx.textAlign = "right";
  for (let y = Math.floor(y0 / major) * major; y <= y1; y += major) {
    const p = deps.project(x0, y);
    if (p.sy < 14 || p.sy > h - 12) continue;
    ctx.fillText(String(y), 6, p.sy - 5);
  }
  ctx.restore();
}

/** 全局探索分区底纹（/api/map chunks，跨租户合并）：已探索 16×16 分区淡蓝底——
 *  全局视图也能一眼看出"探索过的范围"（solo 视图由 tactSurveyLayer 画同款底纹）。
 *  只画视口内 chunk（性能）；无数据（survey-db 未同步）时静默跳过。 */
export function renderGlobalChunks(deps: EnvRenderDeps, s: number): void {
  const ctx = deps.getCtx(); if (!ctx) return;
  const chunks = deps.getChunks();
  if (!chunks || !chunks.length) return;
  ctx.save();
  const chunkPx = 16 * s;
  const cap = Math.min(chunks.length, 500);
  for (let i = 0; i < cap; i++) {
    const ch = chunks[i];
    const cx = Number(ch.cx), cy = Number(ch.cy);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
    const p = deps.project(cx * 16, cy * 16);
    if (p.sx + chunkPx < 0 || p.sy + chunkPx < 0 || p.sx > deps.W() || p.sy > deps.H()) continue;
    ctx.fillStyle = "rgba(64,110,160,.09)";
    ctx.fillRect(p.sx, p.sy, chunkPx, chunkPx);
  }
  ctx.restore();
}

/** 全局联盟地图：每租户疆域色晕 + 核心标签（大联盟地图"完全设计"：一眼区分 4 租户领地）。 */
export function renderTenantRegions(deps: EnvRenderDeps, s: number): void {
  const ctx = deps.getCtx(); if (!ctx) return;
  const cells = deps.getCells();
  const tenantsOn = deps.getTenantsOn();
  const groups: Record<string, any[]> = {};
  for (const c of cells) {
    if (tenantsOn[c.tenant] === false) continue;
    (groups[c.tenant] = groups[c.tenant] || []).push(c);
  }
  ctx.save();
  for (const t of Object.keys(TENANT_COLORS)) {
    const g = groups[t];
    if (!g || !g.length) continue;
    const color = TENANT_COLORS[t];
    const xs = g.map((c: any) => c.x), ys = g.map((c: any) => c.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const span = Math.max(30, Math.max(maxX - minX, maxY - minY));
    const p = deps.project(cx, cy);
    const radius = Math.max(60, span * s * 0.62);
    // 疆域色晕（弱化）：用户反馈"诡异绿色球/绿色区域"——原 alpha .10 的
    // 径向色晕在缩放后像一团实色球。降为 .045/.02 极淡打底 + 虚线疆域环（结构化
    // "领地边界"，不再是一团实心色球）；租户色只作身份语义，不装饰性铺满。
    const grad = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, radius);
    grad.addColorStop(0, hexA(color, 0.045));
    grad.addColorStop(0.55, hexA(color, 0.02));
    grad.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, radius, 0, Math.PI * 2); ctx.fill();
    // 疆域边界环：虚线细环（alpha .16，随缩放 1.2-2px），一眼圈出领地但不抢内容层
    ctx.strokeStyle = hexA(color, 0.16);
    ctx.lineWidth = Math.min(2, Math.max(1.2, s * 0.07));
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.arc(p.sx, p.sy, radius, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    // 疆域标签：贴在核心/最密点上方
    const core = g.find((c: any) => c.type === "core");
    const lx = core ? core.x : cx, ly = core ? core.y : cy;
    const lp = deps.project(lx, ly);
    if (s >= 2.5) {
      const label = `${t.toUpperCase()} · ${TENANT_LABEL[t]}`;
      ctx.font = "600 " + Math.max(9, Math.min(13, s * 0.34)) + "px " + CANVAS_FONT;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const tw = ctx.measureText(label).width;
      const pad = 6, hh = 13;
      const bx = lp.sx, by = lp.sy - Math.max(22, s * 0.9);
      ctx.fillStyle = "rgba(5,6,8,.78)";
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
