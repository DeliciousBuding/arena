/**
 * Alliance shadow 快照（2026-08-08，spec Phase 1 收尾："shadow 输出 alliance snapshot"）。
 *
 * 每 interval tick 从 live TickState 提取观测（受控实体 → roster；可见敌人 →
 * 目击），累积跨 tick 目击记忆（updateSightingsTick），构建 AllianceSnapshot 写
 * JSONL（schema alliance-shadow-snapshot-v1）。只读影子：不改决策、不 submit、
 * IO 失败不阻塞（appendJsonlLine 内部吞错）。
 *
 * 生产接线默认关闭（recordAllianceShadow=false）：代码先行、零行为变化，
 * 下次自然重启时按 config 开启。
 */

import { appendJsonlLine, sanitizeValue, DEFAULT_JSONL_ROTATION } from "../telemetry/jsonl-writer.ts";
import type { TickState } from "../domain/model.ts";
import { type AllianceObservation } from "./snapshot.ts";
import { computeForceCounts } from "./counts.ts";
import { projectThreatField } from "./threat-field.ts";
import { updateSightingsTick } from "./sightings.ts";
import { type EntitySighting } from "./types.ts";
import { EMPTY_ROSTER, registerAlliedEntities, type AllianceRoster } from "./roster.ts";

export const ALLIANCE_SHADOW_INTERVAL_DEFAULT = 4;
/** 快照内敌情明细上限（防 JSONL 行过大；威胁场/统计是全量）。 */
export const ALLIANCE_SHADOW_ENEMY_LIMIT = 50;

/** 从 live TickState 提取联盟观测（受控实体 → roster id；可见敌人 → 目击）。 */
export function observationsFromState(state: TickState, tenantId: string): {
  readonly alliedIds: readonly string[];
  readonly observations: readonly AllianceObservation[];
} {
  const alliedIds: string[] = [];
  if (state.core !== null) alliedIds.push(state.core.id);
  for (const u of state.units) alliedIds.push(u.id);
  const observations: AllianceObservation[] = state.visibleEnemies.map((e) => ({
    tenantId,
    tick: state.tick,
    kind: e.kind,
    entityId: e.id,
    ownerUsername: e.ownerUsername,
    unitType: e.unitType,
    controlled: false,
    position: e.position,
    evidence: "LIVE",
  }));
  return { alliedIds, observations };
}

export interface AllianceShadowRecordV1 {
  readonly schema: "alliance-shadow-snapshot-v1";
  readonly processRunId: string;
  readonly tenantId: string;
  readonly tick: number;
  readonly counts: {
    readonly currentVisibleCombat: number;
    readonly recentUniqueCombat: number;
    readonly historicalSightingCount: number;
    readonly estimatedForce: number;
  };
  readonly allyCount: number;
  readonly sightingCount: number;
  readonly threat: {
    readonly cells: number;
    readonly maxDirect: readonly [number, number] | null;
    readonly estimatedCombatForce: number;
  };
  readonly treasuryTenant: string;
  readonly enemies: readonly {
    readonly key: string;
    readonly kind: string;
    readonly unitType?: string;
    readonly owner?: string;
    readonly position: readonly [number, number];
    readonly lastSeenTick: number;
    readonly currentlyVisible: boolean;
    readonly confidence: number;
  }[];
}

export interface AllianceShadowWriterOptions {
  readonly tenantId: string;
  readonly processRunId: string;
  readonly path: string;
  /** 每 N tick 输出一帧（默认 4，spec §7.2 alliance loop 建议）。 */
  readonly intervalTicks?: number;
  readonly rotation?: typeof DEFAULT_JSONL_ROTATION;
}

