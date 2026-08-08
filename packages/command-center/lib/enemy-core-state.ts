/** 敌核状态视图（2026-08-08，共享测绘深化）：从 core_hunts（共享测绘敌核记忆）
 *  聚合每敌核生命周期状态——直接回答"敌方核心还活着吗 / 在哪 / 迁哪了"。
 *
 *  状态分类（相对 currentTick）：
 *  - ACTIVE：last_seen 距今 ≤ activeWindow（1000 tick）→ 活着，在最新位置；
 *  - RELOCATED：同一 owner 出现于 ≥2 个不同位置且最新目击活跃 → 迁移中
 *    （最新位置 = 当前位置；仍视为活跃目标）；
 *  - STALE：last_seen 距今 > staleWindow（5000 tick，与 core-threats staleAfterTicks
 *    同口径）→ 长时间未见（可能失联/被打掉/离开侦察圈）。
 *  威胁级别：活跃（ACTIVE/RELOCATED）+ 距友核 ≤ 60 → high（打核候选）；
 *  ≤ 200 → medium；其余 low。纯函数、无 I/O、确定性。
 */
export type EnemyCoreStatus = "ACTIVE" | "RELOCATED" | "STALE";
export type EnemyCoreThreat = "high" | "medium" | "low";

export interface EnemyCoreHuntRow {
  readonly owner: string;
  readonly x: number;
  readonly y: number;
  readonly firstSeenTick: number;
  readonly lastSeenTick: number;
  readonly source: "CORE" | "WORKER_INFER";
}

export interface EnemyCoreState {
  readonly owner: string;
  readonly status: EnemyCoreStatus;
  readonly x: number;
  readonly y: number;
  readonly firstSeenTick: number;
  readonly lastSeenTick: number;
  /** 该敌核出现过的位置数（>1 = 迁移过）。 */
  readonly locationCount: number;
  /** 距最近友核距离（Chebyshev；无友核 null）。 */
  readonly distToFriendly: number | null;
  /** 威胁级别：活跃且距友核 ≤60 → high；≤200 → medium；其余/STALE → low。 */
  readonly threat: EnemyCoreThreat;
}

export interface EnemyCoreStateOptions {
  /** 活跃窗口（tick）：last_seen 距今 ≤ 此值 = 活跃。 */
  activeWindow?: number;
  /** 陈旧窗口（tick）：last_seen 距今 > 此值 = STALE。 */
  staleWindow?: number;
  /** 高威胁半径（距友核 Chebyshev，与 core-threats approachRadius 同口径）。 */
  highThreatRadius?: number;
  /** 中威胁半径。 */
  mediumThreatRadius?: number;
}

export const DEFAULT_ENEMY_CORE_OPTS: Readonly<Required<EnemyCoreStateOptions>> = Object.freeze({
  activeWindow: 1000,
  staleWindow: 5000,
  highThreatRadius: 60,
  mediumThreatRadius: 200,
});

const THREAT_ORDER: Record<EnemyCoreThreat, number> = { high: 0, medium: 1, low: 2 };

/** 敌核状态聚合（纯函数）：hunts 按 owner 聚合 → 最新位置/状态/威胁。 */
export function buildEnemyCoreStates(
  hunts: readonly EnemyCoreHuntRow[],
  currentTick: number,
  friendlyCores: readonly (readonly number[])[] = [],
  opts: EnemyCoreStateOptions = {},
): EnemyCoreState[] {
  const { activeWindow, staleWindow, highThreatRadius, mediumThreatRadius } = { ...DEFAULT_ENEMY_CORE_OPTS, ...opts };
  const byOwner = new Map<string, EnemyCoreHuntRow[]>();
  for (const h of hunts) {
    const g = byOwner.get(h.owner);
    if (g) g.push(h);
    else byOwner.set(h.owner, [h]);
  }
  const out: EnemyCoreState[] = [];
  for (const [owner, rows] of byOwner) {
    const latest = rows.reduce((a, b) => (b.lastSeenTick > a.lastSeenTick ? b : a));
    const age = currentTick > 0 ? Math.max(0, currentTick - latest.lastSeenTick) : 0;
    const locationCount = new Set(rows.map((r) => `${r.x},${r.y}`)).size;
    let status: EnemyCoreStatus;
    if (age > staleWindow) status = "STALE";
    else if (locationCount > 1) status = "RELOCATED";
    else status = "ACTIVE";
    let dist: number | null = null;
    for (const fc of friendlyCores) {
      if (fc.length < 2) continue;
      const d = Math.max(Math.abs(latest.x - fc[0]), Math.abs(latest.y - fc[1]));
      if (dist === null || d < dist) dist = d;
    }
    let threat: EnemyCoreThreat = "low";
    if (status !== "STALE" && dist !== null) {
      if (dist <= highThreatRadius) threat = "high";
      else if (dist <= mediumThreatRadius) threat = "medium";
    }
    out.push({
      owner, status, x: latest.x, y: latest.y,
      firstSeenTick: latest.firstSeenTick, lastSeenTick: latest.lastSeenTick,
      locationCount, distToFriendly: dist, threat,
    });
  }
  out.sort((a, b) =>
    (THREAT_ORDER[a.threat] - THREAT_ORDER[b.threat]) ||
    (a.status === "STALE" ? 1 : 0) - (b.status === "STALE" ? 1 : 0) ||
    a.owner.localeCompare(b.owner),
  );
  return out;
}
