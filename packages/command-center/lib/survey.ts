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
}

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
    const resources = db.prepare(
      "SELECT x, y, last_seen_tick AS tick, state, seen_count AS seenCount FROM resources ORDER BY last_seen_tick DESC",
    ).all() as Array<Record<string, unknown>>;
    const obstacles = db.prepare(
      "SELECT x, y, last_seen_tick AS tick FROM obstacles ORDER BY last_seen_tick DESC",
    ).all() as Array<Record<string, unknown>>;
    const cores = db.prepare(
      "SELECT x, y, last_seen_tick AS tick, owner, source FROM core_hunts ORDER BY last_seen_tick DESC",
    ).all() as Array<Record<string, unknown>>;
    const meta = db.prepare("SELECT MAX(last_tick) AS m, SUM(cases_synced) AS c FROM sync_meta").get() as { m: number | null; c: number | null };
    return {
      obstacleCells: obstacles,
      resourceCells: resources,
      coreCells: cores,
      caseCount: Number(meta?.c ?? 0),
      tickMax: Number(meta?.m ?? 0),
      fromDb: true,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** 生命周期摘要：从测绘库读 unit_lifecycle / core_spends / resource_events
 *  聚合（单位/矿物标注 + 消费记账）。库缺失 = null。 */
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
    return {
      units,
      spends,
      harvestCount: Number(harvests?.count ?? 0),
      lastHarvestTick: harvests?.last_tick === null ? null : Number(harvests?.last_tick ?? 0),
      harvestFailCount: Number(fails?.count ?? 0),
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