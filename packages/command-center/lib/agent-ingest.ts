/**
 * Agent 遥测 ingest（2026-08-09，agent-telemetry-bridge-v1；
 * python-mapping-telemetry-v1 扩展测绘落库）。
 *
 * 唯一写入口：POST /api/ingest/agents → survey/<tenant>.db 的 agents/
 * agent_events 表；tick_summary 附带测绘字段（resource_cells/obstacle_cells/
 * units_seen/enemy_cores，python fork 2026-08-09 起上报）时，同步写入
 * resources/obstacles/units_seen/core_hunts 测绘表（python 实时域）。
 * **权威 schema 来源 = arena-agent/src/intel/survey-db.ts** 的 SCHEMA
 * （两处表结构必须一致；变更时同步两处）。
 *
 * 写权限纪律（防耦合，agent-telemetry-bridge-v1 §3.2 扩展）：
 * - ingest 写 agents/agent_events + （python 实时域）测绘表；
 * - survey:sync CLI 写（TS calibration 回放域）测绘表，不触碰
 *   agents/agent_events；
 * - 两域 tick 天然隔离（TS=回放域，python=实时域），SQL 均幂等 upsert。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT } from "./fs-jsonl.ts";

const AGENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  tenant TEXT NOT NULL,
  instance TEXT NOT NULL,
  tick INTEGER,
  resources INTEGER,
  population INTEGER,
  core_x INTEGER,
  core_y INTEGER,
  units INTEGER,
  visible_enemies INTEGER,
  status TEXT,
  sdk_version TEXT,
  base_url TEXT,
  pid INTEGER,
  platform TEXT,
  mode TEXT NOT NULL DEFAULT 'production',
  connection_state TEXT NOT NULL DEFAULT 'down',
  first_seen TEXT,
  last_heartbeat TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant, instance)
);
CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant TEXT NOT NULL,
  instance TEXT NOT NULL,
  event TEXT NOT NULL,
  tick INTEGER,
  detail TEXT,
  ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_events_tenant_ts ON agent_events(tenant, ts);
-- 测绘表（python-mapping-telemetry-v1）：与 arena-agent survey-db.ts SCHEMA
-- 对齐（resources/obstacles/core_hunts/units_seen/resource_seen_history）。
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
  x INTEGER,
  y INTEGER,
  PRIMARY KEY (cell, tick)
);
CREATE TABLE IF NOT EXISTS resource_seen_history (
  cell TEXT NOT NULL,
  tick INTEGER NOT NULL,
  PRIMARY KEY (cell, tick)
);
CREATE INDEX IF NOT EXISTS idx_resource_seen_history_cell ON resource_seen_history(cell, tick);
CREATE INDEX IF NOT EXISTS idx_resource_seen_history_tick ON resource_seen_history(tick);`;

const AGENT_UPSERT = `
INSERT INTO agents (
  tenant, instance, tick, resources, population, core_x, core_y, units,
  visible_enemies, status, sdk_version, base_url, pid, platform, mode,
  connection_state, first_seen, last_heartbeat, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'production'), ?, ?, ?, ?)
ON CONFLICT(tenant, instance) DO UPDATE SET
  tick = COALESCE(excluded.tick, agents.tick),
  resources = COALESCE(excluded.resources, agents.resources),
  population = COALESCE(excluded.population, agents.population),
  core_x = COALESCE(excluded.core_x, agents.core_x),
  core_y = COALESCE(excluded.core_y, agents.core_y),
  units = COALESCE(excluded.units, agents.units),
  visible_enemies = COALESCE(excluded.visible_enemies, agents.visible_enemies),
  status = COALESCE(excluded.status, agents.status),
  sdk_version = COALESCE(excluded.sdk_version, agents.sdk_version),
  base_url = COALESCE(excluded.base_url, agents.base_url),
  pid = COALESCE(excluded.pid, agents.pid),
  platform = COALESCE(excluded.platform, agents.platform),
  -- 事件未带 mode 时保留现值：INSERT 侧的 COALESCE 会把 excluded.mode 变成
  -- 'production'（永远非 NULL），不能用来区分"没带"——这里直接回绑原始参数
  mode = COALESCE(?, agents.mode),
  connection_state = excluded.connection_state,
  last_heartbeat = COALESCE(excluded.last_heartbeat, agents.last_heartbeat),
  updated_at = excluded.updated_at`;

export interface AgentIngestEvent {
  readonly tenant: string;
  readonly instance?: string;
  readonly ts: number;
  readonly event: "register" | "connection" | "tick_summary" | "disconnected";
  readonly tick?: number | null;
  readonly status?: string | null;
  readonly resources?: number | null;
  readonly population?: number | null;
  readonly core?: readonly [number, number] | null;
  readonly units?: number | null;
  readonly visible_enemies?: number | null;
  readonly api_key_tail?: string;
  readonly base_url?: string;
  readonly sdk_version?: string;
  readonly pid?: number | null;
  readonly platform?: string;
  /** agent 运行模式（production|simulation），缺省 production。 */
  readonly mode?: string;
  readonly error?: string;
  /** 测绘字段（python-mapping-telemetry-v1，python fork tick_summary 上报）：
   *  本 tick 可见资源格/障碍格坐标 [[x,y],...]；全部可见单位
   *  [id, unit_type, controlled(0|1), x, y, hp]；敌核心 [x,y,owner]。 */
  readonly resource_cells?: readonly (readonly [number, number])[];
  readonly obstacle_cells?: readonly (readonly [number, number])[];
  readonly units_seen?: readonly (readonly [string, string, number, number, number, number])[];
  readonly enemy_cores?: readonly (readonly [number, number, string])[];
}

