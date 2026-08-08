/**
 * 联盟联防圈兵力协同建议（2026-08-08，抱团 Phase 2 决策支持层）。
 *
 * 定位：cluster（观测层）回答"谁跟谁抱团"；本模块回答"谁濒危、谁能救、
 * 阵型紧不紧"——把兵力 + 威胁 + 核心分布综合成可执行联防建议。
 * 纯函数、无 I/O、确定性（同输入同输出）。数据来自联盟快照成员（兵力/核心/
 * 状态）+ 威胁摘要（8 扇区 totalScore）+ 可选集群视图。
 *
 * 四类建议：
 *  1. ENDANGERED：核心被打爆重生中（CRITICAL）或军事≤1 + 威胁高（HIGH）——濒危预警；
 *  2. REINFORCE：濒危租户的最近军事冗余邻居（≥2 战斗单位、距离<400）——驰援推荐；
 *  3. FORMATION：全联盟核心两两核距中位数——阵型紧凑度（三角态势评估）。
 */
import type { Position } from "./alliance/types.ts";

export type DefenseCategory = "ENDANGERED" | "REINFORCE" | "FORMATION" | "POCKET";
export type DefenseSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";

export interface DefenseMemberInput {
  readonly tenantId: string;
  readonly core: Position | null;
  /** 战斗单位数（VANGUARD + RANGER）。 */
  readonly military: number;
  readonly status: string;
  /** 威胁摘要 totalScore（无则 0）。 */
  readonly threatScore?: number;
  /** 高威胁扇区方向（threatSummaries.highDirections，8 向 N/NE/E/SE/S/SW/W/NW）。 */
  readonly threatDirections?: readonly string[];
  /** 附近敌单位数（threatSummaries sectors entityCount 总和，无则 0）。 */
  readonly threatCount?: number;
}

/** 建议驰援编成：按濒危方敌单位数 × 1.5 安全系数定战斗单位数（至少 2），
 *  不超过援方冗余（military - 1 留 1 守家）；敌 ≥5 时配 Ranger 追击。 */
export function suggestedRaidForce(enemyCount: number, allySurplus: number): { vanguard: number; ranger: number } | null {
  if (allySurplus <= 0) return null;
  const want = Math.max(2, Math.ceil(enemyCount * 1.5));
  const send = Math.min(want, allySurplus);
  if (send <= 0) return null;
  const ranger = send >= 5 ? Math.min(2, Math.floor(send / 3)) : 0;
  return { vanguard: send - ranger, ranger };
}

/** 敌核目击（来自联盟快照 CORE sightings——共享测绘敌核记忆）。 */
export interface PocketEnemyCore {
  readonly key: string;
  readonly owner: string | undefined;
  readonly position: Position;
  readonly lastSeenTick: number;
}

/** POCKET 聚类配置。 */
export interface PocketConfig {
  /** 敌核聚类连接距离（Chebyshev）：≤ 此距离视为同一敌核群。 */
  readonly clusterDist?: number;
  /** 威胁半径：敌核距租户核心 ≤ 此距离视为威胁该租户。 */
  readonly threatRadius?: number;
}

export const DEFAULT_POCKET_CONFIG: Readonly<Required<PocketConfig>> = Object.freeze({
  clusterDist: 120,   // 与 alliance-cluster CLUSTER_LINK_DIST 同口径
  threatRadius: 200,  // 敌核距核心 200 格内即威胁（Vanguard 行军 2-3 tick 可及）
});

/** 联防圈（POCKET）：敌核群聚类 + 威胁租户判定——纯函数、确定性。
 *  敌核按 Chebyshev ≤ clusterDist 贪心连通分组；每簇被"簇内最近敌核距租户核心
 *  ≤ threatRadius"的租户威胁；威胁租户 ≥2 → 联防圈（多租户核心夹缝中的敌核群）。 */
