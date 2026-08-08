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
    mmCtx.fillStyle = "rgba(255,255,255,.03)";
    mmCtx.fillRect(0, 0, MM_W, MM_H);
    if (state.chunks && state.chunks.length) {
      mmCtx.fillStyle = "rgba(120,160,255,.12)";
      for (const ch of state.chunks.slice(0, 300)) {
        const cx = Number(ch.cx), cy = Number(ch.cy);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
        mmCtx.fillRect(X(cx) - 1, Y(cy) - 1, 2, 2);
      }
    }
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
    const vx0 = X(v.cx - vw / 2), vy0 = Y(v.cy - vh / 2), vx1 = X(v.cx + vw / 2), vy1 = Y(v.cy + vh / 2);
    mmCtx.strokeStyle = "rgba(255,255,255,.9)";
    mmCtx.lineWidth = 1;
    mmCtx.strokeRect(vx0, vy0, Math.max(1, vx1 - vx0), Math.max(1, vy1 - vy0));
    mmCtx.restore();
  }

  return { init, draw, worldBounds };
}
