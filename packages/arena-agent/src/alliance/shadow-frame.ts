/** Pure cross-tenant shadow frame contract + deterministic snapshot aggregation. */
import { buildAllianceSnapshotFromSightings } from "./snapshot.ts";
import type { AllianceMemberState, AllianceSnapshot, EntitySighting } from "./types.ts";

export interface AllianceShadowFrameV1 {
  readonly schema: "alliance-shadow-frame-v1";
  readonly processRunId: string;
  readonly tenantId: string;
  readonly tick: number;
  readonly observedAtMs: number;
  readonly member: AllianceMemberState;
  /** Full per-tenant cross-tick memory, not the compressed JSONL projection. */
  readonly sightings: readonly EntitySighting[];
  /** Raw entity IDs only; canonical snapshot performs no-fire filtering. */
  readonly allyEntityIds: readonly string[];
  /** Raw repeated combat observations, audit-only. */
  readonly historicalSightingCount: number;
}

export interface AggregateShadowFramesInput {
  readonly revision: number;
  readonly frames: readonly AllianceShadowFrameV1[];
  readonly nowTick?: number;
  readonly generatedAtMs?: number;
  readonly treasuryTenant?: string;
}

function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function preferSighting(a: EntitySighting, b: EntitySighting): EntitySighting {
  if (a.lastSeenTick !== b.lastSeenTick) return a.lastSeenTick > b.lastSeenTick ? a : b;
  if (a.currentlyVisible !== b.currentlyVisible) return a.currentlyVisible ? a : b;
  if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a : b;
  return stableCompare(a.sourceTenant, b.sourceTenant) <= 0 ? a : b;
}

/**
 * Aggregate one latest frame per tenant into the canonical AllianceSnapshot.
 * No I/O, no wall-clock unless generatedAtMs is intentionally omitted by caller.
 */
export function aggregateAllianceShadowFrames(input: AggregateShadowFramesInput): AllianceSnapshot {
  const latestByTenant = new Map<string, AllianceShadowFrameV1>();
  for (const frame of input.frames) {
    const prev = latestByTenant.get(frame.tenantId);
    if (prev === undefined || frame.tick > prev.tick || (frame.tick === prev.tick && frame.processRunId > prev.processRunId)) {
      latestByTenant.set(frame.tenantId, frame);
    }
  }
  const latest = [...latestByTenant.values()].sort((a, b) => stableCompare(a.tenantId, b.tenantId));
  const inferredNowTick = latest.length === 0 ? 0 : Math.max(...latest.map((frame) => frame.tick));
  const nowTick = input.nowTick ?? inferredNowTick;
  const sightingsByKey = new Map<string, EntitySighting>();
  const allyEntityIds = new Set<string>();
  let historicalSightingCount = 0;
  for (const frame of latest) {
    historicalSightingCount += frame.historicalSightingCount;
    for (const id of frame.allyEntityIds) allyEntityIds.add(id);
    for (const sighting of frame.sightings) {
      const prev = sightingsByKey.get(sighting.key);
      sightingsByKey.set(sighting.key, prev === undefined ? sighting : preferSighting(prev, sighting));
    }
  }
  return buildAllianceSnapshotFromSightings({
    revision: input.revision,
    members: latest.map((frame) => frame.member),
    sightings: [...sightingsByKey.values()],
    allyEntityIds,
    nowTick,
    generatedAtMs: input.generatedAtMs,
    historicalSightingCount,
    treasuryTenant: input.treasuryTenant,
  });
}
