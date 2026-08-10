/**
 * 测绘持久化数据库（2026-08-08，用户裁决"地图测绘落实到数据库"）。
 *
 * 用 Node 内置 node:sqlite（Node 22.5+，本仓 .nvmrc=24）零依赖实现跨 run
 * 测绘累积：矿/障碍/敌核心基地/单位目击，从 calibration case 增量同步写入。
 *
 * 位置：<data-root>/runtime/survey/<tenant>.db（runtime 不提交）。
 * 数据源 = calibration case before.state.objects——官方语义是"自有实体 +
 * 当前可见地形与敌人"（arena-hero-doc state-model.md：Owned entities plus
 * currently visible terrain and enemies），即**单玩家视野投影**，不是服务端
 * 全量地图。因此：
 *  - resources 表 = 我方视野跨 run 累积的已知矿（可见过即标注），不是全图；
 *  - resource_absences 表补足负观测：视野覆盖内确认无矿（collectResourceAbsences
 *    用我方观察者位置 + supercover 视线判定），是真实缺席而非观测中断——
 *    refill 周期实证的正确数据源（resource_seen_history 只是观测记录，
 *    观测间隔 ≠ 缺席，refill 预测 0/401 实证证伪的原因）。
 *
 * 只读约定：本模块只写 survey 库，不碰 telemetry/calibration/生产数据。
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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
  x INTEGER,
  y INTEGER,
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
-- 单位目击热区查询索引（2026-08-08，数据架构审计 A3）：敌情热区
-- 按 controlled=0 全表扫（t1 15 万行）——加 (controlled, tick) 索引；
-- CREATE INDEX IF NOT EXISTS 幂等，下次 openSurveyDb 自动生效。
CREATE INDEX IF NOT EXISTS idx_units_seen_controlled_tick ON units_seen(controlled, tick);

-- 共享记忆分层（2026-08-08，A13）：units_seen 旧目击归档聚合（enemy-heat full
-- 读 archive∪近期，原始行清理防无限膨胀）。每格×类型一行，跨 run 累积。
CREATE TABLE IF NOT EXISTS heat_archive (
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  unit_type TEXT NOT NULL,
  count INTEGER NOT NULL,
  first_tick INTEGER NOT NULL,
  last_tick INTEGER NOT NULL,
  PRIMARY KEY (x, y, unit_type)
);

-- 格级负观测（2026-08-08，A15）：我方视野覆盖内「确认无矿」的已知矿格 × tick——
-- resource_seen_history 只记观测（视野离开=假消失），无法区分真实缺席与观测中断；
-- 本表记「看得到且没有矿」的真实缺席，供矿刷新周期实证。survey-sync 写入。
CREATE TABLE IF NOT EXISTS resource_absences (
  cell TEXT NOT NULL,
  tick INTEGER NOT NULL,
  PRIMARY KEY (cell, tick)
);
CREATE INDEX IF NOT EXISTS idx_resource_absences_cell ON resource_absences(cell);

-- 矿物生命周期事件（2026-08-08）：矿格 × tick 的采集/失败序列
CREATE TABLE IF NOT EXISTS resource_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cell TEXT NOT NULL,
  tick INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  reason_code TEXT,
  amount INTEGER,
  actor_id TEXT,
  UNIQUE(cell, tick, event_type, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_resource_events_cell ON resource_events(cell, tick);

-- 单位生命周期（2026-08-08）：出生/死亡/最近目击
CREATE TABLE IF NOT EXISTS unit_lifecycle (
  unit_id TEXT PRIMARY KEY,
  unit_type TEXT NOT NULL,
  birth_tick INTEGER,
  birth_pos TEXT,
  death_tick INTEGER,
  death_pos TEXT,
  death_reason TEXT,
  last_seen_tick INTEGER NOT NULL,
  last_seen_pos TEXT,
  current_state TEXT NOT NULL DEFAULT 'alive'
);
CREATE INDEX IF NOT EXISTS idx_unit_lifecycle_last_seen ON unit_lifecycle(last_seen_tick);
CREATE INDEX IF NOT EXISTS idx_unit_lifecycle_type ON unit_lifecycle(unit_type, current_state);

-- 核心消费记账（2026-08-08）：spawn/heal/repair 每笔支出
CREATE TABLE IF NOT EXISTS core_spends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  tick INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  unit_type TEXT,
  unit_id TEXT
);
-- 幂等键：SQLite UNIQUE 对 NULL 无效（repair 的 unit_id 可能 NULL），用 COALESCE
-- 表达式唯一索引保证 force 重跑不重复记账（与 resource_events/unit_lifecycle 对齐）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_core_spends_dedup ON core_spends(kind, tick, amount, COALESCE(unit_type, ''), COALESCE(unit_id, ''));
CREATE INDEX IF NOT EXISTS idx_core_spends_kind ON core_spends(kind, tick);

-- 探索分区（2026-08-08）：16×16 chunk 的最后探索 tick——"探索过的区域"跨
-- run 记忆（重启后 Fog 层/未观察分区优先不丢）。数据源 = calibration case
-- 物体位置推导（有物体 = 该 chunk 被探索过）。
CREATE TABLE IF NOT EXISTS chunks (
  chunk_key TEXT PRIMARY KEY,
  last_seen_tick INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_last_seen ON chunks(last_seen_tick);

-- 稀有事迹持久化（2026-08-08，数据架构审计 A4）：CORE_DESTROYED/夺取/信标/
-- 自爆/阵亡等——calibration run 轮换后历史事迹不再丢，deeds 查库替代回扫。
CREATE TABLE IF NOT EXISTS notable_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant TEXT NOT NULL,
  tick INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_id TEXT,
  target_id TEXT,
  x INTEGER,
  y INTEGER,
  amount INTEGER,
  unit_type TEXT,
  reason_code TEXT,
  destroyed_by TEXT,
  is_our_core INTEGER,
  UNIQUE(tenant, tick, event_type, actor_id, target_id)
);
CREATE INDEX IF NOT EXISTS idx_notable_events_tick ON notable_events(tick);

-- 矿格出现-消失历史（2026-08-08，共享记忆算法深化）：每 case 可见矿的
-- (cell × tick) 序列——resources 表是每格一行（只留最后状态），refill 周期/
-- 出现窗口需历史序列。增量写入（upsertResources 内嵌），幂等
-- (cell, tick) 唯一；历史深度随运行累积，refill 统计消费见 mine-patterns。
CREATE TABLE IF NOT EXISTS resource_seen_history (
  cell TEXT NOT NULL,
  tick INTEGER NOT NULL,
  PRIMARY KEY (cell, tick)
);
CREATE INDEX IF NOT EXISTS idx_resource_seen_history_cell ON resource_seen_history(cell, tick);
CREATE INDEX IF NOT EXISTS idx_resource_seen_history_tick ON resource_seen_history(tick);

-- 第三方 agent 注册与心跳（2026-08-09，用户裁决"并进 survey.db"）：
-- SDK fork（arena-hero-sdk-py）通过 command-center
-- POST /api/ingest/agents 上报 register/connection/tick_summary/disconnected。
-- agents = 每 (tenant, instance) 一行的最新台账（upsert；同 agent 不同 seed
--   = 不同 instance = 独立行，多租户区分）；agent_events = 事件流水。
-- 本组表只由 ingest 端点写入（单一 writer），survey:sync CLI 不触碰。
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
CREATE INDEX IF NOT EXISTS idx_agent_events_tenant_ts ON agent_events(tenant, ts);`;

/** 打开（或创建）某租户的测绘库。write=true 时确保目录存在。 */
export function openSurveyDb(dataRoot: string, tenant: string, write = false): DatabaseSync {
  const dir = join(dataRoot, "runtime", "survey");
  if (write) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, `${tenant}.db`));
  // 双写竞争（2026-08-10 P1）：survey:sync CLI（TS calibration 回放域，
  // ~15min 对全部 4 租户持写锁做 SAVEPOINT 单事务）与 ingest（python 实时域，
  // 每 5s flush）并发写同一 survey/<tenant>.db；node:sqlite 默认
  // busy_timeout=0ms，撞上即 "database is locked"，SCHEMA/迁移整体失败——
  // busy_timeout 让等待替代失败（与 map-store.ts 同参；须先于 WAL pragma：
  // journal 切换需独占锁）。
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  if (write) {
    try {
      migrateUnitsSeenXY(db); // 数据架构审计 A2：旧库补 x/y 列 + 回填
      migrateCoreHuntSanity(db); // 数据质量 A5：核心时间戳倒挂修复（first<=last）
      migrateResourceSanity(db); // 数据质量 A10：矿时间戳倒挂 + seen_count 重建（force 重跑污染）
      migrateNotableSanity(db, dataRoot, tenant); // 叙事 A11：CORE_DESTROYED 敌我/摧毁者回填（旧库）
      migrateUnitsSeenArchive(db); // 共享记忆分层 A13：旧目击归档 heat_archive + 清理原始行
      migrateDropControlledSeen(db); // 记忆收敛 A14：清理我方目击行（units_seen 纯敌方记忆）
      migrateAgentMode(db); // agent-ecosystem-v1 P1：agents 表补 mode 列（旧库）
    } catch (err) {
      // busy_timeout 下并发写应等待而非抛错；走到这里是真失败（库损坏/
      // 磁盘/迁移缺陷）。schema 未就绪的连接不可用——关闭并上抛，由
      // 调用方决定重试（syncTenantSurvey 依赖完整库，不静默吞）。
      db.close();
      throw err;
    }
  }
  return db;
}

