/**
 * 实时流读取：overview（outcome 快照 + 60 tick 均值）、runtime 决策流、
 * 回放轨迹、计划/世界快照、事件流。全部只读 calibration/telemetry JSONL。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TENANTS, DATA_ROOT, calibrationDir, latestRunDir, listCases, parseTick, readJsonlTail, telemetryDir } from "./fs-jsonl.ts";
import { openAgentDb, knownAgent } from "./agent-ingest.ts";
import type { SupervisorState } from "./supervisor.ts";

const LIVE_FRESH_MS = 90_000; // outcome.jsonl mtime 新鲜窗口 = 在线
/** 台账与 JSONL 合并的 tick 容差：同一次运行内 ingest flush 滞后约 150 tick，
 *  超过该差值视为旧 run 残留，不合并（避免旧数据混入主指标）。 */
const JSONL_MERGE_TICK_TOLERANCE = 600;

export interface OverviewTenant {
  tenant: string;
  live: boolean;
  supervisor: { alive?: boolean; ready?: boolean; pid?: number | null; lifecycle?: string | null } | null;
  fileFresh: boolean;
  mtime: number | null;
  latest: {
    tick?: number | null;
    resources?: number | null;
    resourceDelta?: number | null;
    workers?: number | null;
    workersWithCargo?: number | null;
    workerMaxDistance?: number | null;
    workerMeanDistance?: number | null;
    visibleResources?: number | null;
    visibleEnemies?: number | null;
    coreX?: number | null;
    coreY?: number | null;
    status?: string | null;
    events?: number;
  } | null;
  window: { avgResources: number | null; avgWorkers: number | null; avgMaxDistance: number | null };
}
export interface OverviewPayload { generatedAt: string; dataRoot: string; tenants: OverviewTenant[] }

/** 每租户最新 outcome 快照 + 近 60 tick 均值（资源/人口展示）。
 *  双源合并（2026-08-10 t1 回归修复）：agents 台账（python-mapping-
 *  telemetry-v1）与 TS 格式 outcome.jsonl 不再是二选一——台账新鲜（updated_at
 *  < LIVE_FRESH_MS）即以台账字段为基准（tick/resources/units/敌数/核心坐标），
 *  JSONL last 行存在且 tick 接近（同一进程同一次运行）时并入 JSONL 独有丰富
 *  字段（resourceDelta/worker 距离/带货运工/可见资源/事件）；台账不新鲜回退
 *  JSONL-only fallback（旧数据展示）。python 租户（t2/t3/t4）不写 TS 格式
 *  JSONL，天然走台账-only 分支。 */
