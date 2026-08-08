/**
 * 事迹日记摘要（2026-08-08）：把事迹流（租户 + 联盟）聚合成"日记"层——
 * 按 tick 窗口给出头条事迹、分租户统计、中文叙事段落。补足"日记、事迹和
 * 日志系统"的日记层（deeds 是流水，journal 是可读日记）。纯读缓存数据，
 * 30s 缓存。
 */
import { loadDeeds, type Deed } from "./deeds.ts";
import { loadAllianceDeeds } from "./alliance-deeds.ts";
import { loadAllianceSnapshot } from "./alliance-snapshot.ts";
import { TtlCache } from "./cache.ts";
import { TENANTS } from "./fs-jsonl.ts";

export interface DeedsJournalPayload {
  generatedAt: string;
  tenant: string;
  windowTicks: number;
  currentTick: number;
  windowStartTick: number;
  headline: Deed | null;
  counts: Record<string, number>;
  perTenant: Record<string, { count: number; topStar: number }>;
  narrative: string;
  /** 按类别分组的 deeds（2026-08-08 折叠/筛选）：harvest/deposit/spawn/death/
   *  milestone/newCore/heatZone/conflict/economy/status/other，每组 ≤20 条。 */
  groups: Record<string, readonly Deed[]>;
  /** 生效的筛选（回显，前端可显示当前过滤状态）。 */
  filters: { categories: readonly string[]; minStar: number };
  deeds: readonly Deed[];
  cachedAt: string;
}

/** 日记查询选项（2026-08-08）：category=harvest,deposit… 按类别过滤；
 *  minStar=N 只保留 ≥N 星级。前端折叠/筛选用，纯后端增强。 */
export interface JournalQuery {
  categories?: readonly string[];
  minStar?: number;
}

const JOURNAL_TTL_MS = 30_000;
const journalCache = new TtlCache<DeedsJournalPayload>(JOURNAL_TTL_MS);

const KIND_GROUP: Record<string, string> = {
  HARVEST_SUCCEEDED: "harvest",
  DEPOSIT_SUCCEEDED: "deposit",
  CORE_SPAWN_SUCCEEDED: "spawn",
  UNIT_DESTROYED: "death",
  MILESTONE_HARVEST: "milestone",
  MILESTONE_BIRTH: "milestone",
  MILESTONE_SPEND: "milestone",
  MILESTONE_DEATH: "milestone",
  MILESTONE_RESOURCES: "milestone",
  RESOURCE_PEAK: "milestone",
  ALLIANCE_NEW_CORE: "newCore",
  ALLIANCE_HEAT_ZONE: "heatZone",
  ALLIANCE_MINE_CONFLICT: "conflict",
  ALLIANCE_ECONOMY: "economy",
  ALLIANCE_STATUS: "status",
};

export async function loadDeedsJournal(tenant: string, windowTicks = 5000, query: JournalQuery = {}): Promise<DeedsJournalPayload> {
  const cats = query.categories?.filter(Boolean) ?? [];
  const minStar = typeof query.minStar === "number" && Number.isFinite(query.minStar) ? Math.min(Math.max(Math.round(query.minStar), 1), 4) : 0;
  const key = `${tenant}:${windowTicks}:${cats.join(",")}:${minStar}`;
  const hit = journalCache.get(key);
  if (hit !== undefined) return hit;
  const snap = loadAllianceSnapshot();
  const currentTick = snap.currentTick;
  const windowStart = currentTick - windowTicks;
  const all = tenant === "all"
    ? [...(await loadDeeds("all", 500)), ...loadAllianceDeeds()]
    : [...(await loadDeeds(tenant, 500))];
  let windowed = all
    .filter((d) => d.tick >= windowStart && d.tick <= currentTick)
    .sort((a, b) => b.star - a.star || b.tick - a.tick);
  // 2026-08-08 折叠/筛选：minStar 与 category（KIND_GROUP 类别）过滤，供前端
  // 日记分组折叠/只看某类；counts/perTenant/narrative 基于过滤后集合，语义一致。
  if (minStar > 0) windowed = windowed.filter((d) => d.star >= minStar);
  const catSet = new Set(cats);
  if (catSet.size > 0) windowed = windowed.filter((d) => catSet.has(KIND_GROUP[d.kind] ?? "other"));
  const headline = windowed[0] ?? null;
  const counts: Record<string, number> = {};
  const perTenant: Record<string, { count: number; topStar: number }> = {};
  const groups: Record<string, Deed[]> = {};
  for (const d of windowed) {
    const g = KIND_GROUP[d.kind] ?? "other";
    counts[g] = (counts[g] ?? 0) + 1;
    (groups[g] = groups[g] ?? []).push(d);
    const t = perTenant[d.tenant] ?? { count: 0, topStar: 0 };
    t.count += 1;
    if (d.star > t.topStar) t.topStar = d.star;
    perTenant[d.tenant] = t;
  }
  const narrative = buildNarrative(windowed, counts, perTenant, tenant);
  const payload: DeedsJournalPayload = {
    generatedAt: new Date().toISOString(),
    tenant,
    windowTicks,
    currentTick,
    windowStartTick: windowStart,
    headline,
    counts,
    perTenant,
    narrative,
    groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.slice(0, 20)])),
    filters: { categories: cats, minStar },
    deeds: windowed.slice(0, 30),
    cachedAt: new Date().toISOString(),
  };
  journalCache.set(key, payload);
  return payload;
}

function buildNarrative(
  deeds: readonly Deed[],
  counts: Record<string, number>,
  perTenant: Record<string, { count: number; topStar: number }>,
  tenant: string,
): string {
  const parts: string[] = [];
  if (deeds.length === 0) return "该窗口内无事迹。";
  const tenantLabel = tenant === "all" ? "联盟" : tenant;
  const lead = `${tenantLabel}最近 ${deeds.length} 条事迹：`;
  if (counts.harvest) parts.push(`采集 ${counts.harvest} 次`);
  if (counts.deposit) parts.push(`交付 ${counts.deposit} 次`);
  if (counts.spawn) parts.push(`产兵 ${counts.spawn} 次`);
  if (counts.death) parts.push(`阵亡 ${counts.death} 个`);
  if (counts.milestone) parts.push(`里程碑 ${counts.milestone} 个`);
  if (counts.newCore) parts.push(`新敌核 ${counts.newCore} 处`);
  if (counts.heatZone) parts.push(`敌情高浓度区 ${counts.heatZone} 处`);
  if (counts.conflict) parts.push(`抢矿冲突 ${counts.conflict} 处`);
  if (counts.economy) parts.push(`资源濒危 ${counts.economy} 租户次`);
  const active = TENANTS.filter((t) => (perTenant[t]?.count ?? 0) > 0).length;
  parts.push(`活跃租户 ${active}/${TENANTS.length}`);
  return parts.length > 0 ? `${lead}${parts.join("，")}。` : `${lead}无突出事件。`;
}

/** 后台预热。 */
export async function refreshDeedsJournal(): Promise<void> {
  await Promise.all([loadDeedsJournal("all"), ...TENANTS.map((t) => loadDeedsJournal(t))]);
}
