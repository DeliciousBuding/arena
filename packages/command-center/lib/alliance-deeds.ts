/**
 * 联盟事迹（2026-08-08）：联盟级叙事事件（跨租户），并入 /api/deeds?tenant=all
 * 的事迹流——补足 per-tenant calibration 事件之外的高层叙事：
 *  - ★3 新敌核发现（survey-db core_hunts first_seen 近期）
 *  - ★3 敌情高浓度区（units_seen 热区 combat 大）
 *  - ★2 跨租户抢矿冲突（共享测绘 conflicts）
 *  - ★2 成员资源濒危（联盟快照 members）
 * 纯读缓存数据（snapshot/survey/heat 均已缓存），45s 缓存 + 后台预热。
 */
import { loadAllianceSnapshot } from "./alliance-snapshot.ts";
import { loadAllianceSurvey } from "./alliance-survey.ts";
import { loadEnemyHeat } from "./enemy-heat.ts";
import { TtlCache } from "./cache.ts";
import type { Deed } from "./deeds.ts";

const ALLIANCE_DEEDS_TTL_MS = 45_000;
const allianceDeedsCache = new TtlCache<readonly Deed[]>(ALLIANCE_DEEDS_TTL_MS);

/** 新敌核发现窗口（tick）：first_seen 距今 ≤ 该值视为"新发现"。 */
const NEW_CORE_WINDOW_TICKS = 1500;
/** 敌情高浓度区阈值：单桶战斗目击数。 */
const HEAT_COMBAT_THRESHOLD = 500;
/** 资源濒危阈值。 */
const LOW_RESOURCE_WARN = 10;

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

export function loadAllianceDeeds(): readonly Deed[] {
  const hit = allianceDeedsCache.get("latest");
  if (hit !== undefined) return hit;
  const out: Deed[] = [];
  const snap = loadAllianceSnapshot();
  const survey = loadAllianceSurvey();
  const now = snap.currentTick;

  // 1) 新敌核发现（survey-db core_hunts first_seen 近期）
  for (const row of survey.enemyCores) {
    const firstSeen = num(row.firstSeenTick);
    if (now <= 0 || now - firstSeen > NEW_CORE_WINDOW_TICKS) continue;
    out.push({
      id: `alliance:new-core:${String(row.tenant)}:${String(row.x)},${String(row.y)}:${firstSeen}`,
      tick: firstSeen,
      tenant: String(row.tenant),
      star: 3,
      kind: "ALLIANCE_NEW_CORE",
      title: "新敌核发现",
      detail: `${String(row.owner ?? "未知")} 核心 @(${String(row.x)},${String(row.y)})（${String(row.tenant)} 目击，${now - firstSeen} tick 前首次）`,
      position: [num(row.x), num(row.y)],
      actor: null,
      target: String(row.owner ?? null),
    });
  }

  // 2) 敌情高浓度区（units_seen 热区）
  const heat = loadEnemyHeat("all");
  for (const b of heat.buckets) {
    if (b.combatCount < HEAT_COMBAT_THRESHOLD) continue;
    out.push({
      id: `alliance:heat:${b.tenant}:${b.bx},${b.by}`,
      tick: b.lastTick,
      tenant: b.tenant,
      star: 3,
      kind: "ALLIANCE_HEAT_ZONE",
      title: "敌情高浓度区",
      detail: `chunk (${b.bx},${b.by}) 累计 ${b.combatCount} 条敌战斗目击（${b.tenant} 侧，${now - b.lastTick} tick 前最后目击）`,
      position: [b.bx * 16 + 8, b.by * 16 + 8],
      actor: null,
      target: null,
    });
  }

  // 3) 跨租户抢矿冲突
  for (const o of survey.conflicts.resourceOverlaps) {
    const ticks = (Array.isArray(o.lastSeenTicks) ? o.lastSeenTicks : []).map((t) => num(t));
    const tick = ticks.length > 0 ? Math.max(...ticks) : now;
    out.push({
      id: `alliance:conflict:${String(o.cell)}`,
      tick,
      tenant: "all",
      star: 2,
      kind: "ALLIANCE_MINE_CONFLICT",
      title: "跨租户抢矿",
      detail: `矿格 (${String(o.cell)}) 被 ${String(o.tenants)} 共同标注（仲裁：保留最新目击租户）`,
      position: (() => {
        const [x, y] = String(o.cell).split(",").map(Number);
        return Number.isFinite(x) && Number.isFinite(y) ? [x, y] as [number, number] : null;
      })(),
      actor: null,
      target: null,
    });
  }

  // 4) 成员资源濒危/状态异常
  for (const m of Object.values(snap.members)) {
    if (m.resources < LOW_RESOURCE_WARN) {
      out.push({
        id: `alliance:economy:${m.tenantId}:${m.tick}`,
        tick: m.tick,
        tenant: m.tenantId,
        star: m.resources < 5 ? 2 : 1,
        kind: "ALLIANCE_ECONOMY",
        title: `${m.tenantId} 资源濒危`,
        detail: `核心资源 ${m.resources}（人口 ${m.population}，工${m.workers}/锋${m.vanguards}/射${m.rangers}）`,
        position: m.core?.position ?? null,
        actor: null,
        target: null,
      });
    }
    if (m.status !== "READY") {
      out.push({
        id: `alliance:status:${m.tenantId}:${m.tick}`,
        tick: m.tick,
        tenant: m.tenantId,
        star: 2,
        kind: "ALLIANCE_STATUS",
        title: `${m.tenantId} 状态异常`,
        detail: `status=${m.status}`,
        position: m.core?.position ?? null,
        actor: null,
        target: null,
      });
    }
  }

  out.sort((a, b) => b.tick - a.tick || b.star - a.star);
  allianceDeedsCache.set("latest", out);
  return out;
}

/** 后台预热。 */
export function refreshAllianceDeeds(): void {
  loadAllianceDeeds();
}