export function loadOverview(supervisorState: SupervisorState | null): OverviewPayload {
  const tenants: OverviewTenant[] = [];
  for (const tenant of TENANTS) {
    const ledger = openAgentDb(tenant, false);
    const agent = knownAgent(ledger, tenant);
    const ledgerFresh =
      agent !== null &&
      agent.updatedAt !== null &&
      Date.now() - Date.parse(agent.updatedAt) < LIVE_FRESH_MS;

    const file = join(telemetryDir(tenant), "outcome.jsonl");
    const rows = readJsonlTail(file, 200);
    const last = rows[rows.length - 1] ?? null;
    const window = rows.slice(-60);
    const avg = (fn: (r: Record<string, unknown>) => unknown): number | null => {
      const vals = window.map(fn).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    let fresh = false;
    let mtime: number | null = null;
    if (existsSync(file)) {
      mtime = statSync(file).mtimeMs;
      fresh = Date.now() - mtime < LIVE_FRESH_MS;
    }
    const sup = supervisorState?.tenants?.find((t) => t.tenantId === tenant) ?? null;
    const live = sup
      ? sup.ready === true && sup.alive === true
      : ledgerFresh || fresh;
    // 台账字段为基准（python 摘要）：resources/population/units/敌数/核心坐标。
    // 台账新鲜 + JSONL last 行存在且 tick 接近（同一进程同一次运行，生产 t1
    // 滞后 ~150 tick）时合并 JSONL 独有丰富字段——否则 t1 主指标行
    // （增量/事件/最大距离/可见资源）被 null/0 遮蔽（2026-08-10 t1 回归）。
    const latest = ledgerFresh && agent !== null
      ? (() => {
          const lastTick = typeof last?.tick === "number" ? last.tick : null;
          const tickClose =
            lastTick !== null &&
            agent.tick !== null &&
            Math.abs(lastTick - agent.tick) <= JSONL_MERGE_TICK_TOLERANCE;
          const base = {
            tick: agent.tick,
            resources: agent.resources,
            resourceDelta: null,
            // 台账语义：units = 单位总数（python 租户 t2/t3/t4 无 TS JSONL，
            // 只有台账可读）
            workers: agent.units,
            workersWithCargo: null,
            workerMaxDistance: null,
            workerMeanDistance: null,
            visibleResources: null,
            visibleEnemies: agent.visibleEnemies,
            coreX: agent.coreX,
            coreY: agent.coreY,
            status: agent.status,
            events: 0,
          };
          if (last === null || !tickClose) return base;
          return {
            ...base,
            // JSONL 语义：workerCount = 自有 worker 数（t1）；台账 units =
            // 单位总数——合并模式下 JSONL 存在即用 workerCount，缺字段回落台账
            workers: (last.workerCount as number | undefined) ?? agent.units,
            resourceDelta: (last.coreResourceDelta as number | undefined) ?? null,
            workerMaxDistance: (last.workerMaxDistanceFromCore as number | undefined) ?? null,
            workerMeanDistance: (last.workerMeanDistanceFromCore as number | undefined) ?? null,
            workersWithCargo: (last.workersWithCargo as number | undefined) ?? null,
            visibleResources: (last.visibleResourceCellCount as number | undefined) ?? null,
            events: Array.isArray(last.events) ? (last.events as unknown[]).length : 0,
          };
        })()
      : last
        ? {
            tick: (last.tick as number | undefined) ?? null,
            resources: (last.coreResourcesAfter as number | undefined) ?? null,
            resourceDelta: (last.coreResourceDelta as number | undefined) ?? null,
            workers: (last.workerCount as number | undefined) ?? null,
            workersWithCargo: (last.workersWithCargo as number | undefined) ?? null,
            workerMaxDistance: (last.workerMaxDistanceFromCore as number | undefined) ?? null,
            workerMeanDistance: (last.workerMeanDistanceFromCore as number | undefined) ?? null,
            visibleResources: (last.visibleResourceCellCount as number | undefined) ?? null,
            events: Array.isArray(last.events) ? (last.events as unknown[]).length : 0,
          }
        : null;
    tenants.push({
      tenant,
      live,
      supervisor: sup ? { alive: sup.alive, ready: sup.ready, pid: sup.pid ?? null, lifecycle: sup.lifecycle ?? null } : null,
      fileFresh: fresh,
      mtime,
      latest,
      window: {
        avgResources: avg((r) => r.coreResourcesAfter),
        avgWorkers: avg((r) => r.workerCount),
        avgMaxDistance: avg((r) => r.workerMaxDistanceFromCore),
      },
    });
  }
  return { generatedAt: new Date().toISOString(), dataRoot: DATA_ROOT, tenants };
}

export function loadStream(tenant: string, n: number): { tenant: string; generatedAt: string; rows: Record<string, unknown>[] } {
  const file = join(telemetryDir(tenant), "runtime.jsonl");
  const rows = readJsonlTail(file, n);
  return { tenant, generatedAt: new Date().toISOString(), rows };
}

/** 回放缓存：同一 run 全部 case 的紧凑单位/核心轨迹（每 tick 位置），供前端回放动画。 */
const replayCache = new Map<string, { runId: string; replay: ReplayPayload }>(); // tenant -> { runId, replay }

interface ReplayPayload {
  tenant: string;
  runId: string;
  ticks: number[];
  units: Array<{ id: string; type: string; controlled?: boolean; trail: Array<{ t: number; x: number; y: number; hp: number; cargo: number }> }>;
  cores: Array<{ id: string; controlled?: boolean; owner?: string | null; trail: Array<{ t: number; x: number; y: number; hp: number; shield: number }> }>;
  eventFrames: Array<{ tick: number; events: Array<Record<string, unknown>> }>;
}

export function loadReplay(tenant: string): ReplayPayload | null {
  const runDir = latestRunDir(tenant);
  if (!runDir) return null;
  const cached = replayCache.get(tenant);
  if (cached && cached.runId === runDir) return cached.replay;
  const caseFiles = listCases(tenant, runDir);
  if (!caseFiles.length) return null;
  const units = new Map<string, { type: string; controlled?: boolean; trail: Array<{ t: number; x: number; y: number; hp: number; cargo: number }> }>();
  const cores = new Map<string, { controlled?: boolean; owner?: string | null; trail: Array<{ t: number; x: number; y: number; hp: number; shield: number }> }>();
  const ticks: number[] = [];
  for (const file of caseFiles) {
    const tick = parseTick(file);
    ticks.push(tick);
    const path = join(calibrationDir(tenant), runDir, "cases", file);
    let raw: { before?: { state?: { objects?: Array<Record<string, unknown>> } } } | null = null;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    const state = raw?.before?.state;
    if (!state?.objects) continue;
    for (const obj of state.objects) {
      const pos = obj.position as number[] | undefined;
      if (obj.kind === "UNIT" && obj.id && pos) {
        let u = units.get(obj.id as string);
        if (!u) { u = { type: (obj.unit_type as string | undefined) ?? "WORKER", controlled: obj.controlled as boolean, trail: [] }; units.set(obj.id as string, u); }
        u.trail.push({ t: tick, x: pos[0], y: pos[1], hp: (obj.hp as number | undefined) ?? 0, cargo: (obj.cargo as number | undefined) ?? 0 });
      } else if (obj.kind === "CORE" && obj.id && pos) {
        let c = cores.get(obj.id as string);
        if (!c) { c = { controlled: obj.controlled as boolean, owner: typeof obj.owner_username === "string" ? obj.owner_username : null, trail: [] }; cores.set(obj.id as string, c); }
        c.trail.push({ t: tick, x: pos[0], y: pos[1], hp: (obj.hp as number | undefined) ?? 0, shield: (obj.shield as number | undefined) ?? 0 });
      }
    }
  }
  // 每 tick 事件帧（compact：战斗/资源活动可视化用；position 存在才保留）。
  const eventFrames: Array<{ tick: number; events: Array<Record<string, unknown>> }> = [];
  for (const file of caseFiles) {
    const tick = parseTick(file);
    const path = join(calibrationDir(tenant), runDir, "cases", file);
    let raw: { before?: { state?: { objects?: Array<Record<string, unknown>>; events?: Array<Record<string, unknown>> } }; after?: { state?: { objects?: Array<Record<string, unknown>>; events?: Array<Record<string, unknown>> } } } | null = null;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    const st = raw?.after?.state ?? raw?.before?.state;
    const byId = new Map<string, Record<string, unknown>>();
    for (const o of st?.objects ?? []) if (o.id) byId.set(o.id as string, o);
    const events = (st?.events ?? [])
      .filter((ev) => ev && ev.event_type && ev.position)
      .map((ev) => {
        const actor = byId.get(ev.actor_id as string), target = byId.get(ev.target_id as string);
        return {
          t: ev.event_type,
          p: ev.position,
          f: actor?.position ?? null,   // 射击/清扫 起点（绘制弹道弧）
          q: target?.position ?? null,  // 终点（命中/落点特效）
          a: ev.actor_id ? String(ev.actor_id).slice(0, 8) : null,
          g: ev.target_id ? String(ev.target_id).slice(0, 8) : null,
          v: ev.values ?? null,
        };
      });
    if (events.length) eventFrames.push({ tick, events });
  }
  const replay: ReplayPayload = {
    tenant, runId: runDir,
    ticks,
    units: [...units.entries()].map(([id, u]) => ({ id, ...u })),
    cores: [...cores.entries()].map(([id, c]) => ({ id, ...c })),
    eventFrames,
  };
  replayCache.set(tenant, { runId: runDir, replay });
  return replay;
}

/** 最新 case 的决策计划（unitActions/coreAction/intents），供待执行命令面板 + 计划箭头。 */
export function loadPlan(tenant: string): { tenant: string; generatedAt: string; plan: unknown; tick: number | null; error?: string } {
  const runDir = latestRunDir(tenant);
  if (runDir === null) return { tenant, generatedAt: new Date().toISOString(), plan: null, tick: null };
  const caseFiles = listCases(tenant, runDir);
  if (!caseFiles.length) return { tenant, generatedAt: new Date().toISOString(), plan: null, tick: null };
  const file = caseFiles[caseFiles.length - 1];
  const path = join(calibrationDir(tenant), runDir, "cases", file);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { plan?: unknown };
    const plan = raw?.plan ?? null;
    return { tenant, generatedAt: new Date().toISOString(), plan, tick: parseTick(file) };
  } catch (error) {
    return { tenant, generatedAt: new Date().toISOString(), plan: null, tick: null, error: String((error as Error)?.message ?? error) };
  }
}

