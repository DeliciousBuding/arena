/**
 * 联盟态势快照（2026-08-08）：Command Center 复用 canonical alliance 域模型
 * （arena-agent/src/alliance 纯函数——spec 不变量：Command Center 与生产/模拟
 * 共用同一套联盟语义，不复制）。数据源 = survey-db（跨 run 敌核，共享测绘）
 * + 各租户最新世界状态（我方成员/可见敌单位）+ 排行榜威胁先验。
 *
 * 输出 /api/alliance/snapshot：
 *  - members: 四租户压缩成员状态（core/资源/人口/兵力/状态）
 *  - sightings: 融合敌情目击（去重 + 置信度衰减，CORE tau=96 / UNIT tau=6）
 *  - counts: 四口径兵力（currentVisible/recentUnique/historical/estimatedForce）
 *  - intel: SharedIntelView（LIVE/RECENT/HISTORICAL 新鲜度分类 + 计数）
 *  - threat: 威胁场（cells[]/maxDirect/estimatedCombatForce）
 *  - threatSummaries: 每租户 8 扇区威胁摘要（前端联盟态势 tab）
 * 30s 缓存 + 启动预热（数据不等前端打开才加载）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_ROOT, TENANTS } from "./fs-jsonl.ts";
import { loadWorld } from "./streams.ts";
import { loadLeaderboardIntel } from "./leaderboard.ts";
import { TtlCache } from "./cache.ts";
import {
  observationsToSightings,
  buildAllianceSnapshotFromSightings,
  type AllianceObservation,
} from "./alliance/snapshot.ts";
import { aggregateAllianceIntel, type SharedIntelView } from "./alliance/shared-intel.ts";
import { currentConfidence } from "./alliance/sightings.ts";
import {
  buildAllianceThreatSummariesFromSnapshot,
  type TenantThreatSummary,
} from "./alliance/threat-summary.ts";
import type {
  AllianceMemberState,
  AllianceSnapshot,
  EntitySighting,
  ThreatCell,
  UnitType,
} from "./alliance/types.ts";

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

const asUnitType = (v: unknown): UnitType | undefined => {
  const s = String(v ?? "");
  return s === "WORKER" || s === "VANGUARD" || s === "RANGER" ? s : undefined;
};

/** 从对象取 [x,y] 坐标（obj.position 形状为数组）。 */
const posOf = (v: unknown): [number, number] => {
  if (Array.isArray(v) && v.length >= 2) return [num(v[0]), num(v[1])];
  return [0, 0];
};

interface WorldLike {
  state?: {
    objects?: Array<Record<string, unknown>>;
    resources?: unknown;
    population?: unknown;
    status?: unknown;
    resource_capacity?: unknown;
  } | null;
  tick?: number | null;
}

/** 从最新世界状态推导压缩成员状态（spec §5.1 AllianceMemberState）。 */
function memberStateFromWorld(tenant: string, world: WorldLike, nowMs: number): AllianceMemberState | null {
  const state = world.state;
  if (!state?.objects) return null;
  let core: AllianceMemberState["core"] = null;
  let workers = 0;
  let vanguards = 0;
  let rangers = 0;
  let carried = 0;
  for (const obj of state.objects) {
    if (obj?.kind === "CORE" && obj.controlled === true) {
      core = {
        id: String(obj.id ?? `${tenant}-core`),
        position: posOf(obj.position),
        hp: num(obj.hp),
        shield: num(obj.shield),
        moving: Boolean(obj.moving),
      };
    } else if (obj?.kind === "UNIT" && obj.controlled === true) {
      const t = String(obj.unit_type ?? "");
      if (t === "WORKER") workers += 1;
      else if (t === "VANGUARD") vanguards += 1;
      else if (t === "RANGER") rangers += 1;
      carried += num(obj.cargo);
    }
  }
  return {
    tenantId: tenant,
    tick: num(world.tick),
    observedAtMs: nowMs,
    core,
    resources: num(state.resources),
    resourceCapacity: num(state.resource_capacity),
    population: num(state.population),
    workers,
    vanguards,
    rangers,
    carriedResources: carried,
    activeFleetIds: [],
    localThreat: 0,
    localHarvestRate: 0,
    status: state.status === "ACTIVE" ? "READY" : "DEGRADED",
  };
}

