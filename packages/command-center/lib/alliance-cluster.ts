/**
 * 联盟集群态势（2026-08-08，抱团 Phase 1 观测层，docs/design/alliance-iff-and-cluster-v1.md §3）。
 *
 * 输入四租户核心/兵力，输出：
 *   - 集群识别：Chebyshev ≤ CLUSTER_LINK_DIST 视为同一联防集群（简单连通分组，
 *     与"西集群 t1+t3 / 东集群 t2+t4"的军事联防语义一致）；
 *   - 抱团指数 cohesion：每租户到集群重心的归一化距离（0..1，越大越紧）；
 *   - 联防圈：集群内核心的 bbox 中心 + 半径（供前端地图叠加）。
 *
 * 纯函数、无 I/O、确定性（同输入同输出）。数据来自联盟快照成员（核心/兵力），
 * 不新增 world 轮询。
 */
import type { Position } from "@arena/arena-hero-ts";

/** 集群连接距离（Chebyshev）：超过此距离不视为同联防集群。
 *  120 格 ≈ 侦察-接敌的联防圈经验值（Vanguard 视野 4、攻坚集结圈 5 的外推安全裕度）。 */
export const CLUSTER_LINK_DIST = 120;
/** 抱团指数归一化上限（同集群内两核最大参考距离；超过按 0 计）。 */
export const COHESION_MAX_DIST = 300;

export interface AllianceClusterMemberInput {
  readonly tenantId: string;
  readonly core: Position | null;
  readonly military: number;
  readonly workers: number;
  readonly status: string;
}

export interface TenantClusterMember {
  readonly tenantId: string;
  readonly core: Position | null;
  readonly military: number;
  readonly workers: number;
  readonly status: string;
  readonly clusterId: number;
  /** 同集群租户数（1 = 孤立）。 */
  readonly clusterSize: number;
  /** 抱团指数 0..1：1 - chebyshev(自身, 集群重心)/COHESION_MAX_DIST；核心缺失 = 0。 */
  readonly cohesion: number;
}

export interface AllianceClusterGroup {
  readonly id: number;
  readonly tenantIds: readonly string[];
  readonly centroid: Position | null;
  readonly military: number;
  readonly workers: number;
  /** 集群内最大核距（Chebyshev）；<2 租户 = 0。 */
  readonly radius: number;
}

export interface AllianceClusterView {
  readonly generatedAtMs: number;
  readonly groups: readonly AllianceClusterGroup[];
  readonly members: readonly TenantClusterMember[];
  readonly summary: {
    readonly memberCount: number;
    readonly groupCount: number;
    /** 孤立租户数（独立集群 = 未抱团）。 */
    readonly isolatedCount: number;
    /** 最大抱团指数（跨租户最大 cohesion；0 = 全孤立）。 */
    readonly maxCohesion: number;
    /** 平均抱团指数（仅同集群租户）。 */
    readonly avgCohesion: number;
  };
}

function chebyshev(a: Position, b: Position): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function groupMembers(input: readonly AllianceClusterMemberInput[], linkDist: number): number[] {
  const n = input.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let i = 0; i < n; i += 1) {
    const a = input[i]!;
    if (a.core === null) continue;
    for (let j = i + 1; j < n; j += 1) {
      const b = input[j]!;
      if (b.core === null) continue;
      if (chebyshev(a.core, b.core) <= linkDist) union(i, j);
    }
  }
  return input.map((_, i) => find(i));
}

