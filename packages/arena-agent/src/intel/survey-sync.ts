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

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { VISION_RADIUS, visionLineBlocked } from "../domain/world.ts";
import {
  markResourceState,
  markSyncMeta,
  openSurveyDb,
  recordNotableEvent,
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
  upsertResourceAbsences,
  upsertChunk,
} from "./survey-db.ts";
import { chunkKeyFor } from "../domain/world.ts";

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
  notables: number;
  absences: number;
}

interface CaseObjects {
  resources: { x: number; y: number }[];
  obstacles: { x: number; y: number }[];
  coreHunts: { x: number; y: number; owner: string | null; source: "CORE" | "WORKER_INFER" }[];
  /** 我方受控核心位置（视野覆盖观察者，A15 负观测用）。 */
  ourCores: { x: number; y: number }[];
  unitSeen: { x: number; y: number; unitType: string; controlled: boolean; id: string | null }[];
}

/** 解析单个 case 的 before.state.objects → 结构化物体集合（容错坏 case）。 */
export function parseCaseObjects(raw: unknown): CaseObjects | null {
  if (typeof raw !== "object" || raw === null) return null;
  const state = (raw as { before?: { state?: { objects?: unknown } } }).before?.state;
  if (typeof state !== "object" || state === null) return null;
  const objects = (state as { objects?: unknown }).objects;
  if (!Array.isArray(objects)) return null;
  const out: CaseObjects = { resources: [], obstacles: [], coreHunts: [], ourCores: [], unitSeen: [] };
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
      if (Array.isArray(o.position) && o.position.length === 2) {
        const x = Number(o.position[0]);
        const y = Number(o.position[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          if (o.controlled === true) {
            out.ourCores.push({ x, y });
          } else {
            out.coreHunts.push({
              x,
              y,
              owner: typeof o.owner_username === "string" && o.owner_username.length > 0 ? o.owner_username : null,
              source: "CORE",
            });
          }
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
  /** 稀有事迹（★2-4：核心摧毁/夺取/信标/自爆/阵亡等）——持久化防 run 轮换丢失。
   *  叙事 A11（2026-08-08）：CORE_DESTROYED 补 reasonCode / destroyedBy（攻击者数组）
   *  / isOurCore（target ∈ before.state 受控核心）——deeds 敌我语义修复。 */
  notables: { eventType: string; actorId: string | null; targetId: string | null; pos: { x: number; y: number } | null; amount: number | null; unitType: string | null; reasonCode: string | null; destroyedBy: readonly string[] | null; isOurCore: boolean | null }[];
}

/** 解析 case 的 after.events → 生命周期事件集（容错坏事件）。 */
export function parseCaseLifecycle(raw: unknown, tick: number): LifecycleEvents {
  const out: LifecycleEvents = { births: [], deaths: [], harvests: [], harvestFails: [], spends: [], notables: [] };
  if (typeof raw !== "object" || raw === null) return out;
  const rawCase = raw as { before?: { state?: { objects?: unknown } }; after?: { state?: { events?: unknown } } };
  // 叙事 A11：受控核心集合（target_id ∈ 集合 → CORE_DESTROYED 是我方核心被打爆）。
  // 与 builder.coreRiskAt / deeds 迁移 coreDestroyedByTick 同判据。
  const ourCoreIds = new Set<string>();
  const objects = rawCase.before?.state?.objects;
  if (Array.isArray(objects)) {
    for (const o of objects) {
      if (o && typeof o === "object") {
        const obj = o as { kind?: unknown; controlled?: unknown; id?: unknown };
        if (obj.kind === "CORE" && obj.controlled && typeof obj.id === "string") ourCoreIds.add(obj.id);
      }
    }
  }
  const after = rawCase.after?.state;
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
    } else if (NOTABLE_TYPES.has(String(type))) {
      // 稀有事迹（2026-08-08，审计 A4）：持久化，deeds 查库替代回扫
      // 叙事 A11：CORE_DESTROYED 带 reasonCode / destroyedBy（数组）/ isOurCore
      const rawBy = vals.destroyed_by;
      const destroyedBy = Array.isArray(rawBy)
        ? rawBy.filter((u): u is string => typeof u === "string")
        : typeof rawBy === "string" && rawBy.trim() !== ""
          ? [rawBy]
          : null;
      out.notables.push({
        eventType: String(type),
        actorId: typeof e.actor_id === "string" ? e.actor_id : null,
        targetId: typeof e.target_id === "string" ? e.target_id : null,
        pos,
        amount: typeof vals.amount === "number" ? Math.round(vals.amount) : null,
        unitType: typeof vals.unit_type === "string" ? vals.unit_type : null,
        reasonCode: typeof e.reason_code === "string" ? e.reason_code : null,
        destroyedBy: destroyedBy && destroyedBy.length > 0 ? destroyedBy : null,
        isOurCore: String(type) === "CORE_DESTROYED" && typeof e.target_id === "string"
          ? ourCoreIds.has(e.target_id)
          : null,
      });
    }
  }
  return out;
}

/** 稀有事迹事件类型（★2-4 叙事；★1 噪声不入库，deeds 从扫描/热区取）。 */
const NOTABLE_TYPES = new Set([
  "CORE_DESTROYED",
  "CORE_RESOURCES_CAPTURED",
  "CORE_RESOURCE_OVERFLOW_DESTROYED",
  "PICKUP_BEACON_SUCCEEDED",
  "DROP_BEACON_SUCCEEDED",
  "SELF_DESTRUCT",
  "UNIT_DESTROYED",
]);

/** 选最新 run：按 run 目录 mtime（agent 只写最新 run，case 写入更新目录
 *  mtime——2026-08-08 修复 `--latest-only` 用字符串排序选错 run 的 bug：UUID
 *  字典序 ≠ 时间序，导致最新 run（最高 case tick）永不同步、survey-db 滞后
 *  ~190 tick）。与面板 fs-jsonl.latestRunDirInner 同判据。 */
function latestRunDirByMtime(calDir: string, runDirs: string[]): string {
  let best = runDirs[0];
  let bestM = -1;
  for (const d of runDirs) {
    try {
      const m = statSync(join(calDir, d)).mtimeMs;
      if (m > bestM) {
        bestM = m;
        best = d;
      }
    } catch {
      /* 忽略不可 stat 的目录 */
    }
  }
  return best;
}

/** 同步一个租户的全部（或最新）calibration run 到测绘库。返回汇总。 */
/** 格级负观测收集（2026-08-08，A15）：我方视野（单位+Core，曼哈顿 ≤ 半径且
 *  supercover 视线无遮挡）覆盖内、本 case 资源列表缺席的「已知矿格」→ 真实缺席
 *  记录。区别于 resource_seen_history 的观测中断（视野离开=假消失）。已知矿格
 *  来自 resources 表累积测绘；每 case 扫描已知格 × 观察者（曼哈顿 O(1) 预过滤，
 *  命中才跑 supercover 视线）。返回待写 absence 行（调用方批量 upsert）。 */
export function collectResourceAbsences(
  db: DatabaseSync,
  objects: CaseObjects,
  tick: number,
): Array<{ cell: string; tick: number }> {
  if (objects.unitSeen.length === 0 && objects.ourCores.length === 0) return [];
  const knownRows = db.prepare("SELECT x, y FROM resources").all() as Array<{ x: number; y: number }>;
  if (knownRows.length === 0) return [];
  const known = new Set<string>();
  for (const r of knownRows) known.add(`${r.x},${r.y}`);
  const nowRes = new Set(objects.resources.map((p) => `${p.x},${p.y}`));
  const obstacles = new Set(objects.obstacles.map((p) => `${p.x},${p.y}`));
  const observers: Array<{ x: number; y: number; radius: number }> = [];
  for (const u of objects.unitSeen) {
    if (!u.controlled) continue;
    const radius = VISION_RADIUS[u.unitType as keyof typeof VISION_RADIUS] ?? 3;
    observers.push({ x: u.x, y: u.y, radius });
  }
  for (const c of objects.ourCores) observers.push({ x: c.x, y: c.y, radius: VISION_RADIUS.CORE });
  if (observers.length === 0) return [];
  const out: Array<{ cell: string; tick: number }> = [];
  for (const cell of known) {
    if (nowRes.has(cell)) continue;
    const [x, y] = cell.split(",").map((v) => Number(v));
    let covered = false;
    for (const ob of observers) {
      if (Math.abs(ob.x - x) + Math.abs(ob.y - y) > ob.radius) continue;
      if (visionLineBlocked([ob.x, ob.y], [x, y], obstacles)) continue;
      covered = true;
      break;
    }
    if (covered) out.push({ cell, tick });
  }
  return out;
}

export function syncTenantSurvey(
  dataRoot: string,
  tenant: string,
  options: SyncOptions = {},
): SyncSummary {
  const db = options.db ?? openSurveyDb(dataRoot, tenant, true);
  const calDir = join(dataRoot, "runtime", tenant, "calibration");
  const summary: Mutable<SyncSummary> = { tenant, runs: 0, cases: 0, resources: 0, obstacles: 0, coreHunts: 0, notables: 0, absences: 0 };
  if (!existsSync(calDir)) return summary;
  const runDirs = readdirSync(calDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const targets = options.latestRunOnly
    ? runDirs.length > 0
      ? [latestRunDirByMtime(calDir, runDirs)]
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
      // 单位目击：units_seen 只记敌方（热区记忆，受控单位生命周期走 unit_lifecycle，
      // 我方目击行无消费方且膨胀 99% 行数——A14 收敛：仅敌方写 units_seen）。
      for (const u of objects.unitSeen) {
        if (!u.controlled) upsertUnitSeen(db, u, u.unitType, u.controlled, tick);
        if (u.controlled && u.id !== null) touchUnitSeen(db, u.id, u.unitType, tick, u);
      }
      // 探索分区（2026-08-08）：case 内所有物体位置 → 16×16 chunk 最后探索 tick
      // ——"探索过的区域"跨 run 记忆（有物体 = 该 chunk 被探索过）。
      for (const pos of [...objects.resources, ...objects.obstacles, ...objects.coreHunts.map((h) => ({ x: h.x, y: h.y })), ...objects.unitSeen.map((u) => ({ x: u.x, y: u.y }))]) {
        upsertChunk(db, chunkKeyFor([pos.x, pos.y]), tick);
      }
      // 格级负观测（2026-08-08，A15）：视野覆盖内确认无矿的已知矿格 → 真实缺席
      // 记录（resource_absences）。为矿刷新周期实证供数据，替代不可靠的出现窗口推断。
      const absences = collectResourceAbsences(db, objects, tick);
      if (absences.length > 0) summary.absences += upsertResourceAbsences(db, absences);
            // 生命周期事件（2026-08-08）：spawn/destroy/harvest/heal/repair
      const lc = parseCaseLifecycle(raw, tick);
      for (const b of lc.births) recordUnitBirth(db, b.unitId, b.unitType, b.tick, b.pos);
      for (const d of lc.deaths) recordUnitDeath(db, d.unitId, d.tick, d.pos);
      // 矿生命周期状态回写（2026-08-08 闭环）：采集事件是"该格当前无矿"的权威证据。
      //  - HARVEST_SUCCEEDED：该格刚被采空（2-6 tick 后从视野消失前仍可见时），
      //    立即标 harvested——此前 state 永远是 visible，"过时矿"地图层根因；
      //  - HARVEST_FAILED RESOURCE_DEPLETED：他人已采空（我们视野可见但无矿）→ empty；
      //  - HARVEST_FAILED NOT_RESOURCE_CELL：记忆格已耗尽/不存在 → harvested（负记忆）；
      //  - 矿 refill 后重新可见时 upsertResources 自动置回 visible（游戏 4 tick 结算
      //    后按 chunk quota 确定性补充，实证同格 refill 周期 avg 37 tick）。
      for (const h of lc.harvests) {
        recordResourceEvent(db, h.cell, h.tick, "HARVEST_SUCCEEDED", null, h.amount, h.actorId);
        markResourceState(db, h.cell, "harvested", h.tick);
      }
      for (const f of lc.harvestFails) {
        recordResourceEvent(db, f.cell, f.tick, "HARVEST_FAILED", f.reason, null, f.actorId);
        if (f.reason === "RESOURCE_DEPLETED") markResourceState(db, f.cell, "empty", f.tick);
        else if (f.reason === "NOT_RESOURCE_CELL") markResourceState(db, f.cell, "harvested", f.tick);
      }
      for (const s of lc.spends) recordCoreSpend(db, s.kind, s.tick, s.amount, s.unitType, s.unitId);
      for (const n of lc.notables) {
        summary.notables += recordNotableEvent(db, { tenant, tick, eventType: n.eventType, actorId: n.actorId, targetId: n.targetId, x: n.pos?.x ?? null, y: n.pos?.y ?? null, amount: n.amount, unitType: n.unitType, reasonCode: n.reasonCode, destroyedBy: n.destroyedBy, isOurCore: n.isOurCore });
      }
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







