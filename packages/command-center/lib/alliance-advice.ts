/**
 * 联盟参谋建议（2026-08-08，人机协同决策支持）：把联盟态势快照 + 共享测绘
 * + 排行榜综合成具体可执行的运维建议（经济/兵力/威胁/敌核邻近/抢矿/高威胁
 * 玩家），按严重度排序——给手操指挥（用户"我在设计和手操和迁移"）一个
 * 一眼可读的"该做什么"清单。纯只读，30s 缓存。
 *
 * 2026-08-08 增强：每条建议带 confidence（置信度 0-1，数据新鲜度 × 直接性）
 * + evidence（证据链引用，前端可 hover 查看依据）——决策可信度可审计。
 *
 * 数据源：loadAllianceSnapshot（canonical 域模型）+ loadAllianceSurvey
 * （共享测绘冲突）+ loadLeaderboardIntel + loadAllianceIntel（raidRisk）。
 */
import { loadAllianceSnapshot } from "./alliance-snapshot.ts";
import { loadEnemyHeat } from "./enemy-heat.ts";
import { loadAllianceSurvey } from "./alliance-survey.ts";
import { loadLeaderboardIntel } from "./leaderboard.ts";
import { loadMinePatterns } from "./mine-patterns.ts";
import { loadMineUtilization } from "./mine-utilization.ts";
import { loadDecisionTrend } from "./decision-audit.ts";
import { loadHumanConflict } from "./human-conflict.ts";
import { loadAllianceExploration, type ResurveyTarget } from "./exploration-coverage.ts";
import { loadCoreTrailsFromSurveyDb } from "./trails.ts";
import { collectCoreThreats } from "./core-threats.ts";
import { loadMiningEffectiveness } from "./mining-effectiveness.ts";
import { TtlCache } from "./cache.ts";

export type AdviceSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";
export type AdviceCategory = "ECONOMY" | "MILITARY" | "THREAT" | "CONFLICT" | "INTEL";

/** 建议证据链条目（2026-08-08）：支撑建议的数据引用，前端可展示"依据"。 */
export interface AdviceEvidence {
  /** 证据类型：world（世界状态）/ sighting（目击）/ heat（热区）/ survey（共享测绘）/ leaderboard（排行榜）。 */
  type: "world" | "sighting" | "heat" | "survey" | "leaderboard" | "audit";
  tenant?: string;
  /** 引用标识（如矿格 / 玩家名 / chunk）。 */
  ref?: string;
  /** 证据年龄（tick 或秒，按类型）。 */
  ageTicks?: number;
}

export interface AllianceAdvice {
  severity: AdviceSeverity;
  category: AdviceCategory;
  tenant: string | null;
  title: string;
  detail: string;
  /** 建议动作（中文，可执行）。 */
  action: string;
  /** 排序权重（severity 内排序用）。 */
  weight: number;
  /** 置信度 0-1：数据新鲜度 × 直接性（世界状态 0.95+ / 目击 0.6-0.9 / 滞后聚合 0.6-0.7 / 排行榜 0.4-0.8）。 */
  confidence: number;
  /** 证据链：支撑本建议的数据引用（前端 hover 显示依据）。 */
  evidence: readonly AdviceEvidence[];
  at: string;
}

const ORDER: Record<AdviceSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, INFO: 3 };

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export interface AllianceAdvicePayload {
  generatedAt: string;
  advice: readonly AllianceAdvice[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    info: number;
  };
  /** 去重掉的重复建议条数（2026-08-08）：跨租户目击同一敌核/同格冲突会重复生成。 */
  dedupCount: number;
  /** 平均置信度（0-1，2026-08-08）：整体建议可信度一眼可读。 */
  avgConfidence: number;
  cachedAt: string;
}

const ADVICE_TTL_MS = 30_000;
const adviceCache = new TtlCache<AllianceAdvicePayload>(ADVICE_TTL_MS);

const LOW_RESOURCE_WARN = 10;
const NO_COMBAT_CORE_RADIUS = 24;
const clamp = (v: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, v));

/** 补测目标建议（2026-08-08，探索线输入）：已探索但观测过旧的 chunk 按陈旧度
 *  排序（refill 模型证伪后的替代勘探信号）——把"哪块旧观测区最该补测"提升为可执行
 *  建议（决策线可据此派 EXPLORE worker 定向补测）。纯函数，入参即测。 */
