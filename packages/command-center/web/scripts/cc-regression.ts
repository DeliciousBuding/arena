// @ts-nocheck — Playwright e2e 黑盒回归脚本（2026-08-08 迁移自 .mjs）：断言以运行时 DOM/API 校验为主，
// 类型由 Playwright 运行时保证；生产代码类型检查见 src/lib。
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
 *   2. 右栏三 tab（决策流/威胁情报/兑换码）渲染；威胁情报 = 情报中心（态势/排行/信标/核心）
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

/** 轮询等待 toast 文本包含 needle（服务重启/慢 world 拉取时点击处理可能 >350ms 才出 toast）。
 *  返回最后一次读到的 toast 文本（超时返回最近一次，调用方用 includes 判定）。 */
async function waitToast(page, needle, timeoutMs = 3000) {
  let last = "";
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    last = await page.evaluate(() => {
      const el = document.getElementById("uiToast");
      if (!el) return "";
      return (el.className || "").includes("show") ? el.textContent || "" : "";
    });
    if (last.includes(needle)) return last;
    await sleep(150);
  }
  return last;
}

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
  // 全局硬超时（240s）：服务重启/并行高负载时不无限卡，强制打印部分结果退出
  const hardTimer = setTimeout(() => {
    console.log("\n== 指挥面板回归（超时中止）==");
    console.log(results.join("\n"));
    console.log(`\n通过 ${pass} / ${pass + fail}（超时中止）`);
    process.exit(2);
  }, 300000);
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

  /** 等待相机动画稳定（F 适应/跳图后 view 仍在动画中，坐标会脱靶——轮询两次采样一致再继续） */
  const waitViewStable = async () => {
    let prev = null;
    for (let i = 0; i < 12; i++) {
      const v = await page.evaluate(() => {
        const g = window.__arenaEngine && window.__arenaEngine.getState ? window.__arenaEngine.getState() : null;
        return g && g.view ? { cx: g.view.cx, cy: g.view.cy, scale: g.view.scale } : null;
      });
      if (v && prev && prev.cx === v.cx && prev.cy === v.cy && prev.scale === v.scale) return true;
      prev = v;
      await sleep(400);
    }
    return false;
  };

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

    // 2) 右栏三 tab（参谋建议/测绘/联盟态势已并入威胁情报，2026-08-10）
    const tabs = await page.$eval(".rp-tab", (els) => els.map((e) => e.getAttribute("data-rp-tab")));
    const want = ["logs", "intel", "redeem"];
    JSON.stringify(tabs) === JSON.stringify(want) ? ok("右栏三 tab", tabs.join(",")) : bad("右栏三 tab", "got " + tabs.join(","));

    // 2b) 全局威胁玫瑰数据管道：/api/alliance/snapshot 被页面拉取（威胁扇区玫瑰数据源）
    // 首次拉取可能恰逢服务重启/慢请求 → 轮询等待（最多 12s），而非单点检查
    let snapReq = false;
    for (let i = 0; i < 12 && !snapReq; i++) {
      snapReq = await page.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.includes("/api/alliance/snapshot")));
      if (!snapReq) await sleep(1000);
    }
    snapReq ? ok("全局威胁玫瑰数据管道", "snapshot 已拉取") : bad("全局威胁玫瑰数据管道", "12s 内未发现 snapshot 请求");

    // 3) 决策流有数据；情报中心（态势）与兑换码渲染非空
    for (const tab of ["logs", "intel", "redeem"]) {
      await page.click(`.rp-tab[data-rp-tab="${tab}"]`, { timeout: 4000 }).catch(() => {});
      await sleep(tab === "intel" ? 4000 : 1000);
      const txt = await page.evaluate(() => (document.querySelector(".rp .rp-body")?.innerText ?? "").slice(0, 120));
      if (tab === "logs") {
        /条/.test(txt) ? ok("决策流有数据", txt.slice(0, 40)) : bad("决策流有数据", txt.slice(0, 40));
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
          await sleep(800);
          if (await page.locator('#actionDialog [data-action="MOVE"]').count() > 0) rowSel = j;
        }
        if (rowSel < 0) await sleep(1500);
      }
      if (rowSel >= 0) {
        await page.click('#actionDialog [data-action="MOVE"]', { timeout: 4000 });
        // MOVE 模式以引擎 state.mode 为准（.act-targeting 是视觉元素，面板重渲染/动画下可能延迟出现）
        let modeOk = false;
        for (let mp = 0; mp < 20 && !modeOk; mp++) {
          modeOk = await page.evaluate(() => { const g = (window as any).__arenaEngine?.getState?.(); return g && g.mode === "MOVE"; }).catch(() => false);
          if (!modeOk) await sleep(200);
        }
        if (!modeOk) {
          const gm = await page.evaluate(() => { const g = (window as any).__arenaEngine?.getState?.(); return g ? g.mode : "no-engine"; }).catch(() => "eval-err");
          throw new Error("MOVE 模式未激活 mode=" + gm);
        }
        // 用 __arenaEngine 读相机变换 + 世界障碍，选受控单位旁可达格，精确点击（确定性，不赌固定视口点）
        const cv = await page.$("#map");
        const box = await cv.boundingBox();
        const hit = await page.evaluate(async ({ boxX, boxY, boxW, boxH }) => {
          const eng = window.__arenaEngine;
          if (!eng) return { err: "无 __arenaEngine 调试钩子" };
          const st = eng.getState();
          const tenant = st.soloTenant || "t1";
          const v = st.view;
          const onScreen = (wx: number, wy: number, m = 8) => {
            const sx = boxX + (wx - v.cx) * v.scale + boxW / 2, sy = boxY + (wy - v.cy) * v.scale + boxH / 2;
            return sx >= boxX - m && sx <= boxX + boxW + m && sy >= boxY - m && sy <= boxY + boxH + m;
          };
          const dpOf = (c: any) => (window as any).__arena && (window as any).__arena.unitDrawPos ? (window as any).__arena.unitDrawPos(c) : { x: c.x, y: c.y };
          const uc = (st.cells ?? []).filter((c) => c.type === "unit" && c.controlled === true && (!st.soloTenant || c.tenant === tenant));
          let bx = 0, by = 0, haveDraw = false;
          for (const u of uc) { const dp = dpOf(u); if (onScreen(dp.x, dp.y)) { bx = dp.x; by = dp.y; haveDraw = true; break; } }
          let w = null;
          for (let r = 0; r < 5 && !w; r++) { try { w = await (await fetch("/api/world?tenant=" + tenant, { cache: "no-store" })).json(); } catch { await new Promise((s) => setTimeout(s, 800)); } }
          if (!w || !w.state) return { err: "world fetch failed (service restart?)" };
          const objs = w?.state?.objects ?? [];
          if (!haveDraw) {
            const unit = objs.find((o) => o.kind === "UNIT" && o.controlled === true && o.position && onScreen(o.position[0], o.position[1]));
            if (!unit) return { err: "无受控单位在屏内" };
            bx = unit.position[0]; by = unit.position[1];
          }
          const blocked = new Set();
          for (const o of objs) if (o.kind === "OBSTACLE" && Array.isArray(o.positions)) for (const pp of o.positions) blocked.add(pp[0] + "," + pp[1]);
          for (const c of (st.cells ?? [])) if (c.type === "obstacle") blocked.add(c.x + "," + c.y);
          const atMap = (sx: number, sy: number) => {
            const el = document.elementFromPoint(sx, sy);
            if (!el) return false;
            return el.id === "map" || !!el.closest("#map") || (el as HTMLElement).tagName === "CANVAS";
          };
          const offsets = [[2,0],[-2,0],[0,2],[0,-2],[1,0],[-1,0],[0,1],[0,-1],[2,1],[-2,-1],[1,2],[-1,-2],[3,0],[-3,0],[0,3],[0,-3]];
          let pick: { tx: number; ty: number; sx: number; sy: number } | null = null;
          for (const [dx, dy] of offsets) {
            const nx = bx + dx, ny = by + dy;
            if (blocked.has(nx + "," + ny)) continue;
            const sx = boxX + (nx - v.cx) * v.scale + boxW / 2, sy = boxY + (ny - v.cy) * v.scale + boxH / 2;
            if (!(sx >= boxX && sx <= boxX + boxW && sy >= boxY && sy <= boxY + boxH)) continue;
            if (!atMap(sx, sy)) continue;
            pick = { tx: nx, ty: ny, sx, sy }; break;
          }
          if (!pick) {
            const sx = boxX + (bx + 2 - v.cx) * v.scale + boxW / 2, sy = boxY + (by - v.cy) * v.scale + boxH / 2;
            const el = document.elementFromPoint(sx, sy);
            return { err: "无可用画布点击点", el: el ? (el.id || el.tagName + "." + (typeof (el as any).className === "string" ? (el as any).className.slice(0, 40) : "")) : "null", sx, sy };
          }
          return { sx: pick.sx, sy: pick.sy, tx: pick.tx, ty: pick.ty, onscreen: true };
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

    // 6e) 右键指挥菜单：左键选中受控单位 → 右键 → ctx-menu 打开（有命令项）→ Esc 关闭
    let ctxOk = null; // true | false
    try {
      // 相机可能被 6b 跳图移走（如跳到 T4 区域）→ 按 F 适应回聚焦租户视口，坐标才不脱靶
      await page.keyboard.press("f");
      await waitViewStable();
      const cvE = await page.$("#map");
      const boxE = await cvE.boundingBox();
      const tgt = await page.evaluate(async ({ boxX, boxY, boxW, boxH }) => {
        const eng = window.__arenaEngine;
        if (!eng) return { err: "no engine" };
        const st = eng.getState();
        const tenant = st.soloTenant || "t1";
        // 所见即所点：优先画布插值绘制位（引擎按 id 实时命中，抗 tick 漂移）；
        // 与 6f 同源修复——/api/world 实时位与画布位 mid-tick 差数格，右键会脱靶
        const v = st.view;
        const onScreen = (wx: number, wy: number, m = 8) => {
          const sx = boxX + (wx - v.cx) * v.scale + boxW / 2, sy = boxY + (wy - v.cy) * v.scale + boxH / 2;
          return sx >= boxX - m && sx <= boxX + boxW + m && sy >= boxY - m && sy <= boxY + boxH + m;
        };
        const dpOf = (c: any) => (window as any).__arena && (window as any).__arena.unitDrawPos ? (window as any).__arena.unitDrawPos(c) : { x: c.x, y: c.y };
        const uc = (st.cells ?? []).filter((c) => (c.type === "unit" || c.type === "core") && c.controlled === true && (!st.soloTenant || c.tenant === tenant));
        let bx = 0, by = 0, haveDraw = false;
        for (const u of uc) { const dp = dpOf(u); if (onScreen(dp.x, dp.y)) { bx = dp.x; by = dp.y; haveDraw = true; break; } }
        let w = null;
        for (let r = 0; r < 5 && !w; r++) { try { w = await (await fetch("/api/world?tenant=" + tenant, { cache: "no-store" })).json(); } catch { await new Promise((s) => setTimeout(s, 800)); } }
        if (!w || !w.state) return { err: "world fetch failed (service restart?)" };
        const objs = w?.state?.objects ?? [];
        if (!haveDraw) {
          const unit = objs.find((o) => (o.kind === "UNIT" || o.kind === "CORE") && o.controlled === true && o.position && onScreen(o.position[0], o.position[1]));
          if (!unit) return { err: "no controlled obj in view" };
          bx = unit.position[0]; by = unit.position[1];
        }
        return { sx: boxX + (bx - v.cx) * v.scale + boxW / 2, sy: boxY + (by - v.cy) * v.scale + boxH / 2 };
      }, { boxX: boxE.x, boxY: boxE.y, boxW: boxE.width, boxH: boxE.height });
      if (tgt.err) { ctxOk = false; }
      else {
        await page.mouse.click(tgt.sx, tgt.sy);
        await sleep(700);
        await page.mouse.click(tgt.sx, tgt.sy, { button: "right" });
        let m1 = null;
        for (let p = 0; p < 10 && !m1; p++) {
          m1 = await page.evaluate(() => {
            const el = document.querySelector(".ctx-menu");
            if (!el || el.hidden) return null;
            const items = document.querySelectorAll(".ctx-item").length;
            return items > 0 ? { hidden: false, items } : null;
          });
          if (!m1) await sleep(200);
        }
        m1 = m1 || { hidden: true, items: 0 };
        if (m1.hidden === false && m1.items > 0) {
          await page.keyboard.press("Escape");
          await sleep(400);
          const m2 = await page.evaluate(() => { const el = document.querySelector(".ctx-menu"); return el ? el.hidden : "no-el"; });
          ctxOk = m2 === true;
        } else ctxOk = false;
      }
    } catch (e) { ctxOk = false; }
    if (ctxOk === true) ok("右键指挥菜单", "选中→右键打开→Esc 关闭");
    else if (ctxOk === false) bad("右键指挥菜单", "菜单未打开或 Esc 未关闭");

    // 6f) 编队多选：Shift 点击两个不同受控单位 → toast 计数（编队 +1 共 N）→ Esc 清理
    //     目标取自引擎已渲染的 st.cells（与画布同源，位置即所见）——避免 /api/world 快照与
    //     画布插值位置错位导致点击落空（高负载下偶发 flake，2026-08-08 实证）。
    //     封装重试 2 次 + 两次点击间 150ms 间隔。
    const multiSelectOnce = async () => {
      await page.keyboard.press("Escape").catch(() => {}); // 清 6e 遗留动作框/选中
      await sleep(250);
      await page.keyboard.press("f");
      await waitViewStable();
      const cvF = await page.$("#map");
      const boxF = await cvF.boundingBox();
      // 候选：引擎已渲染格（与画布同源）同租户受控单位——只取 id，点击前再按 live world
      // 解析当前位置（App 侧 resolveLiveTarget 半径 3 实时命中；测试点 live 坐标避免
      // "点旧渲染位→命中资源格"脱靶——2026-08-08 诊断实证 hit=resource）。
      const cands = await page.evaluate(({ boxX, boxY, boxW, boxH }) => {
        const eng = window.__arenaEngine;
        if (!eng) return { err: "no engine" };
        const st = eng.getState();
        const solo = st.soloTenant || null;
        const inTenant = (o) => !solo || o.tenant === solo;
        let us = (st.cells ?? []).filter((o) => inTenant(o) && o.type === "unit" && o.unitType === "VANGUARD" && o.controlled === true);
        if (us.length < 2) us = (st.cells ?? []).filter((o) => inTenant(o) && o.type === "unit" && o.controlled === true);
        if (us.length < 2) { const cnt: Record<string, number> = {}; for (const c of (st.cells ?? [])) cnt[c.type] = (cnt[c.type] || 0) + 1; return { err: "units<2: " + us.length + " cells=" + (st.cells || []).length + " types=" + JSON.stringify(cnt) + " solo=" + st.soloTenant }; }
        const v = st.view;
        const onScreen = (u) => { const sx = boxX + (u.x - v.cx) * v.scale + boxW / 2, sy = boxY + (u.y - v.cy) * v.scale + boxH / 2; return sx >= boxX - 4 && sx <= boxX + boxW + 4 && sy >= boxY - 4 && sy <= boxY + boxH + 4; };
        const cands = us.filter(onScreen);
        if (cands.length < 2) return { err: "onscreen<2: " + cands.length + "/" + us.length + " solo=" + solo };
        const a = cands[0], b = cands.find((u) => u.id !== a.id && (u.x !== a.x || u.y !== a.y)) ?? cands[1];
        return { a: { id: a.id, tenant: a.tenant }, b: { id: b.id, tenant: b.tenant } };
      }, { boxX: boxF.x, boxY: boxF.y, boxW: boxF.width, boxH: boxF.height });
      if (cands.err) return { ok: false, why: cands.err };
      const livePt = async (id: string, tenant: string) => {
        return page.evaluate(async ({ id, tenant, boxX, boxY, boxW, boxH }) => {
          const eng = window.__arenaEngine;
          const st = eng ? eng.getState() : null;
          if (!st) return { err: "no engine" };
          let w = null;
          for (let r = 0; r < 5 && !w; r++) { try { w = await (await fetch("/api/world?tenant=" + tenant, { cache: "no-store" })).json(); } catch { await new Promise((s) => setTimeout(s, 800)); } }
          const o = (w?.state?.objects ?? []).find((x) => x.id === id && Array.isArray(x.position));
          if (!o) return { err: "unit-gone:" + String(id).slice(0, 6) };
          const v = st.view;
          return { sx: boxX + (o.position[0] - v.cx) * v.scale + boxW / 2, sy: boxY + (o.position[1] - v.cy) * v.scale + boxH / 2, pos: o.position };
        }, { id, tenant, boxX: boxF.x, boxY: boxF.y, boxW: boxF.width, boxH: boxF.height });
      };
      const clickShift = async (target: { id: string; tenant: string }, needle: string) => {
        // 所见即所点：优先点画布上的插值绘制位（引擎按 id 实时命中，抗 /api/world 与画布漂移），
        // 绘制位已不在 cells（换 tick/销毁）时回退 live 世界位。
        let pt = await page.evaluate(({ id, tenant, boxX, boxY, boxW, boxH }) => {
          const eng = window.__arenaEngine;
          const st = eng ? eng.getState() : null;
          if (!st) return { err: "no engine" };
          const cell = (st.cells ?? []).find((c) => (c.type === "unit" || c.type === "core") && String(c.id) === String(id) && (!st.soloTenant || c.tenant === tenant));
          if (!cell) return { err: "cell-gone:" + String(id).slice(0, 6) };
          const dp = (window as any).__arena && (window as any).__arena.unitDrawPos ? (window as any).__arena.unitDrawPos(cell) : { x: cell.x, y: cell.y };
          const v = st.view;
          return { sx: boxX + (dp.x - v.cx) * v.scale + boxW / 2, sy: boxY + (dp.y - v.cy) * v.scale + boxH / 2, pos: [dp.x, dp.y] };
        }, { id: target.id, tenant: target.tenant, boxX: boxF.x, boxY: boxF.y, boxW: boxF.width, boxH: boxF.height });
        if (pt.err) pt = await livePt(target.id, target.tenant);
        if (pt.err) return { ok: false, why: pt.err, t: "" };
        // 绘制位被面板/按钮遮挡（6e 遗留动作框实证）：Esc 后重算一次，仍挡则报错诊断
        const blocked = await page.evaluate(({ sx, sy }) => { const el = document.elementFromPoint(sx, sy); return el ? (el.id === "map" || !!el.closest("#map") || el.tagName === "CANVAS") : false; }, { sx: pt.sx, sy: pt.sy }).catch(() => true);
        if (!blocked) {
          await page.keyboard.press("Escape").catch(() => {});
          await sleep(250);
          const pt2 = await page.evaluate(({ id, tenant, boxX, boxY, boxW, boxH }) => {
            const eng = window.__arenaEngine; const st = eng ? eng.getState() : null;
            if (!st) return { err: "no engine" };
            const cell = (st.cells ?? []).find((c) => (c.type === "unit" || c.type === "core") && String(c.id) === String(id) && (!st.soloTenant || c.tenant === tenant));
            if (!cell) return { err: "cell-gone:" + String(id).slice(0, 6) };
            const dp = (window as any).__arena && (window as any).__arena.unitDrawPos ? (window as any).__arena.unitDrawPos(cell) : { x: cell.x, y: cell.y };
            const v = st.view;
            return { sx: boxX + (dp.x - v.cx) * v.scale + boxW / 2, sy: boxY + (dp.y - v.cy) * v.scale + boxH / 2, pos: [dp.x, dp.y] };
          }, { id: target.id, tenant: target.tenant, boxX: boxF.x, boxY: boxF.y, boxW: boxF.width, boxH: boxF.height });
          if (!pt2.err) { pt = pt2; }
        }

        await page.keyboard.down("Shift");
        await page.mouse.click(pt.sx, pt.sy);
        const t = await waitToast(page, needle, 6000);
        await page.keyboard.up("Shift");
        return { ok: t.includes(needle), why: "toast=" + JSON.stringify(t), t };
      };
      const r1 = await clickShift(cands.a, "编队 +1");
      if (!r1.ok) return { ok: false, why: "a " + (r1.why ?? ""), t1: r1.t, t2: "" };
      await sleep(150);
      const r2 = await clickShift(cands.b, "共 2");
      if (!r2.ok) return { ok: false, why: "b " + (r2.why ?? ""), t1: r1.t, t2: r2.t };
      return { ok: true, t1: r1.t, t2: r2.t };
    };
    let multiOk = null;
    for (let attempt = 0; attempt < 2 && multiOk === null; attempt++) {
      const r = await multiSelectOnce().catch((e) => ({ ok: false, why: e.message }));
      if (r.ok) multiOk = true;
      else {
        console.log(`  ↻ 编队多选重试 ${attempt + 1}/2：${r.why ?? "t1=\"" + (r.t1 ?? "") + "\" t2=\"" + (r.t2 ?? "") + "\"" + (r.diag ? " diag=" + JSON.stringify(r.diag) : "")}`);
        if (attempt === 0) { await page.keyboard.up("Shift").catch(() => {}); await sleep(800); }
        else multiOk = false;
      }
    }
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(300);
    if (multiOk === true) ok("编队多选（Shift 加选）", "两次 Shift 点击 toast 计数正确");
    else if (multiOk === false) bad("编队多选（Shift 加选）", "toast 未出现或计数错误");

    // 6g) 命令队列：选中单位 → MOVE → Shift+点击目标格 → toast「已加入队列」+ 动作面板队列段
    let queueOk = null; // true | false
    try {
      await page.keyboard.press("f");
      await waitViewStable();
      let rowSelQ = -1;
      const rowProbeStartQ = Date.now();
      while (rowSelQ < 0 && Date.now() - rowProbeStartQ < 20000) {
        const cntQ = await page.locator("#assetList .asset-row").count();
        for (let j = 0; j < cntQ && rowSelQ < 0; j++) {
          await page.click(`#assetList .asset-row:nth-child(${j + 1})`, { timeout: 3000 }).catch(() => {});
          // 点击后轮询 MOVE 按钮出现（≤2s）——动作框渲染高负载下可能 >800ms
          for (let mp = 0; mp < 10 && rowSelQ < 0; mp++) {
            if (await page.locator('#actionDialog [data-action="MOVE"]').count() > 0) rowSelQ = j;
            else await sleep(200);
          }
        }
        if (rowSelQ < 0) await sleep(1200);
      }
      if (rowSelQ >= 0) {
        await page.click('#actionDialog [data-action="MOVE"]', { timeout: 4000 });
        await page.waitForSelector('.act-targeting', { timeout: 4000 }).catch(() => {});
        await sleep(300);
        const cvG = await page.$("#map");
        const boxG = await cvG.boundingBox();
        const hitG = await page.evaluate(async ({ boxX, boxY, boxW, boxH }) => {
          const eng = window.__arenaEngine;
          if (!eng) return { err: "no engine" };
          const st = eng.getState();
          const tenant = st.soloTenant || "t1";
          // 优先取画布插值绘制位（所见即所点），引擎 cells 无单位时回退 live world。
          const v = st.view;
          const onScreen = (wx: number, wy: number, m = 8) => {
            const sx = boxX + (wx - v.cx) * v.scale + boxW / 2, sy = boxY + (wy - v.cy) * v.scale + boxH / 2;
            return sx >= boxX - m && sx <= boxX + boxW + m && sy >= boxY - m && sy <= boxY + boxH + m;
          };
          const dpOf = (c: any) => (window as any).__arena && (window as any).__arena.unitDrawPos ? (window as any).__arena.unitDrawPos(c) : { x: c.x, y: c.y };
          const uc = (st.cells ?? []).filter((c) => c.type === "unit" && c.controlled === true && (!st.soloTenant || c.tenant === tenant));
          let bx = 0, by = 0, haveDraw = false;
          for (const u of uc) { const dp = dpOf(u); if (onScreen(dp.x, dp.y)) { bx = dp.x; by = dp.y; haveDraw = true; break; } }
          let w = null;
          for (let r = 0; r < 5 && !w; r++) { try { w = await (await fetch("/api/world?tenant=" + tenant, { cache: "no-store" })).json(); } catch { await new Promise((s) => setTimeout(s, 800)); } }
          if (!w || !w.state) return { err: "world fetch failed (service restart?)" };
          const objs = w?.state?.objects ?? [];
          if (!haveDraw) {
            const unit = objs.find((o) => o.kind === "UNIT" && o.controlled === true && o.position && onScreen(o.position[0], o.position[1]));
            if (!unit) return { err: "无受控单位在屏内" };
            bx = unit.position[0]; by = unit.position[1];
          }
          const blocked = new Set();
          for (const o of objs) if (o.kind === "OBSTACLE" && Array.isArray(o.positions)) for (const pp of o.positions) blocked.add(pp[0] + "," + pp[1]);
          for (const c of (st.cells ?? [])) if (c.type === "obstacle") blocked.add(c.x + "," + c.y);
          const atMap = (sx: number, sy: number) => {
            const el = document.elementFromPoint(sx, sy);
            if (!el) return false;
            return el.id === "map" || !!el.closest("#map") || (el as HTMLElement).tagName === "CANVAS";
          };
          const offsets = [[2,0],[-2,0],[0,2],[0,-2],[1,0],[-1,0],[0,1],[0,-1],[2,1],[-2,-1],[1,2],[-1,-2],[3,0],[-3,0],[0,3],[0,-3]];
          let pick: { tx: number; ty: number; sx: number; sy: number } | null = null;
          for (const [dx, dy] of offsets) {
            const nx = bx + dx, ny = by + dy;
            if (blocked.has(nx + "," + ny)) continue;
            const sx = boxX + (nx - v.cx) * v.scale + boxW / 2, sy = boxY + (ny - v.cy) * v.scale + boxH / 2;
            if (!(sx >= boxX && sx <= boxX + boxW && sy >= boxY && sy <= boxY + boxH)) continue;
            if (!atMap(sx, sy)) continue;
            pick = { tx: nx, ty: ny, sx, sy }; break;
          }
          if (!pick) {
            const sx = boxX + (bx + 2 - v.cx) * v.scale + boxW / 2, sy = boxY + (by - v.cy) * v.scale + boxH / 2;
            const el = document.elementFromPoint(sx, sy);
            return { err: "无可用画布点击点", el: el ? (el.id || el.tagName + "." + (typeof (el as any).className === "string" ? (el as any).className.slice(0, 40) : "")) : "null", sx, sy };
          }
          return { sx: pick.sx, sy: pick.sy, tx: pick.tx, ty: pick.ty, onscreen: true };
        }, { boxX: boxG.x, boxY: boxG.y, boxW: boxG.width, boxH: boxG.height });
        if (hitG.err) { queueOk = false; }
        else {
          await page.keyboard.down("Shift");
          await page.mouse.click(hitG.sx, hitG.sy);
          await page.keyboard.up("Shift");
          // 队列落盘/面板出现可能受服务重启窗口影响：轮询最多 4s
          let qInfo = { toastTxt: "", qTitle: "", qSegs: 0 };
          for (let p = 0; p < 12; p++) {
            qInfo = await page.evaluate(() => {
              const el = document.getElementById("uiToast");
              const toastTxt = el && (el.className || "").includes("show") ? el.textContent || "" : "";
              const qTitle = document.querySelector(".act-queue .q-title")?.textContent || "";
              return { toastTxt, qTitle, qSegs: document.querySelectorAll(".act-queue .q-seg").length };
            });
            if (qInfo.toastTxt.includes("已加入队列") || (qInfo.qTitle.includes("命令队列") && qInfo.qSegs > 0)) break;
            await sleep(200);
          }
          queueOk = qInfo.toastTxt.includes("已加入队列") || (qInfo.qTitle.includes("命令队列") && qInfo.qSegs > 0);
        }
      } else { queueOk = false; }
      await page.evaluate(async () => { await fetch("/api/command/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenant: "t1" }) }); }).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(300);
    } catch (e) { queueOk = false; }
    if (queueOk === true) ok("命令队列（Shift 入队）", "MOVE 模式 Shift 点击入队成功");
    else if (queueOk === false) bad("命令队列（Shift 入队）", "队列未创建");
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
  clearTimeout(hardTimer);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

