/**
 * 测绘持久化数据库（2026-08-08，用户裁决"地图测绘落实到数据库"）。
 *
 * 用 Node 内置 node:sqlite（Node 22.5+，本仓 .nvmrc=24）零依赖实现跨 run
 * 测绘累积：矿/障碍/敌核心基地/单位目击，从 calibration case 增量同步写入。
 *
 * 位置：<data-root>/runtime/survey/<tenant>.db（runtime 不提交）。
 * 数据源 = calibration case before.state.objects（服务端全量投影）——
 * 比 agent 视野权威：资源存在即标注，跨 run 不丢。
 *
 * 只读约定：本模块只写 survey 库，不碰 telemetry/calibration/生产数据。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type SurveyResourceState = "visible" | "stale" | "harvested" | "empty";

export interface SurveyResourceRow {
  readonly cell: string;
  readonly x: number;
  readonly y: number;
  readonly firstSeenTick: number;
  readonly lastSeenTick: number;
  readonly state: SurveyResourceState;
  readonly lastStateTick: number;
  readonly seenCount: number;
}

export interface SurveyObstacleRow {
  readonly cell: string;
  readonly x: number;
  readonly y: number;
  readonly firstSeenTick: number;
  readonly lastSeenTick: number;
}

export interface SurveyCoreHuntRow {
  readonly cell: string;
  readonly x: number;
  readonly y: number;
  readonly owner: string | null;
  readonly source: "CORE" | "WORKER_INFER";
  readonly firstSeenTick: number;
  readonly lastSeenTick: number;
}

export interface SurveySyncMeta {
  readonly runId: string;
  readonly tenant: string;
  readonly casesSynced: number;
  readonly lastTick: number;
  readonly updatedAt: string;
}

export interface KnownResourceFilter {
  /** 仅返回该状态集合的矿（缺省 = 非 empty/harvested 的活跃矿）。 */
  readonly states?: readonly SurveyResourceState[];
  /** last_seen_tick 距今 ≤ maxAgeTicks（缺省不过滤）。 */
  readonly maxAgeTicks?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS resources (
  cell TEXT PRIMARY KEY,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  first_seen_tick INTEGER NOT NULL,
  last_seen_tick INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'visible',
  last_state_tick INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS obstacles (
  cell TEXT PRIMARY KEY,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  first_seen_tick INTEGER NOT NULL,
  last_seen_tick INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS core_hunts (
  cell TEXT PRIMARY KEY,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  owner TEXT,
  source TEXT NOT NULL DEFAULT 'CORE',
  first_seen_tick INTEGER NOT NULL,
  last_seen_tick INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS units_seen (
  cell TEXT NOT NULL,
  unit_type TEXT NOT NULL,
  controlled INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  PRIMARY KEY (cell, tick)
);
CREATE TABLE IF NOT EXISTS sync_meta (
  run_id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  cases_synced INTEGER NOT NULL DEFAULT 0,
  last_tick INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_last_seen ON resources(last_seen_tick);
CREATE INDEX IF NOT EXISTS idx_core_hunts_last_seen ON core_hunts(last_seen_tick);
`;

/** 打开（或创建）某租户的测绘库。write=true 时确保目录存在。 */
export function openSurveyDb(dataRoot: string, tenant: string, write = false): DatabaseSync {
  const dir = join(dataRoot, "runtime", "survey");
  if (write) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, `${tenant}.db`));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

/** upsert 一组可见矿（服务端投影：资源存在）。返回受影响行数。 */
export function upsertResources(
  db: DatabaseSync,
  cells: readonly { x: number; y: number }[],
  tick: number,
): number {
  const stmt = db.prepare(`
    INSERT INTO resources (cell, x, y, first_seen_tick, last_seen_tick, state, last_state_tick, seen_count)
    VALUES (?, ?, ?, ?, ?, 'visible', ?, 1)
    ON CONFLICT(cell) DO UPDATE SET
      last_seen_tick = excluded.last_seen_tick,
      state = 'visible',
      last_state_tick = excluded.last_state_tick,
      seen_count = resources.seen_count + 1
  `);
  let n = 0;
  for (const cell of cells) {
    const key = `${cell.x},${cell.y}`;
    n += Number(stmt.run(key, cell.x, cell.y, tick, tick, tick).changes);
  }
  return n;
}

/** upsert 障碍。 */
export function upsertObstacles(
  db: DatabaseSync,
  cells: readonly { x: number; y: number }[],
  tick: number,
): number {
  const stmt = db.prepare(`
    INSERT INTO obstacles (cell, x, y, first_seen_tick, last_seen_tick)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cell) DO UPDATE SET last_seen_tick = excluded.last_seen_tick
  `);
  let n = 0;
  for (const cell of cells) {
    const key = `${cell.x},${cell.y}`;
    n += Number(stmt.run(key, cell.x, cell.y, tick, tick).changes);
  }
  return n;
}

/** upsert 敌方核心基地（敌情狩猎 sticky intel）。controlled=false 才记录。 */
export function upsertCoreHunt(
  db: DatabaseSync,
  position: { x: number; y: number },
  owner: string | null,
  source: "CORE" | "WORKER_INFER",
  tick: number,
): number {
  const key = `${position.x},${position.y}`;
  return Number(db.prepare(`
    INSERT INTO core_hunts (cell, x, y, owner, source, first_seen_tick, last_seen_tick)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cell) DO UPDATE SET
      owner = COALESCE(excluded.owner, core_hunts.owner),
      last_seen_tick = excluded.last_seen_tick
  `).run(key, position.x, position.y, owner, source, tick, tick).changes);
}

/** upsert 单位目击（动态层，保留最近目击）。 */
export function upsertUnitSeen(
  db: DatabaseSync,
  cell: { x: number; y: number },
  unitType: string,
  controlled: boolean,
  tick: number,
): void {
  const key = `${cell.x},${cell.y}`;
  db.prepare(`
    INSERT INTO units_seen (cell, unit_type, controlled, tick)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(cell, tick) DO NOTHING
  `).run(key, unitType, controlled ? 1 : 0, tick);
}

/** 已知矿查询（跨 run 累积；可过滤状态/新鲜度）。 */
export function knownResources(
  db: DatabaseSync,
  filter: KnownResourceFilter = {},
): readonly SurveyResourceRow[] {
  const states = filter.states ?? ["visible", "stale"];
  const params: (string | number)[] = [];
  let where = `state IN (${states.map(() => "?").join(",")})`;
  params.push(...states);
  // maxAgeTicks 由调用方传外部 tick 自行过滤（SQL 侧按 last_seen 距今过滤需
  // 外部 tick 参数，调用处更清楚语义）。
  const rows = db.prepare(
    `SELECT cell, x, y, first_seen_tick, last_seen_tick, state, last_state_tick, seen_count
     FROM resources WHERE ${where} ORDER BY last_seen_tick DESC`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    cell: String(r.cell),
    x: Number(r.x),
    y: Number(r.y),
    firstSeenTick: Number(r.first_seen_tick),
    lastSeenTick: Number(r.last_seen_tick),
    state: r.state as SurveyResourceState,
    lastStateTick: Number(r.last_state_tick),
    seenCount: Number(r.seen_count),
  }));
}

/** 全部已知障碍。 */
export function knownObstacles(db: DatabaseSync): readonly SurveyObstacleRow[] {
  const rows = db.prepare(
    "SELECT cell, x, y, first_seen_tick, last_seen_tick FROM obstacles ORDER BY last_seen_tick DESC",
  ).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    cell: String(r.cell),
    x: Number(r.x),
    y: Number(r.y),
    firstSeenTick: Number(r.first_seen_tick),
    lastSeenTick: Number(r.last_seen_tick),
  }));
}

/** 已知敌核心基地。 */
export function knownCoreHunts(db: DatabaseSync): readonly SurveyCoreHuntRow[] {
  const rows = db.prepare(
    "SELECT cell, x, y, owner, source, first_seen_tick, last_seen_tick FROM core_hunts ORDER BY last_seen_tick DESC",
  ).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    cell: String(r.cell),
    x: Number(r.x),
    y: Number(r.y),
    owner: r.owner === null ? null : String(r.owner),
    source: r.source as SurveyCoreHuntRow["source"],
    firstSeenTick: Number(r.first_seen_tick),
    lastSeenTick: Number(r.last_seen_tick),
  }));
}

/** 读某 run 的同步水位（无记录 = 未同步）。 */
export function syncMeta(db: DatabaseSync, runId: string): SurveySyncMeta | null {
  const row = db.prepare(
    "SELECT run_id, tenant, cases_synced, last_tick, updated_at FROM sync_meta WHERE run_id = ?",
  ).get(runId) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    runId: String(row.run_id),
    tenant: String(row.tenant),
    casesSynced: Number(row.cases_synced),
    lastTick: Number(row.last_tick),
    updatedAt: String(row.updated_at),
  };
}

/** 更新 run 同步水位（幂等标记：该 run 已同步到 lastTick）。 */
export function markSyncMeta(db: DatabaseSync, runId: string, tenant: string, lastTick: number, casesSynced: number): void {
  db.prepare(`
    INSERT INTO sync_meta (run_id, tenant, cases_synced, last_tick, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      cases_synced = excluded.cases_synced,
      last_tick = excluded.last_tick,
      updated_at = excluded.updated_at
  `).run(runId, tenant, casesSynced, lastTick, new Date().toISOString());
}

/** 显式把某矿标记为已耗尽/已确认空（供采集结果回写；默认 visible→stale 由上游负责）。 */
export function markResourceState(
  db: DatabaseSync,
  cell: string,
  state: SurveyResourceState,
  tick: number,
): void {
  db.prepare(`
    UPDATE resources SET state = ?, last_state_tick = ?
    WHERE cell = ?
  `).run(state, tick, cell);
}

export { dirname };