export interface AgentRow {
  readonly tenant: string;
  readonly instance: string;
  readonly tick: number | null;
  readonly resources: number | null;
  readonly population: number | null;
  readonly coreX: number | null;
  readonly coreY: number | null;
  readonly units: number | null;
  readonly visibleEnemies: number | null;
  readonly status: string | null;
  readonly sdkVersion: string | null;
  readonly baseUrl: string | null;
  readonly pid: number | null;
  readonly platform: string | null;
  readonly mode: string;
  readonly connectionState: "up" | "down";
  readonly firstSeen: string;
  readonly lastHeartbeat: string | null;
  readonly updatedAt: string;
}

/** 打开（必要时创建）某租户 survey 库并确保 agent 表存在。 */
export function openAgentDb(tenant: string, write = false): DatabaseSync {
  const dir = join(DATA_ROOT, "runtime", "survey");
  if (write) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, `${tenant}.db`));
  // 双写竞争（2026-08-10 P1）：ingest（python 实时域，每 5s flush）与
  // survey:sync CLI（TS 回放域，~15min 全量 SAVEPOINT 事务）并发写同一
  // survey/<tenant>.db；node:sqlite 默认 busy_timeout=0ms，撞上即
  // "database is locked"——busy_timeout 让等待替代失败（与 map-store.ts
  // 同参；须先于 WAL pragma：journal 切换需独占锁）。
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(AGENT_SCHEMA);
  if (write) {
    ensureAgentModeColumn(db); // 旧库补 mode 列（幂等）
    ensureAgentCompositePk(db); // 旧库单列 PK → (tenant, instance) 复合 PK（幂等）
  }
  return db;
}

/** 旧库迁移（2026-08-09，python-mapping-telemetry-v1）：agents 表从
 *  tenant 单列 PK 升级为 (tenant, instance) 复合 PK。
 *  背景：1befef3 时代建表为单列 PK；17f28f3 起 AGENT_UPSERT 用
 *  ON CONFLICT(tenant, instance)（对齐 survey-db.ts 权威 SCHEMA），
 *  但 CREATE TABLE IF NOT EXISTS 不升级已存在表 → 旧库上 SQL 报
 *  "ON CONFLICT clause does not match any PRIMARY KEY"。迁移 = 重建
 *  表（rename + 建复合 PK 新表 + 显式列名拷贝 + drop 旧表），幂等：
 *  已是复合 PK 则跳过。仅 write 打开时执行。 */
