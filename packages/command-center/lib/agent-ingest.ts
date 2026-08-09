/**
 * Agent 遥测 ingest（2026-08-09，agent-telemetry-bridge-v1）。
 *
 * 唯一写入口：POST /api/ingest/agents → survey/<tenant>.db 的 agents/
 * agent_events 表。**权威 schema 来源 = arena-agent/src/intel/survey-db.ts**
 * 的 SCHEMA（两处表结构必须一致；变更时同步两处）。
 *
 * 写权限纪律（防耦合）：本模块只写 agents/agent_events 两表，不触碰
 * survey:sync CLI 的测绘表；survey:sync 也不触碰本组表。单一 writer 分区。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT } from "./fs-jsonl.ts";

const AGENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  tenant TEXT PRIMARY KEY,
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
  updated_at TEXT NOT NULL
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
CREATE INDEX IF NOT EXISTS idx_agent_events_tenant_ts ON agent_events(tenant, ts);`;

const AGENT_UPSERT = `
INSERT INTO agents (
  tenant, instance, tick, resources, population, core_x, core_y, units,
  visible_enemies, status, sdk_version, base_url, pid, platform, mode,
  connection_state, first_seen, last_heartbeat, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'production'), ?, ?, ?, ?)
ON CONFLICT(tenant) DO UPDATE SET
  instance = excluded.instance,
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
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(AGENT_SCHEMA);
  if (write) ensureAgentModeColumn(db); // 旧库补 mode 列（幂等）
  return db;
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

/** 将 SDK 上报的一条 telemetry 事件写入台账（agents + agent_events）。 */
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
}

/** 查询某租户的 agent 台账行（无数据返回 null）。 */
export function knownAgent(db: DatabaseSync, tenant: string): AgentRow | null {
  const rows = db.prepare("SELECT * FROM agents WHERE tenant = ?").all(tenant) as Array<
    Record<string, unknown>
  >;
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
