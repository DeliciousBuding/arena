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
  syncMeta,
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
  unitSeen: { x: number; y: number; unitType: string; controlled: boolean }[];
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
      const o = obj as { position?: unknown; unit_type?: unknown; controlled?: unknown };
      if (Array.isArray(o.position) && o.position.length === 2) {
        const x = Number(o.position[0]);
        const y = Number(o.position[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          out.unitSeen.push({
            x,
            y,
            unitType: typeof o.unit_type === "string" ? o.unit_type : "WORKER",
            controlled: o.controlled === true,
          });
        }
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
    // 已同步水位：跳过 tick <= lastTick 的 case
    const skipBelow = meta?.lastTick ?? -1;
    let maxTick = meta?.lastTick ?? -1;
    let casesInRun = meta?.casesSynced ?? 0;
    let runStarted = false;
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
      for (const u of objects.unitSeen) upsertUnitSeen(db, u, u.unitType, u.controlled, tick);
      if (tick > maxTick) maxTick = tick;
      casesInRun += 1;
    }
    if (runStarted) {
      markSyncMeta(db, runDir, tenant, maxTick, casesInRun);
      summary.runs += 1;
      summary.cases += casesInRun;
    }
  }
  if (options.db === undefined) db.close();
  return summary;
}

