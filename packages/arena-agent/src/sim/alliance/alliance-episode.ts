/**
 * Alliance Episode — 联盟模拟器顶层入口（Phase 2）。
 *
 * 复用现有 runEpisode 闭环，通过 onBeforePlanners / policyProvider /
 * onTickRecorded 三个钩子注入联盟语义：
 *
 *   World before → member reports → AllianceSnapshot → director replan
 *   → per-tenant directive evaluation → planner.decide → settleTick
 *   → KPI trace
 *
 * 约束（spec §17）：
 * - 所有 tenant 从同一个 pre-step world 生成 observation（runEpisode 单 world
 *   循环保证）；收齐所有 plan 后一次性 settleTick（不复制 resolver）。
 * - 无 wall-clock / Math.random 进入语义：observedAtMs/generatedAtMs 由 tick
 *   派生；director rng 从 episode seed 派生。
 * - 模拟器输出仅 data/runs/sim；确定性 replay：seed + config + scenario 相同
 *   → end state / KPI / directive trace 一致。
 *
 * 最后更新：2026-08-08
 */

import { createHash } from "node:crypto";
import { compareCodeUnit } from "../deterministic/uuid.ts";
import { createSeededRng } from "../deterministic/rng.ts";
import { loadRulesManifest } from "../contracts/rules-manifest.ts";
import { visibleCellSet } from "../visibility/visibility.ts";
import { cellKey } from "../../domain/model.ts";
import { evaluateDirective } from "../../alliance/directive.ts";
import { computeConfidence } from "../../alliance/member-report.ts";
import type {
  AllianceDirective,
  AllianceMemberReport,
  AllianceSnapshot,
  EntitySighting,
  MemberStatus,
} from "../../alliance/types.ts";
import type { RulesManifest } from "../contracts/rules-manifest.ts";
import type { SimWorld } from "../world/types.ts";
import {
  runEpisode,
  type EpisodeConfig,
  type EpisodeResult,
} from "../harness/episode.ts";
import { AllianceKpiCollector } from "./kpi.ts";
import type {
  AllianceEpisodeConfig,
  AllianceEpisodeResult,
  AllianceTraceEntry,
  DirectiveEvaluationTrace,
  DirectorFaultEvent,
  PlanSource,
} from "./types.ts";

/** 内部可变 trace entry（evaluations 由 policyProvider 延迟填充）。 */
interface MutableTraceEntry extends Omit<AllianceTraceEntry, "evaluations"> {
  evaluations: readonly DirectiveEvaluationTrace[];
}

// ── Helpers ────────────────────────────────────────────────────

export interface MemberReportResult {
  readonly report: AllianceMemberReport;
  /** 本 tenant 当前 tick 视野内的目击（尚未与历史合并）。 */
  readonly currentSightings: ReadonlyMap<string, EntitySighting>;
}

/**
 * 从 SimWorld 构建单个租户的 AllianceMemberReport。
 * 纯函数，只读，不修改 world。localThreat 只从本 tenant 视野内的目击计算
 * （partial observability union——不是服务器全知）。
 */
