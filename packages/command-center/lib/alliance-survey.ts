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
import { loadArbitrations } from "./arbitration.ts";

/** 租户区分色（前端地图/卡片/树目录共用；与 DESIGN.md 统一：t1 蓝 / t2 绿 / t3 紫 / t4 红 muted）。 */
export const TENANT_COLORS: Record<string, string> = {
  t1: "#69b3d8",
  t2: "#57bd84",
  t3: "#a892d6",
  t4: "#dd626d",
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
  /** 共识核心视图（2026-08-08）：同 owner 敌核被多租户目击→取最新位置
   *  + observers 全部观测租户（对称于 consensusResources）。 */
  consensusCores: Array<Record<string, unknown>>;
  /** 联盟探索覆盖（2026-08-08）：四租户 chunks 并集（同 chunk 保留最新
   *  探索 tick + observers）——前端全联盟 Fog 层可用。 */
  consensusChunks: Array<Record<string, unknown>>;
  cachedAt: string;
}

const ALLIANCE_SURVEY_TTL_MS = 30_000;
const allianceSurveyCache = new TtlCache<AllianceSurveyPayload>(ALLIANCE_SURVEY_TTL_MS);

export function loadAllianceSurvey(): AllianceSurveyPayload {
  const hit = allianceSurveyCache.get("all");
  if (hit !== undefined) return hit;
  const arbitrations = loadArbitrations();
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
  // 人工仲裁覆盖（2026-08-08，冲突闭环）：同格存在人类指定 winner → 以覆盖者
  //  为代表（arbitrated 标记），否则自动仲裁（lastSeen 最新者胜）。
  const arbitratedWinner = (rows: Array<Record<string, unknown>>): { winner: Record<string, unknown>; arbitrated: boolean } => {
    const auto = pickResourceWinner(rows);
    const arb = arbitrations.get(`${String(auto.x ?? "")},${String(auto.y ?? "")}`);
    if (arb?.winnerTenant) {
      const override = rows.find((r) => String(r.tenant) === arb.winnerTenant);
      if (override) return { winner: override, arbitrated: true };
    }
    return { winner: auto, arbitrated: false };
  };
  const consensusResources: Array<Record<string, unknown>> = [...resByCell.entries()]
    .map(([, rows]): Record<string, unknown> => {
      if (rows.length === 1) {
        const single = rows[0];
        return { ...single, observers: [single.tenant], consensus: 1 };
      }
      const { winner, arbitrated } = arbitratedWinner(rows);
      return { ...winner, observers: rows.map((r) => r.tenant), consensus: rows.length, arbitrated };
    })
    .sort((a, b) => Number(a.x ?? 0) - Number(b.x ?? 0) || Number(a.y ?? 0) - Number(b.y ?? 0));
  // 共识核心（同 owner 多租户目击合并，取最新位置 + observers）
  const coreByOwner = new Map<string, Record<string, unknown>>();
  for (const k of enemyCores) {
    const owner = String(k.owner ?? "");
    if (!owner) continue;
    const cur = coreByOwner.get(owner);
    if (!cur) {
      coreByOwner.set(owner, { ...k, observers: [k.tenant] });
    } else {
      const obs = new Set([...(cur.observers as string[] ?? []), String(k.tenant)]);
      if (Number(k.tick ?? 0) > Number(cur.tick ?? 0)) {
        coreByOwner.set(owner, { ...k, observers: [...obs] });
      } else {
        cur.observers = [...obs];
      }
    }
  }
  const consensusCores = [...coreByOwner.values()];
  // 联盟探索覆盖：chunks 并集（同 key 保留最新探索 tick + observers）
  const chunkByKey = new Map<string, Record<string, unknown>>();
  for (const ch of chunks) {
    const key = String(ch.key ?? `${String(ch.cx)},${String(ch.cy)}`);
    const cur = chunkByKey.get(key);
    if (!cur) {
      chunkByKey.set(key, { ...ch, observers: [ch.tenant] });
    } else {
      const obs = new Set([...(cur.observers as string[] ?? []), String(ch.tenant)]);
      if (Number(ch.lastSeenTick ?? 0) > Number(cur.lastSeenTick ?? 0)) {
        chunkByKey.set(key, { ...ch, observers: [...obs] });
      } else {
        cur.observers = [...obs];
      }
    }
  }
  const consensusChunks = [...chunkByKey.values()];
  const resourceOverlaps = [...resByCell.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([cell, rows]) => {
      const arb = arbitrations.get(cell);
      const auto = pickResourceWinner(rows);
      const winner = arb?.winnerTenant ? (rows.find((r) => String(r.tenant) === arb.winnerTenant) ?? auto) : auto;
      const losers = rows.filter((r) => r !== winner).map((r) => r.tenant);
      const tieBroken = rows.every((r) => Number(r.tick) === Number(winner.tick));
      const arbitrated = arb?.winnerTenant !== undefined && arb?.winnerTenant !== null;
      return {
        cell,
        tenants: rows.map((r) => r.tenant),
        states: rows.map((r) => r.state),
        lastSeenTicks: rows.map((r) => r.tick),
        // 共享测绘仲裁建议：winner 占矿，losers 该格作负记忆（人工覆盖优先）
        arbitration: {
          winner: String(winner.tenant),
          losers,
          tieBroken,
          arbitrated,
          reason: arbitrated
            ? `人工仲裁：${String(arb?.winnerTenant)} 占矿${arb?.note ? `（${arb.note}）` : ""}`
            : tieBroken
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
    consensusCores,
    consensusChunks,
    cachedAt,
  };
  allianceSurveyCache.set("all", payload);
  return payload;
}

/** 后台预热（启动时调用，与 intel/survey 缓存一致，前端首开即命中）。 */
export function refreshAllianceSurvey(): void {
  // 先失效缓存再重载——仲裁/写入口后立即生效（2026-08-08，冲突闭环）。
  allianceSurveyCache.invalidate();
  loadAllianceSurvey();
}
