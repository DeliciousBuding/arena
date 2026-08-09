/**
 * Arena 本地指挥面板服务入口（2026-08-08 模块化重构：Hono 路由 + 静态 +
 * 组装，领域逻辑在 lib/ 各模块；TypeScript，Node 24 type stripping 直接执行）。
 *
 * 只读：不写 data/runtime、不连接 Arena、不启动任何 writer（人类指挥写
 * data/runtime/human-commands 除外，见 lib/store.ts；测绘保鲜例外：面板可惰性
 * 触发 survey:sync CLI 补同步——写库仍是该 CLI（单一 writer），见
 * lib/survey-sync-bridge.ts）。数据源：
 *  - ARENA_DATA_ROOT（缺省 = 仓库同级 data/）下 runtime/{t1..t4}/calibration
 *    最新 run 的 calibration case + telemetry JSONL；
 *  - supervisor Debug API（127.0.0.1:8120 /ready，探测在线状态）；
 *  - 官方商店代理（linuxdoshop.arenahero.io，需登录 Cookie）。
 */
import { DatabaseSync } from "node:sqlite";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { existsSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_ROOT, TENANTS } from "./lib/fs-jsonl.ts";
import { supervisorState, supervisorAllianceDirectorState } from "./lib/supervisor.ts";
import { loadMergedMap, getMapSig } from "./lib/map.ts";
import { loadOverview, loadStream, loadReplay, loadPlan, loadWorld, loadEvents } from "./lib/streams.ts";
import { loadSurveyDb, loadLifecycleDb, loadSurvey, loadResourceTimeline, loadSpendTrend, loadUnitLifecycleDb, loadChunksDb } from "./lib/survey.ts";
import { openAgentDb, applyAgentEvent, knownAgent, recentAgentEvents, type AgentRow } from "./lib/agent-ingest.ts";
import { loadMinePatterns, refreshMinePatterns } from "./lib/mine-patterns.ts";
import { loadTenantSurveyCached, startSurveyCacheLoop } from "./lib/survey-cache.ts";
import { loadDeeds, startDeedsCacheLoop } from "./lib/deeds.ts";
import { loadAllianceSurvey, refreshAllianceSurvey, TENANT_COLORS } from "./lib/alliance-survey.ts";
import { loadAllianceSnapshot, refreshAllianceSnapshot } from "./lib/alliance-snapshot.ts";
import { loadAllianceCluster, refreshAllianceCluster } from "./lib/alliance-cluster.ts";
import { loadAllianceAdvice, refreshAllianceAdvice } from "./lib/alliance-advice.ts";
import { buildDefenseCoordination, buildDefensePocketAdvice, buildDefensePockets } from "./lib/alliance-defense.ts";
import { buildEnemyCoreStates, type EnemyCoreHuntRow } from "./lib/enemy-core-state.ts";
import { loadEnemyHeat, refreshEnemyHeat } from "./lib/enemy-heat.ts";
import { loadAllianceExploration, refreshAllianceExploration } from "./lib/exploration-coverage.ts";
import { loadPipelineHealth, refreshPipelineHealth } from "./lib/pipeline-health.ts";
import { maybeTriggerSurveySync, surveySyncBridgeState } from "./lib/survey-sync-bridge.ts";
import { loadAllianceDeeds, refreshAllianceDeeds } from "./lib/alliance-deeds.ts";
import { loadDeedsJournal, refreshDeedsJournal } from "./lib/deeds-journal.ts";
import { loadAllianceIntel, buildEncounteredIndex } from "./lib/intel.ts";
import { loadLeaderboardIntel, loadOurUsernames, maybeRefreshLeaderboardLazy, refreshLeaderboardFromOfficial } from "./lib/leaderboard.ts";
import { readHumanStore, writeHumanStore, reconcileHumanStore, latestHumanOverride, stuckRecord, type HumanCommand, type HumanGoal } from "./lib/store.ts";
import { shopProducts, shopCookie, shopMe, shopOrders, shopOrder } from "./lib/shop.ts";
import { appendRedeemRecord, loadRedeemHistory, type RedeemRecord } from "./lib/redeem-log.ts";
import { appendArbitration, clearArbitration, listArbitrations } from "./lib/arbitration.ts";
import { loadDecisionAudit, warmDecisionAudit, loadDecisionTrend, warmDecisionTrend } from "./lib/decision-audit.ts";
import { loadLifecycleAudit, warmLifecycleAudit } from "./lib/lifecycle-audit.ts";
import { loadMineUtilization, warmMineUtilization, loadMineUtilizationTrend, warmMineUtilizationTrend } from "./lib/mine-utilization.ts";
import { loadMapLod, warmMapLod } from "./lib/map-lod.ts";
import { loadAuditOverview, warmAuditOverview } from "./lib/audit-overview.ts";
import { loadHumanConflict, warmHumanConflict } from "./lib/human-conflict.ts";
import { loadAllianceMining, warmAllianceMining } from "./lib/alliance-mining.ts";
import { loadMiningEffectiveness, warmMiningEffectiveness } from "./lib/mining-effectiveness.ts";
import { loadAuditTrail, warmAuditTrail } from "./lib/audit-trail.ts";
import { loadConsensusMining, warmConsensusMining } from "./lib/consensus-mining.ts";
import { loadShopHistory, refreshShopHistory } from "./lib/shop-history.ts";
import { loadAlignmentAudit, warmAlignmentAudit } from "./lib/alignment-audit.ts";
import { loadDecisionInput, warmDecisionInput } from "./lib/decision-input.ts";
import { loadWorkerLivenessAudit, warmWorkerLivenessAudit } from "./lib/worker-liveness-audit.ts";
import { appendHumanAudit, loadHumanAudit } from "./lib/human-audit.ts";
import { applyGoalMutation } from "./lib/goal-store.ts";
import { loadCoreMovingGuard } from "./lib/human-command-guard.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
const WEB_DIR = join(HERE, "web", "dist"); // React 构建产物（vite build --base=/app/）
const PORT = Number(process.env.COMMAND_CENTER_PORT ?? 8787);
const DEFAULT_AUDIT_WINDOW = 3000;

