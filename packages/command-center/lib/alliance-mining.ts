/**
 * 联盟级采矿分工（2026-08-08）：共享测绘 → 谁去采哪个矿。
 *
 * 目标：用户反复提出"很多矿发现了没分配挖"；本文把各租户的"可见未开采"
 * 候选（audit/mines）放到联盟尺度，按"谁离得近谁去"分配——共享记忆的
 * 第一层落地（不写库、不改 agent，纯只读分配建议，供前端/决策线消费）。
 *
 * 输入（全部只读，30s 缓存）：
 *  - alliance-snapshot：各租户核心位置 + worker 数（算距离/评估承载）；
 *  - alliance-survey.resources：同格多租户观测（observers 推导）；
 *  - alliance-survey.conflicts：同格矿重叠（需仲裁/去重）；
 *  - audit/mines candidates：各租户可见未开采矿。
 * 输出（/api/alliance/mining）：
 *  - assignments：候选矿 → 最近观测租户（共享格标 shared，冲突格标 conflict）；
 *  - perTenant：分配数 / 平均距离 / worker 承载；
 *  - 未分配：无核心数据/无观测者（数据缺口提示）。
 */
import { TENANTS } from "./fs-jsonl.ts";
import { TtlCache } from "./cache.ts";
import { loadAllianceSnapshot, type AllianceSnapshotPayload } from "./alliance-snapshot.ts";
import { loadAllianceSurvey, type AllianceSurveyPayload } from "./alliance-survey.ts";
import { loadMineUtilization, type MineUtilizationPayload } from "./mine-utilization.ts";
import { loadMinePatterns } from "./mine-patterns.ts";

const TTL_MS = 30_000;

export interface MiningAssignment {
  cell: string;
  x: number;
  y: number;
  assignedTenant: string;
  distanceToCore: number | null;
  observers: string[];
  shared: boolean;
  conflict: boolean;
  lastSeenTick: number | null;
  /** 发现后仍未采时长（tick，2026-08-08 积压优先排序）。 */
  gapAgeTicks: number | null;
  /** 矿刷新预测（mine-patterns）：预测下次出现 tick / 还有多久（tick）。 */
  predictedNextTick: number | null;
  dueInTicks: number | null;
}

export interface AllianceMiningPayload {
  generatedAt: string;
  currentTick: number | null;
  assignments: MiningAssignment[];
  perTenant: Record<string, { assigned: number; avgDistance: number | null; workers: number | null }>;
  unassigned: Array<{ cell: string; x: number; y: number; reason: string }>;
  global: { totalCandidates: number; assigned: number; shared: number; conflict: number; unassigned: number };
  cachedAt: string;
}

const cache = new TtlCache<AllianceMiningPayload>(TTL_MS);

const chebyshev = (a: [number, number], b: [number, number]): number =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));

/** 纯函数（可测）：候选矿 + 各租户核心 → 就近分配。 */
export function assignAllianceMining(
  cores: Partial<Record<string, [number, number] | null>>,
  workers: Partial<Record<string, number | null>>,
  candidatesByTenant: Record<string, Array<{ cell: string; x: number; y: number; lastSeenTick: number | null }>>,
  observersByCell: Record<string, string[]>,
  conflictCells: Set<string>,
  metaByCell: Record<string, { gapAgeTicks: number | null; predictedNextTick: number | null; dueInTicks: number | null }> = {},
): AllianceMiningPayload {
  const seen = new Set<string>();
  const assignments: MiningAssignment[] = [];
  const perTenant: Record<string, { assigned: number; avgDistance: number | null; workers: number | null }> = {};
  for (const t of TENANTS) perTenant[t] = { assigned: 0, avgDistance: null, workers: workers[t] ?? null };
  const unassigned: Array<{ cell: string; x: number; y: number; reason: string }> = [];

  let totalCandidates = 0, assigned = 0, shared = 0, conflict = 0, unassignedN = 0;

  // 收集全部候选（跨租户去重：同格只处理一次）
  const candidates: Array<{ cell: string; x: number; y: number; lastSeenTick: number | null; prefer: string }> = [];
  for (const [t, list] of Object.entries(candidatesByTenant)) {
    for (const c of list ?? []) {
      if (!seen.has(c.cell)) {
        seen.add(c.cell);
        candidates.push({ cell: c.cell, x: c.x, y: c.y, lastSeenTick: c.lastSeenTick ?? null, prefer: t });
      }
    }
  }
  totalCandidates = candidates.length;

  const distanceSums: Record<string, number> = {};
  const distanceCounts: Record<string, number> = {};

  for (const c of candidates) {
    const observers = observersByCell[c.cell] ?? [];
    const reachable = observers.filter((t) => cores[t] !== undefined && cores[t] !== null);
    if (reachable.length === 0) {
      unassigned.push({ cell: c.cell, x: c.x, y: c.y, reason: "no_observer_core" });
      unassignedN += 1;
      continue;
    }
    // 就近：观察者中距自己核心最近者；平手偏好候选自身租户
    let best: string | null = null;
    let bestDist = Infinity;
    for (const t of reachable) {
      const dist = chebyshev([c.x, c.y], cores[t] as [number, number]);
      if (dist < bestDist || (dist === bestDist && t === c.prefer)) {
        best = t;
        bestDist = dist;
      }
    }
    if (best === null) {
      unassigned.push({ cell: c.cell, x: c.x, y: c.y, reason: "no_core" });
      unassignedN += 1;
      continue;
    }
    const isShared = observers.length > 1;
    const isConflict = conflictCells.has(c.cell);
    if (isShared) shared += 1;
    if (isConflict) conflict += 1;
    assigned += 1;
    perTenant[best].assigned += 1;
    distanceSums[best] = (distanceSums[best] ?? 0) + bestDist;
    distanceCounts[best] = (distanceCounts[best] ?? 0) + 1;

    const meta = metaByCell[c.cell] ?? { gapAgeTicks: null, predictedNextTick: null, dueInTicks: null };
    assignments.push({
      cell: c.cell, x: c.x, y: c.y,
      assignedTenant: best,
      distanceToCore: bestDist,
      observers,
      shared: isShared,
      conflict: isConflict,
      lastSeenTick: c.lastSeenTick,
      gapAgeTicks: meta.gapAgeTicks ?? null,
      predictedNextTick: meta.predictedNextTick ?? null,
      dueInTicks: meta.dueInTicks ?? null,
    });
  }

  for (const t of TENANTS) {
    if ((distanceCounts[t] ?? 0) > 0) {
      perTenant[t].avgDistance = Math.round((distanceSums[t] / distanceCounts[t]) * 10) / 10;
    }
  }
  // 2026-08-08 积压优先：gapAge 大（发现久未采）排前，平手按就近。
  assignments.sort((a, b) =>
    ((b.gapAgeTicks ?? 0) - (a.gapAgeTicks ?? 0)) || ((a.distanceToCore ?? 1e9) - (b.distanceToCore ?? 1e9)));

  return {
    generatedAt: new Date().toISOString(),
    currentTick: null,
    assignments,
    perTenant,
    unassigned,
    global: { totalCandidates, assigned, shared, conflict, unassigned: unassignedN },
    cachedAt: new Date().toISOString(),
  };
}

