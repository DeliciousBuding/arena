/**
 * 事迹/日记系统（2026-08-08）：跨租户叙事级事迹聚合。
 *
 * 定位：事件流（loadEvents）是原始流；deeds 是叙事级事迹——跨租户、按 tick
 * 排序、中文叙事、★1-4 分级。数据源分层：
 *  1. ★3-4 稀有事件：calibration after.events 扫描（最近 RUN_SCAN 个 run，
 *     与 intel.ts 同口径——稀有事件历史在旧 run，需回扫；结果内存缓存）；
 *  2. ★2 里程碑：survey-db 聚合（采集/消费/产兵/阵亡计数到整数档，SQL 精确
 *     定位达标 tick）+ 资源峰值（calibration after.state.resources 扫描）；
 *  3. ★1 常规：产兵/交付/采集/受击/核心移动（同一扫描窗口，每租户限流防刷屏）。
 *
 * 性能：45s 内存缓存 + 启动后台预热（与 survey/intel 缓存一致——前端轮询
 * 命中缓存，不实时扫描落盘文件）。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_ROOT, TENANTS, calibrationDir, latestRunDir, listCases, parseTick, type Position } from "./fs-jsonl.ts";
import { TtlCache } from "./cache.ts";

export interface Deed {
  id: string;
  tick: number;
  tenant: string;
  star: 1 | 2 | 3 | 4;
  kind: string;
  title: string;
  detail: string;
  position: Position | null;
  actor: string | null;
  target: string | null;
}

const RUN_SCAN = 6; // 稀有事件回扫 run 数（近期叙事即可，历史深度靠 survey-db 里程碑）
const CASE_LIMIT = 12; // 每 run 最近 case 数（控制后台刷新事件循环阻塞）
const REGULAR_CAP = 20; // 每租户常规（★1）事迹上限
const MOVE_CAP = 2; // 核心移动（★1 高频噪声）额外上限
const DEEDS_TTL_MS = 45_000;
const SCAN_BUDGET_MS = 25; // 分批扫描时间预算（每 25ms 让出事件循环，高负载下稳定推进）

const yieldEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const deedsCache = new TtlCache<Deed[]>(DEEDS_TTL_MS);

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function pos(v: unknown): Position | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const x = num(v[0]);
  const y = num(v[1]);
  return x !== null && y !== null ? [x, y] : null;
}

const unitTypeName = (t: unknown): string => (typeof t === "string" && t.trim() !== "" ? t : "单位");

interface RawCase {
  after?: { state?: { events?: unknown; resources?: unknown } };
  before?: { state?: { events?: unknown; objects?: unknown } };
}

interface RawEvent {
  event_type?: unknown;
  event_id?: unknown;
  tick?: unknown;
  actor_id?: unknown;
  target_id?: unknown;
  position?: unknown;
  reason_code?: unknown;
  values?: unknown;
}

/** 原始事件 -> 叙事 Deed（★1-4）。不识别的噪声事件返回 null。
 *  ourCoreIds：本租户受控核心集合（CORE_DESTROYED 敌我判定用；扫描路径每 case
 *  传 before.state 受控核心，缺失时按未知处理——旧库/旧 run 兜底叙事）。 */