// 兑换申请记录：落盘 JSONL 持久化（2026-08-08，重启不丢），内存只做最近窗口缓存
const redeemLog: RedeemRecord[] = loadRedeemHistory();

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
// /api/map ETag 304（2026-08-09）：签名不变时 304 零传输（省 642KB）；
// 生产 ~15s/tick 间隔内 poll 3s 一次可命中 4 次 304。max-age=2 限浏览器短缓存。
app.get("/api/map", (c) => {
  const payload = loadMergedMap();
  const etag = `W/"${getMapSig()}"`;
  if (c.req.header("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "public, max-age=2" } });
  }
  return c.json(payload, 200, { etag, "cache-control": "public, max-age=2" });
});
// 地图 LOD 聚合视图（2026-08-08，缩放优化数据支撑）：全局缩放用 chunk 级聚合
// （16×16 chunk 的矿/障碍/核心计数 + 最新 tick，~12KB vs 全量 642KB），
// 放大到局部再请求 /api/map 全量。?tenant=all|tN。30s 缓存 + 启动预热。
app.get("/api/map/lod", (c) => {
  const tenant = c.req.query("tenant") ?? "all";
  if (tenant !== "all" && !TENANTS.includes(tenant as (typeof TENANTS)[number])) {
    return c.json({ error: "非法租户" }, 400);
  }
  return c.json(loadMapLod(tenant));
});
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
app.get("/api/survey/enemy-cores", (c) => {
  // 敌核状态视图（2026-08-08，共享测绘深化）：core_hunts（共享测绘敌核记忆）
  // 聚合每敌核生命周期状态 ACTIVE/RELOCATED/STALE + 威胁级别——回答"敌方核心
  // 还活着吗 / 在哪 / 迁哪了"；活跃且距友核近 → high（打核候选）。只读。
  const hunts: EnemyCoreHuntRow[] = [];
  let maxTick = 0;
  for (const t of TENANTS) {
    const file = join(DATA_ROOT, "runtime", "survey", `${t}.db`);
    if (!existsSync(file)) continue;
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file, { readOnly: true });
    } catch {
      continue;
    }
    try {
      const rows = db.prepare(
        "SELECT owner, x, y, first_seen_tick, last_seen_tick, source FROM core_hunts WHERE owner IS NOT NULL",
      ).all() as Array<Record<string, unknown>>;
      for (const r of rows) {
        const last = Number(r.last_seen_tick);
        if (last > maxTick) maxTick = last;
        hunts.push({
          owner: String(r.owner),
          x: Number(r.x),
          y: Number(r.y),
          firstSeenTick: Number(r.first_seen_tick),
          lastSeenTick: last,
          source: r.source === "WORKER_INFER" ? "WORKER_INFER" : "CORE",
        });
      }
    } catch {
      // 旧库无 core_hunts：跳过
    } finally {
      db.close();
    }
  }
  const snap = loadAllianceSnapshot();
  const friendlyCores = Object.values(snap.members)
    .map((m) => (m.core ? m.core.position : null))
    .filter((p): p is readonly [number, number] => p !== null);
  return c.json({
    generatedAt: new Date().toISOString(),
    currentTick: maxTick,
    cores: buildEnemyCoreStates(hunts, maxTick, friendlyCores),
  });
});
app.get("/api/survey/decision-input", (c) => {
  // 决策输入管道（2026-08-08，G3 断层补全）：矿刷新预测（dueInTicks）+ chunk 覆盖
  // → mission 层 Phase 2 直接消费形状。?tenant=tN。只读组合，30s 缓存 + 预热。
  const tenant = c.req.query("tenant") ?? "t1";
  if (!TENANTS.includes(tenant as (typeof TENANTS)[number])) {
    return c.json({ error: "非法租户" }, 400);
  }
  return c.json(loadDecisionInput(tenant));
});
app.get("/api/survey/mine-patterns", (c) => {
  // 矿生命周期模式（2026-08-08，共享记忆算法深化）：每租户矿格活性/刷新规律/
  // 采集成功率 + topActive 活跃矿（采集推荐）。?tenant=all|tN。30s 缓存 + 预热。
  const tenant = c.req.query("tenant") ?? "all";
  if (tenant !== "all" && !TENANTS.includes(tenant as (typeof TENANTS)[number])) {
    return c.json({ error: "非法租户" }, 400);
  }
  return c.json(loadMinePatterns(tenant));
});

