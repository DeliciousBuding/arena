/**
 * Arena 本地指挥面板服务入口（2026-08-08 模块化重构：Hono 路由 + 静态 +
 * 组装，领域逻辑在 lib/ 各模块；TypeScript，Node 24 type stripping 直接执行）。
 *
 * 只读：不写 data/runtime、不连接 Arena、不启动任何 writer（人类指挥写
 * data/runtime/human-commands 除外，见 lib/store.ts）。数据源：
 *  - ARENA_DATA_ROOT（缺省 = 仓库同级 data/）下 runtime/{t1..t4}/calibration
 *    最新 run 的 calibration case + telemetry JSONL；
 *  - supervisor Debug API（127.0.0.1:8120 /ready，探测在线状态）；
 *  - 官方商店代理（linuxdoshop.arenahero.io，需登录 Cookie）。
 */
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { existsSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_ROOT, TENANTS } from "./lib/fs-jsonl.ts";
import { supervisorState } from "./lib/supervisor.ts";
import { loadMergedMap } from "./lib/map.ts";
import { loadOverview, loadStream, loadReplay, loadPlan, loadWorld, loadEvents } from "./lib/streams.ts";
import { loadSurveyDb, loadLifecycleDb, loadSurvey, loadResourceTimeline, loadSpendTrend, loadUnitLifecycleDb, loadChunksDb } from "./lib/survey.ts";
import { loadTenantSurveyCached, startSurveyCacheLoop } from "./lib/survey-cache.ts";
import { loadDeeds, startDeedsCacheLoop } from "./lib/deeds.ts";
import { loadAllianceSurvey, refreshAllianceSurvey, TENANT_COLORS } from "./lib/alliance-survey.ts";
import { loadAllianceIntel, buildEncounteredIndex } from "./lib/intel.ts";
import { loadLeaderboardIntel, loadOurUsernames } from "./lib/leaderboard.ts";
import { readHumanStore, writeHumanStore, reconcileHumanStore, latestHumanOverride, stuckRecord, type HumanCommand, type HumanGoal } from "./lib/store.ts";
import { shopProducts, shopCookie, shopMe, shopOrders, shopOrder } from "./lib/shop.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
const WEB_DIR = join(HERE, "web", "dist"); // React 构建产物（vite build --base=/app/）
const PORT = Number(process.env.COMMAND_CENTER_PORT ?? 8787);

const redeemLog: Array<{ code: string; at: string; ip: string }> = []; // 兑换申请内存记录（重启即清空）

const app = new Hono();

