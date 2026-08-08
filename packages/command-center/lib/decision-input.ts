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
import { loadTenantSurveyCached } from "./survey-cache.ts";

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
}

export interface ChunkCoverageInput {
  key: string;
  cx: number;
  cy: number;
  lastSeenTick: number | null;
}

export interface DecisionInputPayload {
  generatedAt: string;
  tenant: string;
  currentTick: number | null;
  refillPredictions: RefillPredictionInput[];
  chunkCoverage: ChunkCoverageInput[];
  cachedAt: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

/** 纯函数（可测）：mine-patterns 预测 + 探索 chunks → mission 层 Phase 2 形状。 */
export function buildDecisionInput(
  tenant: string,
  currentTick: number | null,
  predictions: readonly MineRefillPrediction[],
  chunks: readonly { key?: unknown; cx?: unknown; cy?: unknown; lastSeenTick?: unknown }[],
): DecisionInputPayload {
  const refillPredictions: RefillPredictionInput[] = (predictions ?? [])
    .filter((p) => p && p.cell)
    .map((p) => ({
      cell: p.cell,
      x: num(p.x),
      y: num(p.y),
      dueInTicks: p.dueInTicks ?? null,
      predictedNextTick: p.predictedNextTick ?? null,
      lastSeenTick: num(p.lastSeenTick),
    }))
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
  return {
    generatedAt: new Date().toISOString(),
    tenant,
    currentTick,
    refillPredictions,
    chunkCoverage,
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
  const payload = buildDecisionInput(tenant, currentTick, patterns.tenants?.[tenant]?.predictions ?? [], chunkRows);
  cache.set(key, payload);
  return payload;
}

/** 启动预热一次（不进周期循环；过期后请求惰性刷新）。 */
export function warmDecisionInput(): void {
  for (const t of TENANTS) loadDecisionInput(t);
}
