/**
 * 测绘与生命周期：
 *  - survey-db（node:sqlite 只读跨 run 完整测绘，优先于 calibration 扫描）；
 *  - 累积测绘 loadSurvey（同一 run 全部 case 合并已知地形，前端 fog 记忆层）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_ROOT, calibrationDir, cellKey, latestRunDir, listCases, parseTick } from "./fs-jsonl.ts";

export interface SurveyData {
  obstacleCells: Array<Record<string, unknown>>;
  resourceCells: Array<Record<string, unknown>>;
  coreCells: Array<Record<string, unknown>>;
  unitCells?: Array<Record<string, unknown>>;
  caseCount: number;
  tickMax: number;
  fromDb?: boolean;
  tenant?: string;
  runId?: string;
  /** 探索分区（chunks 表，2026-08-08）：16×16 chunk 最后探索 tick，前端 Fog 层用。 */
  chunks?: Array<Record<string, unknown>>;
}

/** 矿格级新鲜度窗口（全库共享，2026-08-08 数据质量一致性）：
 *  mine-patterns / mine-utilization / survey 三处统一引用此常量，避免“同一矿地图显示 stale 但审计显示 visible”的状态分歧。
 *  注：chunk 级探索覆盖窗口（exploration-coverage FRESH_WINDOW_TICKS=2000）是区域探索频率，与矿格级不同类。 */
/**
 * 矿新鲜度窗口（2026-08-08，数据质量 A6）：last_seen 超过该 tick 数视为历史残留（state=stale）。
 * 窗口按 refill 周期实证（同格 re-appear gap：最短 2 tick、均值 ~37 tick）取 200：
 * 矿被采后 2-6 tick 消失、4 tick 结算后可能 refill——200 tick 内未再目击 ≈ 该格
 * 已长期不在视野（可能被采空或 agent 已离开），标 stale 待确认，不再当活跃矿。
 */
export const RESOURCE_FRESH_WINDOW_TICKS = 200;

/** 测绘库（survey-db）：优先于 calibration 扫描——calibration case 只覆盖
 *  "最新 run 已同步 tick"，测绘库累积全部历史 run 的资源/障碍/敌核心
 *  （node:sqlite 只读）。返回形状与 loadSurvey 兼容（前端 tactSurveyLayer
 *  直接消费），资源格额外带 state/seenCount 供状态着色。库缺失/空 = null。 */