app.get("/api/deeds", async (c) => {
  // 事迹/日记（2026-08-08）：跨租户叙事级事迹，?tenant=all|t1..t4&limit=60。
  // 数据源分层：★3-4 稀有事件扫描 + ★2 里程碑（survey-db）+ ★1 常规（限流）。
  // 45s 内存缓存 + 后台预热，前端轮询不实时扫库。
  const tenant = c.req.query("tenant") ?? "all";
  const n = Number(c.req.query("limit") ?? 60);
  const limit = Math.min(Math.max(Number.isFinite(n) ? n : 60, 1), 200);
  if (tenant !== "all" && !TENANTS.includes(tenant as (typeof TENANTS)[number])) {
    return c.json({ error: "非法租户" }, 400);
  }
  const deeds = await loadDeeds(tenant, limit);
  // 联盟事迹并入（2026-08-08）：tenant=all 时叠加联盟级叙事（新敌核/热区/
  // 抢矿/资源濒危），按 tick 倒序同 tick 高星优先。
  if (tenant === "all") {
    deeds.push(...loadAllianceDeeds());
    deeds.sort((a, b) => (b.tick - a.tick) || (b.star - a.star));
  }
  return c.json({ generatedAt: new Date().toISOString(), tenant, limit, allianceMerged: tenant === "all", deeds });
});
app.get("/api/deeds/journal", async (c) => {
  // 事迹日记摘要（2026-08-08）：把事迹流聚合成"日记"层——tick 窗口头条/
  // 分租户统计/中文叙事段落。?tenant=all|tN&window=5000；2026-08-08 新增
  // 折叠/筛选：?category=harvest,deposit,spawn,death,milestone,newCore,
  // heatZone,conflict,economy,status&minStar=2（KIND_GROUP 类别 + 星级下限）。
  // 返回 groups 按类别分组（每组 ≤20 条），前端可折叠。30s 缓存（key 含筛选）。
  const tenant = c.req.query("tenant") ?? "all";
  if (tenant !== "all" && !TENANTS.includes(tenant as (typeof TENANTS)[number])) {
    return c.json({ error: "非法租户" }, 400);
  }
  const w = Number(c.req.query("window") ?? 5000);
  const windowTicks = Number.isFinite(w) ? Math.min(Math.max(w, 500), 50_000) : 5000;
  const categories = (c.req.query("category") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const ms = Number(c.req.query("minStar") ?? 0);
  const minStar = Number.isFinite(ms) ? ms : 0;
  return c.json(await loadDeedsJournal(tenant, windowTicks, { categories, minStar }));
});
app.get("/api/alliance/survey", (c) => {
  // 联盟共享测绘（2026-08-08）：四租户 survey-db 聚合（敌核/矿/障碍/探索分区
  // + 生命周期 + 租户色）——地图「全联盟」层数据源，30s 聚合缓存。
  const full = loadAllianceSurvey();
  // ?view=consensus 轻量模式（2026-08-08 消费优化）：只返回摘要 + 冲突 +
  // 共识三视图（跳过 raw resources/obstacles/chunks/lifecycle，payload 大幅减小）。
  if (c.req.query("view") !== "consensus") return c.json(full);
  return c.json({
    generatedAt: full.generatedAt,
    colors: full.colors,
    tenantSummaries: full.tenantSummaries,
    conflicts: full.conflicts,
    consensusResources: full.consensusResources,
    consensusCores: full.consensusCores,
    consensusChunks: full.consensusChunks,
    cachedAt: full.cachedAt,
  });
});
// 共享测绘人工仲裁（2026-08-08，冲突闭环）：人类覆盖同格矿默认仲裁
// （lastSeen 最新者胜）——落盘 arbitration.jsonl（不写 survey-db），
// 写后失效聚合缓存立即生效；GET 列当前生效仲裁。
app.get("/api/alliance/survey/arbitrations", (c) => c.json({ generatedAt: new Date().toISOString(), arbitrations: listArbitrations() }));
app.post("/api/alliance/survey/arbitrate", async (c) => {
  const body = await c.req.json().catch(() => null);
  const cell = String(body?.cell ?? "").trim();
  const winnerTenant = String(body?.winnerTenant ?? "").trim();
  if (!cell || !TENANTS.includes(winnerTenant as (typeof TENANTS)[number])) {
    return c.json({ error: "非法参数：cell 必填（x,y）+ winnerTenant ∈ t1..t4" }, 400);
  }
  appendArbitration({ cell, winnerTenant, note: String(body?.note ?? ""), createdAt: new Date().toISOString() });
  refreshAllianceSurvey();
  return c.json({ ok: true, cell, winnerTenant, arbitrations: listArbitrations() });
});
app.post("/api/alliance/survey/arbitrate/clear", async (c) => {
  const body = await c.req.json().catch(() => null);
  const cell = String(body?.cell ?? "").trim();
  if (!cell) return c.json({ error: "cell 必填（x,y）" }, 400);
  clearArbitration(cell);
  refreshAllianceSurvey();
  return c.json({ ok: true, cell, arbitrations: listArbitrations() });
});
app.get("/api/alliance/cluster", (c) => {
  // 联盟集群态势（2026-08-08，抱团 Phase 1 观测层）：四租户核心/兵力集群识别
  // + 抱团指数 + 联防圈（西集群 t1+t3 / 东集群 t2+t4 可视化）。30s 缓存。
  return c.json(loadAllianceCluster());
});
app.get("/api/alliance/snapshot", (c) => {
  // 联盟态势快照（2026-08-08）：canonical 联盟域模型 + survey-db 敌核 +
  // 世界状态 + 排行榜先验——members/sightings/counts/intel/threat/
  // threatSummaries（8 扇区），30s 缓存。前端「联盟态势」tab 数据源。
  return c.json(loadAllianceSnapshot());
});
app.get("/api/alliance/advice", (c) => {
  // 联盟参谋建议（2026-08-08）：快照 + 共享测绘 + 排行榜综合成可执行运维
  // 建议（经济/军事/威胁/抢矿/高威胁玩家），按严重度排序——人机协同决策
  // 支持。纯快照数据（不触发 intel 扫描），30s 缓存。
  return c.json(loadAllianceAdvice());
});
app.get("/api/alliance/defense", (c) => {
  // 联盟联防建议（2026-08-08，抱团 Phase 2 决策支持层）：濒危识别（重生/
  // 薄弱+威胁）、驰援推荐（最近军事冗余邻居）、阵型紧凑度——数据来自快照
  // 缓存（members/threatSummaries），构建轻量无独立缓存（30s 快照 TTL 即上限）。
  const snap = loadAllianceSnapshot();
  const byTenant = new Map(snap.threatSummaries.map((s) => [s.tenantId, s.totalScore]));
  const dirsByTenant = new Map(snap.threatSummaries.map((s) => [s.tenantId, s.highDirections]));
  const countByTenant = new Map(snap.threatSummaries.map((s) => [s.tenantId, s.sectors.reduce((n, x) => n + (x.entityCount ?? 0), 0)]));
  const members = Object.values(snap.members).map((m) => ({
    tenantId: m.tenantId,
    core: m.core?.position ?? null,
    military: m.vanguards + m.rangers,
    status: m.status,
    threatScore: byTenant.get(m.tenantId) ?? 0,
    threatDirections: dirsByTenant.get(m.tenantId) ?? [],
    threatCount: countByTenant.get(m.tenantId) ?? 0,
  }));
  // POCKET 联防圈：消费共享测绘敌核目击（快照 CORE sightings），敌核群威胁
  // ≥2 租户 → 协同设防/收缩建议。
  const pocketEnemyCores = snap.sightings
    .filter((s) => s.kind === "CORE" && typeof s.ownerUsername === "string")
    .map((s) => ({ key: s.key, owner: s.ownerUsername, position: s.position, lastSeenTick: s.lastSeenTick }));
  const coordination = buildDefenseCoordination(members);
  const pocketAdvice = buildDefensePocketAdvice(members, pocketEnemyCores);
  const sevOrder: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, INFO: 3 };
  return c.json({
    ...coordination,
    pockets: buildDefensePockets(members, pocketEnemyCores),
    advice: [...coordination.advice, ...pocketAdvice].sort(
      (a, b) => (sevOrder[a.severity] - sevOrder[b.severity]) || a.id.localeCompare(b.id),
    ),
  });
});
app.get("/api/alliance/director", async (c) => {
  // 中央 Alliance Director v3：只读代理 supervisor Debug API。永远 ASSIST_ONLY，
  // actionOwnership=none；8120 不可用时 fail-open 返回 available=false。
  return c.json(await supervisorAllianceDirectorState());
});