export function buildDefensePockets(
  members: readonly { readonly tenantId: string; readonly core: Position | null }[],
  enemyCores: readonly PocketEnemyCore[],
  config: PocketConfig = {},
): DefensePocket[] {
  const { clusterDist, threatRadius } = { ...DEFAULT_POCKET_CONFIG, ...config };
  const cores = enemyCores.filter((c) => Number.isFinite(c.position[0]) && Number.isFinite(c.position[1]));
  const groups: Array<{ enemy: PocketEnemyCore[] }> = [];
  for (const c of cores) {
    let merged = false;
    for (const g of groups) {
      const near = g.enemy.some((e) => chebyshev(e.position, c.position) <= clusterDist);
      if (near) {
        g.enemy.push(c);
        merged = true;
        break;
      }
    }
    if (!merged) groups.push({ enemy: [c] });
  }
  const out: DefensePocket[] = [];
  for (const g of groups) {
    if (g.enemy.length < 2) continue; // 单敌核不构成"群"
    const cx = g.enemy.reduce((n, e) => n + e.position[0], 0) / g.enemy.length;
    const cy = g.enemy.reduce((n, e) => n + e.position[1], 0) / g.enemy.length;
    const threatened: Array<{ tenantId: string; minDist: number }> = [];
    for (const m of members) {
      if (!m.core) continue;
      const minDist = Math.min(...g.enemy.map((e) => chebyshev(m.core as Position, e.position)));
      if (minDist <= threatRadius) threatened.push({ tenantId: m.tenantId, minDist });
    }
    if (threatened.length < 2) continue;
    out.push({
      id: `pocket:${g.enemy.map((e) => e.key).sort().join("+")}`,
      centroid: [Math.round(cx), Math.round(cy)],
      enemyCores: g.enemy.map((e) => ({ owner: e.owner, position: e.position })),
      threatenedTenants: threatened.map((t) => t.tenantId),
      minDistance: Math.min(...threatened.map((t) => t.minDist)),
    });
  }
  return out;
}

/** POCKET 联防圈建议（纯函数）：敌核群威胁 ≥2 租户 → 协同设防/收缩。 */
export function buildDefensePocketAdvice(
  members: readonly { readonly tenantId: string; readonly core: Position | null }[],
  enemyCores: readonly PocketEnemyCore[],
  config: PocketConfig = {},
): DefenseAdvice[] {
  return buildDefensePockets(members, enemyCores, config).map((p) => ({
    id: `defense:pocket:${p.id}`,
    category: "POCKET",
    severity: "MEDIUM",
    title: `联防圈：${p.threatenedTenants.map((t) => t.toUpperCase()).join("/")} 之间的敌核群`,
    detail: `${p.enemyCores.length} 个敌核（中心 ${p.centroid[0]},${p.centroid[1]}）威胁 ${p.threatenedTenants.map((t) => t.toUpperCase()).join("/")}（最近 ${p.minDistance} 格）——建议协同设防或收缩核心避其锋芒`,
    tenant: p.threatenedTenants[0],
    relatedTenants: p.threatenedTenants,
    evidence: [
      { label: "敌核", value: p.enemyCores.map((e) => e.owner ?? "?").join("、") },
      { label: "中心", value: `${p.centroid[0]},${p.centroid[1]}` },
      { label: "最近核距", value: `${p.minDistance} 格` },
    ],
  }));
}

export interface DefenseAdvice {
  readonly id: string;
  readonly category: DefenseCategory;
  readonly severity: DefenseSeverity;
  readonly title: string;
  readonly detail: string;
  readonly tenant: string;
  readonly relatedTenants: readonly string[];
  readonly evidence: readonly { readonly label: string; readonly value: string }[];
}

export interface DefensePocket {
  readonly id: string;
  readonly centroid: Position;
  readonly enemyCores: readonly { readonly owner: string | undefined; readonly position: Position }[];
  readonly threatenedTenants: readonly string[];
  /** 簇到最近被威胁租户核心的距离（Chebyshev）。 */
  readonly minDistance: number;
}

export interface DefensePayload {
  readonly generatedAtMs: number;
  readonly advice: readonly DefenseAdvice[];
  readonly endangered: readonly { readonly tenantId: string; readonly military: number; readonly threatScore: number }[];
  readonly pockets: readonly DefensePocket[];
}

/** 濒危军事上限：≤1 战斗单位视为军事薄弱（无防御反击能力）。
 *  military=0 无条件濒危（无兵即无法防御/无法快速补防，不能等威胁逼近才预警）。 */
export const ENDANGERED_COMBAT_MAX = 1;
/** 濒危威胁分阈值：8 扇区 totalScore ≥ 此值且军事薄弱 → 濒危。 */
export const ENDANGERED_THREAT_MIN = 6;
/** 驰援距离阈值（Chebyshev）：超过此距离驰援来不及（核心被围 400 格外鞭长莫及）。 */
export const REINFORCE_RANGE = 400;
/** 驰援兵力下限：邻居需 ≥2 战斗单位可调配。 */
export const REINFORCE_COMBAT_MIN = 2;
/** 阵型紧凑度分档（Chebyshev 中位）：<120 紧凑 / <300 松散 / ≥300 离散。 */
export const FORMATION_TIGHT_MAX = 120;
export const FORMATION_LOOSE_MAX = 300;

