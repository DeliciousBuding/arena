/**
 * 指挥面板 Playwright 回归脚本（2026-08-08）——统一验证入口，替代 tmp/cc-*.cjs 散件。
 *
 * 用法（command-center/web 下）：
 *   npm run test:regression              # 需本机 8787 已启动 + Playwright chromium 已装
 *   CC_BASE=http://127.0.0.1:8787 npm run test:regression
 *   CC_CHROME=<chrome.exe 路径> npm run test:regression   # 显式指定浏览器
 *
 * 覆盖（全部安全/只读，人类指挥链会写后立即清除）：
 *   1. 页面加载零 console/pageerror
 *   2. 右栏四 tab（决策流/威胁情报/测绘/兑换码）渲染
 *   3. 决策流有数据（条数 > 0）
 *   4. 聚焦租户 → HUD + 舰队索引可见
 *   5. 计划箭头/意图标签层渲染（画布租户色像素 > 阈值）
 *   6. 人类指挥 UI 链：点单位 → MOVE → 点画布 → goal 落盘 → 清除
 *   7. API 健康：overview/stream/survey 响应 < 5s
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const req = createRequire(import.meta.url);
const { chromium } = req("playwright-core");

const BASE = process.env.CC_BASE ?? "http://127.0.0.1:8787";
const CHROME = process.env.CC_CHROME;

/** 解析本地 Playwright chromium（%LOCALAPPDATA%\ms-playwright\chromium-*\chrome-win64\chrome.exe，取最高版本） */
function resolveChrome() {
  if (CHROME) return CHROME;
  const root = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const pw = join(root, "ms-playwright");
  if (!existsSync(pw)) return undefined;
  const dirs = [];
  try {
    for (const d of readdirSync(pw)) {
      const m = /^chromium-(\d+)$/.exec(d);
      if (m) dirs.push({ v: Number(m[1]), p: join(pw, d, "chrome-win64", "chrome.exe") });
    }
  } catch { /* 忽略 */ }
  dirs.sort((a, b) => b.v - a.v);
  for (const d of dirs) if (existsSync(d.p)) return d.p;
  return undefined;
}