export function deedFromEvent(ev: RawEvent, tenant: string, fileTick: number, ourCoreIds?: ReadonlySet<string> | null): Deed | null {
  const kind = String(ev.event_type ?? "").toUpperCase();
  const tick = num(ev.tick) ?? fileTick;
  const values = (ev.values ?? {}) as Record<string, unknown>;
  const p = pos(ev.position);
  const actor = typeof ev.actor_id === "string" ? ev.actor_id : null;
  const target = typeof ev.target_id === "string" ? ev.target_id : null;
  const base = { tick, tenant, position: p, actor, target };
  const idBase = `${tenant}:${tick}:${String(ev.event_id ?? "")}`;
  const amount = num(values.amount) ?? num(values.damage);
  switch (kind) {
    case "CORE_DESTROYED": {
      // 叙事 A11（2026-08-08）：区分 我方被打爆(⚠ HIGH) / 敌方被摧毁(战果) / 自爆。
      // destroyed_by 真实值是数组（combat.ts ATTACK），兼容 string 旧数据。
      const reason = typeof ev.reason_code === "string" ? ev.reason_code : null;
      const rawBy = values.destroyed_by;
      const byList = Array.isArray(rawBy)
        ? rawBy.filter((u): u is string => typeof u === "string")
        : typeof rawBy === "string" && rawBy.trim() !== ""
          ? [rawBy]
          : [];
      const isSelfDestruct = reason === "SELF_DESTRUCT";
      const isOur = !isSelfDestruct && typeof ev.target_id === "string" && !!ourCoreIds?.has(ev.target_id);
      const tag = typeof ev.target_id === "string" ? ev.target_id.slice(0, 8) : null;
      const byText = byList.length > 0 ? byList.join("、") : null;
      if (isSelfDestruct) {
        return { ...base, id: `${idBase}:core_destroyed`, star: 3, kind, title: "核心自爆", detail: p ? `核心在 (${p[0]},${p[1]}) 自爆放弃` : "核心自爆放弃" };
      }
      if (isOur) {
        return { ...base, id: `${idBase}:core_destroyed`, star: 4, kind, title: "我方核心被摧毁 ⚠", detail: byText ? `我方核心 ${tag} 被 ${byText} 摧毁` : (p ? `我方核心 ${tag} 在 (${p[0]},${p[1]}) 被摧毁` : `我方核心 ${tag} 被摧毁`), target: typeof ev.target_id === "string" ? ev.target_id : null };
      }
      return { ...base, id: `${idBase}:core_destroyed`, star: 4, kind, title: "敌方核心被摧毁", detail: byText ? `敌方核心 ${tag} 被 ${byText} 摧毁` : (tag ? `敌方核心 ${tag} 被摧毁` : "敌方核心被摧毁"), target: typeof ev.target_id === "string" ? ev.target_id : null };
    }
    case "CORE_RESOURCES_CAPTURED":
      return { ...base, id: `${idBase}:captured`, star: 3, kind, title: "夺取核心资源", detail: `夺取敌方核心资源 ${amount ?? "?"}（可用 ${num(values.available) ?? "?"}/${num(values.capacity) ?? "?"}）` };
    case "CORE_RESOURCE_OVERFLOW_DESTROYED":
      return { ...base, id: `${idBase}:overflow`, star: 3, kind, title: "核心资源溢出自毁", detail: "资源溢出导致核心自毁" };
    case "PICKUP_BEACON_SUCCEEDED":
      return { ...base, id: `${idBase}:pickup`, star: 3, kind, title: "拾取信标", detail: p ? `在 (${p[0]},${p[1]}) 拾取信标` : "拾取信标" };
    case "DROP_BEACON_SUCCEEDED":
      return { ...base, id: `${idBase}:drop`, star: 3, kind, title: "放置信标", detail: p ? `在 (${p[0]},${p[1]}) 放置信标` : "放置信标" };
    case "SELF_DESTRUCT":
      return { ...base, id: `${idBase}:self_destruct`, star: 3, kind, title: "单位自爆", detail: "单位自爆" };
    case "UNIT_DESTROYED":
      return { ...base, id: `${idBase}:unit_destroyed`, star: 2, kind, title: "单位阵亡", detail: p ? `单位在 (${p[0]},${p[1]}) 阵亡` : "单位阵亡" };
    case "CORE_SPAWN_SUCCEEDED":
      return { ...base, id: `${idBase}:spawn`, star: 2, kind, title: "核心产兵", detail: `核心产出 ${unitTypeName(values.unit_type)}（消耗 ${num(values.cost) ?? "?"} 资源）`, target };
    case "DEPOSIT_SUCCEEDED":
      return { ...base, id: `${idBase}:deposit`, star: 2, kind, title: "交付资源", detail: `交付 ${amount ?? "?"} 资源（容量 ${num(values.capacity) ?? "?"}，剩余 ${num(values.remaining) ?? "?"}）` };
    case "HARVEST_SUCCEEDED":
      return { ...base, id: `${idBase}:harvest`, star: 1, kind, title: "采集资源", detail: p ? `在 (${p[0]},${p[1]}) 采集 ${amount ?? "?"} 资源` : `采集 ${amount ?? "?"} 资源` };
    case "UNIT_DAMAGED":
      return { ...base, id: `${idBase}:damaged`, star: 1, kind, title: "单位受击", detail: `受到 ${num(values.damage) ?? "?"} 点伤害（HP ${num(values.hp) ?? "?"}）` };
    case "SHOT_HIT":
      return { ...base, id: `${idBase}:shot`, star: 1, kind, title: "命中敌军", detail: `造成 ${amount ?? "?"} 点伤害` };
    case "CORE_MOVE_SUCCEEDED":
      return { ...base, id: `${idBase}:core_move`, star: 1, kind, title: "核心移动", detail: p ? `核心移动至 (${p[0]},${p[1]})` : "核心移动" };
    case "HEAL_SUCCEEDED":
    case "UNIT_HEAL_SUCCEEDED":
    case "CORE_HEAL_SUCCEEDED":
    case "REPAIR_SHIELD_SUCCEEDED":
      return { ...base, id: `${idBase}:heal`, star: 1, kind, title: "治疗/维修", detail: `恢复 ${amount ?? "?"} 点` };
    default:
      return null;
  }
}

