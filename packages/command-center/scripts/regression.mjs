/**
 * Arena 指挥面板 — Playwright 回归冒烟（2026-08-08）
 * 用法：node packages/command-center/scripts/regression.mjs [--url http://127.0.0.1:8787]
 * 退出码：0=全部通过 1=失败
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const argUrl = process.argv.find((a) => a.startsWith("--url="))?.slice(6);
const BASE = process.env.CC_URL ?? argUrl ?? "http://127.0.0.1:8787";

function loadPlaywright() {
  const candidates = [
    new URL("../web/node_modules/playwright-core/package.json", import.meta.url),
    new URL("../../../node_modules/playwright-core/package.json", import.meta.url),
  ];
  for (const c of candidates) if (existsSync(c)) return createRequire(import.meta.url)(c.pathname.replace(/package\.json$/, "index.mjs"));
  const tmp = "C:/Users/Ding/tmp/pw/package.json";
  if (existsSync(tmp)) return createRequire(tmp)("playwright-core");
  throw new Error("playwright-core 未找到：请先 npm i playwright-core");
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`  ✅ ${name}`); }
  catch (e) { results.push({ name, ok: false, err: String(e?.message ?? e).slice(0, 300) }); console.log(`  ❌ ${name}: ${String(e?.message ?? e).slice(0, 300)}`); }
}

const pw = await loadPlaywright();
const { chromium } = pw;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push("PAGEERROR: " + e.message));
page.on("console", (m) => { if (m.type() === "error") pageErrors.push("CONSOLE: " + m.text().slice(0, 200)); });

console.log(`Arena 指挥面板回归 · ${BASE}`);

await check("服务健康 /api/overview 200", async () => {
  const res = await fetch(BASE + "/api/overview");
  if (res.status !== 200) throw new Error("HTTP " + res.status);
});

await check("页面加载无报错", async () => {
  await page.goto(BASE + "/app", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(5000);
  if (pageErrors.length) throw new Error(pageErrors.join(" | "));
});

await check("官方子集面板全部存在", async () => {
  const ids = ["#actionDialog","#inspectPanel","#featurePanel","#pendingPanel","#resourceActivity","#commandCountdown","#respawnOverlay","#beaconIndicator","#assetPanel","#fleetHud","#mapControls","#replayBar","#mapTooltip","#map","#sidebar","#streamPane"];
  const missing = await page.evaluate((list) => list.filter((id) => !document.querySelector(id)), ids);
  if (missing.length) throw new Error("缺元素: " + missing.join(","));
});

await check("聚焦租户 → 侧栏滚动到 HUD 可视", async () => {
  await page.locator('.tenant-card[data-tenant="t1"]').click().catch(() => {});
  let r = null;
  for (let i = 0; i < 20; i++) {
    r = await page.evaluate(() => {
      const sb = document.querySelector("#sidebar");
      const fh = document.querySelector("#fleetHud");
      if (!fh || fh.hidden) return { ok: false, why: "fleetHud hidden" };
      const fhr = fh.getBoundingClientRect(), sbr = sb.getBoundingClientRect();
      return { ok: fhr.y >= sbr.y - 2 && fhr.y < sbr.y + sbr.height, relY: Math.round(fhr.y - sbr.y) };
    });
    if (r.ok) break;
    await page.waitForTimeout(500);
  }
  if (!r.ok) throw new Error(JSON.stringify(r));
});

await check("选中单位 → 动作框 → MOVE → 真实 Esc 取消", async () => {
  const r = await page.evaluate(async () => {
    const w = window.__arena;
    const world = w.state.tactical.worlds.t1;
    const u = world.state.objects.find((o) => o.controlled && o.position && o.kind === "UNIT");
    if (!u) throw new Error("无受控单位");
    await w.tactSelect("t1", u);
    const dlg = document.querySelector("#actionDialog");
    const hasActions = dlg.querySelectorAll("[data-action]").length > 0;
    w.tactChooseAction("MOVE");
    if (w.state.tactical.mode !== "MOVE") throw new Error("MOVE 模式未进入");
    const dlgHiddenAfter = dlg.hidden;
    return { hasActions, dlgHiddenAfter };
  });
  // 真实按键 Esc（dispatchEvent 不触发 window keydown，必须用真实按键）
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const cleared = await page.evaluate(() => !window.__arena.state.tactical.selected && !window.__arena.state.tactical.mode);
  if (!r.hasActions || !r.dlgHiddenAfter || !cleared) throw new Error(JSON.stringify({ ...r, cleared }));
});

await check("点击地图要素弹信息卡", async () => {
  // 先平移视图到地形格（确保在视口内），再真实点击
  const setup = await page.evaluate(() => {
    const w = window.__arena;
    const terrain = (w.state.cells || []).find((c) => c.type === "obstacle" || c.type === "resource");
    if (!terrain) return null;
    w.state.view.cx = terrain.x; w.state.view.cy = terrain.y; w.state.view.scale = 10; w.state.viewAnim = null;
    if (w.draw) w.draw();
    const rect = document.querySelector("#map").getBoundingClientRect();
    return { sx: rect.x + rect.width / 2, sy: rect.y + rect.height / 2, cell: terrain };
  });
  if (!setup) throw new Error("无可点地形");
  await page.waitForTimeout(400);
  await page.mouse.click(setup.sx, setup.sy);
  await page.waitForTimeout(700);
  const r = await page.evaluate((cell) => {
    const el = document.querySelector("#featurePanel");
    return { hidden: el?.hidden, title: el?.querySelector(".fp-title")?.textContent ?? null, expect: cell.type };
  }, setup.cell);
  if (r.hidden || !r.title) throw new Error("信息卡未弹出 " + JSON.stringify(r));
});

await check("折叠决策流 → 画布放大（无拉伸）", async () => {
  const before = await page.evaluate(() => Math.round(document.querySelector("#map").getBoundingClientRect().height));
  await page.locator("#streamToggle").click().catch(() => {});
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => Math.round(document.querySelector("#map").getBoundingClientRect().height));
  if (after <= before) throw new Error("画布未随折叠放大 " + JSON.stringify({ before, after }));
});

await check("15s tick 读条在动", async () => {
  const t1 = await page.evaluate(() => document.querySelector("#ccTime")?.textContent);
  await page.waitForTimeout(2500);
  const t2 = await page.evaluate(() => document.querySelector("#ccTime")?.textContent);
  if (t1 === t2) throw new Error("倒计时未变化 " + t1);
});

await check("/api/events 有数据（after.state.events 回归）", async () => {
  let total = 0;
  for (const t of ["t1","t2","t3","t4"]) {
    const res = await fetch(BASE + `/api/events?tenant=${t}&n=20`);
    const j = await res.json();
    total += (j.events ?? []).length;
  }
  if (total === 0) throw new Error("4 租户 events 全空（数据源回归失败）");
});

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) { console.log("失败项："); for (const f of failed) console.log(`  - ${f.name}: ${f.err}`); process.exit(1); }