const results = [];
let pass = 0, fail = 0;
function ok(name, detail = "") { pass++; results.push(`  ✅ ${name}${detail ? " — " + detail : ""}`); }
function bad(name, detail = "") { fail++; results.push(`  ❌ ${name}${detail ? " — " + detail : ""}`); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const exec = resolveChrome();
  if (!exec) { console.error("未找到 Playwright chromium，先 npx playwright-core install chromium"); process.exit(2); }
  const browser = await chromium.launch({ headless: true, executablePath: exec, args: ["--no-sandbox", "--disable-gpu"] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

  try {
    // 1) 加载
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 20000 });
    await sleep(5000);
    errs.length ? bad("页面加载零错误", errs.slice(0, 3).join(" | ")) : ok("页面加载零错误");

    // 2) 右栏四 tab
    const tabs = await page.$$eval(".rp-tab", (els) => els.map((e) => e.getAttribute("data-rp-tab")));
    const want = ["logs", "intel", "survey", "redeem"];
    JSON.stringify(tabs) === JSON.stringify(want) ? ok("右栏四 tab", tabs.join(",")) : bad("右栏四 tab", "got " + tabs.join(","));

    // 3) 决策流有数据
    for (const tab of ["logs", "intel", "survey", "redeem"]) {
      await page.click(`.rp-tab[data-rp-tab="${tab}"]`, { timeout: 4000 }).catch(() => {});
      await sleep(tab === "intel" || tab === "survey" ? 1800 : 800);
      const txt = await page.evaluate(() => (document.querySelector(".rp .rp-body")?.innerText ?? "").slice(0, 120));
      if (tab === "logs") {
        /条/.test(txt) ? ok("决策流有数据", txt.slice(0, 40)) : bad("决策流有数据", txt.slice(0, 40));
      } else {
        txt.length > 20 ? ok(`tab ${tab} 渲染`, txt.slice(0, 40)) : bad(`tab ${tab} 渲染`, txt.slice(0, 40));
      }
    }
    await page.click('.rp-tab[data-rp-tab="logs"]', { timeout: 4000 }).catch(() => {});

    // 4) 聚焦租户 → HUD + 舰队索引
    await page.click('.tenant-card[data-tenant="t1"]', { timeout: 4000 }).catch(() => {});
    await sleep(2500);
    const hud = await page.evaluate(() => ({
      hud: !document.getElementById("fleetHud")?.hidden,
      assets: !document.getElementById("assetPanel")?.hidden,
      assetRows: document.querySelectorAll("#assetList .asset-row").length,
    }));
    hud.hud && hud.assets && hud.assetRows > 0 ? ok("聚焦→HUD/舰队索引", `${hud.assetRows} 行`) : bad("聚焦→HUD/舰队索引", JSON.stringify(hud));

    // 5) 计划箭头/意图标签层（画布租户色像素）
    await sleep(2000);
    const px = await page.evaluate(() => {
      const cv = document.getElementById("map");
      const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      const colors = [[105,179,216],[87,189,132],[168,146,214],[221,98,109]];
      let n = 0;
      for (const [r,g,b] of colors) for (let i = 0; i < d.length; i += 8) {
        if (Math.abs(d[i]-r)<22 && Math.abs(d[i+1]-g)<22 && Math.abs(d[i+2]-b)<22 && d[i+3]>30) n++;
      }
      return n;
    });
    px > 10 ? ok("计划层渲染（租户色像素）", px + " px") : bad("计划层渲染（租户色像素）", px + " px");

    // 6) 人类指挥 UI 链（写后必清）
    let goalOk = false;
    try {
      const workerRow = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("#assetList .asset-row"));
        const w = rows.find((r) => (r.innerText ?? "").includes("工人") || (r.querySelector(".asset-icon img")?.src ?? "").includes("worker"));
        return w ? rows.indexOf(w) : -1;
      });
      if (workerRow >= 0) {
        await page.click(`#assetList .asset-row:nth-child(${workerRow + 1})`, { timeout: 4000 });
        await sleep(800);
        await page.click('#actionDialog [data-action="MOVE"]', { timeout: 4000 }).catch(() => {});
        await sleep(500);
        const cv = await page.$("#map");
        const box = await cv.boundingBox();
        await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.5);
        await sleep(1200);
        const cmds = await page.evaluate(async () => {
          const r = await fetch("/api/commands?tenant=t1", { cache: "no-store" });
          const j = await r.json();
          return { goals: (j.goals ?? []).length, commands: (j.commands ?? []).length };
        });
        goalOk = cmds.goals > 0 || cmds.commands > 0;
        goalOk ? ok("人类指挥 UI 链（goal 落盘）", JSON.stringify(cmds)) : bad("人类指挥 UI 链（goal 落盘）", JSON.stringify(cmds));
      } else {
        bad("人类指挥 UI 链", "未找到 worker 资产行");
      }
    } catch (e) {
      bad("人类指挥 UI 链", e.message);
    } finally {
      try { await page.evaluate(async () => { await fetch("/api/command/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenant: "t1" }) }); }); } catch { /* 忽略 */ }
    }

    // 7) API 健康
    for (const path of ["/api/overview", "/api/stream?tenant=t1&n=5", "/api/survey?tenant=t1"]) {
      const t0 = Date.now();
      try {
        const r = await page.evaluate(async (p) => { const x = await fetch(p, { cache: "no-store" }); return { ok: x.ok, body: await x.text() }; }, path);
        const ms = Date.now() - t0;
        (r.ok && ms < 5000) ? ok(`API ${path}`, ms + "ms") : bad(`API ${path}`, `${ms}ms ok=${r.ok}`);
      } catch (e) { bad(`API ${path}`, e.message); }
    }
  } catch (e) {
    bad("回归主流程", e.message);
  } finally {
    await browser.close().catch(() => {});
  }

  console.log("\n== 指挥面板回归 ==");
  console.log(results.join("\n"));
  console.log(`\n通过 ${pass} / ${pass + fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