export function buildMemberReport(
  world: SimWorld,
  tenantId: string,
  rules: RulesManifest,
): MemberReportResult {
  const player = world.players.get(tenantId);
  if (player === undefined) {
    throw new Error(`buildMemberReport: unknown tenant ${tenantId}`);
  }

  const core = player.core === null ? null : {
    id: player.core.id,
    position: player.core.position,
    hp: player.core.hp,
    shield: player.core.shield,
    moving: player.core.state === "MOVING",
  };

  const workers = player.units.filter((u) => u.unitType === "WORKER");
  const vanguards = player.units.filter((u) => u.unitType === "VANGUARD");
  const rangers = player.units.filter((u) => u.unitType === "RANGER");
  const population = player.units.length;

  const resourceCapacity = Math.max(
    rules.rules.core.minCapacity,
    population * rules.rules.core.capacityPerUnit,
  );
  const carriedResources = workers.reduce((sum, u) => sum + u.cargo, 0);

  const status: MemberStatus = player.status === "RESPAWNING" ? "RESPAWNING" : "READY";

  // 本 tenant 视野内的目击（localThreat 只依赖这个集合）
  const visible = visibleCellSet(world, tenantId, rules);
  const currentSightings = new Map<string, EntitySighting>();
  for (const [enemyId, enemy] of world.players) {
    if (enemyId === tenantId) continue;
    if (enemy.core !== null && visible.has(cellKey(enemy.core.position))) {
      const key = `core:${enemy.core.id}`;
      currentSightings.set(key, {
        key,
        kind: "CORE",
        ownerUsername: enemy.username,
        position: enemy.core.position,
        sourceTenant: tenantId,
        firstSeenTick: world.tick,
        lastSeenTick: world.tick,
        currentlyVisible: true,
        confidence: 1.0,
        evidence: "LIVE",
      });
    }
    for (const unit of enemy.units) {
      if (visible.has(cellKey(unit.position))) {
        const key = `unit:${unit.id}`;
        currentSightings.set(key, {
          key,
          kind: "UNIT",
          unitType: unit.unitType,
          ownerUsername: enemy.username,
          position: unit.position,
          sourceTenant: tenantId,
          firstSeenTick: world.tick,
          lastSeenTick: world.tick,
          currentlyVisible: true,
          confidence: 1.0,
          evidence: "LIVE",
        });
      }
    }
  }

  return {
    report: {
      tenantId,
      tick: world.tick,
      observedAtMs: world.tick * 1000, // tick 派生，非 wall-clock
      core,
      resources: player.resources,
      resourceCapacity,
      population,
      workers: workers.length,
      vanguards: vanguards.length,
      rangers: rangers.length,
      carriedResources,
      activeFleetIds: [], // v1: no fleets
      localThreat: currentSightings.size,
      localHarvestRate: 0, // v1: not computed
      status,
    },
    currentSightings,
  };
}

/**
 * 合并新旧 sighting（per-tenant carry-forward）：
 * 同 key 当前可见 → 更新 lastSeenTick/confidence，保留 firstSeenTick；
 * 未再见 → currentlyVisible=false + confidence 衰减。
 */
export function mergeSightings(
  previous: ReadonlyMap<string, EntitySighting>,
  current: ReadonlyMap<string, EntitySighting>,
  tick: number,
): ReadonlyMap<string, EntitySighting> {
  const merged = new Map<string, EntitySighting>();
  for (const [key, s] of current) {
    merged.set(key, { ...s });
  }
  for (const [key, s] of previous) {
    const existing = merged.get(key);
    if (existing !== undefined) {
      merged.set(key, { ...existing, firstSeenTick: s.firstSeenTick });
    } else {
      const age = tick - s.lastSeenTick;
      const tau = s.kind === "CORE" ? 96 : 6;
      merged.set(key, {
        ...s,
        currentlyVisible: false,
        confidence: computeConfidence(s, tick, tau),
      });
    }
  }
  return merged;
}

/**
 * 构建 AllianceSnapshot。
 *
 * - sightings：跨 tenant union 后稳定去重（同 key 取 lastSeenTick 最新；
 *   tie-break sourceTenant code-unit 序），输出按 key code-unit 排序。
 * - allyEntityIds：只从 pre-step world 抽联盟成员自身的 CORE + UNIT id
 *   （不泄漏敌方全知）。
 * - generatedAtMs：tick 派生，非 wall-clock。
 */
export function buildSnapshot(
  reports: readonly AllianceMemberReport[],
  perTenantSightings: ReadonlyMap<string, ReadonlyMap<string, EntitySighting>>,
  world: SimWorld,
  allianceTenants: readonly string[],
  treasuryTenant: string,
  revision: number,
  tick: number,
): AllianceSnapshot {
  const members = new Map<string, AllianceMemberReport>();
  for (const r of reports) members.set(r.tenantId, r);

  // 跨 tenant union + 稳定去重
  const byKey = new Map<string, EntitySighting>();
  for (const [tenantId, sightings] of perTenantSightings) {
    if (!allianceTenants.includes(tenantId)) continue;
    for (const s of sightings.values()) {
      const existing = byKey.get(s.key);
      if (
        existing === undefined ||
        s.lastSeenTick > existing.lastSeenTick ||
        (s.lastSeenTick === existing.lastSeenTick &&
          compareCodeUnit(s.sourceTenant, existing.sourceTenant) < 0)
      ) {
        byKey.set(s.key, s);
      }
    }
  }
  const sightings = [...byKey.values()].sort((a, b) => compareCodeUnit(a.key, b.key));

  // allyEntityIds：只抽联盟成员自身的实体（no-fire 硬规则依据）
  const allyEntityIds = new Set<string>();
  for (const tid of allianceTenants) {
    const p = world.players.get(tid);
    if (p === undefined) continue;
    if (p.core !== null) allyEntityIds.add(p.core.id);
    for (const u of p.units) allyEntityIds.add(u.id);
  }

  return {
    revision,
    tickWindow: [tick, tick],
    generatedAtMs: tick * 1000, // tick 派生，非 wall-clock
    members,
    sightings,
    allyEntityIds,
    treasuryTenant,
    activeMissions: [], // v1: no real missions
  };
}