function ensureAgentCompositePk(db: DatabaseSync): void {
  try {
    const idx = db.prepare("PRAGMA index_list(agents)").all() as Array<{ name: string; origin: string }>;
    const pk = idx.find((i) => i.origin === "pk");
    if (pk === undefined) return;
    const cols = db.prepare(`PRAGMA index_info(${pk.name})`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    if (names.includes("tenant") && names.includes("instance")) return;
    db.exec("BEGIN");
    db.exec("ALTER TABLE agents RENAME TO agents_legacy");
    // agents 表此刻不存在 → AGENT_SCHEMA 按复合 PK 重建；其余表 IF NOT EXISTS 跳过
    db.exec(AGENT_SCHEMA);
    db.exec(`
      INSERT INTO agents (
        tenant, instance, tick, resources, population, core_x, core_y, units,
        visible_enemies, status, sdk_version, base_url, pid, platform, mode,
        connection_state, first_seen, last_heartbeat, updated_at
      )
      SELECT
        tenant, instance, tick, resources, population, core_x, core_y, units,
        visible_enemies, status, sdk_version, base_url, pid, platform, mode,
        connection_state, first_seen, last_heartbeat, updated_at
      FROM agents_legacy
    `);
    db.exec("DROP TABLE agents_legacy");
    db.exec("COMMIT");
  } catch {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 无活跃事务时 ROLLBACK 也失败，忽略
    }
    // 并发 write 碰撞/迁移失败容错：下次写入重试即可
  }
}

/** 旧库迁移（2026-08-09，agent-ecosystem-v1 P1）：agents 表补 mode 列。
 *  幂等：列已存在则跳过。仅 write 打开时执行（面板只读连接不触发 DDL）。 */
function ensureAgentModeColumn(db: DatabaseSync): void {
  try {
    const cols = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "mode")) {
      db.exec("ALTER TABLE agents ADD COLUMN mode TEXT NOT NULL DEFAULT 'production';");
    }
  } catch {
    // 并发 write 开打碰撞时容错；下次写入重试即可
  }
}

/** 将 SDK 上报的一条 telemetry 事件写入台账（agents + agent_events +
 *  tick_summary 附带测绘字段时写测绘表）。 */