export function loadSurveyDb(tenant: string): SurveyData | null {
  const file = join(DATA_ROOT, "runtime", "survey", `${tenant}.db`);
  if (!existsSync(file)) return null;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const resourcesRaw = db.prepare(
      "SELECT x, y, last_seen_tick AS tick, first_seen_tick AS firstSeenTick, state, seen_count AS seenCount FROM resources ORDER BY last_seen_tick DESC",
    ).all() as Array<Record<string, unknown>>;
    // 矿采集状态（2026-08-08，数据质量 A8）：每格矿聚合 resource_events
    // 的采集次数/最近采集 tick——“哪些矿在被采/已被采过”供 agent
    // 分配与前端矿生命周期可视化。
    const harvestAgg = db.prepare(
      "SELECT cell, COUNT(*) AS n, MAX(tick) AS lastTick FROM resource_events WHERE event_type = 'HARVEST_SUCCEEDED' GROUP BY cell",
    ).all() as Array<{ cell: string; n: number; lastTick: number }>;
    const harvestByCell = new Map(harvestAgg.map((h) => [h.cell, h]));
    const obstacles = db.prepare(
      "SELECT x, y, last_seen_tick AS tick FROM obstacles ORDER BY last_seen_tick DESC",
    ).all() as Array<Record<string, unknown>>;
    const coreRows = db.prepare(
      "SELECT x, y, last_seen_tick AS tick, owner, source FROM core_hunts ORDER BY last_seen_tick DESC",
    ).all() as Array<Record<string, unknown>>;
    // 地图层核心按 owner 合并（2026-08-08 数据质量 A5）：同一玩家核心迁移产生多格
    // core_hunts 记录，原始行直接给前端会显示“双核”——非 null owner 保留
    // 最新位置（last_seen 最大），null owner（无主核心）按格独立保留。
    const seenOwners = new Set<string>();
    const cores: Array<Record<string, unknown>> = [];
    for (const r of coreRows) {
      const owner = typeof r.owner === "string" && r.owner.length > 0 ? r.owner : null;
      if (owner !== null) {
        if (seenOwners.has(owner)) continue;
        seenOwners.add(owner);
      }
      cores.push(r);
    }
    const meta = db.prepare("SELECT MAX(last_tick) AS m, SUM(cases_synced) AS c FROM sync_meta").get() as { m: number | null; c: number | null };
    // 矿新鲜度动态分级（2026-08-08，数据质量 A6 → 生命周期闭环）：state 优先级 =
    // 持久化负态（harvested/empty，survey-sync 事件回写）> 新鲜度派生
    // （visible 窗口内 / stale 超窗口）。此前用 fresh 窗口无条件覆盖 DB state，
    // 采空/确认空的矿永远显示 visible（"过时矿"根因）。前端默认只看 visible。
    const tickMax = Number(meta?.m ?? 0);
    const resources: Array<Record<string, unknown>> = (resourcesRaw as Array<Record<string, unknown>>).map((r) => {
      const lastSeen = Number(r.tick ?? 0);
      const ageTicks = tickMax > 0 && Number.isFinite(lastSeen) ? Math.max(0, tickMax - lastSeen) : 0;
      const fresh = ageTicks <= RESOURCE_FRESH_WINDOW_TICKS;
      const harvest = harvestByCell.get(`${String(r.x)},${String(r.y)}`);
      // 持久化负态优先（survey-sync 由采集事件回写）；仅当 DB 无负态时才按新鲜度派生
      const dbState = String(r.state ?? "");
      const state = dbState === "harvested" || dbState === "empty"
        ? dbState
        : fresh ? "visible" : "stale";
      return {
        ...r, ageTicks, fresh, state,
        harvestCount: harvest?.n ?? 0,
        lastHarvestTick: harvest?.lastTick ?? null,
      };
    });
    const chunks = (db.prepare(
      "SELECT chunk_key AS key, last_seen_tick AS lastSeenTick FROM chunks ORDER BY last_seen_tick DESC",
    ).all() as Array<Record<string, unknown>>).map((r) => {
      const [cx, cy] = String(r.key).split(",").map(Number);
      return { ...r, cx, cy };
    });
    return {
      obstacleCells: obstacles,
      resourceCells: resources,
      coreCells: cores,
      caseCount: Number(meta?.c ?? 0),
      tickMax: Number(meta?.m ?? 0),
      fromDb: true,
      chunks,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}


/** 探索分区（chunks 表，2026-08-08）：跨 run 累积的 16×16 chunk 最后探索 tick，
 *  供前端 Fog 层渲染「探索过的范围」（未探索分区自然暗色）。库缺失/空 = 空数组。 */
export function loadChunksDb(tenant: string, maxAgeTicks = 20_000): Array<Record<string, unknown>> {
  const file = join(DATA_ROOT, "runtime", "survey", `${tenant}.db`);
  if (!existsSync(file)) return [];
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const rows = db.prepare(
      "SELECT chunk_key AS key, last_seen_tick AS lastSeenTick FROM chunks ORDER BY last_seen_tick DESC",
    ).all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return [];
    let maxTick = 0;
    for (const r of rows) if (Number(r.lastSeenTick) > maxTick) maxTick = Number(r.lastSeenTick);
    const cutoff = maxTick - maxAgeTicks;
    const out: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      if (Number(r.lastSeenTick) < cutoff) continue;
      const key = String(r.key);
      const [cx, cy] = key.split(",").map(Number);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      out.push({ key, cx, cy, lastSeenTick: Number(r.lastSeenTick) });
    }
    return out;
  } catch {
    return [];
  } finally {
    db.close();
  }
}
/** 生命周期摘要：从测绘库读 unit_lifecycle / core_spends / resource_events
 *  聚合（单位/矿物标注 + 消费记账），并带最近阵亡明细（面板舰队索引展示）。
 *  库缺失 = null。 */
