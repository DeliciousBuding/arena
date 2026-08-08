/**
 * 生命周期审计（2026-08-08）：单位/矿物/核心的生命周期标注 + 消费优化分析。
 *
 * 输入：calibration 最新 run 的 case 文件（after.state.events，每 tick 完成后的
 * 事件快照）。只读，不轮询；30s 缓存 + 启动预热一次，不进周期循环（无计划任务）。
 *
 * 输出（/api/audit/lifecycle）：
 *  - units：每 actor 生命周期——首见/末见 tick、存活、销毁（时刻/凶手）、角色
 *    （core/worker/combat/unit）、动作计数（移动/采集/交付/战斗/治疗/丢弃/拾取）、
 *    末位置 + 稀疏轨迹采样。
 *  - mines：按格聚合矿物生命周期——首见/末见、采集次数/量/失败、活跃度、刷新间隔
 *    （harvest 事件间平均 gap，供"即将刷新"预测佐证）。
 *  - core：核心生命周期——受伤量、治疗、移动、被捕获/被毁（凶手）。
 *  - consumption：消费汇总——采集/交付/丢弃/伤亡/重生/敌伤，综合"经济吞吐-损耗"。
 *
 * I/O 边界：每租户最多读 500 个 case（按 tick 升序取最新 500），单次全量 JSON 解析
 * 约 50-300ms（run 内通常 40-60 个 case，更小）；30s 缓存 + 启动预热。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, TENANTS, calibrationDir, latestRunDir, listCases, parseTick } from "./fs-jsonl.ts";
import { TtlCache } from "./cache.ts";

const MAX_CASES = 500;
const MAX_POSITION_SAMPLES = 24;
const TTL_MS = 30_000;

export interface LifecycleEvent {
  tick: number;
  kind: string;
  actor: string | null;
  target: string | null;
  reason: string | null;
  position: [number, number] | null;
  amount: number | null;
  hp: number | null;
  source: string | null;
  capacity: number | null;
  destroyedBy: string | null;
  destination: [number, number] | null;
}

export interface LifecycleUnit {
  actor: string;
  role: "core" | "worker" | "combat" | "unit";
  firstSeenTick: number | null;
  lastSeenTick: number | null;
  alive: boolean;
  destroyedAtTick: number | null;
  destroyedBy: string | null;
  spawned: boolean;
  moves: { ok: number; fail: number };
  harvest: { ok: number; fail: number; amount: number };
  deposit: { ok: number; fail: number; amount: number };
  combat: { shotsHit: number; shotsMissed: number; blocked: number; sweepsResolved: number; damageDealt: number };
  heals: { ok: number; fail: number };
  drops: number;
  pickups: number;
  lastPosition: [number, number] | null;
  positionSamples: Array<{ tick: number; position: [number, number] }>;
}

export interface MineLifecycle {
  cell: string;
  x: number;
  y: number;
  firstSeenTick: number | null;
  lastSeenTick: number | null;
  harvestCount: number;
  harvestAmount: number;
  harvestFailCount: number;
  active: boolean;
  refillGapTicks: number | null;
}

export interface CoreLifecycle {
  actor: string | null;
  damageTaken: number;
  damageEvents: number;
  healOk: number;
  healFail: number;
  moveOk: number;
  moveFail: number;
  capturedResources: number;
  destroyed: boolean;
  destroyedAtTick: number | null;
  destroyedBy: string | null;
  lastPosition: [number, number] | null;
  positionSamples: Array<{ tick: number; position: [number, number] }>;
}

export interface ConsumptionSummary {
  harvestOk: number;
  harvestFail: number;
  harvestAmount: number;
  depositOk: number;
  depositFail: number;
  depositAmount: number;
  cargoDropped: number;
  spawns: number;
  respawns: number;
  unitDestroyed: number;
  selfDestructs: number;
  destroyedByEnemy: number;
  coreDamageTaken: number;
}

export interface LifecycleAuditPayload {
  generatedAt: string;
  tenant: string;
  runId: string | null;
  window: { fromTick: number | null; toTick: number | null; cases: number; events: number };
  units: LifecycleUnit[];
  mines: MineLifecycle[];
  core: CoreLifecycle | null;
  consumption: ConsumptionSummary;
  cachedAt: string;
}

const cache = new TtlCache<Record<string, LifecycleAuditPayload> | LifecycleAuditPayload>(TTL_MS);

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

function pair(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const x = Number(v[0]);
  const y = Number(v[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

interface CaseFile {
  after?: { state?: { events?: Array<Record<string, unknown>> } };
  before?: { state?: { events?: Array<Record<string, unknown>> } };
}

const CORE_KINDS = new Set([
  "CORE_DAMAGED", "CORE_DESTROYED", "CORE_HEAL_FAILED", "CORE_HEAL_SUCCEEDED",
  "CORE_MOVE_FAILED", "CORE_MOVE_STARTED", "CORE_MOVE_START_FAILED", "CORE_MOVE_PROGRESS",
  "CORE_MOVE_SUCCEEDED", "CORE_RESOURCES_CAPTURED", "CORE_RESOURCE_OVERFLOW_DESTROYED",
  "CORE_SPAWN_SUCCEEDED", "CORE_SPAWN_FAILED",
]);

/** 纯函数（可测）：把归一化事件聚合为单位/矿物/核心生命周期 + 消费汇总。 */
export function aggregateLifecycle(tenant: string, runId: string | null, evs: readonly LifecycleEvent[]): LifecycleAuditPayload {
  const units = new Map<string, LifecycleUnit>();
  const mines = new Map<string, MineLifecycle>();
  let core: CoreLifecycle = {
    actor: null, damageTaken: 0, damageEvents: 0, healOk: 0, healFail: 0, moveOk: 0, moveFail: 0,
    capturedResources: 0, destroyed: false, destroyedAtTick: null, destroyedBy: null,
    lastPosition: null, positionSamples: [],
  };
  const cons: ConsumptionSummary = {
    harvestOk: 0, harvestFail: 0, harvestAmount: 0, depositOk: 0, depositFail: 0, depositAmount: 0,
    cargoDropped: 0, spawns: 0, respawns: 0, unitDestroyed: 0, selfDestructs: 0,
    destroyedByEnemy: 0, coreDamageTaken: 0,
  };
  let fromTick: number | null = null;
  let toTick: number | null = null;

  const unit = (actor: string): LifecycleUnit => {
    let u = units.get(actor);
    if (!u) {
      u = {
        actor, role: "unit", firstSeenTick: null, lastSeenTick: null, alive: true,
        destroyedAtTick: null, destroyedBy: null, spawned: false,
        moves: { ok: 0, fail: 0 }, harvest: { ok: 0, fail: 0, amount: 0 },
        deposit: { ok: 0, fail: 0, amount: 0 },
        combat: { shotsHit: 0, shotsMissed: 0, blocked: 0, sweepsResolved: 0, damageDealt: 0 },
        heals: { ok: 0, fail: 0 }, drops: 0, pickups: 0, lastPosition: null, positionSamples: [],
      };
      units.set(actor, u);
    }
    return u;
  };

  const mineAt = (pos: [number, number]): MineLifecycle => {
    const key = `${pos[0]},${pos[1]}`;
    let m = mines.get(key);
    if (!m) {
      m = { cell: key, x: pos[0], y: pos[1], firstSeenTick: null, lastSeenTick: null,
        harvestCount: 0, harvestAmount: 0, harvestFailCount: 0, active: true, refillGapTicks: null };
      mines.set(key, m);
    }
    return m;
  };

  const sample = (arr: Array<{ tick: number; position: [number, number] }>, tick: number, pos: [number, number]): void => {
    if (arr.length === 0 || arr[arr.length - 1].tick !== tick) {
      arr.push({ tick, position: pos });
      if (arr.length > MAX_POSITION_SAMPLES) arr.splice(0, arr.length - MAX_POSITION_SAMPLES);
    }
  };

  for (const ev of evs) {
    if (fromTick === null || ev.tick < fromTick) fromTick = ev.tick;
    if (toTick === null || ev.tick > toTick) toTick = ev.tick;
    const kind = ev.kind;
    const amount = ev.amount ?? 0;
    const isCore = CORE_KINDS.has(kind) || (ev.actor !== null && ev.actor === core.actor);

    if (isCore) {
      core.actor = ev.actor ?? core.actor;
      core.lastPosition = ev.position ?? core.lastPosition;
      if (ev.position !== null && ev.actor !== null) sample(core.positionSamples, ev.tick, ev.position);
      switch (kind) {
        case "CORE_DAMAGED": core.damageTaken += amount; core.damageEvents += 1; cons.coreDamageTaken += amount; break;
        case "CORE_HEAL_SUCCEEDED": core.healOk += 1; break;
        case "CORE_HEAL_FAILED": core.healFail += 1; break;
        case "CORE_MOVE_SUCCEEDED": core.moveOk += 1; break;
        case "CORE_MOVE_FAILED":
        case "CORE_MOVE_START_FAILED": core.moveFail += 1; break;
        case "CORE_RESOURCES_CAPTURED": core.capturedResources += amount; break;
        case "CORE_DESTROYED": core.destroyed = true; core.destroyedAtTick = ev.tick;
          core.destroyedBy = ev.destroyedBy ?? ev.source ?? null;
          if (core.destroyedBy !== null) cons.destroyedByEnemy += 1; break;
        case "CORE_RESOURCE_OVERFLOW_DESTROYED": core.destroyed = true; core.destroyedAtTick = ev.tick; break;
        case "CORE_SPAWN_SUCCEEDED": cons.spawns += 1; break;
      }
      continue;
    }

    if (ev.actor === null) continue;
    const u = unit(ev.actor);
    if (u.firstSeenTick === null || ev.tick < u.firstSeenTick) u.firstSeenTick = ev.tick;
    if (u.lastSeenTick === null || ev.tick > u.lastSeenTick) u.lastSeenTick = ev.tick;
    u.lastPosition = ev.position ?? u.lastPosition;
    if (ev.position !== null) sample(u.positionSamples, ev.tick, ev.position);

    switch (kind) {
      case "UNIT_MOVE_SUCCEEDED": u.moves.ok += 1; break;
      case "UNIT_MOVE_FAILED": u.moves.fail += 1; break;
      case "HARVEST_SUCCEEDED": {
        u.harvest.ok += 1; u.harvest.amount += amount;
        cons.harvestOk += 1; cons.harvestAmount += amount;
        if (ev.position !== null) {
          const m = mineAt(ev.position);
          m.harvestCount += 1; m.harvestAmount += amount;
          if (m.firstSeenTick === null) m.firstSeenTick = ev.tick;
          m.lastSeenTick = ev.tick;
        }
        break;
      }
      case "HARVEST_FAILED": {
        u.harvest.fail += 1; cons.harvestFail += 1;
        if (ev.position !== null) {
          const m = mineAt(ev.position);
          m.harvestFailCount += 1;
          if (m.firstSeenTick === null) m.firstSeenTick = ev.tick;
          m.lastSeenTick = ev.tick;
        }
        break;
      }
      case "DEPOSIT_SUCCEEDED": u.deposit.ok += 1; u.deposit.amount += amount; cons.depositOk += 1; cons.depositAmount += amount; break;
      case "DEPOSIT_FAILED": u.deposit.fail += 1; cons.depositFail += 1; break;
      case "SHOT_HIT": u.combat.shotsHit += 1; u.combat.damageDealt += amount; break;
      case "SHOT_MISSED": u.combat.shotsMissed += 1; break;
      case "SHOT_BLOCKED": u.combat.blocked += 1; break;
      case "SWEEP_RESOLVED": u.combat.sweepsResolved += 1; break;
      case "UNIT_HEAL_SUCCEEDED": u.heals.ok += 1; break;
      case "UNIT_HEAL_FAILED": u.heals.fail += 1; break;
      case "WORKER_CARGO_DROPPED": u.drops += 1; cons.cargoDropped += 1; break;
      case "PICKUP_BEACON_SUCCEEDED": u.pickups += 1; break;
      case "RESPAWN": u.spawned = true; u.alive = true; u.destroyedAtTick = null; cons.respawns += 1; break;
      case "SPAWN_SUCCEEDED": u.spawned = true; cons.spawns += 1; break;
      case "UNIT_DESTROYED": {
        u.alive = false; u.destroyedAtTick = ev.tick;
        u.destroyedBy = ev.destroyedBy ?? ev.source ?? null;
        cons.unitDestroyed += 1;
        if (u.destroyedBy !== null) cons.destroyedByEnemy += 1;
        break;
      }
      case "SELF_DESTRUCT": {
        u.alive = false; u.destroyedAtTick = ev.tick;
        u.destroyedBy = "self";
        cons.selfDestructs += 1;
        break;
      }
    }
  }

  // 角色判定：core 已分流；有采集/交付 → worker；有战斗 → combat；否则 unit。
  for (const u of units.values()) {
    if (u.harvest.ok + u.harvest.fail + u.deposit.ok + u.deposit.fail > 0) u.role = "worker";
    else if (u.combat.shotsHit + u.combat.shotsMissed + u.combat.blocked + u.combat.sweepsResolved > 0) u.role = "combat";
  }

  // 矿物刷新间隔：同格 harvest 事件 tick 序列的平均 gap；<10 tick 视为"快速刷新"。
  for (const m of mines.values()) {
    m.active = m.lastSeenTick !== null && (toTick === null || m.lastSeenTick >= (toTick ?? 0) - 5);
  }
  // 用事件序列重新算 refill gap（纯函数需要事件按 tick 升序/降序均可用，这里用已聚合计数简化：
  // 平均 gap ≈ (last-first)/(count-1)，仅当 count>=2 有意义）
  for (const m of mines.values()) {
    if (m.harvestCount >= 2 && m.firstSeenTick !== null && m.lastSeenTick !== null && m.lastSeenTick > m.firstSeenTick) {
      m.refillGapTicks = Math.round((m.lastSeenTick - m.firstSeenTick) / (m.harvestCount - 1));
    }
  }

  const sortedUnits = [...units.values()].sort((a, b) => (b.lastSeenTick ?? -1) - (a.lastSeenTick ?? -1));
  const sortedMines = [...mines.values()].sort((a, b) => (b.lastSeenTick ?? -1) - (a.lastSeenTick ?? -1));
  return {
    generatedAt: new Date().toISOString(),
    tenant, runId,
    window: { fromTick, toTick, cases: 0, events: evs.length },
    units: sortedUnits,
    mines: sortedMines,
    core: core.actor !== null ? core : null,
    consumption: cons,
    cachedAt: new Date().toISOString(),
  };
}