app.get("/api/alliance/exploration", (c) => {
  // 联盟探索覆盖（2026-08-08，地图系统 + 共享测绘 + 综合决策）：per-tenant 探索
  // 格数/新鲜度/bbox/独家贡献 + 联盟并集覆盖 + 距核心未探索盲区。30s 缓存 + 预热。
  return c.json(loadAllianceExploration());
});
app.get("/api/events", (c) => {
  const tenant = c.req.query("tenant") ?? "t1";
  const n = Number(c.req.query("n") ?? 60);
  return c.json(loadEvents(tenant, n));
});
app.get("/api/leaderboard", (c) => {
  // 惰性刷新检查（2026-08-08 无计划任务）：快照 stale 且距上次拉取 ≥10min → 后台异步拉取
  // 一次（不 await、不阻塞请求，返回旧数据；下一次请求即新快照）。
  maybeRefreshLeaderboardLazy();
  const intel = loadLeaderboardIntel();
  if (!intel) return c.json({ generatedAt: new Date().toISOString(), error: "排行榜快照缺失（运行 docs/progress/leaderboard-intel.py 拉取，或 POST /api/leaderboard/refresh）" }, 404);
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
app.post("/api/leaderboard/refresh", async (c) => {
  // 手动刷新排行榜（2026-08-08）：请求驱动拉取官方一次——替代原计划任务 ArenaLeaderboardIntel
  // （用户明确不要计划任务/定时任务）。前端可放"刷新"按钮；拉取 ~1s，成功后缓存即新。
  const r = await refreshLeaderboardFromOfficial();
  if (!r.ok) return c.json({ ok: false, error: r.error ?? "拉取失败" }, 502);
  return c.json({ ok: true, message: "排行榜已刷新", snapshot: loadLeaderboardIntel()?.snapshot });
});
app.get("/api/intel", (c) => c.json(loadAllianceIntel()));
app.get("/api/health/pipeline", (c) => {
  // 数据管线健康（2026-08-08）：survey-db 同步水位 vs live tick 滞后/数据量/
  // 缓存新鲜度——测绘记录层是否健康前进一眼可读。15s 缓存。
  const payload = loadPipelineHealth();
  // 惰性同步桥（2026-08-08，无计划任务）：滞后 > 阈值 → 后台补一次
  // survey:sync --latest-only（防抖 + 单实例锁），请求路径触发不阻塞返回。
  maybeTriggerSurveySync(payload.global.maxLagTicks, TENANTS);
  return c.json({ ...payload, surveySync: surveySyncBridgeState() });
});
app.get("/api/intel/heat", (c) => {
  // 敌情热区（2026-08-08）：survey-db units_seen 聚合为敌方活动热力图
  // （16×16 桶，兵力构成/新鲜度）——地图「敌情热区」层 + 联盟威胁先验。
  // ?tenant=all|t1..t4&window=2000。30s 缓存。
  const tenant = c.req.query("tenant") ?? "all";
  if (tenant !== "all" && !TENANTS.includes(tenant as (typeof TENANTS)[number])) {
    return c.json({ error: "非法租户" }, 400);
  }
  const windowRaw = Number(c.req.query("window") ?? 2000);
  const windowTicks = Number.isFinite(windowRaw) ? Math.min(Math.max(windowRaw, 100), 50_000) : 2000;
  return c.json(loadEnemyHeat(tenant, windowTicks));
});

// ---------- 人类指挥：指令/意图/模式（数据层，仅本机可写） ----------
const VALID_ACTION_TYPES = new Set([
  "WAIT", "MOVE", "HARVEST", "DEPOSIT", "SWEEP", "SHOOT", "PICKUP_BEACON", "DROP_BEACON",
  "SELF_DESTRUCT", "HEAL", "REPAIR_SHIELD", "SPAWN", "START_MOVE", "CANCEL_MOVE",
]);
const validTenant = (t: string | undefined): t is string => !!t && TENANTS.includes(t as (typeof TENANTS)[number]);
/** 核心移动中守卫（2026-08-08）：手操目标是本租户核心且核心正在移动 → 立即拒绝并给
 *  明确原因（否则 agent 端静默拒绝——t3 404 次 "Core is already moving" 实证）。 */
function coreMovingGuard(tenant: string, unitId: string): { blocked: boolean; coreId: string | null } {
  return loadCoreMovingGuard(tenant, unitId);
}

app.get("/api/commands", (c) => {
  const tenant = c.req.query("tenant") ?? "";
  if (!validTenant(tenant)) return c.json({ error: "非法租户" }, 400);
  const store = reconcileHumanStore(tenant);
  return c.json({ ...store, telemetry: latestHumanOverride(tenant), stuck: stuckRecord(tenant) });
});
app.get("/api/audit/decisions", (c) => {
  // 决策-结果审计（2026-08-08，综合决策 + 日志系统）：telemetry decision/outcome
  // 尾部聚合——动作构成/意图 top/planHash 振荡/停摆 tick + 交付成功率/经济吞吐/
  // 满载率/人类覆盖执行。?tenant=all|tN&window=3000。30s 缓存 + 启动预热。
  const tenant = c.req.query("tenant") ?? "all";
  if (tenant !== "all" && !TENANTS.includes(tenant as (typeof TENANTS)[number])) {
    return c.json({ error: "非法租户" }, 400);
  }
  const w = Number(c.req.query("window") ?? DEFAULT_AUDIT_WINDOW);
  const window = Number.isFinite(w) ? Math.min(Math.max(w, 200), 20_000) : DEFAULT_AUDIT_WINDOW;
  return c.json(loadDecisionAudit(tenant, window));
});
app.get("/api/audit/decisions/trend", (c) => {
  // 决策-结果趋势（2026-08-08，综合决策）：尾部 decision/outcome 切 N 窗口，
  // 看 stall/planChurn/cargoEff/coreDelta 是否在改善。?tenant=tN&window=500&steps=6。
  const tenant = c.req.query("tenant") ?? "t1";
  if (tenant !== "all" && !TENANTS.includes(tenant as (typeof TENANTS)[number])) {
    return c.json({ error: "非法租户" }, 400);
  }
  if (tenant === "all") return c.json({ error: "趋势仅支持单租户" }, 400);
  const w = Number(c.req.query("window") ?? 500);
  const window = Number.isFinite(w) ? Math.min(Math.max(w, 100), 2000) : 500;
  const s = Number(c.req.query("steps") ?? 6);
  const steps = Number.isFinite(s) ? Math.min(Math.max(s, 2), 12) : 6;
  return c.json(loadDecisionTrend(tenant, window, steps));
});
app.get("/api/audit/workers", (c) => {
  // Worker 局部活性审计：静态假活/MOVE 无效果/小环振荡/拥挤饥饿。
  // ?tenant=all|tN&window=4000；只读 runtime.jsonl，5s cache。
  const tenant = c.req.query("tenant") ?? "all";
  if (tenant !== "all" && !TENANTS.includes(tenant as (typeof TENANTS)[number])) {
    return c.json({ error: "非法租户" }, 400);
  }
  const w = Number(c.req.query("window") ?? 4000);
  const window = Number.isFinite(w) ? Math.min(Math.max(Math.floor(w), 200), 20_000) : 4000;
  return c.json(loadWorkerLivenessAudit(tenant, window));
});
app.get("/api/audit/lifecycle", (c) => {
  // 生命周期审计（2026-08-08）：单位/矿物/核心生命周期标注 + 消费汇总。
  // 读最新 run 的 calibration 事件（只读），30s 缓存 + 启动预热，不进周期循环。
  // ?tenant=all|tN。units 按末见 tick 降序；mines 按格聚合（含刷新间隔）。
  const tenant = c.req.query("tenant") ?? "all";
  if (tenant !== "all" && !TENANTS.includes(tenant as (typeof TENANTS)[number])) {
    return c.json({ error: "非法租户" }, 400);
  }
  return c.json(loadLifecycleAudit(tenant));
});
app.get("/api/alliance/mining", (c) => {
  // 联盟级采矿分工（2026-08-08）：各租户可见未开采候选 → 就近观测租户分配。
  // 只读组合（快照核心位置 + 共享测绘 observers + 冲突），30s 缓存 + 启动预热。
  return c.json(loadAllianceMining());
});
app.get("/api/audit/alignment", (c) => {
  // 决策-分配对齐审计（2026-08-08，综合决策 + 执行闭环）：决策采集动作占比 vs
  // 矿缺口/分工兑现——一次调用看出"分配了为什么没人采"（采集占比低=决策脱节，
  // 分工 0 兑现=执行没派）。只读组合 30s 缓存 + 预热，不进周期循环。
  return c.json(loadAlignmentAudit());
});
app.get("/api/audit/trail", (c) => {
  // 统一审计流水（2026-08-08，综合调试）：human + command + arbitration + supervisor
  // 四源 jsonl 归一 → 时间倒序 "什么时候发生了什么"。?tenant=&source=&limit= 过滤。
  // 只读（readJsonlTail 尾读），30s 惰性缓存 + 启动预热，不进周期循环。
  const tenant = c.req.query("tenant") ?? undefined;
  const src = c.req.query("source") ?? undefined;
  if (tenant !== undefined && tenant !== "all" && !TENANTS.includes(tenant as (typeof TENANTS)[number])) {
    return c.json({ error: "非法租户" }, 400);
  }
  if (src !== undefined && !["human", "command", "arbitration", "supervisor"].includes(src)) {
    return c.json({ error: "非法来源" }, 400);
  }
  const l = Number(c.req.query("limit") ?? 200);
  const limit = Number.isFinite(l) ? Math.min(Math.max(Math.round(l), 1), 500) : 200;
  return c.json(loadAuditTrail({ tenant: tenant === "all" ? undefined : tenant, source: src as never, limit }));
});
app.get("/api/alliance/survey/mining", (c) => {
  // 全联盟矿 + 分工兑现标注（2026-08-08，共享测绘设计增强）：共识矿 join
  // 分工兑现状态（assignedTenant/miningStatus/gapAgeTicks）+ 积压 topStale——
  // 前端"全联盟矿"地图层一次拿齐，标"已分工未采"。只读组合，30s 缓存 + 预热。
  return c.json(loadConsensusMining());
});
app.get("/api/audit/mining-effectiveness", (c) => {
  // 分工矿兑现校验（2026-08-08，闭环反馈）：alliance/mining 分配 → 实际是否被采。
  // 每分配格状态 harvested/harvestedByOther/open/stale + 首采耗时 + 兑现率；
  // 只读组合（30s 缓存），供决策线修正分配模型（距离不是唯一因素）。不进周期循环。
  return c.json(loadMiningEffectiveness());
});
app.get("/api/audit/overview", (c) => {
  // 综合审计总览（2026-08-08）：决策-结果 + 生命周期 + 矿利用 + 联盟探索 + 管线健康
  // 单调用合成——前端"综合态势"面板一次拉取。纯组合（复用各 30s 缓存），只读。
  return c.json(loadAuditOverview());
});
app.get("/api/audit/mines/trend", (c) => {
  // 矿利用趋势（2026-08-08，共享记忆）：可见未开采缺口在扩大还是缩小。
  // ?tenant=tN&window=2000&steps=6。累计 last_seen 近似（近期窗口准确），只读 survey-db。
  const tenant = c.req.query("tenant") ?? "t1";
  if (tenant !== "all" && !TENANTS.includes(tenant as (typeof TENANTS)[number])) {
    return c.json({ error: "非法租户" }, 400);
  }
  if (tenant === "all") return c.json({ error: "趋势仅支持单租户" }, 400);
  const w = Number(c.req.query("window") ?? 2000);
  const window = Number.isFinite(w) ? Math.min(Math.max(w, 500), 4000) : 2000;
  const s = Number(c.req.query("steps") ?? 6);
  const steps = Number.isFinite(s) ? Math.min(Math.max(s, 2), 10) : 6;
  return c.json(loadMineUtilizationTrend(tenant, window, steps));
});
app.get("/api/audit/mines", (c) => {
  // 矿发现-利用缺口审计（2026-08-08）：survey-db 只读——已发现未开采矿
  // （visibleNever 立即分配候选 / staleNever 历史遗留）+ 利用率 + 发现→首采耗时。
  // ?tenant=all|tN。30s 缓存 + 启动预热，不进周期循环。
  const tenant = c.req.query("tenant") ?? "all";
  if (tenant !== "all" && !TENANTS.includes(tenant as (typeof TENANTS)[number])) {
    return c.json({ error: "非法租户" }, 400);
  }
  return c.json(loadMineUtilization(tenant));
});
app.get("/api/audit/human/conflicts", (c) => {
  // 人机协同冲突审计（2026-08-08）：手操 vs 自动的冲突量化——applied/rejected、
  // 拒绝原因 top（t3 "Core is already moving" 404 次实证）、手操类型构成。
  // outcome 尾部 + human-command-audit 只读；30s 缓存 + 启动预热，不进周期循环。
  const tenant = c.req.query("tenant") ?? "all";
  if (tenant !== "all" && !TENANTS.includes(tenant as (typeof TENANTS)[number])) {
    return c.json({ error: "非法租户" }, 400);
  }
  const w = Number(c.req.query("window") ?? 3000);
  const window = Number.isFinite(w) ? Math.min(Math.max(w, 200), 20_000) : 3000;
  return c.json(loadHumanConflict(tenant, window));
});
app.get("/api/audit/human", (c) => {
  // 人类指挥审计（2026-08-08）：手操流水（指令/目标/模式/清空/删除），
  // 重启不丢——复盘"什么时候手操了什么"。?tenant=tN&limit=100。
  const tenant = c.req.query("tenant") ?? "";
  const l = Number(c.req.query("limit") ?? 100);
  const limit = Number.isFinite(l) ? Math.round(l) : 100;
  const records = loadHumanAudit(tenant && validTenant(tenant) ? tenant : undefined, limit);
  return c.json({ generatedAt: new Date().toISOString(), tenant: tenant || "all", count: records.length, records });
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
  const guard = coreMovingGuard(tenant, b.unitId);
  if (guard.blocked) {
    appendHumanAudit({ at: new Date().toISOString(), tenant, kind: "command", unitId: b.unitId, action: String((b.action as { type?: unknown }).type ?? "?"), note: "rejected: 核心移动中，指令未提交" });
    return c.json({ ok: false, error: "核心移动中，指令未提交（等待移动完成后再操作）", reason: "core_moving" }, 409);
  }
  store.commands = store.commands.filter((x) => x.unitId !== b.unitId).concat(cmd);
  const out = writeHumanStore(tenant, store);
  console.log(`[human-cmd] ${tenant} ${b.unitId} ${JSON.stringify(b.action)}`);
  appendHumanAudit({ at: new Date().toISOString(), tenant, kind: "command", unitId: b.unitId, action: String((b.action as { type?: unknown }).type ?? "?"), note: typeof b.note === "string" ? b.note : undefined });
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
  const guard = coreMovingGuard(tenant, b.unitId);
  if (guard.blocked) {
    appendHumanAudit({ at: new Date().toISOString(), tenant, kind: "goal", unitId: b.unitId, action: `${b.kind} [${b.target[0]},${b.target[1]}]`, note: "rejected: 核心移动中，指令未提交" });
    return c.json({ ok: false, error: "核心移动中，指令未提交（等待移动完成后再操作）", reason: "core_moving" }, 409);
  }
  const goalInput = {
    unitId: String(b.unitId),
    kind: b.kind as "mine" | "goto",
    target: [b.target[0] as number, b.target[1] as number] as [number, number],
    note: typeof b.note === "string" ? b.note : undefined,
  };
  const { outcome, goals } = applyGoalMutation(store, goalInput, Date.now());
  if (!outcome.applied) {
    appendHumanAudit({ at: new Date().toISOString(), tenant, kind: "goal_dup", unitId: goalInput.unitId, action: `${goalInput.kind} [${goalInput.target[0]},${goalInput.target[1]}]`, note: `窗口内去重，未重写（现有 goal ${outcome.goalId}）` });
    const existing = store.goals.find((g) => g.id === outcome.goalId);
    return c.json({ ok: true, goal: existing ?? null, deduped: true, mode: store.mode, total: store.goals.length });
  }
  store.goals = goals as typeof store.goals;
  const out = writeHumanStore(tenant, store);
  console.log(`[human-goal] ${tenant} ${goalInput.unitId} ${goalInput.kind} [${goalInput.target[0]}, ${goalInput.target[1]}]`);
  appendHumanAudit({ at: new Date().toISOString(), tenant, kind: "goal", unitId: goalInput.unitId, action: `${goalInput.kind} [${goalInput.target[0]},${goalInput.target[1]}]`, note: typeof goalInput.note === "string" ? goalInput.note : undefined });
  const goal = store.goals.find((g) => g.id === outcome.goalId);
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
  appendHumanAudit({ at: new Date().toISOString(), tenant, kind: "delete", unitId: b.unitId, action: `scope=${scope}` });
  return c.json({ ok: true, mode: out.mode, total: out.commands.length + out.goals.length });
});
app.post("/api/command/clear", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const tenant = String(b.tenant ?? "");
  if (!validTenant(tenant)) return c.json({ error: "非法租户" }, 400);
  const store = readHumanStore(tenant);
  store.commands = []; store.goals = [];
  const out = writeHumanStore(tenant, store);
  appendHumanAudit({ at: new Date().toISOString(), tenant, kind: "clear" });
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
  appendHumanAudit({ at: new Date().toISOString(), tenant, kind: "mode", action: mode });
  return c.json({ ok: true, mode, message: mode === "override" ? "人类指挥已启用（手操优先于 agent）" : "人类指挥已停用（交还 agent 全权）" });
});

// ---------- 官方商店代理 ----------
app.get("/api/shop/history", (c) => {
  // 商店价格历史（2026-08-08，数据记录层）：products 快照落盘 → 涨跌/库存变化
  // 趋势（不依赖登录 cookie，请求驱动刷新）。只读，30s 缓存。
  return c.json(loadShopHistory());
});
app.post("/api/shop/history/refresh", async (c) => {
  // 手动/请求驱动快照（无计划任务）：拉官方 products，有变化才追加落盘。
  try {
    const r = await refreshShopHistory();
    return c.json(r);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "刷新失败" }, 502);
  }
});
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
  const rec: RedeemRecord = { codeMask: code.slice(0, 6) + "***", at: new Date().toISOString(), ip: c.req.header("x-forwarded-for") ?? "local", status: "pending" };
  redeemLog.push(rec);
  appendRedeemRecord(rec); // 落盘 JSONL（重启不丢，只存掩码不存完整码）
  console.log(`[redeem] code=${code.slice(0, 6)}... at=${rec.at}`);
  return c.json({
    status: "pending",
    message: "兑换通道待 cookie 配置：申请已记录，接入官方 API 后即可完成兑换。",
    receivedAt: rec.at,
    historyLength: redeemLog.length,
  });
});
// 兑换历史查询（2026-08-08）：面板可回看已提交的兑换申请（掩码/时间/来源），
// 重启不丢——审计与联调用，只返回最近窗口。
app.get("/api/redeem/history", (c) => {
  return c.json({ generatedAt: new Date().toISOString(), records: loadRedeemHistory(), count: redeemLog.length });
});