// ---------- 只读 API ----------
app.get("/api/tenants", async (c) => {
  const sup = await supervisorState();
  const tenants = TENANTS.map((t) => {
    const s = sup?.tenants?.find((x) => x.tenantId === t) ?? null;
    return { tenant: t, live: s ? s.ready === true && s.alive === true : false, supervisor: s };
  });
  // 租户区分色（2026-08-08）：前端左栏四租户卡片/地图/树目录共用，无需硬编码。
  return c.json({ generatedAt: new Date().toISOString(), tenants, colors: TENANT_COLORS });
});
app.get("/api/overview", async (c) => {
  const sup = await supervisorState();
  return c.json(loadOverview(sup));
});
app.get("/api/map", (c) => c.json(loadMergedMap()));
app.get("/api/stream", (c) => {
  const tenant = c.req.query("tenant") ?? "t1";
  const n = Number(c.req.query("n") ?? 60);
  return c.json(loadStream(tenant, Math.min(Math.max(n, 1), 200)));
});
app.get("/api/world", (c) => c.json(loadWorld(c.req.query("tenant") ?? "t1")));
app.get("/api/replay", (c) => {
  const tenant = c.req.query("tenant") ?? "t1";
  const replay = loadReplay(tenant);
  if (!replay) return c.json({ tenant, generatedAt: new Date().toISOString(), replay: null });
  return c.json({ generatedAt: new Date().toISOString(), replay });
});
app.get("/api/plan", (c) => c.json(loadPlan(c.req.query("tenant") ?? "t1")));
app.get("/api/exploration", (c) => {
  const tenant = c.req.query("tenant") ?? "t1";
  // 内存缓存优先（2026-08-08 UX 优化）：测绘/生命周期后台 30s 刷新，请求毫秒级
  const cached = loadTenantSurveyCached(tenant);
  const survey = cached.survey ?? loadSurvey(tenant); // 缓存缺失回退 calibration 扫描
  if (!survey) return c.json({ tenant, generatedAt: new Date().toISOString(), survey: null });
  const world = loadWorld(tenant) as { state?: Record<string, unknown> | null; caseFile?: string | null; tick?: number | null };
  return c.json({
    tenant,
    generatedAt: new Date().toISOString(),
    survey,
    lifecycle: cached.lifecycle,
    current: world.state ? { caseFile: world.caseFile, tick: world.tick, objects: world.state.objects, resources: world.state.resources, population: world.state.population, champion_beacon: world.state.champion_beacon } : null,
  });
});
app.get("/api/survey", (c) => {
  // 跨 run 测绘库原始数据：每租户矿（含状态/seenCount）、障碍、敌核心。
  // ?tenant=t1|all；?states=visible,stale 过滤。
  const tenant = c.req.query("tenant") ?? "all";
  const states = (c.req.query("states") ?? "visible,stale").split(",").map((s) => s.trim()).filter(Boolean);
  const tenants = tenant === "all" ? [...TENANTS] : [tenant];
  const out: Record<string, unknown> = { generatedAt: new Date().toISOString(), tenants: {}, colors: TENANT_COLORS };
  for (const t of tenants) {
    const cached = loadTenantSurveyCached(t);
    const s = cached.survey;
    if (!s) { (out.tenants as Record<string, unknown>)[t] = { error: "survey db missing" }; continue; }
    (out.tenants as Record<string, unknown>)[t] = {
      resources: s.resourceCells.filter((r) => states.includes(String(r.state))),
      obstacles: s.obstacleCells,
      coreHunts: s.coreCells,
      caseCount: s.caseCount,
      tickMax: s.tickMax,
      lifecycle: cached.lifecycle,
      spendsTrend: cached.spendsTrend,
      unitsDetail: cached.unitsDetail,
      chunks: cached.chunks,
      cachedAt: cached.cachedAt,
    };
  }
  return c.json(out);
});
app.get("/api/survey/mine", (c) => {
  // 矿格生命周期详情（2026-08-08）：当前状态 + 采集/失败时间线。
  // ?tenant=t1&cell=x,y；cell 缺省从 resources 表取最近活跃矿。
  const tenant = c.req.query("tenant") ?? "t1";
  const cellQ = c.req.query("cell") ?? "";
  const s = loadSurveyDb(tenant);
  if (!s) return c.json({ tenant, error: "survey db missing" });
  const [x, y] = cellQ.split(",").map((v) => Number(v.trim()));
  let mine = null;
  if (Number.isFinite(x) && Number.isFinite(y)) {
    mine = (s.resourceCells as Array<Record<string, unknown>>).find((r) => Number(r.x) === x && Number(r.y) === y) ?? null;
  } else {
    mine = (s.resourceCells as Array<Record<string, unknown>>).sort((a, b) => Number(b.tick ?? 0) - Number(a.tick ?? 0))[0] ?? null;
  }
  if (!mine) return c.json({ tenant, mine: null, timeline: [] });
  const cell = `${mine.x},${mine.y}`;
  return c.json({ tenant, mine, cell, timeline: loadResourceTimeline(tenant, cell) });
});