/** 旧库迁移（2026-08-09，agent-ecosystem-v1 P1）：agents 表补
 *  mode TEXT NOT NULL DEFAULT 'production' 列——旧库由 ingest 端点建表时
 *  尚无该列，ALTER 补齐；幂等：列已存在则跳过。 */
function migrateAgentMode(db: DatabaseSync): void {
  try {
    const cols = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "mode")) {
      db.exec("ALTER TABLE agents ADD COLUMN mode TEXT NOT NULL DEFAULT 'production';");
    }
  } catch {
    // 并发 write 开打碰撞时容错；下次 sync 重试即可
  }
}

/** 旧库迁移（2026-08-08，数据架构审计 A2）：units_seen 补 x/y INTEGER 列并
 *  从 cell 回填（热区查询不再依赖 substr/instr 解析字符串）。
 *  幂等：列存在则跳过 ALTER；回填 WHERE x IS NULL 只跑一次。
 *  仅 write 打开时执行（面板只读连接不触发 DDL）。 */
function migrateUnitsSeenXY(db: DatabaseSync): void {
  try {
    const cols = db.prepare("PRAGMA table_info(units_seen)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("x")) db.exec("ALTER TABLE units_seen ADD COLUMN x INTEGER;");
    if (!names.has("y")) db.exec("ALTER TABLE units_seen ADD COLUMN y INTEGER;");
    db.exec(
      "UPDATE units_seen SET x = CAST(substr(cell, 1, instr(cell, ',') - 1) AS INTEGER), " +
      "y = CAST(substr(cell, instr(cell, ',') + 1) AS INTEGER) WHERE x IS NULL;"
    );
    db.exec("CREATE INDEX IF NOT EXISTS idx_units_seen_xy_type ON units_seen(controlled, x, y, unit_type);");
  } catch {
    // 并发 write 开打碰撞时容错；下次 sync 重试即可
  }
}

/** 旧库健康迁移（2026-08-08，数据质量 A5）：core_hunts 时间戳倒挂
 *  修复（first_seen_tick > last_seen_tick）——旧 upsert 无条件覆盖 last 导致
 *  run 处理顺序不一时间戳回退。幂等：WHERE first > last 只触发一次。
 *  注：SQLite UPDATE 多列 SET 右侧表达式基于旧值计算，MIN/MAX 交换正确。 */
function migrateCoreHuntSanity(db: DatabaseSync): void {
  try {
    db.exec(
      "UPDATE core_hunts SET first_seen_tick = MIN(first_seen_tick, last_seen_tick), " +
      "last_seen_tick = MAX(first_seen_tick, last_seen_tick) WHERE first_seen_tick > last_seen_tick;"
    );
  } catch {
    // 容错；下次 sync 重试
  }
}

/** 矿表健康迁移（2026-08-08，数据质量 A10）：resources 时间戳倒挂
 *  + seen_count 重建。与 core_hunts A5 同因：旧 upsert 无条件覆盖 last 导致
 *  run 处理顺序不一时间戳回退；seen_count 被 force 重跑污染
 *  （每次重处理 +1，但 resource_seen_history 是 INSERT OR IGNORE (cell,tick)
 *  幂等记录——是 seen_count 的准确重建源）。幂等：只触发有异常行。 */
function migrateResourceSanity(db: DatabaseSync): void {
  try {
    // resources 倒挂修复
    db.exec(
      "UPDATE resources SET first_seen_tick = MIN(first_seen_tick, last_seen_tick), " +
      "last_seen_tick = MAX(first_seen_tick, last_seen_tick) WHERE first_seen_tick > last_seen_tick;"
    );
    // obstacles 倒挂修复（同因：旧 upsert 无条件覆盖 last）
    db.exec(
      "UPDATE obstacles SET first_seen_tick = MIN(first_seen_tick, last_seen_tick), " +
      "last_seen_tick = MAX(first_seen_tick, last_seen_tick) WHERE first_seen_tick > last_seen_tick;"
    );
    // seen_count 重建为 resource_seen_history 计数（仅异常行）
    db.exec(
      "UPDATE resources SET seen_count = " +
      "(SELECT COUNT(*) FROM resource_seen_history h WHERE h.cell = resources.cell) " +
      "WHERE seen_count != " +
      "(SELECT COUNT(*) FROM resource_seen_history h WHERE h.cell = resources.cell);"
    );
  } catch {
    // 容错；下次 sync 重试
  }
}

/** 叙事表健康迁移（2026-08-08，叙事 A11）：notable_events 补
 *  reason_code / destroyed_by / is_our_core 三列（新库 SCHEMA 已含，旧库 ALTER），
 *  并对历史 CORE_DESTROYED 回填——deeds 需区分"我方核心被打爆 vs 敌方核心被摧毁
 *  vs 自爆"，且 destroyed_by 真实值是数组（combat.ts ATTACK 事件），旧解析只认
 *  string 导致摧毁者丢失。回填源 = calibration case（按 tick 匹配，扫描该租户
 *  calibration 全量 case；CORE_DESTROYED 稀有，仅一次迁移可接受）。
 *  幂等：只处理 reason_code IS NULL 的行；已回填行不再触发全扫。
 *  叙事 A11b（2026-08-08）：重复行去重 + 表达式唯一索引——SQLite UNIQUE 约束
 *  中 NULL≠NULL，CORE_DESTROYED 的 actor_id 恒 NULL 导致 UNIQUE(tenant,tick,
 *  event_type,actor_id,target_id) 完全不去重（force 重跑/水位回退重复插入，
 *  实测 t2/t3/t4 各有 1 对同 tick 同 target 重复行）。修复：按 COALESCE 归一
 *  键删重复（保留最小 id）+ 表达式唯一索引根治未来写入（INSERT OR IGNORE 生效）。 */
function migrateNotableSanity(db: DatabaseSync, dataRoot: string, tenant: string): void {
  try {
    const cols = db.prepare("PRAGMA table_info(notable_events)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("reason_code")) db.exec("ALTER TABLE notable_events ADD COLUMN reason_code TEXT;");
    if (!names.has("destroyed_by")) db.exec("ALTER TABLE notable_events ADD COLUMN destroyed_by TEXT;");
    if (!names.has("is_our_core")) db.exec("ALTER TABLE notable_events ADD COLUMN is_our_core INTEGER;");
    // 去重：按 COALESCE 归一键（NULL 参与唯一性）保留最小 id；幂等——无重复行时 DELETE 0 行。
    db.exec(
      "DELETE FROM notable_events WHERE id NOT IN (" +
      "SELECT MIN(id) FROM notable_events GROUP BY tenant, tick, event_type, COALESCE(actor_id, ''), COALESCE(target_id, '')" +
      ")",
    );
    // 表达式唯一索引：NULL 归一后唯一（根治 CORE_DESTROYED actor_id=NULL 不去重）。
    // 先删重复后建，索引创建幂等；历史重复已清。
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_notable_events_dedup ON notable_events(" +
      "tenant, tick, event_type, COALESCE(actor_id, ''), COALESCE(target_id, ''))",
    );
    const pending = db.prepare(
      "SELECT id, tick, target_id FROM notable_events WHERE event_type = 'CORE_DESTROYED' AND reason_code IS NULL",
    ).all() as Array<{ id: number; tick: number; target_id: string | null }>;
    if (pending.length === 0) return;
    const byTick = coreDestroyedByTick(dataRoot, tenant);
    if (byTick.size === 0) return;
    const upd = db.prepare(
      "UPDATE notable_events SET reason_code = ?, destroyed_by = ?, is_our_core = ? WHERE id = ?",
    );
    for (const row of pending) {
      const info = byTick.get(Number(row.tick));
      if (!info) continue;
      upd.run(
        info.reason,
        info.destroyedBy.length > 0 ? JSON.stringify(info.destroyedBy) : null,
        info.ourCore ? 1 : 0,
        row.id,
      );
    }
  } catch {
    // 容错；下次 sync 重试
  }
}

/** 扫描某租户 calibration cases，收集 CORE_DESTROYED 的
 *  reason_code / destroyed_by / 是否我方核心（target ∈ before.state 受控核心）。
 *  与 survey-sync.parseCaseLifecycle / builder.coreRiskAt 同判据。 */
function coreDestroyedByTick(dataRoot: string, tenant: string): Map<number, { reason: string | null; destroyedBy: string[]; ourCore: boolean }> {
  const out = new Map<number, { reason: string | null; destroyedBy: string[]; ourCore: boolean }>();
  const cal = join(dataRoot, "runtime", tenant, "calibration");
  if (!existsSync(cal)) return out;
  for (const run of readdirSync(cal, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    const casesDir = join(cal, run.name, "cases");
    if (!existsSync(casesDir)) continue;
    for (const f of readdirSync(casesDir)) {
      if (!f.endsWith(".json")) continue;
      let raw: { before?: { state?: { objects?: unknown } }; after?: { state?: { events?: unknown } } } | null = null;
      try {
        raw = JSON.parse(readFileSync(join(casesDir, f), "utf8")) as { before?: { state?: { objects?: unknown } }; after?: { state?: { events?: unknown } } } | null;
      } catch {
        continue;
      }
      const events = raw?.after?.state?.events;
      if (!Array.isArray(events)) continue;
      const coreIds = new Set<string>();
      const objects = raw?.before?.state?.objects;
      if (Array.isArray(objects)) {
        for (const o of objects) {
          if (o && typeof o === "object") {
            const obj = o as { kind?: unknown; controlled?: unknown; id?: unknown };
            if (obj.kind === "CORE" && obj.controlled && typeof obj.id === "string") coreIds.add(obj.id);
          }
        }
      }
      for (const ev of events) {
        if (!ev || typeof ev !== "object") continue;
        const e = ev as { event_type?: unknown; tick?: unknown; target_id?: unknown; reason_code?: unknown; values?: unknown };
        if (e.event_type !== "CORE_DESTROYED") continue;
        const tick = typeof e.tick === "number" ? e.tick : Number(e.tick);
        if (!Number.isFinite(tick)) continue;
        const vals = (e.values ?? {}) as Record<string, unknown>;
        const rawBy = vals.destroyed_by;
        const destroyedBy = Array.isArray(rawBy)
          ? rawBy.filter((u): u is string => typeof u === "string")
          : typeof rawBy === "string" && rawBy.trim() !== ""
            ? [rawBy]
            : [];
        out.set(tick, {
          reason: typeof e.reason_code === "string" ? e.reason_code : null,
          destroyedBy,
          ourCore: typeof e.target_id === "string" && coreIds.has(e.target_id),
        });
      }
    }
  }
  return out;
}

/** 共享记忆分层阈值（tick）：units_seen 目击超过此龄（相对最新 tick）归档到
 *  heat_archive 聚合表并删除原始行——enemy-heat full 读 archive∪近期语义不变，
 *  防 units_seen 无限膨胀（t1 20 万行/16k tick 实测）。与 enemy-heat recent
 *  窗口（2000）略大，保守保留近期完整目击。 */
export const ARCHIVE_CUTOFF_TICKS = 3000;

/** 记忆收敛迁移（2026-08-08，A14）：units_seen 定位为纯敌方目击记忆表——
 *  我方单位生命周期由 unit_lifecycle 追踪（touchUnitSeen），我方目击行
 *  （controlled=1）无任何消费方（enemy-heat/deeds/advice 全部只读
 *  controlled=0），却占表 99% 行数（t1 实测 205,014/205,165）。此迁移
 *  一次性 DELETE 历史我方行；写入侧 survey-sync 同步改为仅敌方写 units_seen
 *  （A14）。幂等：删完 controlled=1 行数为 0，重复跑无效果。仅 write 执行。 */
function migrateDropControlledSeen(db: DatabaseSync): void {
  try {
    db.prepare("DELETE FROM units_seen WHERE controlled = 1").run();
  } catch {
    // 容错；下次 sync 重试
  }
}


/** 共享记忆分层迁移（2026-08-08，记忆生命周期 A13）：units_seen 旧目击
 *  （controlled=0 且 tick ≤ 最新-3000）聚合写入 heat_archive（每格×类型计数 +
 *  first/last tick），随后删除原始旧行。enemy-heat full 改读 archive∪近期——
 *  「近期原始 + 历史聚合」两层记忆，跨 run 不丢历史强度。幂等：DELETE 后旧行
 *  不在 units_seen，重复跑 SELECT 选不到旧行不重复累加。仅 write 打开执行。 */
function migrateUnitsSeenArchive(db: DatabaseSync): void {
  try {
    const row = db.prepare("SELECT MAX(tick) - ? AS c FROM units_seen").get(ARCHIVE_CUTOFF_TICKS) as { c: number | null };
    if (row.c === null || row.c <= 0) return;
    db.prepare(`
      INSERT INTO heat_archive (x, y, unit_type, count, first_tick, last_tick)
      SELECT x, y, unit_type, COUNT(*), MIN(tick), MAX(tick)
      FROM units_seen
      WHERE controlled = 0 AND x IS NOT NULL AND tick <= ?
      GROUP BY x, y, unit_type
      ON CONFLICT(x, y, unit_type) DO UPDATE SET
        count = heat_archive.count + excluded.count,
        first_tick = MIN(heat_archive.first_tick, excluded.first_tick),
        last_tick = MAX(heat_archive.last_tick, excluded.last_tick)
    `).run(row.c);
    db.prepare(
      "DELETE FROM units_seen WHERE controlled = 0 AND x IS NOT NULL AND tick <= ?",
    ).run(row.c);
  } catch {
    // 容错；下次 sync 重试
  }
}

/** upsert 一组可见矿（服务端投影：资源存在）。返回受影响行数。 */
/** 格级负观测写入（2026-08-08，A15）：视野覆盖内确认无矿的已知矿格。
 *  (cell, tick) 幂等（UNIQUE）。由 survey-sync 每 case 判定后批量调用。 */
export function upsertResourceAbsences(db: DatabaseSync, rows: ReadonlyArray<{ cell: string; tick: number }>): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO resource_absences (cell, tick) VALUES (?, ?)",
  );
  let n = 0;
  for (const r of rows) n += Number(stmt.run(r.cell, r.tick).changes);
  return n;
}

export function upsertResources(
  db: DatabaseSync,
  cells: readonly { x: number; y: number }[],
  tick: number,
): number {
  const stmt = db.prepare(`
    INSERT INTO resources (cell, x, y, first_seen_tick, last_seen_tick, state, last_state_tick, seen_count)
    VALUES (?, ?, ?, ?, ?, 'visible', ?, 1)
    ON CONFLICT(cell) DO UPDATE SET
      -- 2026-08-08 数据质量修复：MAX 保护 last_seen 单调递增（旧无条件覆盖导致 run 处理顺序不一时间戳回退→ first>last 倒挂）
      last_seen_tick = MAX(resources.last_seen_tick, excluded.last_seen_tick),
      state = 'visible',
      last_state_tick = excluded.last_state_tick,
      seen_count = resources.seen_count + 1
  `);
  // 出现-消失历史（2026-08-08）：同 tick 同格只记一次（INSERT OR IGNORE），
  // 随 sync 增量累积——refill 周期/出现窗口统计的数据源（mine-patterns）。
  const histStmt = db.prepare("INSERT OR IGNORE INTO resource_seen_history (cell, tick) VALUES (?, ?)");
  let n = 0;
  for (const cell of cells) {
    const key = `${cell.x},${cell.y}`;
    n += Number(stmt.run(key, cell.x, cell.y, tick, tick, tick).changes);
    histStmt.run(key, tick);
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
    ON CONFLICT(cell) DO UPDATE SET
      -- 2026-08-08 数据质量 A10：MAX 保护 last_seen 单调递增（旧无条件覆盖导致 run 顺序不一时 tick 回退 → first>last 倒挂）
      last_seen_tick = MAX(obstacles.last_seen_tick, excluded.last_seen_tick)
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
      first_seen_tick = MIN(core_hunts.first_seen_tick, excluded.first_seen_tick),
      last_seen_tick = MAX(core_hunts.last_seen_tick, excluded.last_seen_tick)
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
    INSERT INTO units_seen (cell, unit_type, controlled, tick, x, y)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(cell, tick) DO NOTHING
  `).run(key, unitType, controlled ? 1 : 0, tick, cell.x, cell.y);
}

/** 稀有事迹写入（幂等：UNIQUE(tenant,tick,event_type,actor_id,target_id)
 *  INSERT OR IGNORE——force 重跑不重复。位置/金额/单位类型供 deeds 叙事。
 *  叙事 A11（2026-08-08）：CORE_DESTROYED 补 reason_code / destroyed_by（JSON 数组）
 *  / is_our_core——deeds 需区分"我方核心被打爆 vs 敌方核心被摧毁 vs 自爆"。 */
export function recordNotableEvent(
  db: DatabaseSync,
  e: {
    tenant: string;
    tick: number;
    eventType: string;
    actorId: string | null;
    targetId: string | null;
    x: number | null;
    y: number | null;
    amount: number | null;
    unitType: string | null;
    reasonCode?: string | null;
    destroyedBy?: readonly string[] | null;
    isOurCore?: boolean | null;
  },
): number {
  const destroyedByJson = e.destroyedBy && e.destroyedBy.length > 0 ? JSON.stringify(e.destroyedBy) : null;
  return Number(db.prepare(`
    INSERT OR IGNORE INTO notable_events (tenant, tick, event_type, actor_id, target_id, x, y, amount, unit_type, reason_code, destroyed_by, is_our_core)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    e.tenant, e.tick, e.eventType, e.actorId, e.targetId, e.x, e.y, e.amount, e.unitType,
    e.reasonCode ?? null, destroyedByJson, e.isOurCore == null ? null : (e.isOurCore ? 1 : 0),
  ).changes);
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


/** 探索分区 upsert：chunk 最后探索 tick（有物体即探索过）。 */
export function upsertChunk(db: DatabaseSync, chunkKey: string, tick: number): void {
  db.prepare(
    "INSERT INTO chunks (chunk_key, last_seen_tick) VALUES (?, ?) " +
    "ON CONFLICT(chunk_key) DO UPDATE SET last_seen_tick = MAX(last_seen_tick, excluded.last_seen_tick)",
  ).run(chunkKey, tick);
}

/** 已知探索分区：返回最后探索 tick ≥ cutoff 的 chunk（跨 run 累积）。 */
export function knownChunks(db: DatabaseSync, minLastSeenTick: number): readonly { key: string; lastSeenTick: number }[] {
  const rows = db.prepare(
    "SELECT chunk_key AS key, last_seen_tick AS lastSeenTick FROM chunks WHERE last_seen_tick >= ? ORDER BY last_seen_tick DESC",
  ).all(minLastSeenTick) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ key: String(r.key), lastSeenTick: Number(r.lastSeenTick) }));
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

