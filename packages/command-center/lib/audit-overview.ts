/**
 * 综合审计总览（2026-08-08）：把决策-结果审计、生命周期审计、矿发现-利用缺口、
 * 联盟探索覆盖、管线健康合成一个 /api/audit/overview 调用——前端"综合决策/综合
 * 态势"面板单次拉取，避免三四个请求各自加载。
 *
 * 纯组合层：复用各 30s 缓存加载器（无新增 I/O），只读，启动预热一次。
 * 全局汇总：maxLag / 全联盟可见未开采矿总数 / 总核心增量 / 总单位数。
 */
import { TENANTS } from "./fs-jsonl.ts";
import { TtlCache } from "./cache.ts";
import { loadDecisionAudit, type DecisionAuditPayload } from "./decision-audit.ts";
import { loadLifecycleAudit, type LifecycleAuditPayload } from "./lifecycle-audit.ts";
import { loadMineUtilization, type MineUtilizationPayload } from "./mine-utilization.ts";
import { loadAllianceExploration, type AllianceExplorationPayload } from "./exploration-coverage.ts";
import { loadPipelineHealth, type PipelineHealthPayload } from "./pipeline-health.ts";
import { loadHumanConflict, type HumanConflictPayload } from "./human-conflict.ts";
import { loadAllianceMining, type AllianceMiningPayload } from "./alliance-mining.ts";

const TTL_MS = 30_000;

export interface TenantAuditOverview {
  tenant: string;
  tick: number | null;
  decisions: {
    stallTicks: number;
    stallRate: number | null;
    planChurn: number | null;
    cargoEff: number | null;
    coreDelta: number;
    humanApplied: number;
    humanRejected: number;
  } | null;
  lifecycle: {
    units: number;
    alive: number;
    destroyed: number;
    byType: Record<string, number>;
    minesActive: number;
    coreCaptures: number;
    spendTotal: number;
  } | null;
  mines: {
    total: number;
    neverHarvested: number;
    visibleNever: number;
    utilizationRate: number | null;
    topCandidates: Array<{ cell: string; x: number; y: number }>;
  } | null;
  exploration: { exploredChunks: number | null; lastSeenTick: number | null } | null;
  pipeline: { lagTicks: number | null; healthy: boolean } | null;
  conflict: {
    applied: number;
    rejected: number;
    rejectedRate: number | null;
    topRejectedReason: string | null;
  } | null;
  mining: {
    assigned: number;
    avgDistance: number | null;
  } | null;
}

export interface AuditOverviewPayload {
  generatedAt: string;
  tenants: Record<string, TenantAuditOverview>;
  global: {
    maxLagTicks: number | null;
    totalNeverHarvested: number;
    totalVisibleNever: number;
    totalUnits: number;
    totalCoreDelta: number;
    coveragePct: number | null;
    currentTick: number | null;
  };
  cachedAt: string;
}

const cache = new TtlCache<AuditOverviewPayload>(TTL_MS);

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