app.get("/api/deeds", (c) => {
  // 事迹/日记（2026-08-08）：跨租户叙事级事迹，?tenant=all|t1..t4&limit=60。
  // 数据源分层：★3-4 稀有事件扫描 + ★2 里程碑（survey-db）+ ★1 常规（限流）。
  // 45s 内存缓存 + 后台预热，前端轮询不实时扫库。
  const tenant = c.req.query("tenant") ?? "all";
  const n = Number(c.req.query("limit") ?? 60);
  const limit = Math.min(Math.max(Number.isFinite(n) ? n : 60, 1), 200);
  if (tenant !== "all" && !TENANTS.includes(tenant as (typeof TENANTS)[number])) {
    return c.json({ error: "非法租户" }, 400);
  }
  const deeds = loadDeeds(tenant, limit);
  return c.json({ generatedAt: new Date().toISOString(), tenant, limit, deeds });
});
app.get("/api/alliance/survey", (c) => {
  // 联盟共享测绘（2026-08-08）：四租户 survey-db 聚合（敌核/矿/障碍/探索分区
  // + 生命周期 + 租户色）——地图「全联盟」层数据源，30s 聚合缓存。
  return c.json(loadAllianceSurvey());
});

app.get("/api/events", (c) => {
  const tenant = c.req.query("tenant") ?? "t1";
  const n = Number(c.req.query("n") ?? 60);
  return c.json(loadEvents(tenant, n));
});
app.get("/api/leaderboard", (c) => {
  const intel = loadLeaderboardIntel();
  if (!intel) return c.json({ generatedAt: new Date().toISOString(), error: "排行榜快照缺失（运行 docs/progress/leaderboard-intel.py 拉取）" }, 404);
  const ours = loadOurUsernames();
  const encountered = buildEncounteredIndex();
  const profiles = (intel.profiles ?? []).map((p) => ({
    ...p,
    ours: ours.find((o) => o.username === p.username)?.tenant ?? null,
    encountered: encountered.get(p.username) ?? null,
  }));
  return c.json({
    ...intel,
    profiles,
    ours,
    encounteredCount: encountered.size,
    encountered: Object.fromEntries(encountered),
  });
});
app.get("/api/intel", (c) => c.json(loadAllianceIntel()));

// ---------- 人类指挥：指令/意图/模式（数据层，仅本机可写） ----------
const VALID_ACTION_TYPES = new Set([
  "WAIT", "MOVE", "HARVEST", "DEPOSIT", "SWEEP", "SHOOT", "PICKUP_BEACON", "DROP_BEACON",
  "SELF_DESTRUCT", "HEAL", "REPAIR_SHIELD", "SPAWN", "START_MOVE", "CANCEL_MOVE",
]);
const validTenant = (t: string | undefined): t is string => !!t && TENANTS.includes(t as (typeof TENANTS)[number]);