export function applyAgentEvent(db: DatabaseSync, event: AgentIngestEvent): void {
  const now = new Date().toISOString();
  const instance = event.instance || event.tenant;
  const tick = event.tick === null || event.tick === undefined ? null : Number(event.tick);
  const coreX = event.core?.[0] ?? null;
  const coreY = event.core?.[1] ?? null;
  // 只认合法 mode；缺省/非法 → null（INSERT 回落 'production'，UPDATE 保留现值，
  // 避免 tick_summary 等无 mode 事件把已登记的 simulation 覆盖回 production）
  const modeValue = event.mode === "production" || event.mode === "simulation" ? event.mode : null;

  db.prepare(AGENT_UPSERT).run(
    event.tenant,
    instance,
    tick,
    event.resources ?? null,
    event.population ?? null,
    coreX,
    coreY,
    event.units ?? null,
    event.visible_enemies ?? null,
    event.status ?? null,
    event.sdk_version ?? null,
    event.base_url ?? null,
    event.pid ?? null,
    event.platform ?? null,
    modeValue,
    event.event === "disconnected" ? "down" : "up",
    now,
    event.event === "tick_summary" ? now : null,
    now,
    modeValue, // UPDATE 子句的 COALESCE(?, agents.mode)：事件未带 mode 时保留现值
  );

  db.prepare(
    "INSERT INTO agent_events (tenant, instance, event, tick, detail, ts) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(event.tenant, instance, event.event, tick, event.error ?? null, event.ts);

  if (event.event === "tick_summary" && tick !== null) {
    applyMappingUpserts(db, event, tick);
  }
}

/**
 * tick_summary 测绘字段落库（python-mapping-telemetry-v1）。
 * SQL 语义与 arena-agent/src/intel/survey-db.ts 的 upsert* 完全一致：
 * resources/obstacles 幂等 upsert（last_seen MAX 单调）、units_seen 按
 * (cell,tick) DO NOTHING、core_hunts upsert（owner COALESCE/first MIN/
 * last MAX）、resource_seen_history 记出现 tick。字段缺失 = 旧客户端，
 * 无操作。 */
function applyMappingUpserts(
  db: DatabaseSync,
  event: AgentIngestEvent,
  tick: number,
): void {
  const upsertResource = db.prepare(`
    INSERT INTO resources (cell, x, y, first_seen_tick, last_seen_tick, state, last_state_tick, seen_count)
    VALUES (?, ?, ?, ?, ?, 'visible', ?, 1)
    ON CONFLICT(cell) DO UPDATE SET
      last_seen_tick = MAX(resources.last_seen_tick, excluded.last_seen_tick),
      state = 'visible',
      last_state_tick = excluded.last_state_tick,
      seen_count = resources.seen_count + 1
  `);
  const resourceHistory = db.prepare("INSERT OR IGNORE INTO resource_seen_history (cell, tick) VALUES (?, ?)");
  const upsertObstacle = db.prepare(`
    INSERT INTO obstacles (cell, x, y, first_seen_tick, last_seen_tick)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cell) DO UPDATE SET
      last_seen_tick = MAX(obstacles.last_seen_tick, excluded.last_seen_tick)
  `);
  const upsertUnitSeen = db.prepare(`
    INSERT INTO units_seen (cell, unit_type, controlled, tick, x, y)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(cell, tick) DO NOTHING
  `);
  const upsertCoreHunt = db.prepare(`
    INSERT INTO core_hunts (cell, x, y, owner, source, first_seen_tick, last_seen_tick)
    VALUES (?, ?, ?, ?, 'CORE', ?, ?)
    ON CONFLICT(cell) DO UPDATE SET
      owner = COALESCE(excluded.owner, core_hunts.owner),
      first_seen_tick = MIN(core_hunts.first_seen_tick, excluded.first_seen_tick),
      last_seen_tick = MAX(core_hunts.last_seen_tick, excluded.last_seen_tick)
  `);

  for (const [x, y] of event.resource_cells ?? []) {
    const key = `${x},${y}`;
    upsertResource.run(key, x, y, tick, tick, tick);
    resourceHistory.run(key, tick);
  }
  for (const [x, y] of event.obstacle_cells ?? []) {
    const key = `${x},${y}`;
    upsertObstacle.run(key, x, y, tick, tick);
  }
  // 对齐 survey-db A14 纪律：units_seen 只记敌方目击（controlled=0）
  for (const [id, unitType, controlled, x, y] of event.units_seen ?? []) {
    if (controlled !== 0) continue;
    const key = `${x},${y}`;
    upsertUnitSeen.run(key, unitType, 0, tick, x, y);
  }
  for (const [x, y, owner] of event.enemy_cores ?? []) {
    const key = `${x},${y}`;
    upsertCoreHunt.run(key, x, y, owner, tick, tick);
  }
}

/** 查询某租户的 agent 台账行（无数据返回 null；多实例租户取最新心跳行）。 */
export function knownAgent(db: DatabaseSync, tenant: string): AgentRow | null {
  const rows = db.prepare(
    "SELECT * FROM agents WHERE tenant = ? ORDER BY updated_at DESC LIMIT 1",
  ).all(tenant) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    tenant: String(r.tenant),
    instance: String(r.instance),
    tick: r.tick === null ? null : Number(r.tick),
    resources: r.resources === null ? null : Number(r.resources),
    population: r.population === null ? null : Number(r.population),
    coreX: r.core_x === null ? null : Number(r.core_x),
    coreY: r.core_y === null ? null : Number(r.core_y),
    units: r.units === null ? null : Number(r.units),
    visibleEnemies: r.visible_enemies === null ? null : Number(r.visible_enemies),
    status: r.status === null ? null : String(r.status),
    sdkVersion: r.sdk_version === null ? null : String(r.sdk_version),
    baseUrl: r.base_url === null ? null : String(r.base_url),
    pid: r.pid === null ? null : Number(r.pid),
    platform: r.platform === null ? null : String(r.platform),
    mode: String(r.mode ?? "production"),
    connectionState: String(r.connection_state) === "down" ? "down" : "up",
    firstSeen: String(r.first_seen),
    lastHeartbeat: r.last_heartbeat === null ? null : String(r.last_heartbeat),
    updatedAt: String(r.updated_at),
  };
}

/** 最近连接事件流水（面板展示，默认最近 50 条）。 */
export function recentAgentEvents(db: DatabaseSync, tenant: string, limit = 50): Array<Record<string, unknown>> {
  return db.prepare(
    "SELECT id, tenant, instance, event, tick, detail, ts FROM agent_events WHERE tenant = ? ORDER BY ts DESC LIMIT ?",
  ).all(tenant, limit) as Array<Record<string, unknown>>;
}
