/* Arena 指挥面板前端 — 全局小地图（世界缩略 + 视野框 + 点击/拖拽跳转）。
 * 自包含模块：注入 canvas/state/视图尺寸/DPR/跳转回调，与 mapEngine 解耦。 */
import { TENANT_COLORS } from "./tactical.ts";
const TENANTS = ["t1", "t2", "t3", "t4"];
import { hexA } from "./utils.ts";

export const MM_W = 172, MM_H = 128;

export interface MinimapDeps {
  getCanvas(): HTMLCanvasElement | null;
  getState(): any; // engine state: cells/bounds/chunks/view/map/soloTenant
  getViewSize(): { w: number; h: number };
  getDpr(): number;
  onJump(wx: number, wy: number, currentScale: number): void;
}

export function createMinimap(deps: MinimapDeps) {
  let mmCtx: any = null;
  let mmCacheKey = "";
  let mmTenantBox: Record<string, { minX: number; minY: number; maxX: number; maxY: number }> = {};
  let mmCoreCells: any[] = [];

  function worldBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const state = deps.getState();
    if (state.bounds) return state.bounds;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of state.cells) {
      if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y;
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }

  function init() {
    const el = deps.getCanvas();
    if (!el) return;
    const dpr = deps.getDpr();
    el.width = Math.max(1, Math.round(MM_W * dpr));
    el.height = Math.max(1, Math.round(MM_H * dpr));
    mmCtx = el.getContext("2d");
    if (!mmCtx) return;
    // DPR 坐标变换：位图 = CSS×dpr，绘制坐标统一用 CSS 像素（否则高 DPR 下内容只画左上角）
    mmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let mmDrag = false;
    const jump = (e: any) => {
      const b = worldBounds(); if (!b) return;
      const r = el.getBoundingClientRect();
      const pad = 6;
      const iw = MM_W - pad * 2, ih = MM_H - pad * 2;
      const spanX = Math.max(1, b.maxX - b.minX), spanY = Math.max(1, b.maxY - b.minY);
      const s = Math.min(iw / spanX, ih / spanY);
      const ox = pad + (iw - spanX * s) / 2, oy = pad + (ih - spanY * s) / 2;
      const wx = b.minX + (e.offsetX - ox) / s;
      const wy = b.minY + (e.offsetY - oy) / s;
      deps.onJump(wx, wy, deps.getState().view.scale);
    };
    el.addEventListener("pointerdown", (e: any) => { mmDrag = true; el.setPointerCapture(e.pointerId); jump(e); });
    el.addEventListener("pointermove", (e: any) => { if (mmDrag) jump(e); });
    el.addEventListener("pointerup", () => { mmDrag = false; });
    el.addEventListener("pointercancel", () => { mmDrag = false; });
  }

  function draw() {
    const el = deps.getCanvas();
    if (!el || !mmCtx) return;
    const state = deps.getState();
    const dpr = deps.getDpr();
    // DPR 位图重同步：跨显示器拖动/系统缩放后 bitmap 尺寸可能过时（重设会清空位图，随后全量重画）
    const wantW = Math.max(1, Math.round(MM_W * dpr)), wantH = Math.max(1, Math.round(MM_H * dpr));
    if (el.width !== wantW || el.height !== wantH) { el.width = wantW; el.height = wantH; }
    mmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const b = worldBounds();
    mmCtx.save();
    mmCtx.clearRect(0, 0, MM_W, MM_H);
    if (!b) {
      mmCtx.fillStyle = "rgba(255,255,255,.35)"; mmCtx.font = "9px sans-serif"; mmCtx.textAlign = "center";
      mmCtx.fillText("暂无测绘", MM_W / 2, MM_H / 2);
      mmCtx.restore(); return;
    }
    const ck = state.cells.length + ":" + (state.cells[0] ? state.cells[0].x + "," + state.cells[0].y : "") + ":" + (state.map?.generatedAtMs ?? "");
    if (ck !== mmCacheKey) {
      mmCacheKey = ck;
      mmTenantBox = {}; mmCoreCells = [];
      for (const c of state.cells) {
        const t = c.tenant;
        if (!mmTenantBox[t]) mmTenantBox[t] = { minX: c.x, minY: c.y, maxX: c.x, maxY: c.y };
        else {
          const q = mmTenantBox[t];
          if (c.x < q.minX) q.minX = c.x; if (c.x > q.maxX) q.maxX = c.x;
          if (c.y < q.minY) q.minY = c.y; if (c.y > q.maxY) q.maxY = c.y;
        }
        if (c.type === "core") mmCoreCells.push(c);
      }
    }
    const pad = 6;
    const iw = MM_W - pad * 2, ih = MM_H - pad * 2;
    const spanX = Math.max(1, b.maxX - b.minX), spanY = Math.max(1, b.maxY - b.minY);
    const s = Math.min(iw / spanX, ih / spanY);
    const ox = pad + (iw - spanX * s) / 2, oy = pad + (ih - spanY * s) / 2;
    const X = (x: number) => ox + (x - b.minX) * s;
    const Y = (y: number) => oy + (y - b.minY) * s;
    // 底=CSS 深底（透明位图），不再叠全幅白 fill（旧实现产生成片半透明白像素 = "白色乱七八糟"）
    // 探索分区色块底纹（2026-08-09 用户反馈移除）：旧实现把 chunks 逐块画
    // 淡蓝方块（cap 300 块铺满小地图 = "一堆色块"），观感脏。小地图保持干净：
    // 只画租户区域框 + 核心点 + 敌核 + 视野框（探索覆盖看主地图的测绘层）。
    for (const c of mmCoreCells) {
      if (c.controlled !== false) continue;
      mmCtx.fillStyle = "#e0625d";
      mmCtx.beginPath(); mmCtx.arc(X(c.x), Y(c.y), 2.4, 0, Math.PI * 2); mmCtx.fill();
    }
    for (const t of TENANTS) {
      const box = mmTenantBox[t];
      if (!box) continue;
      const color = TENANT_COLORS[t];
      mmCtx.fillStyle = hexA(color, 0.28);
      mmCtx.fillRect(X(box.minX), Y(box.minY), Math.max(1.5, X(box.maxX) - X(box.minX)), Math.max(1.5, Y(box.maxY) - Y(box.minY)));
      const core = mmCoreCells.find((c: any) => c.tenant === t && c.controlled !== false);
      if (core) {
        mmCtx.fillStyle = color;
        mmCtx.beginPath(); mmCtx.arc(X(core.x), Y(core.y), 3.2, 0, Math.PI * 2); mmCtx.fill();
        mmCtx.strokeStyle = "rgba(255,255,255,.7)"; mmCtx.lineWidth = .7; mmCtx.stroke();
      }
    }
    const v = state.view;
    const vw = deps.getViewSize().w / v.scale, vh = deps.getViewSize().h / v.scale;
    let vx0 = X(v.cx - vw / 2), vy0 = Y(v.cy - vh / 2), vx1 = X(v.cx + vw / 2), vy1 = Y(v.cy + vh / 2);
    // 视野框钳到小地图边界；语义判定：视口已包含整个世界（fitView/全局视图）时不画白框——
    // 旧实现按面积阈值，全局下视野仍差一点就整圈白框贴边 + 叠 CSS 边框 = "白色乱七八糟"。
    const wb0 = X(b.minX), wb1 = X(b.maxX), wb2 = Y(b.minY), wb3 = Y(b.maxY);
    const worldInView = vx0 <= wb0 + 0.5 && vy0 <= wb2 + 0.5 && vx1 >= wb1 - 0.5 && vy1 >= wb3 - 0.5;
    if (!worldInView) {
      vx0 = Math.max(0, vx0); vy0 = Math.max(0, vy0);
      vx1 = Math.min(MM_W, vx1); vy1 = Math.min(MM_H, vy1);
      const bw = Math.max(1, vx1 - vx0), bh = Math.max(1, vy1 - vy0);
      mmCtx.fillStyle = "rgba(255,255,255,.035)";
      mmCtx.fillRect(vx0, vy0, bw, bh);
      mmCtx.strokeStyle = "rgba(255,255,255,.6)";
      mmCtx.lineWidth = 1;
      mmCtx.strokeRect(vx0, vy0, bw, bh);
    }
    mmCtx.restore();
  }

  return { init, draw, worldBounds };
}