/** 完整世界快照：最新 calibration case 的 before.state（供前端交互计算：寻路/攻击范围/动作可用性）。 */
export function loadWorld(tenant: string): Record<string, unknown> {
  const runDir = latestRunDir(tenant);
  if (runDir === null) return { tenant, generatedAt: new Date().toISOString(), state: null, caseFile: null };
  const caseFiles = listCases(tenant, runDir);
  if (!caseFiles.length) return { tenant, generatedAt: new Date().toISOString(), state: null, caseFile: null };
  const file = caseFiles[caseFiles.length - 1];
  const path = join(calibrationDir(tenant), runDir, "cases", file);
  let raw: { after?: { tick?: number; state?: unknown }; before?: { tick?: number; state?: unknown } } | null = null;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    return { tenant, generatedAt: new Date().toISOString(), state: null, caseFile: null, error: String((error as Error)?.message ?? error) };
  }
  return {
    tenant,
    generatedAt: new Date().toISOString(),
    runId: runDir,
    caseFile: file,
    tick: raw?.after?.tick ?? raw?.before?.tick ?? null,
    state: raw?.after?.state ?? raw?.before?.state ?? null,
  };
}

/** 指挥操作事件流：从最新 run 的 calibration case 结构化事件（after.state.events，tick 完成后）聚合，
 *  按 tick 倒序。before.state.events 是 tick 起点（通常为空），2026-08-08 修复为 after 优先。 */
