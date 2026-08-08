// @ts-nocheck — Playwright 定向诊断探针（点击→toast 延迟/命中）：运行时 DOM/API 校验，
// 类型由 Playwright 运行时保证；生产代码类型检查见 src/engine。
// 探针：点击单位 live 位置 → 测 toast 出现延迟（区分慢 vs 脱靶）
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const req = createRequire(import.meta.url);
const { chromium } = req("playwright-core");
function resolveChrome() {
  const root = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const pw = join(root, "ms-playwright");
  if (!existsSync(pw)) return undefined;
  const dirs = [];
  try { for (const d of readdirSync(pw)) { const m = /^chromium-(\d+)$/.exec(d); if (m) dirs.push({ v: Number(m[1]), p: join(pw, d, "chrome-win64", "chrome.exe") }); } } catch {}
  dirs.sort((a, b) => b.v - a.v);
  for (const d of dirs) if (existsSync(d.p)) return d.p;
  return undefined;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true, executablePath: resolveChrome(), args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded" });
await sleep(4000);
await page.click('.tenant-card[data-tenant="t1"]', { timeout: 5000 }).catch(() => {});
await sleep(1500);
const waitViewStable = async () => {
  let prev = null;
  for (let i = 0; i < 12; i++) {
    const v = await page.evaluate(() => { const g = window.__arenaEngine?.getState?.(); return g && g.view ? { cx: g.view.cx, cy: g.view.cy, scale: g.view.scale } : null; });
    if (v && prev && prev.cx === v.cx && prev.cy === v.cy && prev.scale === v.scale) return true;
    prev = v; await sleep(400);
  }
  return false;
};
await page.keyboard.press("f"); await waitViewStable();
const cv = await page.$("#map"); const box = await cv.boundingBox();
// 复刻回归 6f：Shift 点击两个不同受控单位的「画布插值绘制位」→ 测 toast 文本 + 延迟
const waitToastProbe = async (needle, timeoutMs) => {
  let last = ""; const t0 = Date.now(); let delay = -1;
  while (Date.now() - t0 < timeoutMs) {
    last = await page.evaluate(() => { const el = document.getElementById("uiToast"); return el && (el.className || "").includes("show") ? el.textContent || "" : ""; });
    if (last.includes(needle)) { delay = Date.now() - t0; break; }
    await sleep(100);
  }
  return { last, delay };
};
const drawnPt = async (id, tenant) => page.evaluate(({ id, tenant, boxX, boxY, boxW, boxH }) => {
  const eng = window.__arenaEngine; const st = eng ? eng.getState() : null;
  if (!st) return { err: "no engine" };
  const cell = (st.cells ?? []).find((c) => (c.type === "unit" || c.type === "core") && String(c.id) === String(id) && (!st.soloTenant || c.tenant === tenant));
  if (!cell) return { err: "cell-gone:" + String(id).slice(0, 6) };
  const dp = window.__arena && window.__arena.unitDrawPos ? window.__arena.unitDrawPos(cell) : { x: cell.x, y: cell.y };
  const v = st.view;
  return { sx: boxX + (dp.x - v.cx) * v.scale + boxW / 2, sy: boxY + (dp.y - v.cy) * v.scale + boxH / 2, pos: [dp.x, dp.y] };
}, { id, tenant, boxX: box.x, boxY: box.y, boxW: box.width, boxH: box.height });
// 候选：同租户受控单位（画布同源）
const cands = await page.evaluate(({ boxX, boxY, boxW, boxH }) => {
  const eng = window.__arenaEngine; const st = eng ? eng.getState() : null;
  if (!st) return { err: "no engine" };
  const solo = st.soloTenant || null;
  const us = (st.cells ?? []).filter((o) => (!solo || o.tenant === solo) && o.type === "unit" && o.controlled === true);
  if (us.length < 2) return { err: "units<2: " + us.length };
  const v = st.view;
  const onScreen = (u) => { const sx = boxX + (u.x - v.cx) * v.scale + boxW / 2, sy = boxY + (u.y - v.cy) * v.scale + boxH / 2; return sx >= boxX && sx <= boxX + boxW && sy >= boxY && sy <= boxY + boxH; };
  const cs = us.filter(onScreen);
  if (cs.length < 2) return { err: "onscreen<2: " + cs.length + "/" + us.length };
  return { a: { id: cs[0].id, tenant: cs[0].tenant }, b: { id: cs.find((u) => u.id !== cs[0].id)?.id ?? cs[1].id, tenant: cs[0].tenant } };
}, { boxX: box.x, boxY: box.y, boxW: box.width, boxH: box.height });
if (cands.err) { console.log("CAND ERR", cands.err); await browser.close(); process.exit(1); }
console.log("candidates", JSON.stringify(cands));
// 3 轮：每轮 Shift 点 a → 期望「编队 +1」，Shift 点 b → 期望「共 2」，Esc 清理
for (let rnd = 0; rnd < 3; rnd++) {
  const pa = await drawnPt(cands.a.id, cands.a.tenant);
  if (pa.err) { console.log(rnd, "ptA ERR", pa.err); continue; }
  await page.keyboard.down("Shift");
  await page.mouse.click(pa.sx, pa.sy);
  const ra = await waitToastProbe("编队 +1", 6000);
  await page.keyboard.up("Shift");
  await sleep(200);
  const pb = await drawnPt(cands.b.id, cands.b.tenant);
  let rb = null;
  if (!pb.err) {
    await page.keyboard.down("Shift");
    await page.mouse.click(pb.sx, pb.sy);
    rb = await waitToastProbe("共 2", 6000);
    await page.keyboard.up("Shift");
  }
  const sel = await page.evaluate(() => { const g = window.__arenaEngine?.getState?.(); return g && g.tac ? { sel: g.tac.selected ? String(g.tac.selected.obj.id).slice(0,6) : null, multi: g.tac.multi.size } : null; });
  console.log(rnd, "A", JSON.stringify({ ...ra, pt: pa.pos }), "B", pb.err ? "ERR " + pb.err : JSON.stringify({ ...rb, pt: pb.pos }), "sel", JSON.stringify(sel));
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(400);
}

await browser.close();
