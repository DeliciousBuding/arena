/**
 * 决策输入管道（2026-08-08，G3 数据断层补全）：把面板侧 survey-db 的
 * 矿刷新预测 + 探索覆盖暴露成 arena-agent mission 层 Phase 2 直接消费的形状
 * （见 docs/design/worker-mission-layer-v1.md §3 to-be：
 *   refillPredictions: Map<cellKey, dueInTicks>；chunkCoverage: Map<chunkKey, lastSeenTick>）。
 *
 * 只读组合（30s 惰性缓存 + 启动预热，无计划任务）：
 *   - mine-patterns.predictions（resource_seen_history → 逐矿刷新预测 dueInTicks）；
 *   - alliance-exploration（chunks → 每 chunk lastSeenTick 覆盖）。
 * 输出（/api/survey/decision-input?tenant=t1）：{ tenant, currentTick, refillPredictions,
 *   chunkCoverage, generatedAt, cachedAt }——agent 可经共享数据根直接读取/落盘消费。
 */
import { TENANTS } from "./fs-jsonl.ts";
import { TtlCache } from "./cache.ts";
import { loadMinePatterns, type MineRefillPrediction } from "./mine-patterns.ts";
import { loadAllianceExploration } from "./exploration-coverage.ts";
import { loadTenantSurveyCached } from "./survey-cache.ts";
import { loadConsensusMining } from "./consensus-mining.ts";
import { loadAllianceSnapshot } from "./alliance-snapshot.ts";
import { loadCoreTrailsFromSurveyDb } from "./trails.ts";
import { collectCoreThreats, type CoreThreatInput } from "./core-threats.ts";
import { loadMineUtilization } from "./mine-utilization.ts";

const TTL_MS = 30_000;
const cache = new TtlCache<DecisionInputPayload>(TTL_MS);

export interface RefillPredictionInput {
  cell: string;
  x: number;
  y: number;
  /** 预计还有多久刷新（tick；负=已过预期）。 */
  dueInTicks: number | null;
  predictedNextTick: number | null;
  lastSeenTick: number;
  /** 敌情威胁（2026-08-08）：consensus-mining 同格 threatLevel 0-3 / threatCombat
   *  目击数——mission 层 Phase 2 单调用即可规避 threatLevel>=2 高危格。 */
  threatLevel: 0 | 1 | 2 | 3;
  threatCombat: number;
}

export interface ChunkCoverageInput {
  key: string;
  cx: number;
  cy: number;
  lastSeenTick: number | null;
}

/** 补测目标（2026-08-08，探索线输入）：已探索但观测过旧的 chunk——refill 模型
 *  证伪后的替代勘探信号（不预测刷新，而是"哪块旧观测区最该先补测"）。
 *  mission 层可据此派 EXPLORE worker 定向补测。 */
export interface ResurveyInput {
  key: string;
  cx: number;
  cy: number;
  lastSeenTick: number;
  /** currentTick - lastSeenTick（越大越旧，越该补测）。 */
  stalenessTicks: number;
  distChunks: number;
}

/** 采集候选（2026-08-08，决策输入缺口补全）：“发现了但还没去挖”的可见未开采矿
 *  ——mine-utilization candidates 提炼（lastSeen 降序：最新发现优先，最可能仍在视野），
 *  mission 层可据此直接派 WORKER 定向采集（回复用户“很多矿发现了没分配去挖”的输入缺口）。 */
export interface MiningCandidateInput {
  cell: string;
  x: number;
  y: number;
  lastSeenTick: number;
  /** 发现后仍未采时长（tick）——越大越该优先派工。 */
  gapAgeTicks: number | null;
  /** 采集失败次数（竞争/死矿信号）。 */
  harvestFail: number;
  /** 活跃度（seenCount/age）。 */
  activity: number;
  /** 同格敌情威胁（2026-08-08）：consensus-mining 威胁级 0-3 ——
   *  mission 层派工时可优先回避 threatLevel>=2 高危格（与 refillPredictions 同格一致）。 */
  threatLevel: 0 | 1 | 2 | 3;
  threatCombat: number;
}