/** 影子快照写入器：累积目击记忆 + roster，按 interval 输出 JSONL 帧。 */
export class AllianceShadowWriter {
  private readonly tenantId: string;
  private readonly processRunId: string;
  private readonly path: string;
  private readonly intervalTicks: number;
  private readonly rotation: typeof DEFAULT_JSONL_ROTATION;
  private sightings: readonly EntitySighting[] = [];
  private roster: AllianceRoster = EMPTY_ROSTER;
  private lastWrittenTick = -Infinity;
  /** 原始战斗目击条数（含重复，审计口径——去重后条数不保留重复信息）。 */
  private rawCombatCount = 0;

  constructor(options: AllianceShadowWriterOptions) {
    this.tenantId = options.tenantId;
    this.processRunId = options.processRunId;
    this.path = options.path;
    this.intervalTicks = options.intervalTicks ?? ALLIANCE_SHADOW_INTERVAL_DEFAULT;
    this.rotation = options.rotation ?? DEFAULT_JSONL_ROTATION;
  }

  /** 每 tick 调用（onTick 钩子内）：累积观测，到 interval 边界输出一帧。 */
  onState(state: TickState): void {
    const { alliedIds, observations } = observationsFromState(state, this.tenantId);
    this.roster = registerAlliedEntities(this.roster, {
      tenantId: this.tenantId,
      ownerUsername: state.core?.ownerUsername ?? null,
      entityIds: alliedIds,
      tick: state.tick,
    });
    const rawObservations = observations.map((o) => ({
      kind: o.kind,
      unitType: o.unitType,
      entityId: o.entityId,
      ownerUsername: o.ownerUsername,
      position: o.position,
      sourceTenant: o.tenantId,
      tick: o.tick,
      evidence: o.evidence,
    }));
    this.sightings = updateSightingsTick(this.sightings, rawObservations, state.tick);
    this.rawCombatCount += observations.filter(
      (o) => !o.controlled && o.kind === "UNIT" && (o.unitType === "VANGUARD" || o.unitType === "RANGER"),
    ).length;
    if (state.tick - this.lastWrittenTick < this.intervalTicks) return;
    this.lastWrittenTick = state.tick;
    // 以累积 sightings 为准（跨 tick 记忆）直接统计 + 投影，不经空观测重建。
    const counts = computeForceCounts(this.sightings, state.tick, { historicalSightingCount: this.rawCombatCount });
    const threat = projectThreatField(this.sightings, state.tick);
    const record = this.toRecord(state.tick, counts, threat.cells.size, threat.maxDirect?.position ?? null, threat.estimatedCombatForce);
    appendJsonlLine(this.path, JSON.stringify(sanitizeValue(record)), this.rotation);
  }

  private toRecord(
    tick: number,
    counts: { currentVisibleCombat: number; recentUniqueCombat: number; historicalSightingCount: number; estimatedForce: number },
    threatCells: number,
    maxDirect: readonly [number, number] | null,
    estimatedCombatForce: number,
  ): AllianceShadowRecordV1 {
    const enemies = [...this.sightings]
      .sort((a, b) => b.lastSeenTick - a.lastSeenTick)
      .slice(0, ALLIANCE_SHADOW_ENEMY_LIMIT)
      .map((s) => ({
        key: s.key,
        kind: s.kind,
        unitType: s.unitType,
        owner: s.ownerUsername,
        position: s.position,
        lastSeenTick: s.lastSeenTick,
        currentlyVisible: s.currentlyVisible,
        confidence: s.confidence,
      }));
    return {
      schema: "alliance-shadow-snapshot-v1",
      processRunId: this.processRunId,
      tenantId: this.tenantId,
      tick,
      counts: {
        currentVisibleCombat: counts.currentVisibleCombat,
        recentUniqueCombat: counts.recentUniqueCombat,
        historicalSightingCount: counts.historicalSightingCount,
        estimatedForce: counts.estimatedForce,
      },
      allyCount: this.roster.allyEntityIds.size,
      sightingCount: this.sightings.length,
      threat: { cells: threatCells, maxDirect, estimatedCombatForce },
      treasuryTenant: "",
      enemies,
    };
  }
}
