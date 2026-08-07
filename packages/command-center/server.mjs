/**
 * Arena 本地指挥面板服务（2026-08-07）。
 *
 * 只读：不写 data/runtime、不连接 Arena、不启动任何 writer。数据源：
 *  - ARENA_DATA_ROOT（缺省 = 仓库同级 ../data）下 runtime/{t1..t4}/calibration
 *    最新 run 的 calibration case（before.state 投影 → 全局联盟测绘地图）；
 *  - runtime/{t1..t4}/telemetry/outcome.jsonl（每 tick 资源/人口/worker 距离）；
 *  - runtime/{t1..t4}/telemetry/runtime.jsonl（实时决策行）；
 *  - supervisor Debug API（127.0.0.1:8120 /ready，仅 t1/t2，探测在线状态）。
 *
 * 仅使用 Node 内置能力（http/fs/path），无第三方依赖。
 */

import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = resolve(process.env.ARENA_DATA_ROOT ?? join(HERE, "..", "..", "..", "data"));
const PUBLIC_DIR = join(HERE, "public");
const PORT = Number(process.env.COMMAND_CENTER_PORT ?? 8787);
const SUPERVISOR_READY_URL = "http://127.0.0.1:8120/ready";
const SHOP_BASE = "https://linuxdoshop.arenahero.io"; // 官方兑换商店（动态价格/库存）
const SHOP_CACHE_MS = 20_000; // products 公开缓存
const TENANTS = ["t1", "t2", "t3", "t4"];
const MAP_CASES_PER_TENANT = 3; // 每个租户合并最近 N 个 calibration case 快照
const LIVE_FRESH_MS = 90_000; // outcome.jsonl mtime 新鲜窗口 = 在线

const redeemLog = []; // 兑换申请内存记录（重启即清空；接入 cookie 后改为持久化）

const runtimeDir = (tenant) => join(DATA_ROOT, "runtime", tenant);
const calibrationDir = (tenant) => join(runtimeDir(tenant), "calibration");
const telemetryDir = (tenant) => join(runtimeDir(tenant), "telemetry");

