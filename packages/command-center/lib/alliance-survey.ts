/**
 * 联盟共享测绘聚合（2026-08-08）：聚合四租户 survey-db（敌核/矿/障碍/探索分区
 * + 生命周期摘要），带租户色与证据来源——地图「全联盟」层数据源。
 *
 * 数据源复用 loadTenantSurveyCached（已带 60s 缓存 + 30s 后台刷新），本模块
 * 再做 30s 聚合缓存：前端轮询 /api/alliance/survey 毫秒级返回，不实时扫库。
 */
import { TENANTS } from "./fs-jsonl.ts";
import { loadTenantSurveyCached } from "./survey-cache.ts";
import { TtlCache } from "./cache.ts";

/** 租户区分色（前端地图/卡片/树目录共用，t1 绿 / t2 蓝 / t3 琥珀 / t4 粉）。 */
export const TENANT_COLORS: Record<string, string> = {
  t1: "#22c55e",
  t2: "#3b82f6",
  t3: "#f59e0b",
  t4: "#ec4899",
};

export interface TenantSummary {
  caseCount: number;
  tickMax: number;
  resources: number;
  obstacles: number;
  cores: number;
  chunks: number;
}

export interface AllianceSurveyPayload {
  generatedAt: string;
  colors: Record<string, string>;
  tenantSummaries: Record<string, TenantSummary>;
  enemyCores: Array<Record<string, unknown>>;
  resources: Array<Record<string, unknown>>;
  obstacles: Array<Record<string, unknown>>;
  chunks: Array<Record<string, unknown>>;
  lifecycle: Record<string, Record<string, unknown> | null>;
  /** 跨租户测绘冲突（2026-08-08，共享测绘质量）：多租户同格矿重叠 /
   *  同格一租户见矿一租户见障碍（记忆不一致，需仲裁）。 */
  conflicts: {
    resourceOverlaps: Array<Record<string, unknown>>;
    obstacleResourceConflicts: Array<Record<string, unknown>>;
  };
  /** 共识矿视图（2026-08-08，共享测绘设计）：同格多租户矿归一化为一条
   *  共识条目（winner 仲裁 + observers 全部观测租户 + consensus 数），
   *  前端“全联盟矿”层可选去重视图；agent 仲裁输入同源。 */
  consensusResources: Array<Record<string, unknown>>;
  cachedAt: string;
}

const ALLIANCE_SURVEY_TTL_MS = 30_000;
const allianceSurveyCache = new TtlCache<AllianceSurveyPayload>(ALLIANCE_SURVEY_TTL_MS);