/** 每 run 最高 case tick（run 排序基准，intel.ts 同口径）。 */
function maxCaseTick(tenant: string, run: string): number {
  let max = -1;
  for (const f of listCases(tenant, run)) {
    const t = parseTick(f);
    if (t > max) max = t;
  }
  return max;
}

/** 最近 N 个 run（按最高 case tick 倒序）。 */
function recentRuns(tenant: string, n: number): string[] {
  const base = calibrationDir(tenant);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .map((name) => ({ name, max: maxCaseTick(tenant, name) }))
    .sort((a, b) => b.max - a.max)
    .slice(0, n)
    .map((x) => x.name);
}

/** 从 calibration 事件扫描聚合事迹（★3-4 稀有 + ★2 产兵/交付/阵亡 + ★1 常规）。
 *  分批异步扫描：每累计 SCAN_BUDGET_MS 让出事件循环，后台刷新不阻塞请求。 */
async function collectEventDeeds(tenant: string): Promise<Deed[]> {
  const out: Deed[] = [];
  // 资源峰值：跨扫描窗口收集 after.state.resources 采样，升序找 1000 档跨越 tick
  const resSamples: Array<{ tick: number; res: number }> = [];
  // 时间预算让出：每累计 SCAN_BUDGET_MS 让一次事件循环（setImmediate）。
  // 高负载+持续轮询下若按文件数让出，回调会被新请求饿死导致扫描永远做不完；
  // 按时间预算保证每批稳定推进（2026-08-08 实测 8s 超时根因）。
  let batchStart = Date.now();
  for (const run of recentRuns(tenant, RUN_SCAN)) {
    const files = listCases(tenant, run).slice(-CASE_LIMIT);
    for (let i = 0; i < files.length; i += 1) {
      if (Date.now() - batchStart >= SCAN_BUDGET_MS) {
        await yieldEventLoop();
        batchStart = Date.now();
      }
      const file = files[i];
      const fileTick = parseTick(file);
      let raw: RawCase | null = null;
      try {
        raw = JSON.parse(readFileSync(join(calibrationDir(tenant), run, "cases", file), "utf8")) as RawCase | null;
      } catch {
        continue;
      }
      const res = num(raw?.after?.state?.resources);
      if (res !== null) resSamples.push({ tick: fileTick, res });
      // 叙事 A11：本 case 受控核心集合（CORE_DESTROYED 敌我判定；与 survey-sync /
      // builder.coreRiskAt 同判据——before.state.objects controlled CORE）。
      const ourCoreIds = new Set<string>();
      const objects = raw?.before?.state?.objects;
      if (Array.isArray(objects)) {
        for (const o of objects) {
          if (o && typeof o === "object") {
            const obj = o as { kind?: unknown; controlled?: unknown; id?: unknown };
            if (obj.kind === "CORE" && obj.controlled && typeof obj.id === "string") ourCoreIds.add(obj.id);
          }
        }
      }
      const evs = (raw?.after?.state?.events ?? raw?.before?.state?.events) as unknown;
      if (!Array.isArray(evs)) continue;
      for (const ev of evs) {
        if (!ev || typeof ev !== "object") continue;
        const d = deedFromEvent(ev as RawEvent, tenant, fileTick, ourCoreIds);
        if (d) out.push(d);
      }
    }
  }
  // 资源突破里程碑：每 1000 档（升序采样，记录首次达标 tick）
  if (resSamples.length > 0) {
    resSamples.sort((a, b) => a.tick - b.tick);
    const peak = resSamples.reduce((m, s) => (s.res > m.res ? s : m), resSamples[0]);
    let current = 0;
    for (const s of resSamples) {
      while (current + 1000 <= s.res) {
        current += 1000;
        out.push({
          id: `${tenant}:milestone:resources:${current}`,
          tick: s.tick,
          tenant,
          star: 2,
          kind: "MILESTONE_RESOURCES",
          title: `资源突破 · ${current}`,
          detail: `单 tick 资源达到 ${current}（峰值 ${peak.res}）`,
          position: null,
          actor: null,
          target: null,
        });
      }
    }
  }
  return out;
}