export function loadLifecycleDb(tenant: string): Record<string, unknown> | null {
  const file = join(DATA_ROOT, "runtime", "survey", `${tenant}.db`);
  if (!existsSync(file)) return null;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const units = db.prepare(
      "SELECT current_state AS state, unit_type AS type, COUNT(*) AS count FROM unit_lifecycle GROUP BY state, unit_type",
    ).all() as Array<Record<string, unknown>>;
    const spends = db.prepare(
      "SELECT kind, COUNT(*) AS count, SUM(amount) AS total FROM core_spends GROUP BY kind ORDER BY total DESC",
    ).all() as Array<Record<string, unknown>>;
    const harvests = db.prepare(
      "SELECT COUNT(*) AS count, MAX(tick) AS last_tick FROM resource_events WHERE event_type = 'HARVEST_SUCCEEDED'",
    ).get() as { count: number; last_tick: number | null };
    const fails = db.prepare(
      "SELECT COUNT(*) AS count FROM resource_events WHERE event_type = 'HARVEST_FAILED'",
    ).get() as { count: number };
    const recentDeaths = db.prepare(
      "SELECT unit_type AS type, birth_tick AS birthTick, death_tick AS deathTick, death_pos AS deathPos, death_reason AS deathReason FROM unit_lifecycle WHERE death_tick IS NOT NULL ORDER BY death_tick DESC LIMIT 8",
    ).all() as Array<Record<string, unknown>>;
    return {
      units,
      spends,
      harvestCount: Number(harvests?.count ?? 0),
      lastHarvestTick: harvests?.last_tick === null ? null : Number(harvests?.last_tick ?? 0),
      harvestFailCount: Number(fails?.count ?? 0),
      recentDeaths,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** 测绘累积缓存：每个租户同一 run 的全部 calibration case 合并出的已知地形（探索过的范围）。 */
const surveyCache = new Map<string, { runId: string; survey: SurveyData }>(); // tenant -> { runId, survey }

/**
 * 累积测绘：遍历同一 run 全部 cases（同一世界连续 tick 采样），
 * 把每个 case "当前看到的物体子集"（obstacle/resource 静态地形）去重累积成完整地形；
 * core/unit 保留最后看到的位置（动态层）。
 */
export function loadSurvey(tenant: string): SurveyData | null {
  const runDir = latestRunDir(tenant);
  if (!runDir) return null;
  const cached = surveyCache.get(tenant);
  if (cached && cached.runId === runDir) return cached.survey;
  const caseFiles = listCases(tenant, runDir);
  if (!caseFiles.length) return null;
  const obstacle = new Map<string, { x: number; y: number; tick: number }>(), resource = new Map<string, { x: number; y: number; tick: number }>();
  const cores = new Map<string, { x: number; y: number; tick: number; hp?: number; shield?: number; controlled?: boolean; owner?: string | null }>();
  const units = new Map<string, { x: number; y: number; tick: number; unitType?: string; controlled?: boolean; hp?: number }>();
  let tickMax = 0, caseCount = 0;
  for (const file of caseFiles) {
    const tick = parseTick(file);
    if (tick > tickMax) tickMax = tick;
    const path = join(calibrationDir(tenant), runDir, "cases", file);
    let raw: { before?: { state?: { objects?: Array<Record<string, unknown>> } } } | null = null;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    const state = raw?.before?.state;
    if (!state?.objects) continue;
    caseCount++;
    for (const obj of state.objects) {
      if (obj.kind === "OBSTACLE") {
        for (const [x, y] of (obj.positions as number[][] | undefined) ?? []) obstacle.set(cellKey(x, y), { x, y, tick });
      } else if (obj.kind === "RESOURCE") {
        for (const [x, y] of (obj.positions as number[][] | undefined) ?? []) resource.set(cellKey(x, y), { x, y, tick });
      } else if (obj.kind === "CORE") {
        const [x, y] = (obj.position as number[] | undefined) ?? [0, 0];
        const k = cellKey(x, y);
        const cur = cores.get(k);
        if (!cur || tick > cur.tick) cores.set(k, { x, y, tick, hp: obj.hp as number, shield: obj.shield as number, controlled: obj.controlled as boolean, owner: typeof obj.owner_username === "string" ? obj.owner_username : null });
      } else if (obj.kind === "UNIT") {
        const [x, y] = (obj.position as number[] | undefined) ?? [0, 0];
        const k = cellKey(x, y);
        const cur = units.get(k);
        if (!cur || tick > cur.tick) units.set(k, { x, y, tick, unitType: (obj.unit_type as string | undefined) ?? "WORKER", controlled: obj.controlled as boolean, hp: obj.hp as number });
      }
    }
  }
  const survey: SurveyData = {
    tenant, runId: runDir, caseCount, tickMax,
    obstacleCells: [...obstacle.values()],
    resourceCells: [...resource.values()],
    coreCells: [...cores.values()],
    unitCells: [...units.values()],
  };
  surveyCache.set(tenant, { runId: runDir, survey });
  return survey;
}
/** 矿格生命周期时间线：resource_events 按格返回采集/失败序列（升序），
 *  供前端矿卡展示「发现→采→空→refill」。库缺失/无事件 = 空数组。 */
export function loadResourceTimeline(tenant: string, cell: string): Array<Record<string, unknown>> {
  const file = join(DATA_ROOT, "runtime", "survey", `${tenant}.db`);
  if (!existsSync(file)) return [];
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return [];
  }
  try {
    return db.prepare(
      "SELECT tick, event_type AS eventType, reason_code AS reason, amount, actor_id AS actorId FROM resource_events WHERE cell = ? ORDER BY tick ASC LIMIT 500",
    ).all(cell) as Array<Record<string, unknown>>;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** 消费趋势：core_spends 按 kind × tick 分桶聚合（每桶 N ticks），
 *  供消费审计面板画趋势线。返回 [{bucketStart, kind, count, total}]。 */
export function loadSpendTrend(tenant: string, bucketTicks = 1000): Array<Record<string, unknown>> {
  const file = join(DATA_ROOT, "runtime", "survey", `${tenant}.db`);
  if (!existsSync(file)) return [];
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return [];
  }
  try {
    return db.prepare(
      "SELECT (tick / ?) * ? AS bucketStart, kind, COUNT(*) AS count, SUM(amount) AS total FROM core_spends GROUP BY bucketStart, kind ORDER BY bucketStart ASC, kind",
    ).all(bucketTicks, bucketTicks) as Array<Record<string, unknown>>;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** 单位生命周期明细：每个单位的出生/死亡/最近目击（unit_lifecycle 全量），
 *  供前端单位卡/审计面板。库缺失 = 空数组。 */
export function loadUnitLifecycleDb(tenant: string, limit = 200): Array<Record<string, unknown>> {
  const file = join(DATA_ROOT, "runtime", "survey", `${tenant}.db`);
  if (!existsSync(file)) return [];
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return [];
  }
  try {
    return db.prepare(
      "SELECT unit_id AS unitId, unit_type AS unitType, birth_tick AS birthTick, birth_pos AS birthPos, death_tick AS deathTick, death_pos AS deathPos, death_reason AS deathReason, last_seen_tick AS lastSeenTick, last_seen_pos AS lastSeenPos, current_state AS state FROM unit_lifecycle ORDER BY last_seen_tick DESC LIMIT ?",
    ).all(limit) as Array<Record<string, unknown>>;
  } catch {
    return [];
  } finally {
    db.close();
  }
}