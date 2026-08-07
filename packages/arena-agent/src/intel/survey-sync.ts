/**
 * 测绘增量同步器（2026-08-08）：把 calibration case 增量写入测绘库。
 *
 * 数据源 = runtime/<tenant>/calibration/<run>/cases/*.json 的 before.state
 * （服务端全量投影：RESOURCE/OBSTACLE/CORE/UNIT 对象）。
 * 幂等：sync_meta 记录每个 run 已同步的最大 tick，跳过已同步 case。
 *
 * 调用方式：
 *   - CLI：`npm run survey:sync -- --tenants=t1,t2,t3,t4`
 *   - 程序内：`syncTenantSurvey(dataRoot, tenant, { db })`
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  markSyncMeta,
  openSurveyDb,
  recordCoreSpend,
  recordResourceEvent,
  recordUnitBirth,
  recordUnitDeath,
  syncMeta,
  touchUnitSeen,
  upsertCoreHunt,
  upsertObstacles,
  upsertResources,
  upsertUnitSeen,
} from "./survey-db.ts";

export interface SyncOptions {
  /** 已打开的测绘库（缺省 = 自动打开 write）。 */
  readonly db?: DatabaseSync;
  /** 只同步最新 run（缺省同步该租户全部 run——跨 run 累积）。 */
  readonly latestRunOnly?: boolean;
  /** 强制重跑全部 case（忽略 sync_meta 水位；新增表回填用）。 */
  readonly force?: boolean;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface SyncSummary {
  readonly tenant: string;
  runs: number;
  cases: number;
  resources: number;
  obstacles: number;
  coreHunts: number;
}

interface CaseObjects {
  resources: { x: number; y: number }[];
  obstacles: { x: number; y: number }[];
  coreHunts: { x: number; y: number; owner: string | null; source: "CORE" | "WORKER_INFER" }[];
  unitSeen: { x: number; y: number; unitType: string; controlled: boolean; id: string | null }[];
}