function chebyshev(a: Position, b: Position): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

const SEV_ORDER: Record<DefenseSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, INFO: 3 };

function endangeredOf(m: DefenseMemberInput): { endangered: boolean; reason: string } {
  if (m.status === "RESPAWNING") return { endangered: true, reason: "respawn" };
  if (m.military === 0) return { endangered: true, reason: "zero" }; // 零军事无条件濒危
  if (m.military <= ENDANGERED_COMBAT_MAX && (m.threatScore ?? 0) >= ENDANGERED_THREAT_MIN) {
    return { endangered: true, reason: "weak" };
  }
  return { endangered: false, reason: "" };
}

/** 从 A 指向 B 的 8 向扇区（与 threat-summary.threatDirection 同构——
 *  dy>0 = 北，dy<0 = 南；<3 格视为同点 "C"）。 */
export function directionOf(a: Position, b: Position): string {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < 3 && ay < 3) return "C";
  if (ax * 2 < ay) return dy > 0 ? "N" : "S";
  if (ay * 2 < ax) return dx > 0 ? "E" : "W";
  if (dx > 0 && dy > 0) return "NE";
  if (dx > 0 && dy < 0) return "SE";
  if (dx < 0 && dy < 0) return "SW";
  return "NW";
}

/** 联盟联防建议（纯函数）。 */
export function buildDefenseCoordination(members: readonly DefenseMemberInput[]): DefensePayload {
  const advice: DefenseAdvice[] = [];
  const endangered: Array<{ tenantId: string; military: number; threatScore: number }> = [];
  const byId = new Map(members.map((m) => [m.tenantId, m]));
  const statusOf = (t: string): string => byId.get(t)?.status ?? "";
  const coreOf = (t: string): Position | null => byId.get(t)?.core ?? null;

  // 1) 濒危识别
  for (const m of members) {
    const { endangered: isEnd, reason } = endangeredOf(m);
    if (!isEnd) continue;
    endangered.push({ tenantId: m.tenantId, military: m.military, threatScore: m.threatScore ?? 0 });
    if (reason === "respawn") {
      advice.push({
        id: `defense:endangered:${m.tenantId}:respawn`,
        category: "ENDANGERED",
        severity: "CRITICAL",
        title: `${m.tenantId.toUpperCase()} 核心被打爆重生中`,
        detail: `新核心区军事=0，敌人可能乘胜追击——联盟需协防新核心或立即补 Vanguard`,
        tenant: m.tenantId,
        relatedTenants: [],
        evidence: [{ label: "状态", value: "RESPAWNING" }, { label: "军事", value: String(m.military) }],
      });
    } else if (reason === "zero") {
      // 零军事：无防御反击能力，任何威胁逼近都打爆（t3 73094 实证）——无条件预警。
      advice.push({
        id: `defense:endangered:${m.tenantId}:zero`,
        category: "ENDANGERED",
        severity: (m.threatScore ?? 0) >= ENDANGERED_THREAT_MIN ? "CRITICAL" : "HIGH",
        title: `${m.tenantId.toUpperCase()} 零军事——无防御反击能力`,
        detail: `军事=0${(m.threatScore ?? 0) > 0 ? `、威胁分=${m.threatScore}` : ""}——建议立即补 Vanguard（防御是底线，不能等威胁逼近）`,
        tenant: m.tenantId,
        relatedTenants: [],
        evidence: [{ label: "军事", value: "0" }, { label: "威胁分", value: String(m.threatScore ?? 0) }],
      });
    } else {
      advice.push({
        id: `defense:endangered:${m.tenantId}:weak`,
        category: "ENDANGERED",
        severity: (m.threatScore ?? 0) >= 10 ? "CRITICAL" : "HIGH",
        title: `${m.tenantId.toUpperCase()} 军事薄弱且受威胁`,
        detail: `军事=${m.military}、威胁分=${m.threatScore ?? 0}——建议立即补 Vanguard 或向盟友收缩`,
        tenant: m.tenantId,
        relatedTenants: [],
        evidence: [{ label: "军事", value: String(m.military) }, { label: "威胁分", value: String(m.threatScore ?? 0) }],
      });
    }
  }

  // 2) 驰援推荐：濒危租户的最近军事冗余邻居
  const endangeredIds = new Set(endangered.map((e) => e.tenantId));
  for (const e of endangered) {
    const ec = coreOf(e.tenantId);
    if (!ec) continue;
    let best: { tenantId: string; dist: number; military: number; nc: Position | null } | null = null;
    for (const n of members) {
      if (n.tenantId === e.tenantId || endangeredIds.has(n.tenantId)) continue;
      if (n.military < REINFORCE_COMBAT_MIN) continue;
      const nc = n.core;
      if (!nc) continue;
      const dist = chebyshev(ec, nc);
      if (dist > REINFORCE_RANGE) continue;
      if (best === null || dist < best.dist) best = { tenantId: n.tenantId, dist, military: n.military, nc };
    }
    if (best) {
      // 威胁方位投影（Phase 2 深化）：援军相对濒危核心的方位，是否落在威胁锋面侧。
      const threatDirs = byId.get(e.tenantId)?.threatDirections ?? [];
      const flankDir = best.nc ? directionOf(ec, best.nc) : null;
      const onFlank = flankDir !== null && flankDir !== "C" && threatDirs.includes(flankDir);
      const flankNote = threatDirs.length > 0 && flankDir !== null
        ? (onFlank
            ? `；注意 ${best.tenantId.toUpperCase()} 位于威胁锋面（${threatDirs.join("/")}）侧——驰援需绕行或先清剿`
            : `；${best.tenantId.toUpperCase()} 从 ${flankDir} 侧进入可避开威胁锋面（${threatDirs.join("/")}）`)
        : "";
      // 驰援编成量化（Phase 2 深化）：按濒危方敌单位数 × 1.5 定编成，不超过援方冗余。
      const enemyCount = byId.get(e.tenantId)?.threatCount ?? 0;
      const force = suggestedRaidForce(enemyCount, Math.max(0, best.military - 1));
      const forceNote = force
        ? `——建议编成 ${force.vanguard} Vanguard${force.ranger > 0 ? ` + ${force.ranger} Ranger` : ""}${enemyCount > 0 ? `（对应敌 ${enemyCount} 单位）` : "（防御底线）"}`
        : "";
      advice.push({
        id: `defense:reinforce:${best.tenantId}:${e.tenantId}`,
        category: "REINFORCE",
        severity: "HIGH",
        title: `${best.tenantId.toUpperCase()} 可驰援 ${e.tenantId.toUpperCase()}`,
        detail: `距 ${best.dist} 格、${best.military} 战斗单位可调配——濒危租户 ${e.tenantId.toUpperCase()} 需外援${forceNote}${flankNote}`,
        tenant: best.tenantId,
        relatedTenants: [e.tenantId],
        evidence: [
          { label: "核距", value: `${best.dist} 格` },
          { label: "可调配", value: `${best.military} 战斗单位` },
          { label: "濒危方", value: e.tenantId.toUpperCase() },
          ...(flankDir ? [{ label: "援军方位", value: flankDir }] : []),
          ...(force ? [{ label: "建议编成", value: `${force.vanguard}V${force.ranger > 0 ? `+${force.ranger}R` : ""}` }] : []),
        ],
      });
    }
  }

  // 3) 阵型紧凑度（三角态势评估）
  const cores: Array<{ tenantId: string; pos: Position }> = [];
  for (const m of members) {
    if (m.core) cores.push({ tenantId: m.tenantId, pos: m.core });
  }
  if (cores.length >= 3) {
    const dists: number[] = [];
    for (let i = 0; i < cores.length; i += 1) {
      for (let j = i + 1; j < cores.length; j += 1) {
        dists.push(chebyshev(cores[i].pos, cores[j].pos));
      }
    }
    dists.sort((a, b) => a - b);
    const med = dists[Math.floor(dists.length / 2)];
    let label: string;
    let severity: DefenseSeverity;
    if (med < FORMATION_TIGHT_MAX) {
      label = "紧凑";
      severity = "INFO";
    } else if (med < FORMATION_LOOSE_MAX) {
      label = "松散";
      severity = "INFO";
    } else {
      label = "离散";
      severity = "MEDIUM";
    }
    advice.push({
      id: "defense:formation",
      category: "FORMATION",
      severity,
      title: `联盟阵型${label}`,
      detail: `${cores.length} 租户核心两两核距中位 ${med} 格（${label}）——${med >= FORMATION_LOOSE_MAX ? "建议收缩成三角态势以缩短驰援时间" : "联防响应半径可接受"}`,
      tenant: cores[0].tenantId,
      relatedTenants: cores.map((c) => c.tenantId),
      evidence: [{ label: "核距中位", value: `${med} 格` }],
    });
  }

  advice.sort((a, b) => (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) || a.id.localeCompare(b.id));
  return { generatedAtMs: Date.now(), advice, endangered, pockets: [] };
}