// ── Config validation / hash ───────────────────────────────────

function validateAllianceConfig(config: AllianceEpisodeConfig): string {
  if (config.allianceTenants.length === 0) {
    throw new Error("allianceTenants must be non-empty");
  }
  const unique = new Set(config.allianceTenants);
  if (unique.size !== config.allianceTenants.length) {
    throw new Error("allianceTenants must not contain duplicates");
  }
  const episodeTenantIds = new Set(config.episode.tenants.map((t) => t.id));
  for (const tid of config.allianceTenants) {
    if (!episodeTenantIds.has(tid)) {
      throw new Error(`alliance tenant "${tid}" not in episode.tenants (${[...episodeTenantIds].join(", ")})`);
    }
  }
  if (!Number.isSafeInteger(config.directorPeriodTicks) || config.directorPeriodTicks < 1) {
    throw new Error(`directorPeriodTicks must be a positive integer, got ${config.directorPeriodTicks}`);
  }
  // 默认 treasury 取排序后第一个（与 allianceTenants 传入顺序无关——canonical）
  const treasuryTenant = config.treasuryTenant
    ?? [...config.allianceTenants].sort(compareCodeUnit)[0];
  if (!config.allianceTenants.includes(treasuryTenant)) {
    throw new Error(`treasuryTenant "${treasuryTenant}" must be an alliance tenant`);
  }
  return treasuryTenant;
}