/** 由 alliance-survey.resources 推导 同格→观测租户 映射。 */
export function buildObserversByCell(
  resources: ReadonlyArray<{ tenant?: unknown; x?: unknown; y?: unknown }>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of resources) {
    const t = String(r.tenant ?? "");
    const x = Number(r.x);
    const y = Number(r.y);
    if (!t || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const key = `${x},${y}`;
    const arr = out[key] ?? [];
    if (!arr.includes(t)) arr.push(t);
    out[key] = arr;
  }
  return out;
}

export function loadAllianceMining(): AllianceMiningPayload {
  const hit = cache.get("mining");
  if (hit !== undefined) return hit;
  const snap = loadAllianceSnapshot() as AllianceSnapshotPayload;
  const survey = loadAllianceSurvey() as AllianceSurveyPayload;
  const mines = loadMineUtilization("all") as MineUtilizationPayload;

  const cores: Partial<Record<string, [number, number] | null>> = {};
  const workers: Partial<Record<string, number | null>> = {};
  for (const t of TENANTS) {
    const m = (snap.members ?? {})[t];
    const pos = m?.core?.position;
    cores[t] = Array.isArray(pos) && pos.length >= 2 ? [Number(pos[0]), Number(pos[1])] : null;
    workers[t] = typeof m?.workers === "number" ? m.workers : null;
  }

  const candidatesByTenant: Record<string, Array<{ cell: string; x: number; y: number; lastSeenTick: number | null }>> = {};
  for (const t of TENANTS) {
    candidatesByTenant[t] = (mines.tenants[t]?.candidates ?? []).map((c) => ({
      cell: c.cell, x: c.x, y: c.y, lastSeenTick: c.lastSeenTick ?? null,
    }));
  }

  const observersByCell = buildObserversByCell(survey.resources ?? []);
  const conflictCells = new Set<string>();
  for (const c of survey.conflicts?.resourceOverlaps ?? []) {
    const cell = String((c as { cell?: unknown }).cell ?? "");
    if (cell) conflictCells.add(cell);
  }

  // 2026-08-08 候选优先级：gapAge（发现后仍未采，积压优先）+ 矿刷新预测（dueInTicks）
  const metaByCell: Record<string, { gapAgeTicks: number | null; predictedNextTick: number | null; dueInTicks: number | null }> = {};
  for (const t of TENANTS) {
    for (const c of mines.tenants[t]?.candidates ?? []) {
      const cell = c.cell;
      const cur = metaByCell[cell] ?? { gapAgeTicks: null, predictedNextTick: null, dueInTicks: null };
      const g = Number(c.gapAgeTicks) || 0;
      if (g > (cur.gapAgeTicks ?? 0)) cur.gapAgeTicks = g;
      metaByCell[cell] = cur;
    }
  }
  try {
    const patterns = loadMinePatterns("all");
    for (const t of TENANTS) {
      for (const p of patterns.tenants[t]?.predictions ?? []) {
        const cell = p.cell;
        const cur = metaByCell[cell] ?? { gapAgeTicks: null, predictedNextTick: null, dueInTicks: null };
        if (p.predictedNextTick !== null && p.predictedNextTick !== undefined) cur.predictedNextTick = p.predictedNextTick;
        if (p.dueInTicks !== null && p.dueInTicks !== undefined) cur.dueInTicks = p.dueInTicks;
        metaByCell[cell] = cur;
      }
    }
  } catch { /* 预测不可用不阻断分配 */ }
  const payload = assignAllianceMining(cores, workers, candidatesByTenant, observersByCell, conflictCells, metaByCell);
  payload.currentTick = typeof snap.currentTick === "number" ? snap.currentTick : null;
  cache.set("mining", payload);
  return payload;
}

/** 启动预热一次（复用各子缓存）。 */
export function warmAllianceMining(): void {
  loadAllianceMining();
}
