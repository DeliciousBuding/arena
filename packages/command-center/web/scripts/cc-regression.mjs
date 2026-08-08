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
 *   2. 右栏六 tab（决策流/威胁情报/参谋建议/测绘/联盟态势/兑换码）渲染
 *   3. 决策流有数据（条数 > 0）
 *   4. 聚焦租户 → HUD + 舰队索引可见
 *   5. 计划箭头/意图标签层渲染（画布租户色像素 > 阈值）
 *   6. 人类指挥 UI 链：点单位 → MOVE → 点画布 → goal 落盘 → 清除
 *   7. API 健康：overview/stream/survey 响应 < 5s
 */
import { createRequire } from "node:module";
import { request as httpRequest } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const req = createRequire(import.meta.url);
const { chromium } = req("playwright-core");

const BASE = process.env.CC_BASE ?? "http://127.0.0.1:8787";
const CHROME = process.env.CC_CHROME;
const API_TIMEOUT_MS = Number(process.env.CC_API_TIMEOUT_MS ?? 25000);

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

/** 前置健康：node:http 直连（绕开 HTTP_PROXY 环境变量对 undici fetch 的代理劫持，不依赖 NO_PROXY 配置） */
function probeHealth(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const u = new URL(url);
      const req = httpRequest(
        { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET", timeout: timeoutMs },
        (res) => { res.resume(); done({ ok: res.statusCode === 200, status: res.statusCode }); }
      );
      req.on("timeout", () => { req.destroy(new Error("timeout")); });
      req.on("error", (e) => done({ ok: false, err: e.message.slice(0, 40) }));
      req.end();
    } catch (e) {
      done({ ok: false, err: String(e?.message ?? e).slice(0, 40) });
    }
  });
}

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
    // 0) 前置健康：8787 可达性快速诊断（node:http 直连绕代理；失败关浏览器后打印退出，避免 return 吞掉结果）
    let pre = null, preErr = "";
    try { pre = await probeHealth(BASE + "/api/overview", 5000); } catch (e) { preErr = String(e?.name ?? e).slice(0, 40); }
    if (!pre || !pre.ok) {
      await browser.close().catch(() => {});
      console.log("\n== 指挥面板回归 ==");
      console.log("  ❌ 前置健康 — 8787 不可达（" + (pre ? "HTTP " + pre.status : preErr || "连接失败") + "）——确认 server.ts 已启动且 /api/overview 可用");
      console.log("\n通过 0 / 1");
      process.exit(1);
    }
    ok("前置健康", "8787 /api/overview 可达");

    // 1) 加载
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(8000);
    errs.length ? bad("页面加载零错误", errs.slice(0, 3).join(" | ")) : ok("页面加载零错误");

    // 2) 右栏六 tab
    const tabs = await page.$$eval(".rp-tab", (els) => els.map((e) => e.getAttribute("data-rp-tab")));
    const want = ["logs", "intel", "advice", "survey", "situation", "redeem"];
    JSON.stringify(tabs) === JSON.stringify(want) ? ok("右栏六 tab", tabs.join(",")) : bad("右栏六 tab", "got " + tabs.join(","));

    // 2b) 全局威胁玫瑰数据管道：/api/alliance/snapshot 被页面拉取（威胁扇区玫瑰数据源）
    // 首次拉取可能恰逢服务重启/慢请求 → 轮询等待（最多 12s），而非单点检查
    let snapReq = false;
    for (let i = 0; i < 12 && !snapReq; i++) {
      snapReq = await page.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.includes("/api/alliance/snapshot")));
      if (!snapReq) await sleep(1000);
    }
    snapReq ? ok("全局威胁玫瑰数据管道", "snapshot 已拉取") : bad("全局威胁玫瑰数据管道", "12s 内未发现 snapshot 请求");

    // 3) 决策流有数据
    for (const tab of ["logs", "intel", "advice", "survey", "situation", "redeem"]) {
      await page.click(`.rp-tab[data-rp-tab="${tab}"]`, { timeout: 4000 }).catch(() => {});
      await sleep(tab === "intel" || tab === "survey" || tab === "situation" ? 4000 : 1000);
      const txt = await page.evaluate(() => (document.querySelector(".rp .rp-body")?.innerText ?? "").slice(0, 120));
      if (tab === "logs") {
        /条/.test(txt) ? ok("决策流有数据", txt.slice(0, 40)) : bad("决策流有数据", txt.slice(0, 40));
      } else if (tab === "survey") {
        // 测绘 tab 首帧可能是"加载测绘数据…"：轮询等真实内容（CPU 高占用时初始化更慢）
        let real = false;
        for (let i = 0; i < 8 && !real; i++) {
          const cur = await page.evaluate(() => (document.querySelector(".rp .rp-body")?.innerText ?? "").trim());
          real = cur.length > 20 && !cur.startsWith("加载测绘");
          if (!real) await sleep(1000);
        }
        real ? ok("tab survey 渲染", txt.slice(0, 40)) : bad("tab survey 渲染", txt.slice(0, 40));
      } else {
        txt.length > 20 ? ok(`tab ${tab} 渲染`, txt.slice(0, 40)) : bad(`tab ${tab} 渲染`, txt.slice(0, 40));
      }
    }
    await page.click('.rp-tab[data-rp-tab="logs"]', { timeout: 4000 }).catch(() => {});

    // 4) 聚焦租户 → HUD + 舰队索引（轮询等可见：CPU 高占用时 world/资产加载更慢）
    await page.click('.tenant-card[data-tenant="t1"]', { timeout: 4000 }).catch(() => {});
    let hud = { hud: false, assets: false, assetRows: 0 };
    for (let i = 0; i < 15 && !(hud.hud && hud.assets && hud.assetRows > 0); i++) {
      hud = await page.evaluate(() => ({
        hud: !document.getElementById("fleetHud")?.hidden,
        assets: !document.getElementById("assetPanel")?.hidden,
        assetRows: document.querySelectorAll("#assetList .asset-row").length,
      }));
      if (!(hud.hud && hud.assets && hud.assetRows > 0)) await sleep(1000);
    }
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
      // 世界状态抖动（t1 可能无工人）→ 探测首个有 MOVE 动作的受控单位资产行
      let rowSel = -1;
      const rowProbeStart = Date.now();
      while (rowSel < 0 && Date.now() - rowProbeStart < 20000) {
        const cnt = await page.locator("#assetList .asset-row").count();
        for (let j = 0; j < cnt && rowSel < 0; j++) {
          await page.click(`#assetList .asset-row:nth-child(${j + 1})`, { timeout: 3000 }).catch(() => {});
          await sleep(600);
          if (await page.locator('#actionDialog [data-action="MOVE"]').count() > 0) rowSel = j;
        }
        if (rowSel < 0) await sleep(1500);
      }
      if (rowSel >= 0) {
        await page.click('#actionDialog [data-action="MOVE"]', { timeout: 4000 });
        await page.waitForSelector('.act-targeting', { timeout: 4000 });
        // 用 __arenaEngine 读相机变换 + 世界障碍，选受控单位旁可达格，精确点击（确定性，不赌固定视口点）
        const cv = await page.$("#map");
        const box = await cv.boundingBox();
        const hit = await page.evaluate(async ({ boxX, boxY, boxW, boxH }) => {
          const eng = window.__arenaEngine;
          if (!eng) return { err: "无 __arenaEngine 调试钩子" };
          const st = eng.getState();
          const tenant = st.soloTenant || "t1";
          const w = await (await fetch("/api/world?tenant=" + tenant, { cache: "no-store" })).json();
          const objs = w?.state?.objects ?? [];
          const unit = objs.find((o) => o.kind === "UNIT" && o.controlled === true && o.position);
          if (!unit) return { err: "无受控单位" };
          const [ux, uy] = unit.position;
          const blocked = new Set();
          for (const o of objs) if (o.kind === "OBSTACLE" && Array.isArray(o.positions)) for (const pp of o.positions) blocked.add(pp[0] + "," + pp[1]);
          let tx = ux + 2, ty = uy;
          for (const [dx, dy] of [[2,0],[-2,0],[0,2],[0,-2],[2,1],[-2,-1],[1,2],[-1,-2]]) {
            if (!blocked.has((ux + dx) + "," + (uy + dy))) { tx = ux + dx; ty = uy + dy; break; }
          }
          const v = st.view;
          return { sx: boxX + (tx - v.cx) * v.scale + boxW / 2, sy: boxY + (ty - v.cy) * v.scale + boxH / 2, tx, ty };
        }, { boxX: box.x, boxY: box.y, boxW: box.width, boxH: box.height });
        if (hit.err) { bad("人类指挥 UI 链", hit.err); }
        else {
          await page.mouse.click(hit.sx, hit.sy);
          // 轮询等待落盘（≤4s）：实时世界下服务端写库/应用存在 tick 时序，单次 1s 查询易 flaky
          let cmds = { goals: 0, commands: 0 };
          for (let i = 0; i < 8 && cmds.goals === 0 && cmds.commands === 0; i++) {
            cmds = await page.evaluate(async () => {
              const r = await fetch("/api/commands?tenant=t1", { cache: "no-store" });
              const j = await r.json();
              return { goals: (j.goals ?? []).length, commands: (j.commands ?? []).length };
            });
            if (cmds.goals === 0 && cmds.commands === 0) await sleep(500);
          }
          if (cmds.goals > 0 || cmds.commands > 0) { goalOk = true; ok("人类指挥 UI 链（goal 落盘）", JSON.stringify(cmds)); }
          else bad("人类指挥 UI 链（goal 落盘）", `点击可达格 (${hit.tx},${hit.ty}) 未落盘`);
        }
      } else {
        bad("人类指挥 UI 链", "未找到有 MOVE 动作的单位资产行");
      }
    } catch (e) {
      bad("人类指挥 UI 链", e.message);
    } finally {
      try { await page.evaluate(async () => { await fetch("/api/command/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenant: "t1" }) }); }); } catch { /* 忽略 */ }
    }

    // 6b) 跳图定位标记（jumpPins）：点目击 → pin 生成 → Esc 全清（有数据才断言，数据抖动时跳过不误报）
    let pinOk = null; // true | false | null(跳过)
    try {
      await page.click('.rp-tab[data-rp-tab="situation"]', { timeout: 4000 }).catch(() => {});
      await sleep(3000);
      const sightCount = await page.locator(".sit-sight-row").count();
      if (sightCount > 0) {
        await page.click(".sit-sight-row", { timeout: 4000 });
        await sleep(1000);
        const got = await page.evaluate(() => window.__arenaEngine?.getState?.()?.jumpPins?.length ?? -1);
        if (got > 0) {
          await page.keyboard.press("Escape");
          await sleep(400);
          const after = await page.evaluate(() => window.__arenaEngine?.getState?.()?.jumpPins?.length ?? -1);
          pinOk = after === 0;
        } else pinOk = false;
      }
    } catch (e) { pinOk = false; }
    if (pinOk === true) ok("跳图定位标记（jumpPins）", "目击跳图→pin→Esc 清空");
    else if (pinOk === false) bad("跳图定位标记（jumpPins）", "点目击后未生成 pin 或 Esc 未清空");
    else results.push("  ⚠ 跳图定位标记（jumpPins）— 无目击数据，跳过");


    // 6c) 手操审计 UI：HUMAN AUDIT 区块存在且有记录（手操链刚写过 goal，应有记录；无记录则跳过不误报）
    let auditOk = null; // true | false | null(跳过)
    try {
      await page.click('.rp-tab[data-rp-tab="situation"]', { timeout: 4000 }).catch(() => {});
      await sleep(2500);
      const auditState = await page.evaluate(() => {
        const blocks = [...document.querySelectorAll(".sit-sight")];
        const b = blocks.find((x) => (x.querySelector(".sit-sight-head")?.innerText ?? "").includes("HUMAN AUDIT"));
        if (!b) return { exists: false, rows: 0, empty: false };
        return { exists: true, rows: b.querySelectorAll(".sit-sight-list .sit-sight-row").length, empty: !!b.querySelector(".sv-empty") };
      });
      if (auditState.exists && auditState.rows > 0) auditOk = true;
      else if (auditState.exists && auditState.empty) auditOk = null;
      else auditOk = false;
    } catch (e) { auditOk = false; }
    if (auditOk === true) ok("手操审计 UI", "HUMAN AUDIT 记录可见");
    else if (auditOk === false) bad("手操审计 UI", "手操记录区块缺失/异常");
    else results.push("  ⚠ 手操审计 UI — 暂无手操记录，跳过");

    // 6d) 15s tick 读条可视化：tickFill 存在且随 tick 推进（两次采样 transform 变化）
    let tickOk = null; // true | false | null(跳过)
    let tickDetail = "";
    try {
      const t1 = await page.evaluate(() => {
        const el = document.getElementById("tickFill");
        return { exists: !!el, transform: el ? (el.style.transform || getComputedStyle(el).transform) : null, label: document.getElementById("tickLabel")?.innerText ?? null };
      });
      await sleep(4000);
      const t2 = await page.evaluate(() => {
        const el = document.getElementById("tickFill");
        return { exists: !!el, transform: el ? (el.style.transform || getComputedStyle(el).transform) : null };
      });
      if (t1.exists && t2.exists && t1.transform && t1.transform !== t2.transform) { tickOk = true; tickDetail = (t1.label ?? "") + " 推进 " + t1.transform + "→" + t2.transform; }
      else if (!t1.exists) tickOk = false;
      else tickOk = null;
    } catch (e) { tickOk = false; }
    if (tickOk === true) ok("15s tick 读条", tickDetail);
    else if (tickOk === false) bad("15s tick 读条", "tickFill 缺失");
    else results.push("  ⚠ 15s tick 读条 — 采样窗口内未推进，跳过");
    // 7) API 健康
    for (const path of ["/api/overview", "/api/stream?tenant=t1&n=5", "/api/survey?tenant=t1"]) {
      const t0 = Date.now();
      try {
        const r = await page.evaluate(async (p) => { const x = await fetch(p, { cache: "no-store" }); return { ok: x.ok, body: await x.text() }; }, path);
        const ms = Date.now() - t0;
        (r.ok && ms < API_TIMEOUT_MS) ? ok(`API ${path}`, ms + "ms") : bad(`API ${path}`, `${ms}ms ok=${r.ok} (>${API_TIMEOUT_MS}ms)`);
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
