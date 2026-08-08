/**
 * 事迹日记摘要（2026-08-08）：把事迹流（租户 + 联盟）聚合成"日记"层——
 * 按 tick 窗口给出头条事迹、分租户统计、中文叙事段落。补足"日记、事迹和
 * 日志系统"的日记层（deeds 是流水，journal 是可读日记）。纯读缓存数据，
 * 30s 缓存。
 */
import { loadDeeds, type Deed } from "./deeds.ts";
import { loadAllianceDeeds } from "./alliance-deeds.ts";
import { loadAllianceSnapshot } from "./alliance-snapshot.ts";
import { loadAuditOverview } from "./audit-overview.ts";
import { loadAllianceMining } from "./alliance-mining.ts";
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
  AUDIT_INSIGHT: "audit",
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
    ? [...(await loadDeeds("all", 500)), ...loadAllianceDeeds(), ...buildAuditDeeds(currentTick)]
    : [...(await loadDeeds(tenant, 500)), ...buildAuditDeeds(currentTick).filter((d) => d.tenant === tenant)];
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

/** 审计事迹（2026-08-08）：把综合审计总览的关键健康信号合成可读日记条目——
 *  负增长/发现未开采缺口/决策空转/搬运瓶颈/经济停滞。kind=AUDIT_INSIGHT →
 *  分组 "audit"；star 按严重度 2-4。纯读 audit/overview（30s 缓存），无新增 I/O。 */