/** 纯函数：联盟集群态势（输入按 tenantId 排序；核心缺失的租户自成一簇且 cohesion=0）。 */
export function buildAllianceClusterView(
  input: readonly AllianceClusterMemberInput[],
  nowMs: number,
): AllianceClusterView {
  const sorted = [...input].sort((a, b) => stableCompare(a.tenantId, b.tenantId));
  const clusterOf = groupMembers(sorted, CLUSTER_LINK_DIST);
  const idByRoot = new Map<number, number>();
  let nextId = 0;
  for (const root of clusterOf) {
    if (!idByRoot.has(root)) idByRoot.set(root, nextId++);
  }
  const clusterIds = clusterOf.map((root) => idByRoot.get(root)!);

  const groups: AllianceClusterGroup[] = [];
  for (let gid = 0; gid < nextId; gid += 1) {
    const idxs = sorted.map((_, i) => i).filter((i) => clusterIds[i] === gid);
    const cores = idxs.map((i) => sorted[i]!.core).filter((c): c is Position => c !== null);
    const centroid: Position | null = cores.length === 0
      ? null
      : [
          Math.round(cores.reduce((s, c) => s + c[0], 0) / cores.length),
          Math.round(cores.reduce((s, c) => s + c[1], 0) / cores.length),
        ];
    let radius = 0;
    for (const c of cores) {
      if (centroid !== null) radius = Math.max(radius, chebyshev(c, centroid));
    }
    groups.push({
      id: gid,
      tenantIds: Object.freeze(idxs.map((i) => sorted[i]!.tenantId)),
      centroid,
      military: idxs.reduce((s, i) => s + sorted[i]!.military, 0),
      workers: idxs.reduce((s, i) => s + sorted[i]!.workers, 0),
      radius,
    });
  }

  const members: TenantClusterMember[] = sorted.map((m, i) => {
    const gid = clusterIds[i]!;
    const group = groups[gid]!;
    const cohesion = m.core === null || group.centroid === null || group.tenantIds.length < 2
      ? 0
      : Math.max(0, 1 - chebyshev(m.core, group.centroid) / COHESION_MAX_DIST);
    return Object.freeze({
      tenantId: m.tenantId,
      core: m.core,
      military: m.military,
      workers: m.workers,
      status: m.status,
      clusterId: gid,
      clusterSize: group.tenantIds.length,
      cohesion: Math.round(cohesion * 1000) / 1000,
    });
  });

  const grouped = members.filter((m) => m.clusterSize > 1);
  const maxCohesion = grouped.length === 0 ? 0 : Math.max(...grouped.map((m) => m.cohesion));
  const avgCohesion = grouped.length === 0
    ? 0
    : Math.round((grouped.reduce((s, m) => s + m.cohesion, 0) / grouped.length) * 1000) / 1000;

  return Object.freeze({
    generatedAtMs: nowMs,
    groups: Object.freeze(groups.sort((a, b) => a.id - b.id)),
    members,
    summary: Object.freeze({
      memberCount: sorted.length,
      groupCount: groups.length,
      isolatedCount: members.filter((m) => m.clusterSize === 1).length,
      maxCohesion,
      avgCohesion,
    }),
  });
}

/** 从联盟快照成员构建输入（command-center 端点用；members 为 Record 或 Map）。 */
export function clusterInputOfMembers(
  members: ReadonlyMap<string, AllianceClusterMemberSource> | Record<string, AllianceClusterMemberSource>,
): AllianceClusterMemberInput[] {
  const entries = members instanceof Map ? [...members.entries()] : Object.entries(members);
  return entries.map(([tenantId, m]) => ({
    tenantId,
    core: m.core?.position ?? null,
    military: m.vanguards + m.rangers,
    workers: m.workers,
    status: m.status,
  }));
}

export interface AllianceClusterMemberSource {
  readonly core: { readonly position: Position } | null;
  readonly vanguards: number;
  readonly rangers: number;
  readonly workers: number;
  readonly status: string;
}

// ---------- 端点加载器（30s 缓存，与 alliance-snapshot 同模式） ----------
import { TtlCache } from "./cache.ts";
import { loadAllianceSnapshot } from "./alliance-snapshot.ts";

const ALLIANCE_CLUSTER_TTL_MS = 30_000;
const allianceClusterCache = new TtlCache<AllianceClusterView>(ALLIANCE_CLUSTER_TTL_MS);

/** 读取联盟集群态势（30s 缓存；未命中则刷新）。 */
export function loadAllianceCluster(): AllianceClusterView {
  const hit = allianceClusterCache.get("latest");
  if (hit !== undefined) return hit;
  return refreshAllianceCluster();
}

/** 刷新联盟集群态势（复用 alliance-snapshot 30s 缓存，重算成本极低）。 */
export function refreshAllianceCluster(): AllianceClusterView {
  const snapshot = loadAllianceSnapshot();
  const view = buildAllianceClusterView(clusterInputOfMembers(snapshot.members), Date.now());
  allianceClusterCache.set("latest", view);
  return view;
}