/** 读 JSONL 文件尾部最多 maxLines 行（容错坏行）。 */
function readJsonlTail(filePath, maxLines) {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rows = [];
  for (const line of lines.slice(-maxLines)) {
    try { rows.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
  }
  return rows;
}

/** 最近一个有 calibration cases 的 run 目录名：按 run 内最高 case tick 选
 *  （UUID 字典序 ≠ 时间序——旧 bug：新 run 80d2d3d6 排在旧 run fffa09fa 前，
 *  面板恒显示旧 run 的 stale tick，即"界面卡住显示旧数据"根因）。 */
function latestRunDir(tenant) {
  const base = calibrationDir(tenant);
  if (!existsSync(base)) return null;
  const runs = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  let best = null;
  let bestTick = -1;
  for (const name of runs) {
    const casesDir = join(base, name, "cases");
    if (!existsSync(casesDir)) continue;
    let maxTick = -1;
    for (const f of readdirSync(casesDir)) {
      const tick = parseTick(f);
      if (tick > maxTick) maxTick = tick;
    }
    if (maxTick > bestTick) {
      bestTick = maxTick;
      best = name;
    }
  }
  return best;
}

function listCases(tenant, runDir) {
  const casesDir = join(calibrationDir(tenant), runDir, "cases");
  if (!existsSync(casesDir)) return [];
  return readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();
}

function parseTick(fileName) {
  const match = fileName.match(/^(\d+)/);
  return match ? Number(match[1]) : 0;
}

const cellKey = (x, y) => `${x},${y}`;

/** 合并 4 租户最新 calibration case → 全局联盟测绘地图（只读）。
 *
 * 测绘语义（对照官方 exploration/visibility）：
 *  - 障碍/资源 = 静态地形：同一 run 全部 case 去重累积（资源带 lastSeen 新鲜度，被采完的会淡出）；
 *  - 单位/核心 = 动态层：按 object id 保留最新 tick 快照（消除"单位云团/核心幽灵"——旧 bug 把 3 个
 *    case 的每个 tick 位置都堆成 cell，导致单位成片、核心像有两个）。
 */
const SURVEY_CASE_LIMIT = 24; // 每个租户累积测绘最多取最近 N 个 case（覆盖与新鲜度平衡）
function loadMergedMap() {
  const cells = new Map();
  const perTenant = [];
  for (const tenant of TENANTS) {
    const runDir = latestRunDir(tenant);
    if (runDir === null) {
      perTenant.push({ tenant, runId: null, caseCount: 0, latestTick: null });
      continue;
    }
    const caseFiles = listCases(tenant, runDir).slice(-SURVEY_CASE_LIMIT);
    let latestTick = 0;
    const terrain = new Map(); // key -> { type, tick }（obstacle/resource 累积）
    const coreById = new Map(); // id -> 最新快照
    const unitById = new Map(); // id -> 最新快照
    for (const file of caseFiles) {
      const tick = parseTick(file);
      if (tick > latestTick) latestTick = tick;
      const path = join(calibrationDir(tenant), runDir, "cases", file);
      let raw;
      try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
      const state = raw?.before?.state;
      if (!state?.objects) continue;
      for (const obj of state.objects) {
        if (obj.kind === "OBSTACLE") {
          for (const [x, y] of obj.positions ?? []) {
            const key = cellKey(x, y);
            const cur = terrain.get(key);
            if (!cur || cur.type !== "obstacle") terrain.set(key, { x, y, type: "obstacle", tick });
          }
        } else if (obj.kind === "RESOURCE") {
          for (const [x, y] of obj.positions ?? []) {
            const key = cellKey(x, y);
            const cur = terrain.get(key);
            if (!cur || cur.type !== "obstacle") terrain.set(key, { x, y, type: "resource", tick });
          }
        } else if (obj.kind === "CORE") {
          const [x, y] = obj.position ?? [0, 0];
          const id = obj.id ?? `core@${x},${y}`;
          const cur = coreById.get(id);
          if (!cur || tick >= cur.tick) coreById.set(id, { x, y, type: "core", tick, hp: obj.hp, shield: obj.shield, controlled: obj.controlled, owner: obj.owner_username ?? null, id: obj.id ?? null });
        } else if (obj.kind === "UNIT") {
          const [x, y] = obj.position ?? [0, 0];
          const id = obj.id;
          if (!id) continue;
          const cur = unitById.get(id);
          if (!cur || tick >= cur.tick) unitById.set(id, { x, y, type: "unit", tick, hp: obj.hp, unitType: obj.unit_type ?? "WORKER", cargo: obj.cargo ?? 0, controlled: obj.controlled, id });
        }
      }
    }
    // 组装：地形在下，动态在上（同格冲突按优先级 obstacle < resource < unit < core）
    const byCell = new Map();
    const put = (c, prio) => {
      const key = cellKey(c.x, c.y);
      const cur = byCell.get(key);
      if (cur && cur.prio > prio) return;
      byCell.set(key, { ...c, tenant, fresh: c.tick === latestTick, prio });
    };
    for (const c of terrain.values()) put(c, c.type === "obstacle" ? 1 : 2);
    for (const c of unitById.values()) put(c, 3);
    for (const c of coreById.values()) put(c, 4);
    for (const { prio, ...c } of byCell.values()) cells.set(cellKey(c.x, c.y), c);
    // 最新 case 的冠军信标（用于全局测绘 beacon 图层）
    let beacon = null;
    if (caseFiles.length > 0) {
      const lastPath = join(calibrationDir(tenant), runDir, "cases", caseFiles[caseFiles.length - 1]);
      try {
        const lastRaw = JSON.parse(readFileSync(lastPath, "utf8"));
        const cb = lastRaw?.before?.state?.champion_beacon;
        if (cb?.position) beacon = { x: cb.position[0], y: cb.position[1], status: cb.status ?? "GROUND", carrier_id: cb.carrier_id ?? null };
      } catch { /* 忽略 beacon 读取失败 */ }
    }
    perTenant.push({ tenant, runId: runDir, caseCount: caseFiles.length, latestTick: latestTick === 0 ? null : latestTick, beacon });
  }
  const list = [...cells.values()];
  const xs = list.map((c) => c.x);
  const ys = list.map((c) => c.y);
  const bounds = list.length === 0
    ? { minX: 0, maxX: 0, minY: 0, maxY: 0 }
    : { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  const beacons = perTenant.map((t) => t.beacon ? { tenant: t.tenant, ...t.beacon } : null).filter(Boolean);
  return { generatedAt: new Date().toISOString(), tenants: perTenant, bounds, cellCount: list.length, cells: list, beacons };
}

/** 每租户最新 outcome 快照 + 近 60 tick 均值（资源/人口展示）。 */
function loadOverview(supervisorState) {
  const tenants = [];
  for (const tenant of TENANTS) {
    const file = join(telemetryDir(tenant), "outcome.jsonl");
    const rows = readJsonlTail(file, 200);
    const last = rows[rows.length - 1] ?? null;
    const window = rows.slice(-60);
    const avg = (fn) => {
      const vals = window.map(fn).filter((v) => typeof v === "number" && Number.isFinite(v));
      return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    let fresh = false;
    let mtime = null;
    if (existsSync(file)) {
      mtime = statSync(file).mtimeMs;
      fresh = Date.now() - mtime < LIVE_FRESH_MS;
    }
    const sup = supervisorState?.tenants?.find((t) => t.tenantId === tenant) ?? null;
    tenants.push({
      tenant,
      live: sup ? sup.ready === true && sup.alive === true : fresh,
      supervisor: sup ? { alive: sup.alive, ready: sup.ready, pid: sup.pid, lifecycle: sup.lifecycle } : null,
      fileFresh: fresh,
      mtime,
      latest: last
        ? {
            tick: last.tick ?? null,
            resources: last.coreResourcesAfter ?? null,
            resourceDelta: last.coreResourceDelta ?? null,
            workers: last.workerCount ?? null,
            workersWithCargo: last.workersWithCargo ?? null,
            workerMaxDistance: last.workerMaxDistanceFromCore ?? null,
            workerMeanDistance: last.workerMeanDistanceFromCore ?? null,
            visibleResources: last.visibleResourceCellCount ?? null,
            events: Array.isArray(last.events) ? last.events.length : 0,
          }
        : null,
      window: {
        avgResources: avg((r) => r.coreResourcesAfter),
        avgWorkers: avg((r) => r.workerCount),
        avgMaxDistance: avg((r) => r.workerMaxDistanceFromCore),
      },
    });
  }
  return { generatedAt: new Date().toISOString(), dataRoot: DATA_ROOT, tenants };
}

function loadStream(tenant, n) {
  const file = join(telemetryDir(tenant), "runtime.jsonl");
  const rows = readJsonlTail(file, n);
  return { tenant, generatedAt: new Date().toISOString(), rows };
}

/** 回放缓存：同一 run 全部 case 的紧凑单位/核心轨迹（每 tick 位置），供前端回放动画。 */
const replayCache = new Map(); // tenant -> { runId, replay }

function loadReplay(tenant) {
  const runDir = latestRunDir(tenant);
  if (!runDir) return null;
  const cached = replayCache.get(tenant);
  if (cached && cached.runId === runDir) return cached.replay;
  const caseFiles = listCases(tenant, runDir);
  if (!caseFiles.length) return null;
  const units = new Map(), cores = new Map();
  const ticks = [];
  for (const file of caseFiles) {
    const tick = parseTick(file);
    ticks.push(tick);
    const path = join(calibrationDir(tenant), runDir, "cases", file);
    let raw;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    const state = raw?.before?.state;
    if (!state?.objects) continue;
    for (const obj of state.objects) {
      const pos = obj.position;
      if (obj.kind === "UNIT" && obj.id && pos) {
        let u = units.get(obj.id);
        if (!u) { u = { type: obj.unit_type ?? "WORKER", controlled: obj.controlled, trail: [] }; units.set(obj.id, u); }
        u.trail.push({ t: tick, x: pos[0], y: pos[1], hp: obj.hp ?? 0, cargo: obj.cargo ?? 0 });
      } else if (obj.kind === "CORE" && obj.id && pos) {
        let c = cores.get(obj.id);
        if (!c) { c = { controlled: obj.controlled, owner: obj.owner_username ?? null, trail: [] }; cores.set(obj.id, c); }
        c.trail.push({ t: tick, x: pos[0], y: pos[1], hp: obj.hp ?? 0, shield: obj.shield ?? 0 });
      }
    }
  }
  // 每 tick 事件帧（compact：战斗/资源活动可视化用；position 存在才保留）。
  const eventFrames = [];
  for (const file of caseFiles) {
    const tick = parseTick(file);
    const path = join(calibrationDir(tenant), runDir, "cases", file);
    let raw;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    const events = (raw?.before?.state?.events ?? [])
      .filter((ev) => ev && ev.event_type && ev.position)
      .map((ev) => ({
        t: ev.event_type,
        p: ev.position,
        a: ev.actor_id ? String(ev.actor_id).slice(0, 8) : null,
        g: ev.target_id ? String(ev.target_id).slice(0, 8) : null,
        v: ev.values ?? null,
      }));
    if (events.length) eventFrames.push({ tick, events });
  }
  const replay = {
    tenant, runId: runDir,
    ticks,
    units: [...units.entries()].map(([id, u]) => ({ id, ...u })),
    cores: [...cores.entries()].map(([id, c]) => ({ id, ...c })),
    eventFrames,
  };
  replayCache.set(tenant, { runId: runDir, replay });
  return replay;
}

/** 测绘累积缓存：每个租户同一 run 的全部 calibration case 合并出的已知地形（探索过的范围）。 */
const surveyCache = new Map(); // tenant -> { runId, survey }

/**
 * 累积测绘：遍历同一 run 全部 cases（同一世界连续 tick 采样），
 * 把每个 case "当前看到的物体子集"（obstacle/resource 静态地形）去重累积成完整地形；
 * core/unit 保留最后看到的位置（动态层）。
 */
function loadSurvey(tenant) {
  const runDir = latestRunDir(tenant);
  if (!runDir) return null;
  const cached = surveyCache.get(tenant);
  if (cached && cached.runId === runDir) return cached.survey;
  const caseFiles = listCases(tenant, runDir);
  if (!caseFiles.length) return null;
  const obstacle = new Map(), resource = new Map();
  const cores = new Map(), units = new Map();
  let tickMax = 0, caseCount = 0;
  for (const file of caseFiles) {
    const tick = parseTick(file);
    if (tick > tickMax) tickMax = tick;
    const path = join(calibrationDir(tenant), runDir, "cases", file);
    let raw;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    const state = raw?.before?.state;
    if (!state?.objects) continue;
    caseCount++;
    for (const obj of state.objects) {
      if (obj.kind === "OBSTACLE") {
        for (const [x, y] of obj.positions ?? []) obstacle.set(cellKey(x, y), { x, y, tick });
      } else if (obj.kind === "RESOURCE") {
        for (const [x, y] of obj.positions ?? []) resource.set(cellKey(x, y), { x, y, tick });
      } else if (obj.kind === "CORE") {
        const [x, y] = obj.position ?? [0, 0];
        const k = cellKey(x, y);
        const cur = cores.get(k);
        if (!cur || tick > cur.tick) cores.set(k, { x, y, tick, hp: obj.hp, shield: obj.shield, controlled: obj.controlled, owner: obj.owner_username ?? null });
      } else if (obj.kind === "UNIT") {
        const [x, y] = obj.position ?? [0, 0];
        const k = cellKey(x, y);
        const cur = units.get(k);
        if (!cur || tick > cur.tick) units.set(k, { x, y, tick, unitType: obj.unit_type ?? "WORKER", controlled: obj.controlled, hp: obj.hp });
      }
    }
  }
  const survey = {
    tenant, runId: runDir, caseCount, tickMax,
    obstacleCells: [...obstacle.values()],
    resourceCells: [...resource.values()],
    coreCells: [...cores.values()],
    unitCells: [...units.values()],
  };
  surveyCache.set(tenant, { runId: runDir, survey });
  return survey;
}

/** 完整世界快照：最新 calibration case 的 before.state（供前端交互计算：寻路/攻击范围/动作可用性）。 */
/** 最新 case 的决策计划（unitActions/coreAction/intents），供待执行命令面板 + 计划箭头。 */
function loadPlan(tenant) {
  const runDir = latestRunDir(tenant);
  if (runDir === null) return { tenant, generatedAt: new Date().toISOString(), plan: null, tick: null };
  const caseFiles = listCases(tenant, runDir);
  if (!caseFiles.length) return { tenant, generatedAt: new Date().toISOString(), plan: null, tick: null };
  const file = caseFiles[caseFiles.length - 1];
  const path = join(calibrationDir(tenant), runDir, "cases", file);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const plan = raw?.plan ?? null;
    return { tenant, generatedAt: new Date().toISOString(), plan, tick: parseTick(file) };
  } catch (error) {
    return { tenant, generatedAt: new Date().toISOString(), plan: null, tick: null, error: String(error?.message ?? error) };
  }
}
function loadWorld(tenant) {
  const runDir = latestRunDir(tenant);
  if (runDir === null) return { tenant, generatedAt: new Date().toISOString(), state: null, caseFile: null };
  const caseFiles = listCases(tenant, runDir);
  if (!caseFiles.length) return { tenant, generatedAt: new Date().toISOString(), state: null, caseFile: null };
  const file = caseFiles[caseFiles.length - 1];
  const path = join(calibrationDir(tenant), runDir, "cases", file);
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    return { tenant, generatedAt: new Date().toISOString(), state: null, caseFile: null, error: String(error?.message ?? error) };
  }
  return {
    tenant,
    generatedAt: new Date().toISOString(),
    runId: runDir,
    caseFile: file,
    tick: raw?.before?.tick ?? null,
    state: raw?.before?.state ?? null,
  };
}

/** 指挥操作事件流：从最新 run 的 calibration case 结构化事件（before.state.events）聚合，
 *  按 tick 倒序。outcome.jsonl 的 events 是纯字符串（旧实现读它导致事件页永远为空）。 */
const EVENT_KINDS = new Set([
  "UNIT_MOVE_FAILED", "CORE_MOVE_FAILED",
  "SPAWN_SUCCEEDED", "SPAWN_FAILED",
  "HARVEST_SUCCEEDED", "HARVEST_FAILED",
  "DEPOSIT_SUCCEEDED", "DEPOSIT_FAILED",
  "SHOT_HIT", "SHOT_MISSED", "SHOT_BLOCKED",
  "SWEEP_RESOLVED", "SWEEP_FAILED",
  "PICKUP_BEACON_SUCCEEDED", "PICKUP_BEACON_FAILED",
  "DROP_BEACON_SUCCEEDED", "DROP_BEACON_FAILED",
  "SELF_DESTRUCT", "HEAL_SUCCEEDED", "HEAL_FAILED", "REPAIR_SHIELD_SUCCEEDED",
  "UNIT_DESTROYED", "CORE_DESTROYED", "CORE_DAMAGED", "RESPAWN",
  "CORE_RESOURCES_CAPTURED", "CORE_RESOURCE_OVERFLOW_DESTROYED", "WORKER_CARGO_DROPPED",
  "UNIT_HEAL_SUCCEEDED", "UNIT_HEAL_FAILED", "CORE_HEAL_SUCCEEDED", "CORE_HEAL_FAILED",
  "WAIT", "NOTHING_TO_DO",
]);
function loadEvents(tenant, n) {
  const runDir = latestRunDir(tenant);
  if (runDir === null) return { tenant, generatedAt: new Date().toISOString(), events: [] };
  const caseFiles = listCases(tenant, runDir).slice(-20);
  const events = [];
  for (const file of caseFiles) {
    const fileTick = parseTick(file);
    const path = join(calibrationDir(tenant), runDir, "cases", file);
    let raw;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    const evs = raw?.before?.state?.events;
    if (!Array.isArray(evs)) continue;
    for (const ev of evs) {
      if (!ev || typeof ev !== "object") continue;
      const kind = String(ev.event_type ?? "").toUpperCase();
      if (!EVENT_KINDS.has(kind)) continue;
      events.push({
        tick: ev.tick ?? fileTick ?? null,
        kind,
        reason: ev.reason_code ?? null,
        actor: ev.actor_id ?? null,
        target: ev.target_id ?? null,
        position: ev.position ?? null,
        amount: ev.values?.amount ?? ev.values?.damage ?? null,
        hp: ev.values?.hp ?? null,
        source: ev.values?.source ?? null,
        capacity: ev.values?.capacity ?? null,
      });
    }
  }
  events.sort((a, b) => (b.tick ?? 0) - (a.tick ?? 0));
  return { tenant, generatedAt: new Date().toISOString(), events: events.slice(0, Math.min(Math.max(n, 1), 200)) };
}

async function supervisorState() {
  try {
    const res = await fetch(SUPERVISOR_READY_URL, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** 官方商店代理：products 公开可缓存；me/orders/order 需要登录 cookie（经 X-Shop-Cookie 请求头传入，不落盘）。 */
let shopCache = { at: 0, data: null };
async function shopProducts() {
  const now = Date.now();
  if (shopCache.data && now - shopCache.at < SHOP_CACHE_MS) return shopCache.data;
  const res = await fetch(`${SHOP_BASE}/api/v1/products`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`shop products HTTP ${res.status}`);
  const data = await res.json();
  shopCache = { at: now, data };
  return data;
}
function shopCookie(req) {
  const c = req.headers["x-shop-cookie"];
  return typeof c === "string" && c.trim().length > 0 ? c.trim() : null;
}
/** 官方商店要求 X-CSRF-Token：与 cookie 中的 arena_shop_csrf 同值，从 Cookie 内联提取，不落盘。 */
function extractShopCsrf(cookie) {
  const m = /(?:^|;\s*)arena_shop_csrf=([^;]+)/.exec(cookie);
  return m ? m[1] : null;
}
function shopHeaders(cookie) {
  const headers = { Cookie: cookie, Accept: "application/json" };
  const csrf = extractShopCsrf(cookie);
  if (csrf) headers["x-csrf-token"] = csrf;
  return headers;
}
async function shopMe(cookie) {
  const res = await fetch(`${SHOP_BASE}/api/v1/me`, {
    headers: shopHeaders(cookie),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `shop me HTTP ${res.status}`);
  return data;
}
async function shopOrders(cookie) {
  const res = await fetch(`${SHOP_BASE}/api/v1/orders`, {
    headers: shopHeaders(cookie),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `shop orders HTTP ${res.status}`);
  return data;
}
async function shopOrder(cookie, productId) {
  const headers = shopHeaders(cookie);
  headers["Content-Type"] = "application/json";
  const res = await fetch(`${SHOP_BASE}/api/v1/orders`, {
    method: "POST",
    headers,
    body: JSON.stringify({ product_id: productId }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `shop order HTTP ${res.status}`);
  return data;
}

const MIME = {
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

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;
  try {
    if (pathname === "/api/tenants") {
      const sup = await supervisorState();
      const tenants = TENANTS.map((t) => {
        const s = sup?.tenants?.find((x) => x.tenantId === t) ?? null;
        return { tenant: t, live: s ? s.ready === true && s.alive === true : false, supervisor: s };
      });
      return sendJson(res, { generatedAt: new Date().toISOString(), tenants });
    }
    if (pathname === "/api/overview") {
      const sup = await supervisorState();
      return sendJson(res, loadOverview(sup));
    }
    if (pathname === "/api/map") {
      return sendJson(res, loadMergedMap());
    }
    if (pathname === "/api/stream") {
      const tenant = url.searchParams.get("tenant") ?? "t1";
      const n = Number(url.searchParams.get("n") ?? 60);
      return sendJson(res, loadStream(tenant, Math.min(Math.max(n, 1), 200)));
    }
    if (pathname === "/api/world") {
      const tenant = url.searchParams.get("tenant") ?? "t1";
      return sendJson(res, loadWorld(tenant));
    }
    if (pathname === "/api/replay") {
      const tenant = url.searchParams.get("tenant") ?? "t1";
      const replay = loadReplay(tenant);
      if (!replay) return sendJson(res, { tenant, generatedAt: new Date().toISOString(), replay: null });
      return sendJson(res, { generatedAt: new Date().toISOString(), replay });
    }
    if (pathname === "/api/plan") {
      const tenant = url.searchParams.get("tenant") ?? "t1";
      return sendJson(res, loadPlan(tenant));
    }
    if (pathname === "/api/exploration") {
      const tenant = url.searchParams.get("tenant") ?? "t1";
      const survey = loadSurvey(tenant);
      if (!survey) return sendJson(res, { tenant, generatedAt: new Date().toISOString(), survey: null });
      const world = loadWorld(tenant);
      return sendJson(res, {
        tenant,
        generatedAt: new Date().toISOString(),
        survey,
        current: world.state ? { caseFile: world.caseFile, tick: world.tick, objects: world.state.objects, resources: world.state.resources, population: world.state.population, champion_beacon: world.state.champion_beacon } : null,
      });
    }
    if (pathname === "/api/events") {
      const tenant = url.searchParams.get("tenant") ?? "t1";
      const n = Number(url.searchParams.get("n") ?? 60);
      return sendJson(res, loadEvents(tenant, n));
    }
    if (pathname === "/api/shop" && req.method === "GET") {
      const data = await shopProducts();
      return sendJson(res, { generatedAt: new Date().toISOString(), ...data });
    }
    if (pathname === "/api/shop/me" && req.method === "GET") {
      const cookie = shopCookie(req);
      if (!cookie) return sendJson(res, { error: "缺少商店 Cookie（请在兑换面板粘贴官方站点登录 Cookie）" }, 400);
      const data = await shopMe(cookie);
      return sendJson(res, data);
    }
    if (pathname === "/api/shop/orders" && req.method === "GET") {
      const cookie = shopCookie(req);
      if (!cookie) return sendJson(res, { error: "缺少商店 Cookie" }, 400);
      const data = await shopOrders(cookie);
      return sendJson(res, data);
    }
    if (pathname === "/api/shop/order" && req.method === "POST") {
      const cookie = shopCookie(req);
      if (!cookie) return sendJson(res, { error: "缺少商店 Cookie" }, 400);
      let body = "";
      for await (const chunk of req) body += chunk;
      let productId = "";
      try { productId = String(JSON.parse(body || "{}").product_id ?? "").trim(); } catch { /* 忽略 */ }
      if (!productId) return sendJson(res, { error: "缺少商品 ID" }, 400);
      const data = await shopOrder(cookie, productId);
      return sendJson(res, data);
    }
    if (pathname === "/api/redeem" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let code = "";
      try { code = String(JSON.parse(body || "{}").code ?? "").trim(); } catch { /* 忽略坏 body */ }
      if (!code) return sendJson(res, { status: "error", message: "兑换码不能为空" }, 400);
      // 兑换通道设计：接入官方 Arena API 时，用用户提供的 session cookie 在此完成
      // POST { code } -> official /api/v1/redeem（等待 cookie 配置）。当前只记录申请，不触碰外部。
      redeemLog.push({ code, at: new Date().toISOString(), ip: req.socket.remoteAddress ?? "local" });
      console.log(`[redeem] code=${code.slice(0, 6)}... at=${new Date().toISOString()}`);
      return sendJson(res, {
        status: "pending",
        message: "兑换通道待 cookie 配置：申请已记录，接入官方 API 后即可完成兑换。",
        receivedAt: new Date().toISOString(),
        historyLength: redeemLog.length,
      });
    }
    if (pathname === "/") {
      const body = readFileSync(join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(body);
    }
    const file = join(PUBLIC_DIR, pathname.slice(1));
    if (existsSync(file) && statSync(file).isFile()) {
      const ext = file.slice(file.lastIndexOf("."));
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
      return res.end(readFileSync(file));
    }
    sendJson(res, { error: "not found" }, 404);
  } catch (error) {
    sendJson(res, { error: String(error?.message ?? error) }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Arena 指挥面板：http://127.0.0.1:${PORT}`);
  console.log(`数据根（只读）：${DATA_ROOT}`);
});