/** 解析单个 case 的 before.state.objects → 结构化物体集合（容错坏 case）。 */
export function parseCaseObjects(raw: unknown): CaseObjects | null {
  if (typeof raw !== "object" || raw === null) return null;
  const state = (raw as { before?: { state?: { objects?: unknown } } }).before?.state;
  if (typeof state !== "object" || state === null) return null;
  const objects = (state as { objects?: unknown }).objects;
  if (!Array.isArray(objects)) return null;
  const out: CaseObjects = { resources: [], obstacles: [], coreHunts: [], unitSeen: [] };
  for (const obj of objects) {
    if (typeof obj !== "object" || obj === null) continue;
    const kind = (obj as { kind?: unknown }).kind;
    if (kind === "OBSTACLE" || kind === "RESOURCE") {
      const positions = (obj as { positions?: unknown }).positions;
      if (Array.isArray(positions)) {
        for (const p of positions) {
          if (Array.isArray(p) && p.length === 2 && typeof p[0] === "number" && typeof p[1] === "number") {
            (kind === "OBSTACLE" ? out.obstacles : out.resources).push({ x: p[0], y: p[1] });
          }
        }
      }
    } else if (kind === "CORE") {
      const o = obj as { position?: unknown; owner_username?: unknown; controlled?: unknown };
      if (Array.isArray(o.position) && o.position.length === 2 && o.controlled === false) {
        const x = Number(o.position[0]);
        const y = Number(o.position[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          out.coreHunts.push({
            x,
            y,
            owner: typeof o.owner_username === "string" && o.owner_username.length > 0 ? o.owner_username : null,
            source: "CORE",
          });
        }
      }
    } else if (kind === "UNIT") {
      const o = obj as { position?: unknown; unit_type?: unknown; controlled?: unknown; id?: unknown };
      if (Array.isArray(o.position) && o.position.length === 2) {
        const x = Number(o.position[0]);
        const y = Number(o.position[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          out.unitSeen.push({
            x,
            y,
            unitType: typeof o.unit_type === "string" ? o.unit_type : "WORKER",
            controlled: o.controlled === true,
            id: typeof o.id === "string" && o.id.length > 0 ? o.id : null,
          });
        }
      }
    }
  }
  return out;
}

/** 生命周期事件（从 case after.events 提取——完整 actor/position/values）。 */
export interface LifecycleEvents {
  births: { unitId: string; unitType: string; tick: number; pos: { x: number; y: number } | null }[];
  deaths: { unitId: string; tick: number; pos: { x: number; y: number } | null }[];
  harvests: { cell: string; tick: number; amount: number | null; actorId: string | null }[];
  harvestFails: { cell: string; tick: number; reason: string | null; actorId: string | null }[];
  spends: { kind: string; tick: number; amount: number; unitType: string | null; unitId: string | null }[];
}

/** 解析 case 的 after.events → 生命周期事件集（容错坏事件）。 */
export function parseCaseLifecycle(raw: unknown, tick: number): LifecycleEvents {
  const out: LifecycleEvents = { births: [], deaths: [], harvests: [], harvestFails: [], spends: [] };
  if (typeof raw !== "object" || raw === null) return out;
  const after = (raw as { after?: { state?: { events?: unknown } } }).after?.state;
  if (typeof after !== "object" || after === null) return out;
  const events = (after as { events?: unknown }).events;
  if (!Array.isArray(events)) return out;
  const posOf = (p: unknown): { x: number; y: number } | null =>
    Array.isArray(p) && p.length === 2 && typeof p[0] === "number" && typeof p[1] === "number"
      ? { x: p[0], y: p[1] }
      : null;
  for (const ev of events) {
    if (typeof ev !== "object" || ev === null) continue;
    const e = ev as { event_type?: unknown; actor_id?: unknown; target_id?: unknown; position?: unknown; reason_code?: unknown; values?: unknown };
    const type = e.event_type;
    const pos = posOf(e.position);
    const vals = (e.values ?? {}) as Record<string, unknown>;
    if (type === "CORE_SPAWN_SUCCEEDED" && typeof e.target_id === "string") {
      out.births.push({
        unitId: e.target_id,
        unitType: typeof vals.unit_type === "string" ? vals.unit_type : "WORKER",
        tick,
        pos,
      });
      const cost = typeof vals.cost === "number" ? Math.round(vals.cost) : 0;
      if (cost > 0) {
        out.spends.push({
          kind: "spawn",
          tick,
          amount: cost,
          unitType: typeof vals.unit_type === "string" ? vals.unit_type : null,
          unitId: e.target_id,
        });
      }
    } else if (type === "UNIT_DESTROYED" && typeof e.actor_id === "string") {
      out.deaths.push({ unitId: e.actor_id, tick, pos });
    } else if (type === "HARVEST_SUCCEEDED" && pos !== null) {
      out.harvests.push({
        cell: `${pos.x},${pos.y}`,
        tick,
        amount: typeof vals.amount === "number" ? Math.round(vals.amount) : null,
        actorId: typeof e.actor_id === "string" ? e.actor_id : null,
      });
    } else if (type === "HARVEST_FAILED" && pos !== null) {
      out.harvestFails.push({
        cell: `${pos.x},${pos.y}`,
        tick,
        reason: typeof e.reason_code === "string" ? e.reason_code : null,
        actorId: typeof e.actor_id === "string" ? e.actor_id : null,
      });
    } else if (type === "CORE_HEAL_SUCCEEDED" || type === "CORE_REPAIR_SUCCEEDED" || type === "UNIT_HEAL_SUCCEEDED") {
      const cost = typeof vals.cost === "number" ? Math.round(vals.cost) : 0;
      if (cost > 0) {
        out.spends.push({
          kind: type === "CORE_HEAL_SUCCEEDED" ? "core_heal" : type === "CORE_REPAIR_SUCCEEDED" ? "repair" : "unit_heal",
          tick,
          amount: cost,
          unitType: null,
          unitId: typeof e.actor_id === "string" ? e.actor_id : null,
        });
      }
    }
  }
  return out;
}

/** 同步一个租户的全部（或最新）calibration run 到测绘库。返回汇总。 */
export function syncTenantSurvey(
  dataRoot: string,
  tenant: string,
  options: SyncOptions = {},
): SyncSummary {
  const db = options.db ?? openSurveyDb(dataRoot, tenant, true);
  const calDir = join(dataRoot, "runtime", tenant, "calibration");
  const summary: Mutable<SyncSummary> = { tenant, runs: 0, cases: 0, resources: 0, obstacles: 0, coreHunts: 0 };
  if (!existsSync(calDir)) return summary;
  const runDirs = readdirSync(calDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const targets = options.latestRunOnly
    ? runDirs.length > 0
      ? [runDirs[runDirs.length - 1]]
      : []
    : runDirs;
  for (const runDir of targets) {
    const meta = syncMeta(db, runDir);
    const casesDir = join(calDir, runDir, "cases");
    if (!existsSync(casesDir)) continue;
    const files = readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();
    if (files.length === 0) continue;
    // 已同步水位：跳过 tick <= lastTick 的 case（force 忽略）
    const skipBelow = options.force === true ? -1 : (meta?.lastTick ?? -1);
    let maxTick = meta?.lastTick ?? -1;
    let casesInRun = meta?.casesSynced ?? 0;
    let runStarted = false;
    // 每 run 一个事务（2026-08-08 性能优化）：全量回填 2w+ case 逐条
    // autocommit 极慢（每次 INSERT 独立 fsync，t2/t3/t4 全量 ~20 分钟）；
    // SAVEPOINT 嵌套安全——外部已开事务（如测试传入 db）也兼容。
    db.exec("SAVEPOINT survey_sync_run");
    try {
    for (const file of files) {
      const tick = Number(file.replace(/^0+/, "").replace(/\.json$/, ""));
      if (!Number.isFinite(tick)) continue;
      if (tick <= skipBelow) continue;
      const path = join(casesDir, file);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        continue;
      }
      const objects = parseCaseObjects(raw);
      if (objects === null) continue;
      runStarted = true;
      const r = upsertResources(db, objects.resources, tick);
      const o = upsertObstacles(db, objects.obstacles, tick);
      summary.resources += r;
      summary.obstacles += o;
      for (const hunt of objects.coreHunts) {
        summary.coreHunts += upsertCoreHunt(db, hunt, hunt.owner, hunt.source, tick);
      }
      // 单位目击：只记受控单位到生命周期（敌方单位无稳定身份追踪价值，记 units_seen 即可）
      for (const u of objects.unitSeen) {
        upsertUnitSeen(db, u, u.unitType, u.controlled, tick);
        if (u.controlled && u.id !== null) touchUnitSeen(db, u.id, u.unitType, tick, u);
      }
      // 生命周期事件（2026-08-08）：spawn/destroy/harvest/heal/repair
      const lc = parseCaseLifecycle(raw, tick);
      for (const b of lc.births) recordUnitBirth(db, b.unitId, b.unitType, b.tick, b.pos);
      for (const d of lc.deaths) recordUnitDeath(db, d.unitId, d.tick, d.pos);
      for (const h of lc.harvests) recordResourceEvent(db, h.cell, h.tick, "HARVEST_SUCCEEDED", null, h.amount, h.actorId);
      for (const f of lc.harvestFails) recordResourceEvent(db, f.cell, f.tick, "HARVEST_FAILED", f.reason, null, f.actorId);
      for (const s of lc.spends) recordCoreSpend(db, s.kind, s.tick, s.amount, s.unitType, s.unitId);
      if (tick > maxTick) maxTick = tick;
      casesInRun += 1;
    }
    if (runStarted) {
      markSyncMeta(db, runDir, tenant, maxTick, casesInRun);
      db.exec("RELEASE survey_sync_run");
      summary.runs += 1;
      summary.cases += casesInRun;
    } else {
      db.exec("ROLLBACK TO survey_sync_run");
      db.exec("RELEASE survey_sync_run");
    }
    } catch (err) {
      db.exec("ROLLBACK TO survey_sync_run");
      db.exec("RELEASE survey_sync_run");
      throw err;
    }
  }
  if (options.db === undefined) db.close();
  return summary;
}







