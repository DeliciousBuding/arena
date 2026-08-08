/**
 * 事迹日记摘要（2026-08-08）：把事迹流（租户 + 联盟）聚合成"日记"层——
 * 按 tick 窗口给出头条事迹、分租户统计、中文叙事段落。补足"日记、事迹和
 * 日志系统"的日记层（deeds 是流水，journal 是可读日记）。纯读缓存数据，
 * 30s 缓存。
 */
import { loadDeeds, type Deed } from "./deeds.ts";
import { loadAllianceDeeds } from "./alliance-deeds.ts";
import { loadAllianceSnapshot } from "./alliance-snapshot.ts";
import { loadAllianceExploration, type AllianceExplorationPayload } from "./exploration-coverage.ts";
import { loadAuditOverview, type AuditOverviewPayload } from "./audit-overview.ts";
import { loadAllianceMining } from "./alliance-mining.ts";
import { loadMiningEffectiveness } from "./mining-effectiveness.ts";
import { loadShopHistoryEntries, buildShopJournalLine } from "./shop-history.ts";
import { TtlCache } from "./cache.ts";
import { TENANTS } from "./fs-jsonl.ts";
import { loadLeaderboardIntel, type LeaderboardIntel } from "./leaderboard.ts";
import { buildEncounteredIndex, type EncounterEntry } from "./intel.ts";

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
  /** 窗口对比（2026-08-08，复盘日记）：本窗口 vs 上一窗口各类别变化。 */
  delta: {
    prevWindowStartTick: number;
    counts: Record<string, { cur: number; prev: number; delta: number }>;
    narrative: string;
  } | null;
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
  const prevWindowStart = currentTick - windowTicks * 2;
  const all = tenant === "all"
    ? [...(await loadDeeds("all", 500)), ...loadAllianceDeeds(), ...buildAuditDeeds(currentTick)]
    : [...(await loadDeeds(tenant, 500)), ...buildAuditDeeds(currentTick).filter((d) => d.tenant === tenant)];
  const catSet = new Set(cats);
  // 2026-08-08 折叠/筛选：minStar 与 category 过滤，供前端分组折叠/只看某类；
  // counts/perTenant/narrative/delta 基于过滤后集合，语义一致。
  const applyFilter = (ds: readonly Deed[]): Deed[] => {
    let out = ds.slice();
    if (minStar > 0) out = out.filter((d) => d.star >= minStar);
    if (catSet.size > 0) out = out.filter((d) => catSet.has(KIND_GROUP[d.kind] ?? "other"));
    return out;
  };
  const curRaw = all.filter((d) => d.tick >= windowStart && d.tick <= currentTick);
  const prevRaw = all.filter((d) => d.tick >= prevWindowStart && d.tick < windowStart);
  const windowed = applyFilter(curRaw).sort((a, b) => b.star - a.star || b.tick - a.tick);
  const prevWindowed = applyFilter(prevRaw);
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
  let narrative = buildNarrative(windowed, counts, perTenant, tenant);
  // 商店历史跨日涨跌（2026-08-08，日记层）：联盟级追加一行——观察期内价格/库存变动 +
  // 下架商品（读落盘快照，30s 缓存，无触网/无定时任务）。
  if (tenant === "all") {
    try {
      const shopLine = buildShopJournalLine(loadShopHistoryEntries());
      if (shopLine) narrative = narrative ? narrative + " " + shopLine : shopLine;
      // 联盟测绘覆盖（2026-08-08，共享测绘日记）：覆盖% + 各租户区块 + 核心旁盲区。
      const covLine = buildAllianceCoverageLine(loadAllianceExploration());
      if (covLine) narrative = narrative ? narrative + " " + covLine : covLine;
      // 决策健康（2026-08-08，综合决策日记）：逐租户质量分 + 联盟平均 + 最差归因。
      const healthLine = buildDecisionHealthLine(loadAuditOverview());
      if (healthLine) narrative = narrative ? narrative + " " + healthLine : healthLine;
      // 敌情威胁（2026-08-08，日记层第 5 层）：高威胁遭遇 + 猛攻蛆——读 leaderboard
      // 30s 缓存 + 遭遇索引 30s 缓存，无触网/无定时任务。
      const threatLine = buildThreatJournalLine(loadLeaderboardIntel(), buildEncounteredIndex());
      if (threatLine) narrative = narrative ? narrative + " " + threatLine : threatLine;
    } catch { /* 商店数据不可用不阻断 */ }
  }
  const windowDelta = buildWindowDelta(windowed, prevWindowed);
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
    delta: { prevWindowStartTick: prevWindowStart, ...windowDelta },
    deeds: windowed.slice(0, 30),
    cachedAt: new Date().toISOString(),
  };
  journalCache.set(key, payload);
  return payload;
}