/** I/O：读最新 run 的 case 事件（最多 MAX_CASES 个，按 tick 升序取最新），归一化后聚合。 */
function auditTenant(tenant: string): LifecycleAuditPayload {
  const runDir = latestRunDir(tenant);
  if (runDir === null) {
    return { generatedAt: new Date().toISOString(), tenant, runId: null,
      window: { fromTick: null, toTick: null, cases: 0, events: 0 },
      units: [], mines: [], core: null,
      consumption: { harvestOk: 0, harvestFail: 0, harvestAmount: 0, depositOk: 0, depositFail: 0,
        depositAmount: 0, cargoDropped: 0, spawns: 0, respawns: 0, unitDestroyed: 0,
        selfDestructs: 0, destroyedByEnemy: 0, coreDamageTaken: 0 },
      cachedAt: new Date().toISOString() };
  }
  const files = listCases(tenant, runDir).slice(-MAX_CASES);
  const evs: LifecycleEvent[] = [];
  const base = join(calibrationDir(tenant), runDir, "cases");
  for (const file of files) {
    const fileTick = parseTick(file);
    const raw = (() => {
      try { return JSON.parse(readFileSync(join(base, file), "utf8")) as CaseFile; } catch { return null; }
    })();
    const list = raw?.after?.state?.events ?? raw?.before?.state?.events;
    if (!Array.isArray(list)) continue;
    for (const ev of list) {
      if (!ev || typeof ev !== "object") continue;
      const kind = String((ev as { event_type?: unknown }).event_type ?? "").toUpperCase();
      if (kind === "") continue;
      const values = ((ev as { values?: Record<string, unknown> }).values ?? {}) as Record<string, unknown>;
      evs.push({
        tick: num((ev as { tick?: unknown }).tick) || fileTick,
        kind,
        actor: ((ev as { actor_id?: unknown }).actor_id as string | null | undefined) ?? null,
        target: ((ev as { target_id?: unknown }).target_id as string | null | undefined) ?? null,
        reason: ((ev as { reason_code?: unknown }).reason_code as string | null | undefined) ?? null,
        position: pair((ev as { position?: unknown }).position),
        amount: num(values.amount ?? values.damage) || null,
        hp: num(values.hp) || null,
        source: (values.source as string | null | undefined) ?? null,
        capacity: num(values.capacity) || null,
        destroyedBy: (values.destroyed_by as string | null | undefined) ?? null,
        destination: pair(values.destination),
      });
    }
  }
  evs.sort((a, b) => a.tick - b.tick);
  const payload = aggregateLifecycle(tenant, runDir, evs);
  payload.window.cases = files.length;
  return payload;
}

export function loadLifecycleAudit(tenant = "all"): Record<string, LifecycleAuditPayload> | LifecycleAuditPayload {
  const key = `lifecycle:${tenant}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (tenant === "all") {
    const perTenant: Record<string, LifecycleAuditPayload> = {};
    for (const t of TENANTS) perTenant[t] = auditTenant(t);
    cache.set(key, perTenant);
    return perTenant;
  }
  const payload = auditTenant(tenant);
  cache.set(key, payload);
  return payload;
}

/** 启动预热一次（不进周期循环；过期后请求惰性刷新）。 */
export function warmLifecycleAudit(): void {
  loadLifecycleAudit("all");
}