/** 稳定 config hash：输入顺序不影响结果（全部 canonical 排序）。 */
function computeConfigHash(
  config: AllianceEpisodeConfig,
  treasuryTenant: string,
): string {
  const stable = JSON.stringify({
    allianceTenants: [...config.allianceTenants].sort(compareCodeUnit),
    directorKind: config.director.kind,
    directorPeriodTicks: config.directorPeriodTicks,
    treasuryTenant,
    directorFaults: [...(config.directorFaults ?? [])]
      .sort((a, b) => a.atTick - b.atTick || compareCodeUnit(a.fault, b.fault)),
    episodeTenants: [...config.episode.tenants]
      .sort((a, b) => compareCodeUnit(a.id, b.id))
      .map((t) => ({ id: t.id, planner: t.planner })),
    seed: config.episode.seed,
    ticks: config.episode.ticks,
  });
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

// ── Director fault injection ───────────────────────────────────

function faultAt(
  faults: readonly DirectorFaultEvent[] | undefined,
  tick: number,
): DirectorFaultEvent | null {
  if (faults === undefined || faults.length === 0) return null;
  for (const f of faults) {
    if (f.fault === "DISAPPEAR") {
      const duration = f.durationTicks ?? 1;
      if (tick >= f.atTick && tick < f.atTick + duration) return f;
    } else if (f.atTick === tick) {
      return f;
    }
  }
  return null;
}

/** WRONG_TENANT 变换：tenantId 环形移到下一个联盟 tenant（单条）。 */
function shiftTenant(tenantId: string, allianceTenants: readonly string[]): string {
  const sorted = [...allianceTenants].sort(compareCodeUnit);
  const idx = sorted.indexOf(tenantId);
  return sorted[(idx + 1) % sorted.length];
}

/** 静态扫描 Plan 中 SHOOT targetId ∈ allyEntityIds 的次数（no-fire 监控）。 */
function countAllyTargetShots(
  plans: Readonly<Record<string, { readonly unitActions: Readonly<Record<string, { readonly type: string; readonly targetId?: string | null }>> }>>,
  allyEntityIds: ReadonlySet<string>,
): number {
  let count = 0;
  for (const plan of Object.values(plans)) {
    for (const action of Object.values(plan.unitActions)) {
      const targetId = action.targetId ?? null;
      if (action.type === "SHOOT" && targetId !== null && allyEntityIds.has(targetId)) {
        count += 1;
      }
    }
  }
  return count;
}

// ── runAllianceEpisode ─────────────────────────────────────────

/**
 * 运行一个联盟 episode。
 *
 * 时序（与 spec §17.3 对齐）：
 * 1. World before（runEpisode 单 world 循环——所有 tenant 同源）
 * 2. onBeforePlanners → member reports → snapshot → director replan → cache directives
 * 3. Per-tenant planner.decide + policyProvider（directive evaluation 记录）
 * 4. 收齐全部 plan 后一次性 settleTick（复用 runEpisode 内部 resolve）
 * 5. onTickRecorded → KPI trace
 */
export function runAllianceEpisode(config: AllianceEpisodeConfig): AllianceEpisodeResult {
  const rules = loadRulesManifest(config.episode.rulesPath);
  const treasuryTenant = validateAllianceConfig(config);

  // 跨 tick 状态
  const perTenantSightings = new Map<string, ReadonlyMap<string, EntitySighting>>();
  const directiveCache = new Map<string, AllianceDirective>(); // tenantId → latest directive
  const kpiCollector = new AllianceKpiCollector();
  const trace: MutableTraceEntry[] = [];
  let currentEntry: MutableTraceEntry | null = null;

  // Director RNG（episode seed 派生，独立流）
  const directorRng = createSeededRng(config.episode.seed + 1);

  let firstAllianceTick: number | null = null;
  let lastSnapshot: AllianceSnapshot | null = null;
  let revision = 0;

  // 每 tick 增量计数（onBeforePlanners 重置，onTickRecorded 消费）
  let tickAccepted = 0;
  let tickRejected = 0;
  let tickStale = 0;
  let tickExpired = 0;
  let tickFallback = 0;
  let tickEvalCount = 0;
  let tickDirectorErrors = 0;
  const tickEvaluations: DirectiveEvaluationTrace[] = [];

  const episodeConfig: EpisodeConfig = {
    ...config.episode,

    // H1: Alliance pre-planner hook（planner 前提供全景 SimWorld）
    onBeforePlanners: ({ tick, world }) => {
      tickAccepted = 0;
      tickRejected = 0;
      tickStale = 0;
      tickExpired = 0;
      tickFallback = 0;
      tickEvalCount = 0;
      tickDirectorErrors = 0;
      tickEvaluations.length = 0;

      if (firstAllianceTick === null) firstAllianceTick = tick;

      // 1. member reports + per-tenant sighting carry-forward
      const reports: AllianceMemberReport[] = [];
      for (const tid of config.allianceTenants) {
        const { report, currentSightings } = buildMemberReport(world, tid, rules);
        reports.push(report);
        perTenantSightings.set(
          tid,
          mergeSightings(perTenantSightings.get(tid) ?? new Map(), currentSightings, tick),
        );
      }

      // 2. Director replan（首 tick + 周期对齐：(tick - firstAllianceTick) % period === 0）
      const shouldReplan =
        lastSnapshot === null ||
        (tick - firstAllianceTick) % config.directorPeriodTicks === 0;

      let directorRan = false;
      let directiveCount = 0;
      let directorError: string | null = null;

      if (shouldReplan) {
        revision += 1;
        const snapshot = buildSnapshot(
          reports,
          perTenantSightings,
          world,
          config.allianceTenants,
          treasuryTenant,
          revision,
          tick,
        );
        lastSnapshot = snapshot;

        const fault = faultAt(config.directorFaults, tick);
        const skipDirector =
          fault !== null && (fault.fault === "NO_DIRECTIVE" || fault.fault === "DISAPPEAR");

        if (!skipDirector) {
          directorRan = true;
          try {
            const result = config.director.decide(snapshot, () => directorRng.next());
            for (const d of result.directives) {
              // WRONG_TENANT：以原 tenantId 为 key 存 shift 后的 directive——
              // 消费时 directive.tenantId ≠ tenantId → invalid reject（fail-open）。
              const stored = fault?.fault === "WRONG_TENANT"
                ? { ...d, tenantId: shiftTenant(d.tenantId, config.allianceTenants) }
                : d;
              directiveCache.set(d.tenantId, stored);
              directiveCount += 1;
            }
          } catch (err) {
            tickDirectorErrors += 1;
            directorError = (err as Error).message;
          }
        }
        // NO_DIRECTIVE / DISAPPEAR / THROW：保留旧 directive（自然 stale/expired → fallback）
      }

      // evaluations 由本 tick 的 policyProvider 填充，onTickRecorded 回填
      const entry: MutableTraceEntry = {
        tick,
        snapshotRevision: lastSnapshot?.revision ?? null,
        directorRan,
        directiveCount,
        directorError,
        evaluations: [],
      };
      trace.push(entry);
      currentEntry = entry;
    },

    // H2: Per-tenant directive evaluation（v1：只记录/评估，不改变 plan）
    policyProvider: (tenantId, tick, _state) => {
      if (!config.allianceTenants.includes(tenantId)) return null;
      tickEvalCount += 1;

      const directive = directiveCache.get(tenantId);
      if (directive === undefined) {
        tickFallback += 1;
        tickEvaluations.push({
          tenantId,
          revision: null,
          consume: false,
          reason: "no-directive",
          planSource: "baseline",
        });
        return null;
      }

      const evaluation = evaluateDirective(directive, tenantId, tick);
      if (evaluation.consume) {
        tickAccepted += 1;
        tickEvaluations.push({
          tenantId,
          revision: directive.revision,
          consume: true,
          reason: null,
          planSource: "baseline-shadow", // accepted 但不接管动作
        });
        return null; // v1：policy 不改变——shadow-only
      }

      // forced fallback：stale / expired / invalid / pending / wrong-tenant
      tickFallback += 1;
      if (evaluation.reason === "stale") tickStale += 1;
      else if (evaluation.reason === "expired") tickExpired += 1;
      else tickRejected += 1;
      tickEvaluations.push({
        tenantId,
        revision: directive.revision,
        consume: false,
        reason: evaluation.reason,
        planSource: "baseline",
      });
      return null;
    },

    // H3: KPI per-tick recording + no-fire 静态扫描
    onTickRecorded: ({ before, after, plans }) => {
      // allyEntityIds 从 pre-step world 抽联盟成员（plans 是本 tick 提交的动作）
      const allyIds = new Set<string>();
      for (const tid of config.allianceTenants) {
        const p = before.players.get(tid);
        if (p === undefined) continue;
        if (p.core !== null) allyIds.add(p.core.id);
        for (const u of p.units) allyIds.add(u.id);
      }
      const safetyRejects = countAllyTargetShots(
        plans as Readonly<Record<string, { readonly unitActions: Readonly<Record<string, { readonly type: string; readonly targetId?: string | null }>> }>>,
        allyIds,
      );

      kpiCollector.recordTick({
        world: after,
        treasuryTenant,
        directiveAccepted: tickAccepted,
        directiveRejected: tickRejected,
        directiveStale: tickStale,
        expiredDirectiveConsumed: tickExpired,
        fallbackCount: tickFallback,
        evaluationCount: tickEvalCount,
        directorErrorCount: tickDirectorErrors,
        safetyRejectCount: safetyRejects,
      });

      // 回填本 tick 的 per-tenant directive evaluation（policyProvider 已全部执行）
      if (currentEntry !== null) {
        currentEntry.evaluations = Object.freeze([...tickEvaluations]);
      }
    },
  };

  // 复用 runEpisode 的 single-world resolve 循环
  const episode: EpisodeResult = runEpisode(episodeConfig);
  const kpi = kpiCollector.finalize();

  return {
    episode,
    kpi,
    trace,
    replayFootprint: {
      seed: config.episode.seed,
      rulesVersion: rules.rulesVersion,
      directorKind: config.director.kind,
      configHash: computeConfigHash(config, treasuryTenant),
    },
  };
}

export type { PlanSource } from "./types.ts";