/** 决策健康摘要（2026-08-08，日记层）：综合决策质量分逐租户 + 联盟平均 + 最差归因。
 *  读 audit/overview（30s 缓存，已在日记路径加载），无触网。 */
export function buildDecisionHealthLine(ov: AuditOverviewPayload | null): string | null {
  if (!ov) return null;
  const parts: string[] = [];
  for (const t of TENANTS) {
    const q = ov.tenants?.[t]?.quality;
    if (!q) continue;
    parts.push(`${t.toUpperCase()} ${q.score}${q.grade}`);
  }
  const gq = ov.global?.quality;
  if (parts.length === 0 && !gq) return null;
  const suffix = gq ? `（联盟 ${gq.score}${gq.grade}）` : "";
  const worst = gq ? gq.reasons.slice(0, 3).join("/") : "";
  return `决策健康：${parts.join("·")}${suffix}${worst ? "——" + worst : ""}。`;
}


/** 敌情威胁摘要（2026-08-08，日记层 · 第 5 层）：高威胁遭遇（CRITICAL/HIGH + 距核距离）
 *  + 排行榜猛攻蛆（ELITE_AGGRESSOR = 伤害 top10）——联盟日记叙事追加一行，让"谁在
 *  附近/谁有威胁"一眼可读。纯读 leaderboard（30s 缓存）+ 遭遇索引（30s 缓存），无触网。 */
export function buildThreatJournalLine(
  lb: LeaderboardIntel | null,
  encountered: ReadonlyMap<string, readonly EncounterEntry[]>,
): string | null {
  const RISK_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  // 高威胁遭遇：raidRisk CRITICAL/HIGH，按风险 + 距核距离升序取前 3
  const hot: Array<{ username: string; tenant: string; dist: number | null; risk: string }> = [];
  for (const [username, entries] of encountered) {
    for (const e of entries) {
      if (!e.raidRisk || !(e.raidRisk in RISK_ORDER) || RISK_ORDER[e.raidRisk] > 1) continue;
      hot.push({ username, tenant: e.tenant, dist: e.distanceToFriendlyCore, risk: e.raidRisk });
    }
  }
  hot.sort((a, b) => (RISK_ORDER[a.risk] - RISK_ORDER[b.risk]) || ((a.dist ?? 9999) - (b.dist ?? 9999)));
  const hotPart = hot.slice(0, 3).map((h) => `${h.username}@${h.tenant.toUpperCase()}${h.dist != null ? `距核${h.dist}` : ""}`).join("·");
  // 猛攻蛆：排行榜伤害 top10 = ELITE_AGGRESSOR
  const elites = (lb?.profiles ?? []).filter((p) => p.tier === "ELITE_AGGRESSOR");
  const eliteNames = elites.slice(0, 5).map((p) => p.username).filter(Boolean).join("/");
  if (!hotPart && eliteNames.length === 0) return null;
  const parts: string[] = [];
  if (hotPart) parts.push(`高威胁遭遇 ${hotPart}`);
  if (eliteNames.length > 0) parts.push(`排行榜猛攻蛆 ${elites.length} 人（${eliteNames}…）`);
  return `敌情：${parts.join("；")}。`;
}
/** 联盟测绘覆盖摘要（2026-08-08，日记层）：共享测绘覆盖%（区块数）+ 各租户探索区块 +
 *  核心旁盲区。供联盟日记叙事追加一行（只读，读 exploration 30s 缓存，无触网）。 */
