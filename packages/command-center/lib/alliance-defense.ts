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

export type DefenseCategory = "ENDANGERED" | "REINFORCE" | "FORMATION";
export type DefenseSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";

export interface DefenseMemberInput {
  readonly tenantId: string;
  readonly core: Position | null;
  /** 战斗单位数（VANGUARD + RANGER）。 */
  readonly military: number;
  readonly status: string;
  /** 威胁摘要 totalScore（无则 0）。 */
  readonly threatScore?: number;
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

export interface DefensePayload {
  readonly generatedAtMs: number;
  readonly advice: readonly DefenseAdvice[];
  readonly endangered: readonly { readonly tenantId: string; readonly military: number; readonly threatScore: number }[];
}

/** 濒危军事上限：≤1 战斗单位视为军事薄弱（无防御反击能力）。 */
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
  if (m.military <= ENDANGERED_COMBAT_MAX && (m.threatScore ?? 0) >= ENDANGERED_THREAT_MIN) {
    return { endangered: true, reason: "weak" };
  }
  return { endangered: false, reason: "" };
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
    let best: { tenantId: string; dist: number; military: number } | null = null;
    for (const n of members) {
      if (n.tenantId === e.tenantId || endangeredIds.has(n.tenantId)) continue;
      if (n.military < REINFORCE_COMBAT_MIN) continue;
      const nc = n.core;
      if (!nc) continue;
      const dist = chebyshev(ec, nc);
      if (dist > REINFORCE_RANGE) continue;
      if (best === null || dist < best.dist) best = { tenantId: n.tenantId, dist, military: n.military };
    }
    if (best) {
      advice.push({
        id: `defense:reinforce:${best.tenantId}:${e.tenantId}`,
        category: "REINFORCE",
        severity: "HIGH",
        title: `${best.tenantId.toUpperCase()} 可驰援 ${e.tenantId.toUpperCase()}`,
        detail: `距 ${best.dist} 格、${best.military} 战斗单位可调配——濒危租户 ${e.tenantId.toUpperCase()} 需外援`,
        tenant: best.tenantId,
        relatedTenants: [e.tenantId],
        evidence: [
          { label: "核距", value: `${best.dist} 格` },
          { label: "可调配", value: `${best.military} 战斗单位` },
          { label: "濒危方", value: e.tenantId.toUpperCase() },
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
  return { generatedAtMs: Date.now(), advice, endangered };
}