/** 已知矿格的缺席统计（2026-08-08，seed 死格过滤）：返回近 absentWindowTicks 内
 *  每个已知矿格的缺席次数——缺席是"我方视野覆盖内确认无矿"的负观测（A15），
 *  高频缺席 = 长期死格（矿补充在 chunk 内别处生成，官方规则：Replenishment
 *  may later create a natural replacement elsewhere in the chunk；t2 实证
 *  缺席→恢复中位 133 tick，多数格缺席后长期不恢复）。 */
export function knownResourceAbsenceCounts(
  db: DatabaseSync,
  sinceTick: number,
): ReadonlyMap<string, number> {
  const rows = db.prepare(
    "SELECT cell, COUNT(*) AS absent FROM resource_absences WHERE tick > ? GROUP BY cell",
  ).all(sinceTick) as Array<Record<string, unknown>>;
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(String(row.cell), Number(row.absent));
  }
  return counts;
}

/** 缺席分级冷却（2026-08-08，动态冷却分级）：缺席计数 → 失败冷却时长分级。
 *  分级依据（t2 实证，absentWindowTicks=20000 内）：p50=246 / p90=1378 次——
 *  缺席 256+ 次 ≈ 持续 1000+ tick 视野确认无矿（采样每 4 tick 一次），长期死格
 *  信号；缺席 < 64 次可能是活跃矿的短暂采空，保持默认 32 tick。分档保守：
 *  只升级"确认死"的格，不拦 refill 后重新可见（visible 优先于冷却）。 */
