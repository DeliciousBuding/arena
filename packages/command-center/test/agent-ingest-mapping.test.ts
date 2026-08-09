/**
 * agent-ingest 测绘落库测试（python-mapping-telemetry-v1，2026-08-09）。
 * 覆盖：tick_summary 附带测绘字段 → resources/obstacles/units_seen/
 * core_hunts/resource_seen_history 正确写入（SQL 对齐 survey-db.ts 语义）；
 * 旧客户端（无测绘字段）行为不变；units_seen 只记敌方（A14 纪律）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAgentEvent, type AgentIngestEvent } from "../lib/agent-ingest.ts";

function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "arena-ingest-test-"));
  const db = new DatabaseSync(join(dir, "t2.db"));
  // 直接跑 ingest 的建表 DDL（openAgentDb 依赖 DATA_ROOT，测试用独立库）
  db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  tenant TEXT NOT NULL, instance TEXT NOT NULL, tick INTEGER,
  resources INTEGER, population INTEGER, core_x INTEGER, core_y INTEGER,
  units INTEGER, visible_enemies INTEGER, status TEXT, sdk_version TEXT,
  base_url TEXT, pid INTEGER, platform TEXT,
  mode TEXT NOT NULL DEFAULT 'production',
  connection_state TEXT NOT NULL DEFAULT 'down',
  first_seen TEXT, last_heartbeat TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant, instance)
);
CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL,
  instance TEXT NOT NULL, event TEXT NOT NULL, tick INTEGER,
  detail TEXT, ts REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS resources (
  cell TEXT PRIMARY KEY, x INTEGER NOT NULL, y INTEGER NOT NULL,
  first_seen_tick INTEGER NOT NULL, last_seen_tick INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'visible', last_state_tick INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS obstacles (
  cell TEXT PRIMARY KEY, x INTEGER NOT NULL, y INTEGER NOT NULL,
  first_seen_tick INTEGER NOT NULL, last_seen_tick INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS core_hunts (
  cell TEXT PRIMARY KEY, x INTEGER NOT NULL, y INTEGER NOT NULL,
  owner TEXT, source TEXT NOT NULL DEFAULT 'CORE',
  first_seen_tick INTEGER NOT NULL, last_seen_tick INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS units_seen (
  cell TEXT NOT NULL, unit_type TEXT NOT NULL, controlled INTEGER NOT NULL,
  tick INTEGER NOT NULL, x INTEGER, y INTEGER,
  PRIMARY KEY (cell, tick)
);
CREATE TABLE IF NOT EXISTS resource_seen_history (
  cell TEXT NOT NULL, tick INTEGER NOT NULL,
  PRIMARY KEY (cell, tick)
);
CREATE INDEX IF NOT EXISTS idx_resource_seen_history_cell ON resource_seen_history(cell, tick);
CREATE INDEX IF NOT EXISTS idx_resource_seen_history_tick ON resource_seen_history(tick);
`);
  return db;
}

function summaryEvent(overrides: Partial<AgentIngestEvent> = {}): AgentIngestEvent {
  return {
    tenant: "t2",
    instance: "test-instance",
    ts: Date.now() / 1000,
    event: "tick_summary",
    tick: 80000,
    resources: 5,
    population: 10,
    core: [-500, -300],
    units: 10,
    visible_enemies: 2,
    ...overrides,
  };
}

test("tick_summary 测绘字段：resources/obstacles/units_seen/core_hunts 落库", () => {
  const db = freshDb();
  const event = summaryEvent({
    resource_cells: [[-500, -300], [-501, -300], [-502, -301]],
    obstacle_cells: [[-510, -310], [-511, -311]],
    units_seen: [
      // [id, unit_type, controlled, x, y, hp]
      ["enemy-1", "VANGUARD", 0, -520, -320, 50],
      ["mine-1", "WORKER", 1, -500, -300, 30], // 己方不应进 units_seen
    ],
    enemy_cores: [[-530, -330, "torther"]],
  });
  applyAgentEvent(db, event);

  const resources = db.prepare("SELECT x, y, first_seen_tick, last_seen_tick, state, seen_count FROM resources ORDER BY x").all();
  assert.equal(resources.length, 3);
  assert.deepEqual({ ...resources[0] }, { x: -502, y: -301, first_seen_tick: 80000, last_seen_tick: 80000, state: "visible", seen_count: 1 });

  const obstacles = db.prepare("SELECT x, y, first_seen_tick, last_seen_tick FROM obstacles ORDER BY x").all();
  assert.equal(obstacles.length, 2);
  assert.deepEqual({ ...obstacles[0] }, { x: -511, y: -311, first_seen_tick: 80000, last_seen_tick: 80000 });

  // 只记敌方（controlled=0）
  const unitsSeen = db.prepare("SELECT unit_type, controlled, tick, x, y FROM units_seen").all();
  assert.equal(unitsSeen.length, 1);
  assert.deepEqual({ ...unitsSeen[0] }, { unit_type: "VANGUARD", controlled: 0, tick: 80000, x: -520, y: -320 });

  const cores = db.prepare("SELECT x, y, owner, source, first_seen_tick, last_seen_tick FROM core_hunts").all();
  assert.equal(cores.length, 1);
  assert.deepEqual({ ...cores[0] }, { x: -530, y: -330, owner: "torther", source: "CORE", first_seen_tick: 80000, last_seen_tick: 80000 });

  const history = db.prepare("SELECT cell, tick FROM resource_seen_history ORDER BY cell").all();
  assert.equal(history.length, 3);
  rmSync(join(tmpdir(), "arena-ingest-test-"), { recursive: true, force: true });
});

test("tick_summary 幂等：同格二次上报 last_seen 单调、seen_count 累加", () => {
  const db = freshDb();
  const base = summaryEvent({ resource_cells: [[-500, -300]], obstacle_cells: [[-510, -310]] });
  applyAgentEvent(db, base);
  applyAgentEvent(db, { ...base, tick: 80001, resource_cells: [[-500, -300], [-505, -305]], obstacle_cells: [[-510, -310]] });

  const res = db.prepare("SELECT cell, first_seen_tick, last_seen_tick, seen_count FROM resources ORDER BY cell").all();
  assert.equal(res.length, 2);
  assert.deepEqual({ ...res[0] }, { cell: "-500,-300", first_seen_tick: 80000, last_seen_tick: 80001, seen_count: 2 });
  const obs = db.prepare("SELECT last_seen_tick FROM obstacles WHERE cell = '-510,-310'").get() as { last_seen_tick: number };
  assert.deepEqual({ ...obs }, { last_seen_tick: 80001 });
  // resource_seen_history 同 tick 幂等（INSERT OR IGNORE）：(cell,tick) 唯一
  const hist = db.prepare("SELECT COUNT(*) AS n FROM resource_seen_history WHERE cell = '-500,-300'").get() as { n: number };
  assert.equal(hist.n, 2);
  rmSync(join(tmpdir(), "arena-ingest-test-"), { recursive: true, force: true });
});

test("旧客户端（无测绘字段）行为不变：仅写 agents/agent_events", () => {
  const db = freshDb();
  applyAgentEvent(db, summaryEvent());
  const resources = db.prepare("SELECT COUNT(*) AS n FROM resources").get() as { n: number };
  const unitsSeen = db.prepare("SELECT COUNT(*) AS n FROM units_seen").get() as { n: number };
  const agents = db.prepare("SELECT tick, resources, visible_enemies FROM agents").get() as { tick: number; resources: number; visible_enemies: number };
  assert.equal(resources.n, 0);
  assert.equal(unitsSeen.n, 0);
  assert.deepEqual({ ...agents }, { tick: 80000, resources: 5, visible_enemies: 2 });
  rmSync(join(tmpdir(), "arena-ingest-test-"), { recursive: true, force: true });
});