// ---------- Agent 遥测桥（2026-08-09，agent-telemetry-bridge-v1） ----------

// SDK 遥测唯一写入口（agents/agent_events 单一 writer）。只接受已知租户；
// 事件 schema 见 docs/design/agent-telemetry-bridge-v1.md §4。
app.post("/api/ingest/agents", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { events?: unknown } | null;
  if (!body || !Array.isArray(body.events) || body.events.length === 0) {
    return c.json({ error: "events 数组必填" }, 400);
  }
  let accepted = 0;
  const open: Array<{ tenant: string; db: DatabaseSync }> = [];
  try {
    for (const raw of body.events) {
      const ev = raw as Record<string, unknown>;
      const tenant = String(ev.tenant ?? "");
      const kind = String(ev.event ?? "");
      // 白名单：生产租户 t1-t4 + 模拟器 sim- 前缀命名空间（agent-telemetry-bridge-v1 §3.4）
      const tenantOk = TENANTS.includes(tenant as (typeof TENANTS)[number]) || tenant.startsWith("sim-");
      if (!tenantOk) continue;
      if (!["register", "connection", "tick_summary", "disconnected"].includes(kind)) continue;
      const held = open.find((o) => o.tenant === tenant);
      const db = held?.db ?? openAgentDb(tenant, true);
      if (!held) open.push({ tenant, db });
      applyAgentEvent(db, ev as never);
      accepted += 1;
    }
  } finally {
    for (const o of open) o.db.close();
  }
  return c.json({ accepted, at: new Date().toISOString() });
});