export function buildResurveyAdvice(resurveyTargets: readonly ResurveyTarget[]): AllianceAdvice[] {
  const out: AllianceAdvice[] = [];
  const byTenant = new Map<string, ResurveyTarget[]>();
  // 每租户先按陈旧度降序排（函数自洽，不依赖入参顺序），取最旧 3 块
  for (const t of resurveyTargets) {
    const list = byTenant.get(t.nearCoreOf) ?? [];
    list.push(t);
    byTenant.set(t.nearCoreOf, list);
  }
  for (const [t, all] of byTenant) {
    const list = all.slice().sort((a, b) => b.stalenessTicks - a.stalenessTicks).slice(0, 3);
    const top = list[0];
    const staleMax = list[0].stalenessTicks;
    // 陈旧度 ≥ 5000 tick 的旧观测区是数据新鲜度实质风险（资源可能已变/已采空），
    // 升 MEDIUM 避免被 15 条上限挤出面板；低陈旧 INFO 提示。
    out.push({
      severity: staleMax >= 5000 ? "MEDIUM" : "INFO",
      category: "INTEL",
      tenant: t,
      title: `${t} ${list.length} 块旧观测区待补测（陈旧 ${staleMax} tick）`,
      detail: `最旧 ${top.key}（距核 ${top.distChunks} chunk，t${top.lastSeenTick}）——refill 模型证伪后按陈旧度重测`,
      action: "派 EXPLORE worker 定向补测旧观测区（地图记忆刷新，资源可能已变）",
      weight: -staleMax,
      confidence: 0.7,
      evidence: [{ type: "survey", tenant: t, ref: `resurvey=${top.key} stale=${staleMax}` }],
      at: new Date().toISOString(),
    });
  }
  return out;
}

/** 金牌矿建议（2026-08-08，联盟共享记忆·值得守/抢）：audit/mines topMines——累计
 *  收益/采集次数 top 的矿是"黄金矿脉"，值得优先守护（防敌人抢）与持续采集。
 *  纯函数，入参即测。每租户取 byAmount 榜首（金额 >0），INFO 级（防 15 条上限挤占）。 */