const EVENT_KINDS = new Set([
  "UNIT_MOVE_SUCCEEDED", "UNIT_MOVE_FAILED", "CORE_MOVE_SUCCEEDED", "CORE_MOVE_FAILED",
  "SPAWN_SUCCEEDED", "SPAWN_FAILED",
  "HARVEST_SUCCEEDED", "HARVEST_FAILED",
  "DEPOSIT_SUCCEEDED", "DEPOSIT_FAILED",
  "SHOT_HIT", "SHOT_MISSED", "SHOT_BLOCKED",
  "SWEEP_RESOLVED", "SWEEP_FAILED",
  "PICKUP_BEACON_SUCCEEDED", "PICKUP_BEACON_FAILED",
  "DROP_BEACON_SUCCEEDED", "DROP_BEACON_FAILED",
  "SELF_DESTRUCT", "HEAL_SUCCEEDED", "HEAL_FAILED", "REPAIR_SHIELD_SUCCEEDED",
  "UNIT_DESTROYED", "CORE_DESTROYED", "CORE_DAMAGED", "RESPAWN",
  "CORE_RESOURCES_CAPTURED", "CORE_RESOURCE_OVERFLOW_DESTROYED", "WORKER_CARGO_DROPPED",
  "UNIT_HEAL_SUCCEEDED", "UNIT_HEAL_FAILED", "CORE_HEAL_SUCCEEDED", "CORE_HEAL_FAILED",
  "WAIT", "NOTHING_TO_DO",
]);
export function loadEvents(tenant: string, n: number): { tenant: string; generatedAt: string; events: Array<Record<string, unknown>> } {
  const runDir = latestRunDir(tenant);
  if (runDir === null) return { tenant, generatedAt: new Date().toISOString(), events: [] };
  const caseFiles = listCases(tenant, runDir).slice(-20);
  const events: Array<Record<string, unknown>> = [];
  for (const file of caseFiles) {
    const fileTick = parseTick(file);
    const path = join(calibrationDir(tenant), runDir, "cases", file);
    let raw: { before?: { state?: { events?: Array<Record<string, unknown>> } }; after?: { state?: { events?: Array<Record<string, unknown>> } } } | null = null;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    // 事件在 tick 完成后的 after.state（before 是 tick 起点，events 恒空——2026-08-08 修复）
    const evs = raw?.after?.state?.events ?? raw?.before?.state?.events;
    if (!Array.isArray(evs)) continue;
    for (const ev of evs) {
      if (!ev || typeof ev !== "object") continue;
      const kind = String(ev.event_type ?? "").toUpperCase();
      if (!EVENT_KINDS.has(kind)) continue;
      const values = (ev.values ?? {}) as Record<string, unknown>;
      events.push({
        tick: (ev.tick as number | undefined) ?? fileTick ?? null,
        kind,
        reason: (ev.reason_code as string | null | undefined) ?? null,
        actor: (ev.actor_id as string | null | undefined) ?? null,
        target: (ev.target_id as string | null | undefined) ?? null,
        position: ev.position ?? null,
        amount: (values.amount as number | undefined) ?? (values.damage as number | undefined) ?? null,
        hp: values.hp ?? null,
        source: values.source ?? null,
        capacity: values.capacity ?? null,
        destroyedBy: values.destroyed_by ?? null,
      });
    }
  }
  events.sort((a, b) => ((b.tick as number) ?? 0) - ((a.tick as number) ?? 0));
  return { tenant, generatedAt: new Date().toISOString(), events: events.slice(0, Math.min(Math.max(n, 1), 200)) };
}