/** 纯函数（可测）：把各审计 payload 合成综合总览。 */
export function aggregateAuditOverview(
  decisions: Record<string, DecisionAuditPayload>,
  lifecycles: Record<string, LifecycleAuditPayload>,
  mines: Record<string, MineUtilizationPayload["tenants"][string]>,
  exploration: AllianceExplorationPayload | null,
  pipeline: PipelineHealthPayload | null,
  conflicts: Record<string, HumanConflictPayload> = {},
  mining: AllianceMiningPayload | null = null,
): AuditOverviewPayload {
  const tenants: Record<string, TenantAuditOverview> = {};
  let maxLag: number | null = null;
  let totalNever = 0, totalVisibleNever = 0, totalUnits = 0, totalCoreDelta = 0;

  const pipelineByTenant = new Map<string, { lagTicks: number | null; healthy: boolean }>();
  for (const t of pipeline?.tenants ?? []) {
    pipelineByTenant.set(t.tenant, { lagTicks: num(t.lagTicks) || null, healthy: t.health === "OK" });
    const lag = num(t.lagTicks);
    if (lag > 0 && (maxLag === null || lag > maxLag)) maxLag = lag;
  }
  const explorationByTenant = new Map<string, { exploredChunks: number | null; lastSeenTick: number | null }>();
  for (const [t, v] of Object.entries(exploration?.perTenant ?? {})) {
    explorationByTenant.set(t, { exploredChunks: num(v.exploredChunks) || null, lastSeenTick: num(v.lastSeenTick) || null });
  }

  for (const t of TENANTS) {
    const dec = decisions[t];
    const lc = lifecycles[t];
    const mu = mines[t];
    totalNever += num(mu?.neverHarvested);
    totalVisibleNever += num(mu?.visibleNever);
    totalUnits += lc?.units?.length ?? 0;
    totalCoreDelta += num(dec?.outcome?.coreDeltaSum);

    const byType: Record<string, number> = {};
    let alive = 0, destroyed = 0, minesActive = 0, coreCaptures = 0, spendTotal = 0;
    for (const u of lc?.units ?? []) {
      const ty = u.unitType ?? "unknown";
      byType[ty] = (byType[ty] ?? 0) + 1;
      if (u.alive) alive += 1; else destroyed += 1;
    }
    for (const m of lc?.mines ?? []) if (m.active) minesActive += 1;
    coreCaptures = num(lc?.core?.captures?.count);
    spendTotal = num(lc?.consumption?.spends?.total);

    tenants[t] = {
      tenant: t,
      tick: num(dec?.currentTick) || null,
      decisions: dec ? {
        stallTicks: num(dec.decision.stallTicks),
        stallRate: dec.decision.records > 0 ? Math.round((dec.decision.stallTicks / dec.decision.records) * 1000) / 1000 : null,
        planChurn: dec.decision.planChurn?.rate ?? null,
        cargoEff: dec.outcome.cargoEfficiency,
        coreDelta: num(dec.outcome.coreDeltaSum),
        humanApplied: num(dec.outcome.humanApplied),
        humanRejected: num(dec.outcome.humanRejected),
      } : null,
      lifecycle: lc ? { units: lc.units.length, alive, destroyed, byType, minesActive, coreCaptures, spendTotal } : null,
      mines: mu ? {
        total: num(mu.total),
        neverHarvested: num(mu.neverHarvested),
        visibleNever: num(mu.visibleNever),
        utilizationRate: mu.utilizationRate,
        topCandidates: mu.candidates.slice(0, 5).map((c) => ({ cell: c.cell, x: c.x, y: c.y })),
      } : null,
      exploration: explorationByTenant.get(t) ?? null,
      pipeline: pipelineByTenant.get(t) ?? null,
      conflict: conflicts[t] ? {
        applied: num(conflicts[t].applied),
        rejected: num(conflicts[t].rejected),
        rejectedRate: conflicts[t].rejectedRate,
        topRejectedReason: conflicts[t].topRejectedReasons[0]?.reason ?? null,
      } : null,
      mining: mining?.perTenant[t] ? {
        assigned: num(mining.perTenant[t].assigned),
        avgDistance: mining.perTenant[t].avgDistance,
      } : null,
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    tenants,
    global: {
      maxLagTicks: maxLag,
      totalNeverHarvested: totalNever,
      totalVisibleNever: totalVisibleNever,
      totalUnits,
      totalCoreDelta,
      coveragePct: exploration?.world?.coveragePct ?? null,
      currentTick: Object.values(tenants).map((t) => t.tick).reduce<number | null>((a, b) => (b === null ? a : Math.max(a ?? 0, b)), null),
    },
    cachedAt: new Date().toISOString(),
  };
}

export function loadAuditOverview(): AuditOverviewPayload {
  const hit = cache.get("overview");
  if (hit !== undefined) return hit;
  const decisions = loadDecisionAudit("all") as Record<string, DecisionAuditPayload>;
  const lifecycles = loadLifecycleAudit("all") as Record<string, LifecycleAuditPayload>;
  const mines = loadMineUtilization("all") as MineUtilizationPayload;
  const exploration = loadAllianceExploration();
  const pipeline = loadPipelineHealth();
  const conflicts = loadHumanConflict("all") as Record<string, HumanConflictPayload>;
  const mining = loadAllianceMining();
  const payload = aggregateAuditOverview(decisions, lifecycles, mines.tenants, exploration, pipeline, conflicts, mining);
  cache.set("overview", payload);
  return payload;
}

/** 启动预热一次（复用各子审计缓存，无额外 I/O）。 */
export function warmAuditOverview(): void {
  loadAuditOverview();
}