/** 从 survey-db 聚合里程碑（★2）：采集/消费/产兵/阵亡到整数档，SQL 精确定位达标 tick。 */
function collectMilestoneDeeds(tenant: string): Deed[] {
  const file = join(DATA_ROOT, "runtime", "survey", `${tenant}.db`);
  if (!existsSync(file)) return [];
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return [];
  }
  const out: Deed[] = [];
  try {
    const cnt = (sql: string): number => {
      try {
        const r = db.prepare(sql).get() as { c?: unknown };
        return num(r?.c) ?? 0;
      } catch {
        return 0;
      }
    };
    const tickAt = (sql: string): number | null => {
      try {
        const r = db.prepare(sql).get() as { tick?: unknown } | undefined;
        return num(r?.tick);
      } catch {
        return null;
      }
    };
    const harvestCount = cnt("SELECT COUNT(*) AS c FROM resource_events WHERE event_type = 'HARVEST_SUCCEEDED'");
    const spendTotal = cnt("SELECT COALESCE(SUM(amount),0) AS c FROM core_spends");
    const birthCount = cnt("SELECT COUNT(*) AS c FROM unit_lifecycle");
    const deathCount = cnt("SELECT COUNT(*) AS c FROM unit_lifecycle WHERE death_tick IS NOT NULL");
    for (let t = 50; t <= harvestCount; t += 50) {
      const tick = tickAt(`SELECT tick FROM resource_events WHERE event_type = 'HARVEST_SUCCEEDED' ORDER BY tick, id LIMIT 1 OFFSET ${t - 1}`);
      if (tick !== null) out.push({ id: `${tenant}:milestone:harvest:${t}`, tick, tenant, star: 2, kind: "MILESTONE_HARVEST", title: `采集里程碑 · ${t} 次`, detail: `累计成功采集 ${t} 次矿`, position: null, actor: null, target: null });
    }
    for (let t = 1000; t <= spendTotal; t += 1000) {
      const tick = tickAt(`SELECT tick FROM core_spends ORDER BY tick, id LIMIT 1 OFFSET ${t - 1}`);
      if (tick !== null) out.push({ id: `${tenant}:milestone:spend:${t}`, tick, tenant, star: 2, kind: "MILESTONE_SPEND", title: `核心消费 · ${t}`, detail: `核心累计消费 ${t} 资源`, position: null, actor: null, target: null });
    }
    for (let t = 25; t <= birthCount; t += 25) {
      const tick = tickAt(`SELECT birth_tick AS tick FROM unit_lifecycle ORDER BY birth_tick, rowid LIMIT 1 OFFSET ${t - 1}`);
      if (tick !== null) out.push({ id: `${tenant}:milestone:birth:${t}`, tick, tenant, star: 2, kind: "MILESTONE_BIRTH", title: `累计产兵 · ${t}`, detail: `累计产出 ${t} 个单位`, position: null, actor: null, target: null });
    }
    for (let t = 10; t <= deathCount; t += 10) {
      const tick = tickAt(`SELECT death_tick AS tick FROM unit_lifecycle WHERE death_tick IS NOT NULL ORDER BY death_tick, rowid LIMIT 1 OFFSET ${t - 1}`);
      if (tick !== null) out.push({ id: `${tenant}:milestone:death:${t}`, tick, tenant, star: 1, kind: "MILESTONE_DEATH", title: `累计阵亡 · ${t}`, detail: `累计阵亡 ${t} 个单位`, position: null, actor: null, target: null });
    }
  } finally {
    db.close();
  }
  return out;
}