app.get("/api/commands", (c) => {
  const tenant = c.req.query("tenant") ?? "";
  if (!validTenant(tenant)) return c.json({ error: "非法租户" }, 400);
  const store = reconcileHumanStore(tenant);
  return c.json({ ...store, telemetry: latestHumanOverride(tenant), stuck: stuckRecord(tenant) });
});
app.post("/api/command", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const tenant = String(b.tenant ?? "");
  if (!validTenant(tenant)) return c.json({ error: "非法租户" }, 400);
  if (typeof b.unitId !== "string" || !b.unitId) return c.json({ error: "缺少 unitId" }, 400);
  if (!b.action || typeof b.action !== "object" || !VALID_ACTION_TYPES.has(String((b.action as { type?: unknown }).type ?? ""))) {
    return c.json({ error: "非法动作类型" }, 400);
  }
  const store = readHumanStore(tenant);
  const cmd: HumanCommand = {
    id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    unitId: b.unitId,
    action: b.action as Record<string, unknown>,
    note: typeof b.note === "string" ? b.note : undefined,
    createdAt: new Date().toISOString(),
  };
  store.commands = store.commands.filter((x) => x.unitId !== b.unitId).concat(cmd);
  const out = writeHumanStore(tenant, store);
  console.log(`[human-cmd] ${tenant} ${b.unitId} ${JSON.stringify(b.action)}`);
  return c.json({ ok: true, command: cmd, mode: out.mode, total: out.commands.length });
});
app.post("/api/command/goal", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const tenant = String(b.tenant ?? "");
  if (!validTenant(tenant)) return c.json({ error: "非法租户" }, 400);
  if (typeof b.unitId !== "string" || !b.unitId) return c.json({ error: "缺少 unitId" }, 400);
  if (b.kind !== "mine" && b.kind !== "goto") return c.json({ error: "非法意图类型" }, 400);
  if (!Array.isArray(b.target) || b.target.length !== 2 || !Number.isInteger(b.target[0]) || !Number.isInteger(b.target[1])) {
    return c.json({ error: "非法目标坐标" }, 400);
  }
  const store = readHumanStore(tenant);
  const goal: HumanGoal = {
    id: `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    unitId: b.unitId,
    kind: b.kind,
    target: [b.target[0] as number, b.target[1] as number],
    note: typeof b.note === "string" ? b.note : undefined,
    createdAt: new Date().toISOString(),
  };
  store.goals = store.goals.filter((g) => g.unitId !== b.unitId).concat(goal);
  const out = writeHumanStore(tenant, store);
  console.log(`[human-goal] ${tenant} ${b.unitId} ${b.kind} [${b.target[0]}, ${b.target[1]}]`);
  return c.json({ ok: true, goal, mode: out.mode, total: out.goals.length });
});
app.delete("/api/command", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const tenant = String(b.tenant ?? "");
  if (!validTenant(tenant)) return c.json({ error: "非法租户" }, 400);
  if (typeof b.unitId !== "string" || !b.unitId) return c.json({ error: "缺少 unitId" }, 400);
  const scope = b.scope === "goal" ? "goal" : b.scope === "action" ? "action" : "all";
  const store = readHumanStore(tenant);
  if (scope === "all" || scope === "action") store.commands = store.commands.filter((x) => x.unitId !== b.unitId);
  if (scope === "all" || scope === "goal") store.goals = store.goals.filter((g) => g.unitId !== b.unitId);
  const out = writeHumanStore(tenant, store);
  return c.json({ ok: true, mode: out.mode, total: out.commands.length + out.goals.length });
});
app.post("/api/command/clear", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const tenant = String(b.tenant ?? "");
  if (!validTenant(tenant)) return c.json({ error: "非法租户" }, 400);
  const store = readHumanStore(tenant);
  store.commands = []; store.goals = [];
  const out = writeHumanStore(tenant, store);
  return c.json({ ok: true, mode: out.mode, total: 0 });
});
app.post("/api/command/mode", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const tenant = String(b.tenant ?? "");
  if (!validTenant(tenant)) return c.json({ error: "非法租户" }, 400);
  const mode = b.mode === "disabled" ? "disabled" : "override";
  const store = readHumanStore(tenant);
  store.mode = mode;
  writeHumanStore(tenant, store);
  return c.json({ ok: true, mode, message: mode === "override" ? "人类指挥已启用（手操优先于 agent）" : "人类指挥已停用（交还 agent 全权）" });
});

// ---------- 官方商店代理 ----------
app.get("/api/shop", async (c) => {
  const data = await shopProducts();
  return c.json({ generatedAt: new Date().toISOString(), ...(data as Record<string, unknown>) });
});
app.get("/api/shop/me", async (c) => {
  const cookie = shopCookie(c.req.raw);
  if (!cookie) return c.json({ error: "缺少商店 Cookie（请在兑换面板粘贴官方站点登录 Cookie）" }, 400);
  return c.json(await shopMe(cookie));
});
app.get("/api/shop/orders", async (c) => {
  const cookie = shopCookie(c.req.raw);
  if (!cookie) return c.json({ error: "缺少商店 Cookie" }, 400);
  return c.json(await shopOrders(cookie));
});
app.post("/api/shop/order", async (c) => {
  const cookie = shopCookie(c.req.raw);
  if (!cookie) return c.json({ error: "缺少商店 Cookie" }, 400);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const productId = String(b.product_id ?? "").trim();
  if (!productId) return c.json({ error: "缺少商品 ID" }, 400);
  return c.json(await shopOrder(cookie, productId));
});
app.post("/api/redeem", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const code = String(b.code ?? "").trim();
  if (!code) return c.json({ status: "error", message: "兑换码不能为空" }, 400);
  // 兑换通道设计：接入官方 Arena API 时，用用户提供的 session cookie 在此完成
  // POST { code } -> official /api/v1/redeem（等待 cookie 配置）。当前只记录申请，不触碰外部。
  redeemLog.push({ code, at: new Date().toISOString(), ip: c.req.header("x-forwarded-for") ?? "local" });
  console.log(`[redeem] code=${code.slice(0, 6)}... at=${new Date().toISOString()}`);
  return c.json({
    status: "pending",
    message: "兑换通道待 cookie 配置：申请已记录，接入官方 API 后即可完成兑换。",
    receivedAt: new Date().toISOString(),
    historyLength: redeemLog.length,
  });
});

// ---------- 静态文件 ----------
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
function serveFile(c: Context, filePath: string): Response | Promise<Response> {
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    const ext = filePath.slice(filePath.lastIndexOf("."));
    return new Response(readFileSync(filePath), { headers: { "content-type": MIME[ext] ?? "application/octet-stream" } });
  }
  return new Response("not found", { status: 404 });
}
function servePublic(c: Context, pathname: string): Response | Promise<Response> {
  return serveFile(c, join(PUBLIC_DIR, pathname));
}
// React 前端（web/dist，vite build --base=/app/）：SPA 回退 index.html
app.get("/app", (c) => serveFile(c, join(WEB_DIR, "index.html")));
app.get("/app/*", (c) => {
  const rel = c.req.path.slice("/app".length);
  const file = join(WEB_DIR, rel);
  if (existsSync(file) && statSync(file).isFile()) return serveFile(c, file);
  return serveFile(c, join(WEB_DIR, "index.html")); // SPA fallback
});
app.get("/", (c) => c.redirect("/app/"));
// legacy public/ 仅作样式/素材源
app.get("/assets/*", (c) => servePublic(c, c.req.path.slice(1)));
app.get("/styles/*", (c) => servePublic(c, c.req.path.slice(1)));
app.get("/js/*", (c) => servePublic(c, c.req.path.slice(1)));
app.notFound((c) => servePublic(c, c.req.path.slice(1)));

// 全局错误兜底：异常响应 500（商店/读取失败等，前端已有降级展示）
app.onError((err, c) => {
  console.error("请求处理错误", err);
  return c.json({ error: String(err?.message ?? err) }, 500);
});

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info: { port: number }) => {
  console.log(`Arena 指挥面板：http://127.0.0.1:${info.port}`);
  console.log(`数据根（只读）：${DATA_ROOT}`);
  // 后台预热 + 定时刷新（2026-08-08 UX 优化：前端请求读缓存毫秒级，数据不
  // 等前端打开才加载）：测绘 30s / 事迹 45s / 联盟情报 30s / 共享测绘 30s。
  startSurveyCacheLoop(30_000);
  startDeedsCacheLoop(45_000);
  const warmAlliance = (): void => {
    try {
      loadAllianceIntel(); // 内部 30s 缓存（排行榜 + 遭遇索引）
      refreshAllianceSurvey(); // 共享测绘聚合 30s 缓存
    } catch { /* 数据缺失/临时 IO 失败不阻塞启动 */ }
  };
  warmAlliance();
  setInterval(warmAlliance, 30_000);
  console.log("后台预热：测绘 30s / 事迹 45s / 联盟情报 + 共享测绘 30s 已启动");
});