export function buildAllianceCoverageLine(exp: AllianceExplorationPayload | null): string | null {
  const world = exp?.world;
  const explored = Number(world?.exploredChunks ?? 0);
  if (!world || explored <= 0) return null;
  const span = Number(world?.spanChunks ?? 0);
  const pct = typeof world?.coveragePct === "number" ? world.coveragePct : span > 0 ? Math.round((explored / span) * 1000) / 10 : null;
  const per = exp?.perTenant ?? {};
  const byTenant = TENANTS.map((t) => `${t.toUpperCase()} ${Number(per[t]?.exploredChunks ?? 0)}`).join("·");
  const parts: string[] = [`覆盖 ${pct ?? 0}%（${explored}/${span} 区块）`, `各租户 ${byTenant}`];
  const gaps = Number(exp?.gaps?.length ?? 0);
  if (gaps > 0) parts.push(`核心旁盲区 ${gaps} 处`);
  return `联盟测绘：${parts.join("，")}。`;
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
    let miningEff: ReturnType<typeof loadMiningEffectiveness> | null = null;
    try { miningEff = loadMiningEffectiveness(); } catch { /* 兑现数据不可用不阻断 */ }
    for (const [t, p] of Object.entries(mining.perTenant ?? {})) {
      const n = Number(p?.assigned ?? 0);
      if (n >= 10) {
        const e = miningEff?.perTenant?.[t];
        const closed = (e?.harvested ?? 0) + (e?.stale ?? 0);
        const detail = e && closed > 0
          ? `联盟就近分配 ${n} 矿（avg ${p?.avgDistance ?? "-"} 格）——已采 ${e.harvested}/失效 ${e.stale}/在途 ${e.open}，兑现率见 audit/mining-effectiveness。`
          : `联盟就近分配 ${n} 矿（avg ${p?.avgDistance ?? "-"} 格）——尚 0 兑现（全在途），按 audit/mines + alliance/mining 候选格派 worker。`;
        out.push({ id: `audit-mining-${t}`, tick: now, tenant: t, star: e && e.harvested > 0 ? 2 : 3, kind: "AUDIT_INSIGHT",
          title: `${t} 已分工 ${n} 矿${e ? `（0 兑现 ${e.open} 在途）` : "待开采"}`, detail,
          position: null, actor: null, target: null });
      }
    }
  } catch { /* 分工数据不可用不阻断 */ }
  return out;
}

/** 窗口对比（2026-08-08，复盘日记）：本窗口 vs 上一窗口各类别计数变化 +
 *  中文叙事（新增/归零/±N）。纯函数可测，两窗口已按同一筛选口径。 */
export function buildWindowDelta(
  cur: readonly Deed[],
  prev: readonly Deed[],
): { counts: Record<string, { cur: number; prev: number; delta: number }>; narrative: string } {
  const tally = (deeds: readonly Deed[]): Record<string, number> => {
    const c: Record<string, number> = {};
    for (const d of deeds) {
      // AUDIT_INSIGHT 是当前态洞察（tick=now，非历史事件流）——不进窗口对比，避免"新增 N"假象
      if (d.kind === "AUDIT_INSIGHT") continue;
      const g = KIND_GROUP[d.kind] ?? "other";
      c[g] = (c[g] ?? 0) + 1;
    }
    return c;
  };
  const curC = tally(cur);
  const prevC = tally(prev);
  const cats = new Set([...Object.keys(curC), ...Object.keys(prevC)]);
  const counts: Record<string, { cur: number; prev: number; delta: number }> = {};
  for (const k of cats) counts[k] = { cur: curC[k] ?? 0, prev: prevC[k] ?? 0, delta: (curC[k] ?? 0) - (prevC[k] ?? 0) };
  const LABEL: Record<string, string> = {
    harvest: "采集", deposit: "交付", spawn: "产兵", death: "阵亡", milestone: "里程碑",
    newCore: "新敌核", heatZone: "热区", conflict: "抢矿冲突", economy: "资源濒危", audit: "审计",
  };
  const parts: string[] = [];
  for (const [k, v] of Object.entries(counts)) {
    if (v.delta === 0) continue;
    const label = LABEL[k] ?? k;
    if (v.cur > 0 && v.prev === 0) parts.push(`${label} 新增 ${v.cur}`);
    else if (v.cur === 0 && v.prev > 0) parts.push(`${label} 归零（-${v.prev}）`);
    else if (Math.abs(v.delta) >= 2) parts.push(`${label} ${v.delta > 0 ? "+" : ""}${v.delta}（${v.prev}→${v.cur}）`);
  }
  return { counts, narrative: parts.length > 0 ? `较上一窗口：${parts.join("，")}。` : "较上一窗口无显著变化。" };
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