/** 稀有事迹去重键（notable 表与扫描双源时避免重复条目；★1 噪声不去重）。 */
function dedupeKey(d: Deed): string | null {
  if (d.star < 2) return null;
  if (!NOTABLE_KINDS.has(d.kind)) return null;
  return `${d.tick}:${d.kind}:${d.actor ?? ""}:${d.target ?? ""}`;
}

/** notable_events 表持久化的事件类型（★2-4；与 arena-agent NOTABLE_TYPES 同口径）。 */
const NOTABLE_KINDS = new Set([
  "CORE_DESTROYED",
  "CORE_RESOURCES_CAPTURED",
  "CORE_RESOURCE_OVERFLOW_DESTROYED",
  "PICKUP_BEACON_SUCCEEDED",
  "DROP_BEACON_SUCCEEDED",
  "SELF_DESTRUCT",
  "UNIT_DESTROYED",
]);

/** survey-db notable_events 行 -> 叙事 Deed（★2-4）。
 *  reason_code / destroyed_by(JSON 数组) / is_our_core 为叙事 A11 新增列
 *  （旧库缺列时 collectNotableDeeds 走旧 SELECT，字段为 null）。 */
export function deedFromNotableRow(r: {
  tick: number; event_type: string; actor_id: string | null; target_id: string | null;
  x: number | null; y: number | null; amount: number | null; unit_type: string | null;
  reason_code: string | null; destroyed_by: string | null; is_our_core: number | null;
}, tenant: string): Deed | null {
  const kind = r.event_type;
  if (!NOTABLE_KINDS.has(kind)) return null;
  const position: Position | null = r.x !== null && r.y !== null ? [r.x, r.y] : null;
  const id = `${tenant}:${r.tick}:${kind}:${r.actor_id ?? ""}:${r.target_id ?? ""}`;
  const base = { id, tick: r.tick, tenant, position, actor: r.actor_id, target: r.target_id };
  switch (kind) {
    case "CORE_DESTROYED": {
      // 叙事 A11：敌我 + 摧毁者 + 自爆三态（与 deedFromEvent 同口径）。
      const reason = r.reason_code;
      let byList: string[] = [];
      if (r.destroyed_by) {
        try {
          const v = JSON.parse(r.destroyed_by) as unknown;
          if (Array.isArray(v)) byList = v.filter((u): u is string => typeof u === "string");
        } catch { /* 旧脏数据按无摧毁者处理 */ }
      }
      const isSelfDestruct = reason === "SELF_DESTRUCT";
      const isOur = !isSelfDestruct && r.is_our_core === 1;
      const tag = r.target_id ? r.target_id.slice(0, 8) : null;
      const byText = byList.length > 0 ? byList.join("、") : null;
      if (isSelfDestruct) {
        return { ...base, star: 3, kind, title: "核心自爆", detail: position ? `核心在 (${position[0]},${position[1]}) 自爆放弃` : "核心自爆放弃" };
      }
      if (isOur) {
        return { ...base, star: 4, kind, title: "我方核心被摧毁 ⚠", detail: byText ? `我方核心 ${tag} 被 ${byText} 摧毁` : (position ? `我方核心 ${tag} 在 (${position[0]},${position[1]}) 被摧毁` : `我方核心 ${tag} 被摧毁`) };
      }
      return { ...base, star: 4, kind, title: "敌方核心被摧毁", detail: byText ? `敌方核心 ${tag} 被 ${byText} 摧毁` : (tag ? `敌方核心 ${tag} 被摧毁` : "敌方核心被摧毁") };
    }
    case "CORE_RESOURCES_CAPTURED":
      return { ...base, star: 3, kind, title: "夺取核心资源", detail: `夺取敌方核心资源 ${r.amount ?? "?"}` };
    case "CORE_RESOURCE_OVERFLOW_DESTROYED":
      return { ...base, star: 3, kind, title: "核心资源溢出自毁", detail: "资源溢出导致核心自毁" };
    case "PICKUP_BEACON_SUCCEEDED":
      return { ...base, star: 3, kind, title: "拾取信标", detail: position ? `在 (${position[0]},${position[1]}) 拾取信标` : "拾取信标" };
    case "DROP_BEACON_SUCCEEDED":
      return { ...base, star: 3, kind, title: "放置信标", detail: position ? `在 (${position[0]},${position[1]}) 放置信标` : "放置信标" };
    case "SELF_DESTRUCT":
      return { ...base, star: 3, kind, title: "单位自爆", detail: "单位自爆" };
    case "UNIT_DESTROYED":
      return { ...base, star: 2, kind, title: "单位阵亡", detail: position ? `单位在 (${position[0]},${position[1]}) 阵亡` : "单位阵亡" };
    default:
      return null;
  }
}