export interface DecisionInputPayload {
  generatedAt: string;
  tenant: string;
  currentTick: number | null;
  refillPredictions: RefillPredictionInput[];
  chunkCoverage: ChunkCoverageInput[];
  /** 补测目标（2026-08-08）：旧观测区按陈旧度降序——勘探方向直接输入。 */
  resurveyTargets: ResurveyInput[];
  /** 敌核威胁（2026-08-08）：逼近/近距目击全量（不 cap）——mission 层防御部署方向输入。 */
  coreThreats: CoreThreatInput[];
  /** 采集候选（2026-08-08）：可见未开采矿（最新发现优先，cap 40）——mission 层派 WORKER 采集直接输入。 */
  miningCandidates: MiningCandidateInput[];
  cachedAt: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

/** 纯函数（可测）：mine-patterns 预测 + 探索 chunks → mission 层 Phase 2 形状。 */
export function buildDecisionInput(
  tenant: string,
  currentTick: number | null,
  predictions: readonly MineRefillPrediction[],
  chunks: readonly { key?: unknown; cx?: unknown; cy?: unknown; lastSeenTick?: unknown }[],
  threatByCell?: ReadonlyMap<string, { threatLevel: 0 | 1 | 2 | 3; threatCombat: number }>,
  resurvey?: readonly { key?: unknown; cx?: unknown; cy?: unknown; lastSeenTick?: unknown; stalenessTicks?: unknown; distChunks?: unknown }[],
  coreThreats: readonly CoreThreatInput[] = [],
  miningCandidates: readonly MiningCandidateInput[] = [],
): DecisionInputPayload {
  const refillPredictions: RefillPredictionInput[] = (predictions ?? [])
    .filter((p) => p && p.cell)
    .map((p) => {
      const th = threatByCell?.get(p.cell);
      return {
        cell: p.cell,
        x: num(p.x),
        y: num(p.y),
        dueInTicks: p.dueInTicks ?? null,
        predictedNextTick: p.predictedNextTick ?? null,
        lastSeenTick: num(p.lastSeenTick),
        threatLevel: th?.threatLevel ?? 0,
        threatCombat: th?.threatCombat ?? 0,
      };
    })
    .sort((a, b) => (a.dueInTicks ?? 1e9) - (b.dueInTicks ?? 1e9)); // 即将刷新优先
  const chunkCoverage: ChunkCoverageInput[] = (chunks ?? [])
    .map((c) => ({
      key: String(c.key ?? `${num(c.cx)},${num(c.cy)}`),
      cx: num(c.cx),
      cy: num(c.cy),
      lastSeenTick: c.lastSeenTick === null || c.lastSeenTick === undefined ? null : num(c.lastSeenTick),
    }))
    .filter((c) => c.key.length > 0)
    .sort((a, b) => (a.lastSeenTick ?? -1) - (b.lastSeenTick ?? -1)); // 最老分区优先（勘探方向）
  // 补测目标（2026-08-08）：旧观测区按陈旧度降序——mission 层勘探方向直接输入。
  const resurveyTargets: ResurveyInput[] = (resurvey ?? [])
    .filter((r) => r && (r.key !== undefined || (r.cx !== undefined && r.cy !== undefined)))
    .map((r) => ({
      key: String(r.key ?? "" + num(r.cx) + "," + num(r.cy)),
      cx: num(r.cx),
      cy: num(r.cy),
      lastSeenTick: num(r.lastSeenTick),
      stalenessTicks: num(r.stalenessTicks),
      distChunks: num(r.distChunks),
    }))
    .sort((a, b) => b.stalenessTicks - a.stalenessTicks); // 最旧优先
  return {
    generatedAt: new Date().toISOString(),
    tenant,
    currentTick,
    refillPredictions,
    chunkCoverage,
    resurveyTargets,
    coreThreats: [...coreThreats],
    miningCandidates: [...miningCandidates],
    cachedAt: new Date().toISOString(),
  };
}

export function loadDecisionInput(tenant: string): DecisionInputPayload {
  const key = `decision-input:${tenant}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const patterns = loadMinePatterns(tenant);
  const surveyCached = loadTenantSurveyCached(tenant);
  let currentTick: number | null = surveyCached.survey?.tickMax ?? null;
  const chunkRows: { key?: unknown; cx?: unknown; cy?: unknown; lastSeenTick?: unknown }[] =
    (surveyCached.chunks ?? []).map((c) => ({
      key: String(c.key ?? `${num(c.cx)},${num(c.cy)}`),
      cx: num(c.cx),
      cy: num(c.cy),
      lastSeenTick: c.lastSeenTick ?? c.tick ?? null,
    }));
  // 威胁表：consensus-mining 按 cell 加入 threatLevel/threatCombat（30s 缓存，无触网）
  const threatByCell = new Map<string, { threatLevel: 0 | 1 | 2 | 3; threatCombat: number }>();
  try {
    for (const r of loadConsensusMining().resources ?? []) {
      if (r.cell && typeof r.threatLevel === "number") threatByCell.set(r.cell, { threatLevel: r.threatLevel as 0 | 1 | 2 | 3, threatCombat: Number(r.threatCombat ?? 0) });
    }
  } catch { /* 威胁数据不可用不阻断（refill/chunk 仍返回） */ }
  // 补测目标（2026-08-08）：exploration 的旧观测区（refill 模型证伪后替代勘探信号）
  // ——mission 层据此定向补测（读 30s 缓存，无触网）。
  let resurveyRows: Array<{ key: string; cx: number; cy: number; lastSeenTick: number; stalenessTicks: number; distChunks: number }> = [];
  try {
    resurveyRows = loadAllianceExploration().resurveyTargets.map((r) => ({
      key: r.key, cx: r.cx, cy: r.cy, lastSeenTick: r.lastSeenTick, stalenessTicks: r.stalenessTicks, distChunks: r.distChunks,
    }));
  } catch { /* 探索数据不可用不阻断 */ }
  // 敌核威胁（2026-08-08）：core_hunts 轨迹提炼全量（不 cap，mission 层自行决策）。
  let coreThreats: CoreThreatInput[] = [];
  try {
    // 友核位置从联盟快照取（世界状态，30s 缓存，无触网）
    const friendlyCore = loadAllianceSnapshot().members[tenant]?.core?.position ?? null;
    const curTick = currentTick ?? 0;
    if (friendlyCore) {
      coreThreats = collectCoreThreats(loadCoreTrailsFromSurveyDb(tenant, 48, 1), friendlyCore, curTick);
    }
  } catch { /* 敌核轨迹不可用不阻断 */ }
  // 采集候选（2026-08-08）：“发现了没去挖”的可见未开采矿——mine-utilization candidates
  // （lastSeen 降序：最新发现优先，最可能仍在视野），cap 40 防 payload 过大。
  let miningCandidates: MiningCandidateInput[] = [];
  try {
    const util = loadMineUtilization().tenants?.[tenant];
    miningCandidates = (util?.candidates ?? []).slice(0, 40).map((c) => {
      const th = threatByCell.get(c.cell);
      return {
        cell: c.cell,
        x: c.x,
        y: c.y,
        lastSeenTick: c.lastSeenTick ?? 0,
        gapAgeTicks: c.gapAgeTicks ?? null,
        harvestFail: c.harvestFail ?? 0,
        activity: c.activity ?? 0,
        threatLevel: th?.threatLevel ?? 0,
        threatCombat: th?.threatCombat ?? 0,
      };
    });
  } catch { /* 矿利用数据不可用不阻断 */ }
  const payload = buildDecisionInput(tenant, currentTick, patterns.tenants?.[tenant]?.predictions ?? [], chunkRows, threatByCell, resurveyRows, coreThreats, miningCandidates);
  cache.set(key, payload);
  return payload;
}

/** 启动预热一次（不进周期循环；过期后请求惰性刷新）。 */
export function warmDecisionInput(): void {
  for (const t of TENANTS) loadDecisionInput(t);
}