export function buildGoldMineAdvice(
  tenants: Readonly<Record<string, { topMines?: { byAmount?: Array<{ cell?: unknown; x?: unknown; y?: unknown; harvestAmount?: unknown; harvestOk?: unknown; activity?: unknown }> } }>>,
): AllianceAdvice[] {
  const out: AllianceAdvice[] = [];
  for (const [t, x] of Object.entries(tenants)) {
    const top = x?.topMines?.byAmount?.[0];
    if (!top) continue;
    const amount = Number(top.harvestAmount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const cell = String(top.cell ?? "");
    if (!cell) continue;
    out.push({
      // 高价值矿脉 = 值得守/抢（战略资产，MEDIUM 防被 15 条上限挤出）
      severity: "MEDIUM",
      category: "INTEL",
      tenant: t,
      title: t + " 金牌矿 " + cell + "（累计收益 " + amount + "）",
      detail: "该矿累计采集 " + Number(top.harvestOk ?? 0) + " 次——高价值矿脉，值得守/抢",
      action: "优先派 worker 守护并持续采集；观察敌人是否觊觎（高价值目标）",
      // 战略资产锚点（2026-08-08 A16 修复）：金额通常个位数，weight=-amount 排不进
      // 15 条上限（被 MEDIUM/INFO 挤掉）——加权 -amount*100-1000 保证同 severity 靠前，
      // 且金额大的矿仍相对优先。
      weight: -(amount * 100 + 1000),
      confidence: 0.75,
      evidence: [{ type: "survey", tenant: t, ref: "gold=" + cell + " amount=" + amount }],
      at: new Date().toISOString(),
    });
  }
  return out;
}

export function loadAllianceAdvice(): AllianceAdvicePayload {
  const hit = adviceCache.get("latest");
  if (hit !== undefined) return hit;
  let out: AllianceAdvice[] = [];
  const snap = loadAllianceSnapshot();
  const survey = loadAllianceSurvey();
  const lb = loadLeaderboardIntel();

  // 1) 经济：成员资源濒危（世界状态实时，置信度最高）
  for (const m of Object.values(snap.members)) {
    if (m.resources < LOW_RESOURCE_WARN) {
      out.push({
        severity: m.resources < 5 ? "CRITICAL" : "HIGH",
        category: "ECONOMY",
        tenant: m.tenantId,
        title: `${m.tenantId} 核心资源 ${m.resources} 濒危`,
        detail: `人口 ${m.population}（工${m.workers}/锋${m.vanguards}/射${m.rangers}），携带 ${m.carriedResources}`,
        action: m.resources < 5 ? "立即清点满载 worker 卸货/迁移路线；资源低于 5 无法产兵" : "安排采集优先，暂停非必要 spawn",
        weight: -m.resources,
        confidence: m.resources < 3 ? 0.98 : m.resources < 5 ? 0.95 : 0.9,
        evidence: [{ type: "world", tenant: m.tenantId, ref: `res=${m.resources} pop=${m.population}` }],
        at: new Date().toISOString(),
      });
    }
  }

  // 2) 军事：无战斗单位且敌核邻近（raid-defense 空窗）——纯快照数据
  //    （survey-db 敌核 + 成员核心位置），不依赖 intel 扫描。置信度按最近目击新鲜度。
  const manhattan = (a: readonly number[], b: readonly number[]): number =>
    Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  for (const m of Object.values(snap.members)) {
    if (m.vanguards + m.rangers > 0) continue;
    if (!m.core) continue;
    const near = snap.sightings.filter(
      (s) => s.kind === "CORE" && manhattan(s.position, m.core!.position) <= NO_COMBAT_CORE_RADIUS,
    );
    if (near.length > 0) {
      const maxAge = Math.max(...near.map((s) => snap.currentTick - s.lastSeenTick));
      out.push({
        severity: "CRITICAL",
        category: "MILITARY",
        tenant: m.tenantId,
        title: `${m.tenantId} 零战斗单位且敌核邻近`,
        detail: `${near.length} 个敌核 ≤${NO_COMBAT_CORE_RADIUS} 格（${near.map((s) => s.ownerUsername ?? s.entityId ?? "?").join("/")}）`,
        action: "守家优先：产 Vanguard 或远端军事回援；worker 召回半径扩大",
        weight: -near.length,
        confidence: Math.round(clamp(0.85 - maxAge / 4000) * 100) / 100,
        evidence: near.map((s) => ({
          type: "sighting" as const,
          tenant: s.sourceTenant,
          ref: s.ownerUsername ?? s.entityId ?? "?",
          ageTicks: snap.currentTick - s.lastSeenTick,
        })),
        at: new Date().toISOString(),
      });
    }
  }

  // 2.5) 敌情高浓度区接近核心（units_seen 热区，跨 run 敌情记忆；滞后聚合置信度中）
  const heat = loadEnemyHeat("all");
  const HEAT_COMBAT_THRESHOLD = 50;
  const HEAT_NEAR_CHUNKS = 3;
  for (const m of Object.values(snap.members)) {
    if (!m.core) continue;
    const cxb = Math.floor(m.core.position[0] / 16);
    const cyb = Math.floor(m.core.position[1] / 16);
    const near = heat.buckets.filter(
      (b) => b.combatCount >= HEAT_COMBAT_THRESHOLD
        && Math.max(Math.abs(b.bx - cxb), Math.abs(b.by - cyb)) <= HEAT_NEAR_CHUNKS,
    );
    if (near.length > 0) {
      const top = near.sort((a, b) => b.combatCount - a.combatCount)[0];
      const age = heat.currentTick - top.lastTick;
      out.push({
        severity: "HIGH",
        category: "THREAT",
        tenant: m.tenantId,
        title: `${m.tenantId} 核心附近敌情高浓度区`,
        detail: `(chunk ${top.bx},${top.by}) 累计 ${top.combatCount} 条敌战斗目击（最近 ${age} tick 前）`,
        action: "该区域敌方活动密集——守家 + 侦察，避免 worker 裸采经过",
        weight: -top.combatCount,
        confidence: Math.round(clamp(0.7 - age / 6000) * 100) / 100,
        evidence: [{ type: "heat", tenant: m.tenantId, ref: `chunk ${top.bx},${top.by}`, ageTicks: age }],
        at: new Date().toISOString(),
      });
    }
  }

  // 3) 威胁：每租户高威胁扇区（threat-summary）
  for (const ts of snap.threatSummaries) {
    if (ts.highDirections.length === 0) continue;
    out.push({
      severity: ts.totalScore > 10 ? "HIGH" : "MEDIUM",
      category: "THREAT",
      tenant: ts.tenantId,
      title: `${ts.tenantId} 威胁集中 ${ts.highDirections.join("/")}（总分 ${ts.totalScore.toFixed(1)}）`,
      detail: ts.multiDirectionPressure ? "多方向压力，注意分兵" : "单方向集中威胁",
      action: ts.multiDirectionPressure ? "核心迁移/防御需防多面夹击" : "面向高威胁扇区布防或撤离",
      weight: -ts.totalScore,
      confidence: 0.8,
      evidence: [{ type: "sighting", tenant: ts.tenantId, ref: `dir=${ts.highDirections.join("+")}` }],
      at: new Date().toISOString(),
    });
  }

  // 4) 高威胁玩家核心目击（排行榜先验 + snapshot 敌核，纯快照数据）
  const tierRank: Record<string, number> = { ELITE_AGGRESSOR: 0, AGGRESSOR: 1 };
  const tierByUser = new Map<string, string>((lb?.profiles ?? []).map((p) => [p.username, p.tier]));
  const tierOf = (username: string): string => tierByUser.get(username) ?? "";
  for (const s of snap.sightings) {
    if (s.kind !== "CORE" || !s.ownerUsername) continue;
    const tier = tierOf(s.ownerUsername);
    if (!(tier in tierRank)) continue;
    const age = snap.currentTick - s.lastSeenTick;
    if (age > 500) continue; // 只关注近期目击
    out.push({
      severity: tier === "ELITE_AGGRESSOR" ? "HIGH" : "MEDIUM",
      category: "INTEL",
      tenant: s.sourceTenant,
      title: `${tier === "ELITE_AGGRESSOR" ? "猛攻蛆" : "攻击者"} ${s.ownerUsername} 核心目击（t${age} tick 前）`,
      detail: `由 ${s.sourceTenant} 目击 @${s.position.join(",")}`,
      action: "提升戒备：守家 + 观察其动向",
      weight: age,
      confidence: Math.round(clamp(0.95 - age / 500) * 100) / 100,
      evidence: [{ type: "sighting", tenant: s.sourceTenant, ref: s.ownerUsername, ageTicks: age }],
      at: new Date().toISOString(),
    });
  }

  // 5) 抢矿冲突（共享测绘，滞后聚合置信度中低）
  for (const o of survey.conflicts.resourceOverlaps) {
    const tenants = String(o.tenants);
    out.push({
      severity: "MEDIUM",
      category: "CONFLICT",
      tenant: null,
      title: `跨租户抢矿 ${String(o.cell)}`,
      detail: `${tenants} 同格矿重叠（各 ${String(o.states)}，最后目击 ${String(o.lastSeenTicks)}）`,
      action: "保留最新目击租户，其余租户该矿记忆标记 stale/仲裁",
      weight: 0,
      confidence: 0.6,
      evidence: [{ type: "survey", tenant: String(o.tenants), ref: `cell ${String(o.cell)}` }],
      at: new Date().toISOString(),
    });
  }

  // 6) 排行榜基线提示（只有最近快照才提示；快照陈旧则置信度下降）
  if (lb && (lb.profiles ?? []).length > 0) {
    const elites = (lb.profiles ?? []).filter((p) => p.tier === "ELITE_AGGRESSOR").slice(0, 5);
    if (elites.length > 0) {
      out.push({
        severity: "INFO",
        category: "INTEL",
        tenant: null,
        title: `排行榜猛攻蛆 ${elites.length} 名（伤害 top10）`,
        detail: elites.map((p) => `${p.username}(${p.damage})`).join(" "),
        action: "高伤害玩家可能猛攻——联盟威胁场已加先验，注意近期目击",
        weight: 0,
        confidence: lb.stale ? 0.4 : 0.8,
        evidence: [{ type: "leaderboard", ref: elites.map((p) => p.username).join("/"), ageTicks: lb.ageSeconds }],
        at: new Date().toISOString(),
      });
    }
  }

  // 7) 矿活性采集机会（2026-08-08，mine-patterns 算法闭环到决策）：租户资源低于
  //    采集机会阈值且有活跃矿（visible > 0）——提示"值得去采的矿"（与资源濒危
  //    警报互补：濒危是问题，这里给行动指引）。INFO 级，置信度 0.75（survey-db 缓存）。
  const MINE_OPPORTUNITY_RESOURCE = 15;
  const mp = loadMinePatterns("all");
  for (const m of Object.values(snap.members)) {
    const pat = mp.tenants[m.tenantId];
    if (!pat || pat.visible === 0) continue;
    if (m.resources >= MINE_OPPORTUNITY_RESOURCE) continue;
    const top = pat.topActive[0];
    out.push({
      severity: "INFO",
      category: "ECONOMY",
      tenant: m.tenantId,
      title: `${m.tenantId} ${pat.visible} 个活跃矿可采`,
      detail: top ? `最近活跃 ${top.cell}（seen ${top.seenCount}，t${top.lastSeenTick}）等` : "活跃矿可派 worker 采集",
      action: "优先派 worker 采活跃矿（mine-patterns 推荐）；资源低于 15 补采集",
      weight: -pat.visible,
      confidence: 0.75,
      evidence: [{ type: "survey", tenant: m.tenantId, ref: `active=${pat.visible} top=${top?.cell ?? "-"}` }],
      at: new Date().toISOString(),
    });
  }

  // 8) 数据层审计建议（2026-08-08，综合决策到参谋建议）：把审计端点的量化信号
  //    （发现-利用缺口 / 核心负增长趋势 / 决策空转 / 手操冲突）提升为可执行建议——
  //    与 mine-patterns #7 互补（#7 是机会，这里是问题/差距）。证据 type=audit。
  try {
    const mu = loadMineUtilization("all");
    for (const m of Object.values(snap.members)) {
      const t = m.tenantId;
      const visNever = mu.tenants[t]?.visibleNever ?? 0;
      if (visNever >= 10) {
        out.push({
          severity: "HIGH",
          category: "ECONOMY",
          tenant: t,
          title: `${t} ${visNever} 个可见矿从未开采`,
          detail: `已发现未开采（分配缺口）——联盟分工已就近分配，见 audit/mines`,
          action: "优先派 worker 采可见未开采矿（alliance/mining 候选格）",
          weight: -visNever,
          confidence: 0.85,
          evidence: [{ type: "audit", tenant: t, ref: `visibleNever=${visNever}` }],
          at: new Date().toISOString(),
        });
      }
    }
    // 决策趋势（最新窗口）：负增长 / 高空转
    for (const m of Object.values(snap.members)) {
      const t = m.tenantId;
      const trend = loadDecisionTrend(t, 500, 4);
      const last = trend.trend[trend.trend.length - 1];
      if (!last) continue;
      if (last.coreDelta < 0) {
        out.push({
          severity: "HIGH",
          category: "ECONOMY",
          tenant: t,
          title: `${t} 最近窗口核心负增长 ${last.coreDelta}`,
          detail: `t${last.tick} 窗口 coreDelta ${last.coreDelta}（cargo ${last.cargoEff === null ? "-" : (last.cargoEff * 100).toFixed(0)}%）`,
          action: "检查满载率/交付失败/手操干扰；按 audit/decisions 归因",
          weight: -last.coreDelta,
          confidence: 0.8,
          evidence: [{ type: "audit", tenant: t, ref: `coreDelta=${last.coreDelta} tick=${last.tick}` }],
          at: new Date().toISOString(),
        });
      }
      if (last.stallRate !== null && last.stallRate >= 0.9) {
        out.push({
          severity: "MEDIUM",
          category: "ECONOMY",
          tenant: t,
          title: `${t} 决策空转 ${Math.round(last.stallRate * 100)}%`,
          detail: `最近窗口 wait 主导（停摆 tick 占比）——目标链/搬运需优化`,
          action: "commit 目标到矿格（修 planChurn）；校验障碍挡路",
          weight: Math.round(last.stallRate * 100),
          confidence: 0.75,
          evidence: [{ type: "audit", tenant: t, ref: `stallRate=${last.stallRate}` }],
          at: new Date().toISOString(),
        });
      }
    }
    // 手操冲突（拒绝率）
    const hc = loadHumanConflict("all") as Record<string, { rejectedRate: number | null }>;
    for (const m of Object.values(snap.members)) {
      const t = m.tenantId;
      const rate = hc[t]?.rejectedRate ?? 0;
      if (rate >= 0.3) {
        out.push({
          severity: "MEDIUM",
          category: "CONFLICT",
          tenant: t,
          title: `${t} 手操拒绝率 ${Math.round(rate * 100)}%`,
          detail: "手操指令被 agent 端拒绝（常见：核心移动中）——UI 应即时反馈",
          action: "核心移动中指令已被 guard 拦截（409）；UI 显示拒绝原因",
          weight: Math.round(rate * 100),
          confidence: 0.7,
          evidence: [{ type: "audit", tenant: t, ref: `rejectedRate=${rate}` }],
          at: new Date().toISOString(),
        });
      }
    }
    // 分工兑现（2026-08-08，闭环执行反馈）：alliance/mining 分了但没采到 →
    // 按兑现状态分级建议（全失效 HIGH / 全在途 MEDIUM / 部分兑现 INFO）。证据 type=audit。
    const me = loadMiningEffectiveness();
    for (const m of Object.values(snap.members)) {
      const t = m.tenantId;
      const e = me.perTenant?.[t];
      if (!e || e.assigned < 5) continue;
      const staleOnly = e.stale > 0 && e.harvested === 0;
      const openOnly = e.harvested === 0 && e.open > 0;
      if (staleOnly) {
        out.push({
          severity: "HIGH", category: "ECONOMY", tenant: t,
          title: `${t} 分工 ${e.assigned} 矿兑现失效（${e.stale} 失效/0 采到）`,
          detail: "已闭环但全失效——分配距离/路径/承载与就近模型不符",
          action: "按 alliance/mining 换就近观测者重分配；校验 worker 路径障碍",
          weight: e.assigned, confidence: 0.8,
          evidence: [{ type: "audit", tenant: t, ref: `assigned=${e.assigned} stale=${e.stale}` }],
          at: new Date().toISOString(),
        });
      } else if (openOnly) {
        out.push({
          severity: "MEDIUM", category: "ECONOMY", tenant: t,
          title: `${t} 分工 ${e.assigned} 矿 0 兑现（${e.open} 在途）`,
          detail: "联盟就近分配尚未被采集——分配未兑现，需真正派 worker",
          action: "派 worker 到分工候选格（alliance/mining）；下轮看兑现率",
          weight: e.assigned, confidence: 0.75,
          evidence: [{ type: "audit", tenant: t, ref: `assigned=${e.assigned} open=${e.open} progress=${e.progressRate}` }],
          at: new Date().toISOString(),
        });
      } else if (e.harvested > 0) {
        out.push({
          severity: "INFO", category: "ECONOMY", tenant: t,
          title: `${t} 分工兑现中（${e.harvested}/${e.assigned} 采到）`,
          detail: `已采 ${e.harvested} / 在途 ${e.open} / 失效 ${e.stale}——闭环中`,
          action: "保持派 worker；失效格按联盟重分配",
          weight: -e.harvested, confidence: 0.7,
          evidence: [{ type: "audit", tenant: t, ref: `harvested=${e.harvested}/${e.assigned} progress=${e.progressRate}` }],
          at: new Date().toISOString(),
        });
      }
    }
  } catch { /* 审计数据不可用不阻断建议 */ }

  // 9) 补测目标（2026-08-08，探索线输入）：已探索但观测过旧的 chunk 按陈旧度
  //    排序（refill 模型证伪后的替代勘探信号）——把"哪块旧观测区最该补测"提升为
  //    可执行建议（决策线可据此派 EXPLORE worker 定向补测）。读 exploration 30s 缓存。
  try {
    out.push(...buildResurveyAdvice(loadAllianceExploration().resurveyTargets));
  } catch { /* 探索数据缺失不阻断 */ }

  // 10) 金牌矿（2026-08-08，联盟共享记忆·值得守/抢）：audit/mines topMines byAmount 榜首
  //     ——高价值矿脉值得优先守护与持续采集（读 30s 缓存，无触网）。
  try {
    const mu2 = loadMineUtilization("all");
    out.push(...buildGoldMineAdvice(mu2.tenants));
  } catch { /* 矿利用数据不可用不阻断 */ }

  // 11) 敌核逼近/近距目击（2026-08-08，算法适配·raid-defense 输入）：core_hunts 历史
  //     轨迹 → collectCoreThreats 提炼结构化威胁（approaching 半径 60 /
  //     proximity 半径 40，stale 降 INFO 防幽灵威胁占槽）——每租户 cap 3 转建议。
  try {
    const PER_TENANT_THREAT_CAP = 3; // 每租户最多 3 条，防刷屏
    for (const [t, m] of Object.entries(snap.members)) {
      const friendlyCore = m.core?.position ?? null;
      if (!friendlyCore) continue;
      const threats: AllianceAdvice[] = [];
      // minPoints=1：单点目击也保留（近距威胁主体恰是单点，方向未知走 proximity 兕底）
      for (const ct of collectCoreThreats(loadCoreTrailsFromSurveyDb(t, 48, 1), friendlyCore, m.tick)) {
        const dist = ct.distCells;
        if (ct.kind === "approaching") {
          threats.push({
            severity: dist < 30 ? "HIGH" : "MEDIUM",
            category: "THREAT",
            tenant: t,
            title: t + " 敌核逼近（" + ct.username + " 距 " + dist + " 格）",
            detail: "敌核 " + ct.username + " 正朝友核移动：距 " + dist + " 格，速度 "
              + (ct.speedCellsPerTick ?? 0).toFixed(2) + " 格/tick，最近目击 " + ct.x + "," + ct.y,
            action: dist < 30
              ? "高威胁：立即预备拦截/转移核心，别让敌核贴近"
              : "提高警觉，向逼近方向预部署防守兵力",
            weight: -dist,
            confidence: 0.7,
            evidence: [{ type: "sighting", tenant: t, ref: "core_hunts " + ct.username + " @" + ct.x + "," + ct.y + " tick=" + ct.lastSeenTick }],
            at: new Date().toISOString(),
          });
        } else {
          // 陈旧目击（可能已离开）统一 INFO：幽灵威胁不占 HIGH/MEDIUM 高槽位
          threats.push({
            severity: ct.stale ? "INFO" : dist < 15 ? "HIGH" : dist < 25 ? "MEDIUM" : "INFO",
            category: "THREAT",
            tenant: t,
            title: t + " 敌核近距目击（" + ct.username + " 距 " + dist + " 格）",
            detail: "敌核 " + ct.username + " 最近目击距友核 " + dist + " 格"
              + (ct.stale ? "（" + Math.max(0, m.tick - ct.lastSeenTick) + " tick 前，可能已离开）" : "（方向待确认，建议侦察）")
              + " @" + ct.x + "," + ct.y,
            action: ct.stale
              ? "派侦察确认该方向敌核是否仍在；若已离开则移出威胁清单"
              : "就近侦察 + 预备防御；若再次目击确认逼近则升级拦截",
            weight: -dist,
            confidence: ct.stale ? 0.4 : 0.6,
            evidence: [{ type: "sighting", tenant: t, ref: "core_hunts " + ct.username + " @" + ct.x + "," + ct.y + " tick=" + ct.lastSeenTick }],
            at: new Date().toISOString(),
          });
        }
      }
      threats.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.weight - b.weight);
      out.push(...threats.slice(0, PER_TENANT_THREAT_CAP));
    }
  } catch { /* 敌核轨迹不可用不阻断 */ }

  out.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.weight - b.weight);
  // 2026-08-08 建议去重：同一 (category, tenant, title) 只保留一条（跨租户目击
  // 同一敌核/同格冲突/多租户同态建议会重复生成，面板叠罗汉）。sort 后取首条
  // = severity 最高、weight 最小者。
  const seen = new Set<string>();
  const deduped: AllianceAdvice[] = [];
  for (const a of out) {
    const key = `${a.category}|${a.tenant ?? "all"}|${a.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(a);
  }
  const dedupCount = out.length - deduped.length;
  out = deduped;
  const shown = out.slice(0, 15);
  const avgConfidence = shown.length > 0
    ? Math.round((shown.reduce((acc, a) => acc + a.confidence, 0) / shown.length) * 100) / 100
    : 0;
  const payload: AllianceAdvicePayload = {
    generatedAt: new Date().toISOString(),
    advice: shown,
    dedupCount,
    avgConfidence,
    summary: {
      critical: out.filter((a) => a.severity === "CRITICAL").length,
      high: out.filter((a) => a.severity === "HIGH").length,
      medium: out.filter((a) => a.severity === "MEDIUM").length,
      info: out.filter((a) => a.severity === "INFO").length,
    },
    cachedAt: new Date().toISOString(),
  };
  adviceCache.set("latest", payload);
  return payload;
}

/** 后台预热。 */
export function refreshAllianceAdvice(): void {
  loadAllianceAdvice();
}