/** 从 survey-db notable_events 查稀有事迹（★2-4，历史全量；防 run 轮换丢失）。
 *  只读打开；表不存在/无数据返回空（扫描兜底）。 */
function collectNotableDeeds(tenant: string): Deed[] {
  const file = join(DATA_ROOT, "runtime", "survey", `${tenant}.db`);
  if (!existsSync(file)) return [];
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return [];
  }
  const out: Deed[] = [];
  try {
    // 叙事 A11：新库带 reason_code/destroyed_by/is_our_core；旧库（未跑 sync
    // 迁移）缺列则走旧 SELECT（字段 null，deeds 按未知敌我兜底叙事）。
    const hasA11 = (db.prepare("PRAGMA table_info(notable_events)").all() as Array<{ name: string }>)
      .some((c) => c.name === "reason_code");
    const rows = db.prepare(
      hasA11
        ? "SELECT tick, event_type, actor_id, target_id, x, y, amount, unit_type, reason_code, destroyed_by, is_our_core FROM notable_events ORDER BY tick DESC LIMIT 300"
        : "SELECT tick, event_type, actor_id, target_id, x, y, amount, unit_type FROM notable_events ORDER BY tick DESC LIMIT 300",
    ).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const d = deedFromNotableRow({
        tick: Number(row.tick),
        event_type: String(row.event_type),
        actor_id: typeof row.actor_id === "string" ? row.actor_id : null,
        target_id: typeof row.target_id === "string" ? row.target_id : null,
        x: num(row.x),
        y: num(row.y),
        amount: num(row.amount),
        unit_type: typeof row.unit_type === "string" ? row.unit_type : null,
        reason_code: typeof row.reason_code === "string" ? row.reason_code : null,
        destroyed_by: typeof row.destroyed_by === "string" ? row.destroyed_by : null,
        is_our_core: typeof row.is_our_core === "number" ? row.is_our_core : null,
      }, tenant);
      if (d) out.push(d);
    }
  } catch {
    // 旧库无 notable_events 表：扫描兜底（loadDeeds 仍走 collectEventDeeds）
  } finally {
    db.close();
  }
  return out;
}