export function cooldownTierForAbsenceCount(absenceCount: number): number {
  if (absenceCount >= 2048) return 384;
  if (absenceCount >= 512) return 192;
  if (absenceCount >= 128) return 96;
  return 32;
}

/** 已知矿格的分级冷却表（cell → cooldownTicks；仅含缺席 ≥ 128 次的升级格）。
 *  seed/运行期注入 World.seedFailedCooldownTiers 用。空表 = 零回归。 */
export function knownResourceCooldownTiers(
  db: DatabaseSync,
  sinceTick: number,
): ReadonlyMap<string, number> {
  const counts = knownResourceAbsenceCounts(db, sinceTick);
  const tiers = new Map<string, number>();
  for (const [cell, absent] of counts) {
    const cooldown = cooldownTierForAbsenceCount(absent);
    if (cooldown > 32) tiers.set(cell, cooldown);
  }
  return tiers;
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

/** 负态 TTL 过期（P2，2026-08-10）：harvested/empty 格超过阈值未恢复 →
 *  复位 visible（待复查）。对照 world.ts 资源记忆 64-tick TTL；refill 同格
 *  周期实证 avg 37 tick（survey-sync 注释），128 = 2 倍余量。幂等（WHERE 只
 *  命中过期负态行）。在 survey-sync 每 run 开头执行。返回受影响行数。 */
export function expireNegativeResourceStates(db: DatabaseSync, beforeTick: number): number {
  return Number(db.prepare(`
    UPDATE resources SET state = 'visible'
    WHERE state IN ('harvested', 'empty') AND last_state_tick < ?
  `).run(beforeTick).changes);
}

export { dirname };




// ---------- 生命周期（2026-08-08：单位/矿物标注 + 消费记账） ----------

/** 矿物采集事件（HARVEST_SUCCEEDED/FAILED）追加。 */
export function recordResourceEvent(
  db: DatabaseSync,
  cell: string,
  tick: number,
  eventType: string,
  reasonCode: string | null,
  amount: number | null,
  actorId: string | null,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO resource_events (cell, tick, event_type, reason_code, amount, actor_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(cell, tick, eventType, reasonCode, amount, actorId);
}

/** 单位出生（CORE_SPAWN_SUCCEEDED target_id）。 */
export function recordUnitBirth(
  db: DatabaseSync,
  unitId: string,
  unitType: string,
  tick: number,
  pos: { x: number; y: number } | null,
): void {
  db.prepare(`
    INSERT INTO unit_lifecycle (unit_id, unit_type, birth_tick, birth_pos, last_seen_tick, last_seen_pos, current_state)
    VALUES (?, ?, ?, ?, ?, ?, 'alive')
    ON CONFLICT(unit_id) DO UPDATE SET
      birth_tick = COALESCE(unit_lifecycle.birth_tick, excluded.birth_tick),
      birth_pos = COALESCE(unit_lifecycle.birth_pos, excluded.birth_pos),
      last_seen_tick = MAX(unit_lifecycle.last_seen_tick, excluded.last_seen_tick),
      current_state = 'alive'
  `).run(unitId, unitType, tick, pos === null ? null : `${pos.x},${pos.y}`, tick, pos === null ? null : `${pos.x},${pos.y}`);
}

/** 单位死亡（UNIT_DESTROYED actor_id）。 */
export function recordUnitDeath(
  db: DatabaseSync,
  unitId: string,
  tick: number,
  pos: { x: number; y: number } | null,
): void {
  db.prepare(`
    UPDATE unit_lifecycle SET death_tick = ?, death_pos = ?, death_reason = 'DESTROYED', current_state = 'dead'
    WHERE unit_id = ? AND (death_tick IS NULL OR death_tick < ?)
  `).run(tick, pos === null ? null : `${pos.x},${pos.y}`, unitId, tick);
}

/** 单位目击刷新（来自 case before.state.objects UNIT）。 */
export function touchUnitSeen(
  db: DatabaseSync,
  unitId: string,
  unitType: string,
  tick: number,
  pos: { x: number; y: number },
): void {
  const key = `${pos.x},${pos.y}`;
  db.prepare(`
    INSERT INTO unit_lifecycle (unit_id, unit_type, last_seen_tick, last_seen_pos, current_state)
    VALUES (?, ?, ?, ?, 'alive')
    ON CONFLICT(unit_id) DO UPDATE SET
      unit_type = excluded.unit_type,
      last_seen_tick = MAX(unit_lifecycle.last_seen_tick, excluded.last_seen_tick),
      last_seen_pos = excluded.last_seen_pos
  `).run(unitId, unitType, tick, key);
}

/** 核心消费记账（spawn/heal/repair 成功事件的 cost）。 */
export function recordCoreSpend(
  db: DatabaseSync,
  kind: string,
  tick: number,
  amount: number,
  unitType: string | null,
  unitId: string | null,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO core_spends (kind, tick, amount, unit_type, unit_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(kind, tick, amount, unitType, unitId);
}

export interface ResourceLifecycleSummary {
  readonly cell: string;
  readonly x: number;
  readonly y: number;
  readonly state: SurveyResourceState;
  readonly firstSeenTick: number;
  readonly lastSeenTick: number;
  readonly seenCount: number;
  readonly harvestCount: number;
  readonly lastHarvestTick: number | null;
  readonly failCount: number;
}

/** 矿生命周期摘要（资源表 + resource_events 聚合）。 */
export function resourceLifecycle(db: DatabaseSync): readonly ResourceLifecycleSummary[] {
  const rows = db.prepare(`
    SELECT r.cell, r.x, r.y, r.state, r.first_seen_tick, r.last_seen_tick, r.seen_count,
      (SELECT COUNT(*) FROM resource_events e WHERE e.cell = r.cell AND e.event_type = 'HARVEST_SUCCEEDED') AS harvest_count,
      (SELECT MAX(e.tick) FROM resource_events e WHERE e.cell = r.cell AND e.event_type = 'HARVEST_SUCCEEDED') AS last_harvest_tick,
      (SELECT COUNT(*) FROM resource_events e WHERE e.cell = r.cell AND e.event_type = 'HARVEST_FAILED') AS fail_count
    FROM resources r
  `).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    cell: String(r.cell),
    x: Number(r.x),
    y: Number(r.y),
    state: r.state as SurveyResourceState,
    firstSeenTick: Number(r.first_seen_tick),
    lastSeenTick: Number(r.last_seen_tick),
    seenCount: Number(r.seen_count),
    harvestCount: Number(r.harvest_count),
    lastHarvestTick: r.last_harvest_tick === null ? null : Number(r.last_harvest_tick),
    failCount: Number(r.fail_count),
  }));
}