export function loadAllianceSurvey(): AllianceSurveyPayload {
  const hit = allianceSurveyCache.get("all");
  if (hit !== undefined) return hit;
  const colors = { ...TENANT_COLORS };
  const tenantSummaries: Record<string, TenantSummary> = {};
  const enemyCores: Array<Record<string, unknown>> = [];
  const resources: Array<Record<string, unknown>> = [];
  const obstacles: Array<Record<string, unknown>> = [];
  const chunks: Array<Record<string, unknown>> = [];
  const lifecycle: Record<string, Record<string, unknown> | null> = {};
  let cachedAt = "";
  for (const t of TENANTS) {
    const c = loadTenantSurveyCached(t);
    cachedAt = c.cachedAt;
    const s = c.survey;
    tenantSummaries[t] = {
      caseCount: s?.caseCount ?? 0,
      tickMax: s?.tickMax ?? 0,
      resources: s?.resourceCells.length ?? 0,
      obstacles: s?.obstacleCells.length ?? 0,
      cores: s?.coreCells.length ?? 0,
      chunks: c.chunks.length,
    };
    for (const r of s?.resourceCells ?? []) resources.push({ tenant: t, ...r });
    for (const o of s?.obstacleCells ?? []) obstacles.push({ tenant: t, ...o });
    for (const k of s?.coreCells ?? []) enemyCores.push({ tenant: t, ...k });
    for (const ch of c.chunks) chunks.push({ tenant: t, ...ch });
    lifecycle[t] = c.lifecycle;
  }
  // 跨租户测绘冲突：同格矿重叠（两租户抢矿候选）+ 矿/障碍矛盾（记忆不一致）
  const resByCell = new Map<string, Array<Record<string, unknown>>>();
  for (const r of resources) {
    const k = `${String(r.x)},${String(r.y)}`;
    const list = resByCell.get(k) ?? [];
    list.push(r);
    resByCell.set(k, list);
  }
  // 仲裁规则（2026-08-08，蓝图 §2 同口径）：同格矿，lastSeenTick 最新者胜
  // （记忆新鲜=占矿）；同 tick 平局按租户序 t1<t2<t3<t4。败者该格应写入负记忆
  // （HARVEST_FAILED NOT_RESOURCE_CELL 同类机制），worker 不再追。
  const pickResourceWinner = (rows: Array<Record<string, unknown>>): Record<string, unknown> =>
    [...rows].sort((a, b) => {
      const ta = Number(a.tick ?? 0);
      const tb = Number(b.tick ?? 0);
      if (ta !== tb) return tb - ta;
      return String(a.tenant).localeCompare(String(b.tenant));
    })[0];
  // 共识矿视图（去重归一化）：单租户原样 + observers；多租户重叠
  // 按仲裁取 winner 为代表，observers 列全部观测租户，consensus=观测数。
  const consensusResources: Array<Record<string, unknown>> = [...resByCell.entries()]
    .map(([, rows]): Record<string, unknown> => {
      if (rows.length === 1) {
        const single = rows[0];
        return { ...single, observers: [single.tenant], consensus: 1 };
      }
      const winner = pickResourceWinner(rows);
      return { ...winner, observers: rows.map((r) => r.tenant), consensus: rows.length };
    })
    .sort((a, b) => Number(a.x ?? 0) - Number(b.x ?? 0) || Number(a.y ?? 0) - Number(b.y ?? 0));
  const resourceOverlaps = [...resByCell.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([cell, rows]) => {
      const winner = pickResourceWinner(rows);
      const losers = rows.filter((r) => r !== winner).map((r) => r.tenant);
      const tieBroken = rows.every((r) => Number(r.tick) === Number(winner.tick));
      return {
        cell,
        tenants: rows.map((r) => r.tenant),
        states: rows.map((r) => r.state),
        lastSeenTicks: rows.map((r) => r.tick),
        // 共享测绘仲裁建议：winner 占矿，losers 该格作负记忆
        arbitration: {
          winner: String(winner.tenant),
          losers,
          tieBroken,
          reason: tieBroken
            ? `同 tick 平局，租户序 ${String(winner.tenant)} 胜`
            : `lastSeen ${String(winner.tick)} 最新，${String(winner.tenant)} 占矿`,
        },
      };
    })
    .sort((a, b) => String(a.cell).localeCompare(String(b.cell)));
  const obstacleCells = new Map<string, string[]>();
  for (const o of obstacles) {
    const k = `${String(o.x)},${String(o.y)}`;
    const list = obstacleCells.get(k) ?? [];
    list.push(String(o.tenant));
    obstacleCells.set(k, list);
  }
  const obstacleResourceConflicts: Array<Record<string, unknown>> = [];
  for (const [cell, rows] of resByCell) {
    const obsTenants = obstacleCells.get(cell);
    if (obsTenants && obsTenants.length > 0) {
      obstacleResourceConflicts.push({
        cell,
        resourceTenants: rows.map((r) => r.tenant),
        obstacleTenants: obsTenants,
      });
    }
  }
  obstacleResourceConflicts.sort((a, b) => String(a.cell).localeCompare(String(b.cell)));
  const payload: AllianceSurveyPayload = {
    generatedAt: new Date().toISOString(),
    colors,
    tenantSummaries,
    enemyCores,
    resources,
    obstacles,
    chunks,
    lifecycle,
    conflicts: { resourceOverlaps, obstacleResourceConflicts },
    consensusResources,
    cachedAt,
  };
  allianceSurveyCache.set("all", payload);
  return payload;
}

/** 后台预热（启动时调用，与 intel/survey 缓存一致，前端首开即命中）。 */
export function refreshAllianceSurvey(): void {
  loadAllianceSurvey();
}