function buildAuditDeeds(currentTick: number): Deed[] {
  const ov = loadAuditOverview();
  const out: Deed[] = [];
  // 审计事迹是"当前状态"洞察，tick 对齐日记窗口（避免与 snapshot tick 不一致被过滤）。
  const now = currentTick;
  for (const [t, x] of Object.entries(ov.tenants)) {
    const dec = x.decisions;
    const lc = x.lifecycle;
    const mu = x.mines;
    if (dec && dec.coreDelta < 0) {
      out.push({ id: `audit-neg-${t}`, tick: now, tenant: t, star: 4, kind: "AUDIT_INSIGHT",
        title: `${t} 核心负增长 ${dec.coreDelta}`, detail: `窗口内核心净增为负（手操/自动冲突或经济失血）——需专项复盘。`,
        position: null, actor: null, target: null });
    }
    if (mu && mu.visibleNever >= 10) {
      out.push({ id: `audit-unmined-${t}`, tick: now, tenant: t, star: 3, kind: "AUDIT_INSIGHT",
        title: `${t} ${mu.visibleNever} 个可见矿未开采`, detail: `已发现但从未采集（分配缺口）——优先派 worker，候选格见 audit/mines。`,
        position: null, actor: null, target: null });
    }
    // 趋势方向（2026-08-08，闭环叙事）：缺口扩大/收窄、经济转负/转正——
    // 读 audit/overview 的 trend 字段（最新 vs 前一窗口），把"变化"写进日记。
    const tr = x.trend;
    if (tr && typeof tr.visibleNever === "number" && typeof tr.visibleNeverPrev === "number") {
      if (tr.visibleNever > tr.visibleNeverPrev && tr.visibleNever >= 10) {
        out.push({ id: `audit-unmined-trend-${t}`, tick: now, tenant: t, star: 4, kind: "AUDIT_INSIGHT",
          title: `${t} 矿缺口扩大 ${tr.visibleNeverPrev}→${tr.visibleNever}`, detail: `可见未开采缺口仍在扩大——兑现率见 audit/mining-effectiveness，优先派 worker。`,
          position: null, actor: null, target: null });
      } else if (tr.visibleNever < tr.visibleNeverPrev && tr.visibleNeverPrev > 0) {
        out.push({ id: `audit-unmined-trend-${t}`, tick: now, tenant: t, star: 2, kind: "AUDIT_INSIGHT",
          title: `${t} 矿缺口收窄 ${tr.visibleNeverPrev}→${tr.visibleNever}`, detail: `可见未开采缺口缩小——分工/采集生效，保持节奏。`,
          position: null, actor: null, target: null });
      }
    }
    if (tr && typeof tr.coreDelta === "number" && typeof tr.coreDeltaPrev === "number") {
      if (tr.coreDelta < 0 && tr.coreDeltaPrev >= 0) {
        out.push({ id: `audit-eco-trend-${t}`, tick: now, tenant: t, star: 4, kind: "AUDIT_INSIGHT",
          title: `${t} 经济转负（core ${tr.coreDeltaPrev}→${tr.coreDelta}）`, detail: `核心净增（最新窗口）由非负转负——手操/自动冲突或经济失血，需专项复盘。`,
          position: null, actor: null, target: null });
      } else if (tr.coreDelta > 0 && tr.coreDeltaPrev <= 0) {
        out.push({ id: `audit-eco-trend-${t}`, tick: now, tenant: t, star: 2, kind: "AUDIT_INSIGHT",
          title: `${t} 经济转正（core ${tr.coreDeltaPrev}→${tr.coreDelta}）`, detail: `核心净增（最新窗口）由非正转正——经济恢复，保持。`,
          position: null, actor: null, target: null });
      }
    }
    if (dec && dec.stallRate !== null && dec.stallRate >= 0.9) {
      out.push({ id: `audit-stall-${t}`, tick: now, tenant: t, star: 3, kind: "AUDIT_INSIGHT",
        title: `${t} 决策空转率 ${Math.round(dec.stallRate * 100)}%`, detail: `wait 空转占主导（停摆 tick 占比）——搬运/目标链需优化。`,
        position: null, actor: null, target: null });
    }
    if (dec && dec.cargoEff !== null && dec.cargoEff < 0.25) {
      out.push({ id: `audit-cargo-${t}`, tick: now, tenant: t, star: 2, kind: "AUDIT_INSIGHT",
        title: `${t} 满载率 ${dec.cargoEff}（搬运瓶颈）`, detail: `worker 满载占比低——采了运不回来/分配不均。`,
        position: null, actor: null, target: null });
    }
    if (lc && lc.units <= 2 && lc.spendTotal >= 100) {
      out.push({ id: `audit-eco-${t}`, tick: now, tenant: t, star: 3, kind: "AUDIT_INSIGHT",
        title: `${t} 经济停滞（${lc.units} 单位/已花 ${lc.spendTotal}）`, detail: `大量 spawn 投入但现役单位极少——可能被灭/未续产。`,
        position: null, actor: null, target: null });
    }
  }
  // 联盟采矿分工（2026-08-08）：已就近分配的待开采矿——共享记忆→执行清单可读化
  try {
    const mining = loadAllianceMining();
    for (const [t, p] of Object.entries(mining.perTenant ?? {})) {
      const n = Number(p?.assigned ?? 0);
      if (n >= 10) {
        out.push({ id: `audit-mining-${t}`, tick: now, tenant: t, star: 2, kind: "AUDIT_INSIGHT",
          title: `${t} 已分工 ${n} 矿待开采`, detail: `联盟就近分配（avg ${p?.avgDistance ?? "-"} 格）——按 audit/mines + alliance/mining 候选格派 worker。`,
          position: null, actor: null, target: null });
      }
    }
  } catch { /* 分工数据不可用不阻断 */ }
  return out;
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
  if (counts.audit) parts.push(`数据层审计 ${counts.audit} 条`);
  const active = TENANTS.filter((t) => (perTenant[t]?.count ?? 0) > 0).length;
  parts.push(`活跃租户 ${active}/${TENANTS.length}`);
  return parts.length > 0 ? `${lead}${parts.join("，")}。` : `${lead}无突出事件。`;
}

/** 后台预热。 */
export async function refreshDeedsJournal(): Promise<void> {
  await Promise.all([loadDeedsJournal("all"), ...TENANTS.map((t) => loadDeedsJournal(t))]);
}