export interface UnitLifecycleRow {
  readonly unitId: string;
  readonly unitType: string;
  readonly birthTick: number | null;
  readonly deathTick: number | null;
  readonly currentState: "alive" | "dead";
  readonly lastSeenTick: number;
}

/** 单位生命周期列表（按类型/状态过滤）。 */
export function unitLifecycleRows(
  db: DatabaseSync,
  filter: { type?: string; state?: "alive" | "dead" } = {},
): readonly UnitLifecycleRow[] {
  const cond: string[] = [];
  const params: (string)[] = [];
  if (filter.type !== undefined) { cond.push("unit_type = ?"); params.push(filter.type); }
  if (filter.state !== undefined) { cond.push("current_state = ?"); params.push(filter.state); }
  const where = cond.length > 0 ? `WHERE ${cond.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT unit_id, unit_type, birth_tick, death_tick, current_state, last_seen_tick
     FROM unit_lifecycle ${where} ORDER BY last_seen_tick DESC LIMIT 2000`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    unitId: String(r.unit_id),
    unitType: String(r.unit_type),
    birthTick: r.birth_tick === null ? null : Number(r.birth_tick),
    deathTick: r.death_tick === null ? null : Number(r.death_tick),
    currentState: r.current_state as "alive" | "dead",
    lastSeenTick: Number(r.last_seen_tick),
  }));
}

export interface CoreSpendSummary {
  readonly kind: string;
  readonly count: number;
  readonly total: number;
  readonly minTick: number;
  readonly maxTick: number;
}

/** 核心消费汇总（按 kind）。 */
export function coreSpendsSummary(db: DatabaseSync): readonly CoreSpendSummary[] {
  const rows = db.prepare(`
    SELECT kind, COUNT(*) AS count, SUM(amount) AS total, MIN(tick) AS min_tick, MAX(tick) AS max_tick
    FROM core_spends GROUP BY kind ORDER BY total DESC
  `).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    kind: String(r.kind),
    count: Number(r.count),
    total: Number(r.total),
    minTick: Number(r.min_tick),
    maxTick: Number(r.max_tick),
  }));
}