/** 事迹聚合入口：tenant=all 合并四租户；按 tick 倒序；内存缓存 45s。
 *  异步：缓存命中立即返回；未命中分批扫描（让出事件循环）。 */
export async function loadDeeds(tenant: string, limit: number): Promise<Deed[]> {
  const key = tenant === "all" ? "all" : tenant;
  const hit = deedsCache.get(key);
  if (hit !== undefined) return hit.slice(0, Math.max(1, limit));
  if (tenant === "all") {
    // 从四租户各自缓存合并（各租户先各自加载/命中缓存），避免 all 二次全扫
    const parts: Deed[][] = [];
    for (const t of TENANTS) parts.push(await loadDeeds(t, 500));
    const merged = parts.flat().sort((a, b) => (b.tick - a.tick) || (b.star - a.star));
    deedsCache.set("all", merged);
    return merged.slice(0, Math.max(1, limit));
  }
  const out: Deed[] = [];
  const tenants = [tenant];
  for (const t of tenants) {
    let regular = 0;
    let moves = 0;
    const seenNotable = new Set<string>();
    // ★2-4 稀有/里程碑：查库优先（历史全量，2026-08-08 审计 A4，
    // calibration run 轮换后历史稀有叙事不丢）；扫描仅兜底
    // 近期窗口（survey:sync lag 期间）。
    for (const d of collectNotableDeeds(t)) {
      const k = dedupeKey(d);
      if (k !== null) seenNotable.add(k);
      out.push(d);
    }
    for (const d of await collectEventDeeds(t)) {
      const k = dedupeKey(d);
      if (k !== null) {
        if (seenNotable.has(k)) continue; // 查库已含，扫描重复跳过
        seenNotable.add(k);
      }
      if (d.star === 1) {
        if (d.kind === "CORE_MOVE_SUCCEEDED") {
          if (moves >= MOVE_CAP) continue;
          moves += 1;
        } else {
          if (regular >= REGULAR_CAP) continue;
          regular += 1;
        }
      }
      out.push(d);
    }
    out.push(...collectMilestoneDeeds(t));
  }
  out.sort((a, b) => (b.tick - a.tick) || (b.star - a.star)); // 同 tick 高星级优先
  deedsCache.set(key, out);
  return out.slice(0, Math.max(1, limit));
}

/** 后台预热/刷新全部租户 + all（启动后调用，不阻塞请求）。 */
export async function refreshDeedsCache(): Promise<void> {
  await Promise.all(TENANTS.map((t) => loadDeeds(t, 200)));
  await loadDeeds("all", 200);
}

/** 启动后台刷新循环（返回 timer 供测试清理）。 */
export function startDeedsCacheLoop(intervalMs = 45_000): NodeJS.Timeout {
  setTimeout(() => { void refreshDeedsCache(); }, 0); // 启动即后台预热，不阻塞首次 listen
  return setInterval(() => { void refreshDeedsCache(); }, intervalMs);
}

/** 供调试：最近一个有 case 的 run 名（与面板口径一致）。 */
export function currentRunOf(tenant: string): string | null {
  return latestRunDir(tenant);
}
