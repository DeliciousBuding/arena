/**
 * 测绘数据库 API 服务（2026-08-08，survey-db 联动）：跨 run 完整测绘只读接口。
 *
 * 与主指挥面板（server.mjs，8787）分离部署——避免与并行 agent 的主面板改动
 * 冲突；前端地图图层后续接入本服务。
 *
 * 端点：
 *   GET /api/survey?tenant=t1|all&states=visible,stale&maxAge=20000
 *     → { tenant, generatedAt, resources: [...], obstacles: [...], coreHunts: [...] }
 *   GET /health → { ok: true }
 *
 * 数据源：<ARENA_DATA_ROOT>/runtime/survey/<tenant>.db（node:sqlite，零依赖）。
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = resolve(process.env.ARENA_DATA_ROOT ?? join(HERE, "..", "..", "..", "data"));
const PORT = Number(process.env.SURVEY_PORT ?? 8788);
const TENANTS = ["t1", "t2", "t3", "t4"];


function dbFor(tenant) {
  const file = join(DATA_ROOT, "runtime", "survey", `${tenant}.db`);
  if (!existsSync(file)) return null;
  return new DatabaseSync(file, { readOnly: true });
}

function queryResources(db, states, maxAgeTicks) {
  const placeholders = states.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT x, y, first_seen_tick, last_seen_tick, state, seen_count
     FROM resources WHERE state IN (${placeholders}) ORDER BY last_seen_tick DESC`,
  ).all(...states);
  if (maxAgeTicks === null || maxAgeTicks <= 0) return rows;
  let maxTick = 0;
  for (const r of rows) if (r.last_seen_tick > maxTick) maxTick = r.last_seen_tick;
  const cutoff = maxTick - maxAgeTicks;
  return rows.filter((r) => r.last_seen_tick >= cutoff);
}

function queryObstacles(db) {
  return db.prepare("SELECT x, y, first_seen_tick, last_seen_tick FROM obstacles ORDER BY last_seen_tick DESC").all();
}

function queryCoreHunts(db) {
  return db.prepare(
    "SELECT x, y, owner, source, first_seen_tick, last_seen_tick FROM core_hunts ORDER BY last_seen_tick DESC",
  ).all();
}


/** 生命周期摘要（2026-08-08）：单位/消费/采集聚合——与主面板 lib/survey.ts
 *  loadLifecycleDb 同 SQL，独立服务也能直接消费生命周期数据。 */
function queryLifecycle(db) {
  const units = db.prepare(
    "SELECT current_state AS state, unit_type AS type, COUNT(*) AS count FROM unit_lifecycle GROUP BY state, unit_type",
  ).all();
  const spends = db.prepare(
    "SELECT kind, COUNT(*) AS count, SUM(amount) AS total FROM core_spends GROUP BY kind ORDER BY total DESC",
  ).all();
  const harvests = db.prepare(
    "SELECT COUNT(*) AS count, MAX(tick) AS last_tick FROM resource_events WHERE event_type = 'HARVEST_SUCCEEDED'",
  ).get();
  const fails = db.prepare(
    "SELECT COUNT(*) AS count FROM resource_events WHERE event_type = 'HARVEST_FAILED'",
  ).get();
  return {
    units,
    spends,
    harvestCount: Number(harvests?.count ?? 0),
    lastHarvestTick: harvests?.last_tick === null ? null : Number(harvests?.last_tick ?? 0),
    harvestFailCount: Number(fails?.count ?? 0),
  };
}
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(text);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    const pathname = url.pathname;
    if (pathname === "/health") {
      sendJson(res, 200, { ok: true, dataRoot: DATA_ROOT });
      return;
    }
    if (pathname === "/api/survey") {
      const tenant = url.searchParams.get("tenant") ?? "all";
      const states = (url.searchParams.get("states") ?? "visible,stale")
        .split(",").map((s) => s.trim()).filter(Boolean);
      const maxAge = Number(url.searchParams.get("maxAge") ?? 20000);
      const tenants = tenant === "all" ? TENANTS : [tenant];
      const out = { generatedAt: new Date().toISOString(), tenants: {} };
      for (const t of tenants) {
        const db = dbFor(t);
        if (db === null) {
          out.tenants[t] = { error: "survey db not found" };
          continue;
        }
        try {
          out.tenants[t] = {
            resources: queryResources(db, states, Number.isFinite(maxAge) ? maxAge : null),
            obstacles: queryObstacles(db),
            coreHunts: queryCoreHunts(db),
            lifecycle: queryLifecycle(db),
          };
        } finally {
          db.close();
        }
      }
      sendJson(res, 200, out);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    sendJson(res, 500, { error: String(error) });
  }
});

server.listen(PORT, () => {
  console.log(`[survey-server] http://127.0.0.1:${PORT} (data-root=${DATA_ROOT})`);
});