// Agent 统一台账视图：自有（TS 数据流）+ 第三方（SDK 心跳）同屏。
app.get("/api/agents", async (c) => {
  const sup = await supervisorState();
  const overview = loadOverview(sup);
  const result = [];
  for (const tenant of TENANTS) {
    const ov = overview.tenants.find((t) => t.tenant === tenant) ?? null;
    let agent: AgentRow | null = null;
    let events: Array<Record<string, unknown>> = [];
    let db: DatabaseSync | null = null;
    try {
      db = openAgentDb(tenant, false);
      agent = knownAgent(db, tenant);
      events = recentAgentEvents(db, tenant, 20);
    } catch {
      // 库尚未创建：无台账数据
    } finally {
      db?.close();
    }
    const world = loadWorld(tenant) as { state?: { objects?: unknown[]; resources?: number; population?: number } | null; tick?: number | null } | null;
    const coreObj = Array.isArray(world?.state?.objects)
      ? (world.state.objects as Array<{ kind?: string; controlled?: boolean; position?: readonly [number, number] }>)
          .find((o) => o.kind === "CORE" && o.controlled === true) ?? null
      : null;
    result.push({
      tenant,
      source: agent ? "sdk" : "ts",
      live: ov?.live ?? false,
      supervisor: ov?.supervisor ?? null,
      agent,
      latest: agent
        ? {
            tick: agent.tick,
            resources: agent.resources,
            population: agent.population,
            core: agent.coreX !== null && agent.coreY !== null ? [agent.coreX, agent.coreY] : null,
            units: agent.units,
            visibleEnemies: agent.visibleEnemies,
            status: agent.status,
            heartbeatAt: agent.lastHeartbeat,
          }
        : {
            tick: ov?.latest?.tick ?? null,
            resources: ov?.latest?.resources ?? null,
            population: ov?.latest?.workers ?? null,
            core: coreObj?.position ? [coreObj.position[0], coreObj.position[1]] : null,
            units: null,
            visibleEnemies: null,
            status: null,
            heartbeatAt: null,
          },
      events,
    });
  }
  return c.json({ generatedAt: new Date().toISOString(), agents: result });
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
    const st = statSync(filePath);
    const ext = filePath.slice(filePath.lastIndexOf("."));
    const etag = `W/"${Math.floor(st.mtimeMs / 1000)}-${st.size}"`;
    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { etag, "cache-control": "no-cache" } });
    }
    // 字体/位图 immutable（内容寻址或极少变更）；js/css/html 协商缓存（304 零传输）
    const immutable = ext === ".woff2" || ext === ".png" || ext === ".webp" || ext === ".jpg" || ext === ".jpeg" || ext === ".ico" || ext === ".svg";
    const cacheControl = immutable ? "public, max-age=31536000, immutable" : "no-cache";
    return new Response(readFileSync(filePath), {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        etag,
        "last-modified": st.mtime.toUTCString(),
        "cache-control": cacheControl,
      },
    });
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
// public/ 仅 assets（字体/图，React 引用）+ style.css（Vite 构建打包，dev 兜底）
app.get("/assets/*", (c) => servePublic(c, c.req.path.slice(1)));
app.get("/style.css", (c) => serveFile(c, join(PUBLIC_DIR, "style.css")));
// legacy /styles/* /js/* 路由随 app.js/index.html 退役删除（2026-08-09 neat-freak）
app.notFound((c) => c.json({ error: "not found", path: c.req.path }, 404));

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
  // 联盟情报（intel）冷扫描 2.7s 同步阻塞事件循环——只在启动预热一次
  // （setTimeout 0，不阻塞首次 listen），不进周期循环；过期后按请求惰性
  // 刷新（内部 30s 缓存，原有行为）。周期循环只做轻量刷新。
  setTimeout(() => { try { loadAllianceIntel(); } catch { /* 忽略 */ } }, 0);
  // 决策审计（重 I/O 尾部截读）：启动预热一次，不进 30s 周期循环（请求惰性 30s 缓存）。
  setTimeout(() => { try { warmDecisionAudit(); } catch { /* 忽略 */ } }, 50);
  // 决策趋势（尾部只读）：启动预热一次，不进周期循环。
  setTimeout(() => { try { warmDecisionTrend(); } catch { /* 忽略 */ } }, 55);
  // 生命周期审计（重 I/O 全 case 解析）：启动预热一次，不进周期循环（请求惰性 30s 缓存）。
  setTimeout(() => { try { warmLifecycleAudit(); } catch { /* 忽略 */ } }, 60);
  // 矿利用审计（survey-db 只读）：启动预热一次，不进周期循环（请求惰性 30s 缓存）。
  setTimeout(() => { try { warmMineUtilization(); } catch { /* 忽略 */ } }, 70);
  // 矿利用趋势（survey-db 只读）：启动预热一次，不进周期循环。
  setTimeout(() => { try { warmMineUtilizationTrend(); } catch { /* 忽略 */ } }, 75);
  // 综合审计总览（复用子审计缓存）：启动预热一次，不进周期循环。
  setTimeout(() => { try { warmAuditOverview(); } catch { /* 忽略 */ } }, 80);
  // 人机冲突审计（尾部只读）：启动预热一次，不进周期循环。
  setTimeout(() => { try { warmHumanConflict(); } catch { /* 忽略 */ } }, 90);
  // Worker 活性审计（runtime.jsonl 异常尾读）：启动预热一次，5s 惰性缓存。
  setTimeout(() => { try { warmWorkerLivenessAudit(); } catch { /* 忽略 */ } }, 95);
  // 联盟采矿分工（只读组合）：启动预热一次，不进周期循环。
  setTimeout(() => { try { warmAllianceMining(); } catch { /* 忽略 */ } }, 100);
  setTimeout(() => { try { warmMiningEffectiveness(); } catch { /* 忽略 */ } }, 105);
  setTimeout(() => { try { warmAuditTrail(); } catch { /* 忽略 */ } }, 108);
  setTimeout(() => { try { warmConsensusMining(); } catch { /* 忽略 */ } }, 110);
  setTimeout(() => { try { warmAlignmentAudit(); } catch { /* 忽略 */ } }, 115);
  setTimeout(() => { try { warmDecisionInput(); } catch { /* 忽略 */ } }, 120);
  setTimeout(() => { try { warmMapLod(); } catch { /* 忽略 */ } }, 125);
  const warmLight = (): void => {
    try {
      refreshAllianceSurvey(); // 共享测绘聚合 30s 缓存（读 survey 内存缓存，快）
      refreshAllianceSnapshot(); // 联盟态势快照 30s 缓存（读 survey/世界缓存，快）
      refreshAllianceCluster(); // 联盟集群态势 30s 缓存（抱团观测）
      refreshAllianceAdvice(); // 联盟参谋建议 30s 缓存（读快照/共享测绘缓存，快）
      refreshEnemyHeat(); // 敌情热区 30s 缓存（读 units_seen 聚合，快）
      refreshPipelineHealth(); // 数据管线健康 15s 缓存（读 survey 水位/世界，快）
      refreshAllianceDeeds(); // 联盟事迹 45s 缓存（读快照/共享测绘/热区缓存，快）
      void refreshDeedsJournal(); // 事迹日记摘要 30s 缓存（读 deeds 缓存，快）
      maybeRefreshLeaderboardLazy(); // 排行榜惰性刷新检查（无计划任务：stale 且间隔到才后台拉）
      refreshMinePatterns(); // 矿生命周期模式 30s 缓存（读 survey-db，快）
      refreshAllianceExploration(); // 联盟探索覆盖 30s 缓存（读 survey chunks，快）
      void supervisorState(); // 8120 健康状态 5s 缓存（/api/overview、/api/tenants 首开即快）
    } catch { /* 数据缺失/临时 IO 失败不阻塞启动 */ }
  };
  warmLight();
  setInterval(warmLight, 30_000);
  console.log("后台预热：测绘 30s / 事迹 45s / 联盟情报 + 共享测绘 30s 已启动");
});