/** survey-db 敌核 → 联盟观测（跨 run 累积，证据=CALIBRATION）。 */
function coreObservationsFromSurvey(tenant: string): AllianceObservation[] {
  const file = join(DATA_ROOT, "runtime", "survey", `${tenant}.db`);
  if (!existsSync(file)) return [];
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const rows = db.prepare(
      "SELECT x, y, last_seen_tick, owner FROM core_hunts ORDER BY last_seen_tick DESC",
    ).all() as Array<{ x: number; y: number; last_seen_tick: number; owner: string | null }>;
    return rows.map((r) => ({
      tenantId: tenant,
      tick: num(r.last_seen_tick),
      kind: "CORE" as const,
      ownerUsername: r.owner ?? undefined,
      controlled: false,
      position: [r.x, r.y] as [number, number],
      evidence: "CALIBRATION" as const,
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** 最新世界状态可见敌方实体（UNIT + CORE）→ 联盟观测（证据=LIVE，fresh 时置信度 1）。 */
function liveEnemyObservationsFromWorld(tenant: string, world: WorldLike): AllianceObservation[] {
  const state = world.state;
  if (!state?.objects) return [];
  const tick = num(world.tick);
  const out: AllianceObservation[] = [];
  for (const obj of state.objects) {
    if (obj?.kind === "CORE" && obj.controlled !== true) {
      out.push({
        tenantId: tenant,
        tick,
        kind: "CORE" as const,
        entityId: typeof obj.id === "string" && obj.id !== "" ? obj.id : undefined,
        ownerUsername: typeof obj.owner_username === "string" && obj.owner_username !== "" ? obj.owner_username : undefined,
        controlled: false,
        position: posOf(obj.position),
        evidence: "LIVE" as const,
      });
    } else if (obj?.kind === "UNIT" && obj.controlled !== true) {
      out.push({
        tenantId: tenant,
        tick,
        kind: "UNIT" as const,
        entityId: typeof obj.id === "string" && obj.id !== "" ? obj.id : undefined,
        unitType: asUnitType(obj.unit_type),
        controlled: false,
        position: posOf(obj.position),
        evidence: "LIVE" as const,
      });
    }
  }
  return out;
}

/** 受控实体 id 并集（盟军 roster，不进敌方目击）。 */
function allyEntityIdsFromWorlds(worlds: ReadonlyMap<string, WorldLike>): string[] {
  const ids: string[] = [];
  for (const w of worlds.values()) {
    for (const obj of w.state?.objects ?? []) {
      if (obj?.controlled === true && typeof obj.id === "string" && obj.id !== "") ids.push(obj.id);
    }
  }
  return ids;
}

/** 排行榜威胁先验：username -> 0..1（仅威胁场加成，不生成实体）。 */
function leaderboardAggression(): Map<string, number> {
  const m = new Map<string, number>();
  const lb = loadLeaderboardIntel();
  for (const p of lb?.profiles ?? []) {
    m.set(p.username, p.tier === "ELITE_AGGRESSOR" ? 0.9 : p.tier === "AGGRESSOR" ? 0.6 : 0.2);
  }
  return m;
}

/** Treasury：Phase 1 未选举时取资源最高租户（展示用，非决策）。 */
function treasuryOf(members: readonly AllianceMemberState[]): string {
  let best = "";
  let bestRes = -1;
  for (const m of members) {
    if (m.resources > bestRes) {
      bestRes = m.resources;
      best = m.tenantId;
    }
  }
  return best;
}

export interface AllianceSnapshotPayload {
  generatedAt: string;
  currentTick: number;
  revision: number;
  members: Record<string, AllianceMemberState>;
  sightings: readonly EntitySighting[];
  counts: AllianceSnapshot["counts"];
  intel: SharedIntelView;
  threat: {
    /** 威胁总分 top-N 格（面板热层用，避免 3 万格全量传输）。 */
    topCells: Array<{ key: string; cell: ThreatCell }>;
    cellCount: number;
    maxDirect: ThreatCell | null;
    estimatedCombatForce: number;
    tickWindow: readonly [number, number];
    generatedAtMs: number;
  };
  threatSummaries: readonly TenantThreatSummary[];
  treasuryTenant: string;
  leaderboardAggression: Record<string, number>;
  cachedAt: string;
}

const ALLIANCE_SNAPSHOT_TTL_MS = 30_000;
const allianceSnapshotCache = new TtlCache<AllianceSnapshotPayload>(ALLIANCE_SNAPSHOT_TTL_MS);

export function loadAllianceSnapshot(): AllianceSnapshotPayload {
  const hit = allianceSnapshotCache.get("latest");
  if (hit !== undefined) return hit;
  const nowMs = Date.now();
  const worlds = new Map<string, WorldLike>();
  let currentTick = 0;
  for (const t of TENANTS) {
    const w = loadWorld(t) as WorldLike;
    worlds.set(t, w);
    const tick = num(w.tick);
    if (tick > currentTick) currentTick = tick;
  }
  const members: AllianceMemberState[] = [];
  for (const t of TENANTS) {
    const m = memberStateFromWorld(t, worlds.get(t) ?? {}, nowMs);
    if (m) members.push(m);
  }
  const observations: AllianceObservation[] = [];
  for (const t of TENANTS) {
    observations.push(...coreObservationsFromSurvey(t));
    observations.push(...liveEnemyObservationsFromWorld(t, worlds.get(t) ?? {}));
  }
  const allyIds = allyEntityIdsFromWorlds(worlds);
  const aggression = leaderboardAggression();
  // 一次性重建（非跨 tick 累积）时新条目 confidence 恒 1——按 lastSeenTick
  // 龄用 canonical currentConfidence 衰减（CORE tau=96 / UNIT tau=6，floor 0.05），
  // 陈旧敌核不占全威胁权重。
  const sightings = observationsToSightings(observations, currentTick)
    .map((s) => (s.lastSeenTick < currentTick ? { ...s, confidence: currentConfidence(s, currentTick) } : s));
  const snapshot = buildAllianceSnapshotFromSightings({
    revision: 1,
    members,
    sightings,
    allyEntityIds: allyIds,
    nowTick: currentTick,
    generatedAtMs: nowMs,
    leaderboardAggression: aggression,
    treasuryTenant: treasuryOf(members),
  });
  const intel = aggregateAllianceIntel({ sightings, allyEntityIds: allyIds, currentTick });
  const threatSummaries = buildAllianceThreatSummariesFromSnapshot(snapshot);
  const payload: AllianceSnapshotPayload = {
    generatedAt: new Date().toISOString(),
    currentTick,
    revision: snapshot.revision,
    members: Object.fromEntries(snapshot.members),
    sightings: snapshot.sightings,
    counts: snapshot.counts,
    intel,
    threat: {
      topCells: [...snapshot.threat.cells.entries()]
        .map(([key, cell]) => ({ key, cell, score: cell.directCombat + cell.projectedCombat + cell.coreRaid }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 300)
        .map(({ key, cell }) => ({ key, cell })),
      cellCount: snapshot.threat.cells.size,
      maxDirect: snapshot.threat.maxDirect,
      estimatedCombatForce: snapshot.threat.estimatedCombatForce,
      tickWindow: snapshot.threat.tickWindow,
      generatedAtMs: snapshot.threat.generatedAtMs,
    },
    threatSummaries,
    treasuryTenant: snapshot.treasuryTenant,
    leaderboardAggression: Object.fromEntries(aggression),
    cachedAt: new Date().toISOString(),
  };
  allianceSnapshotCache.set("latest", payload);
  return payload;
}

/** 后台预热（启动/周期循环调用，与联盟情报一致）。 */
export function refreshAllianceSnapshot(): void {
  loadAllianceSnapshot();
}
