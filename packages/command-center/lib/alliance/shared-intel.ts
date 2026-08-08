/**
 * Alliance shared-intelligence fusion.
 *
 * Pure, deterministic, JSON-serializable views over tenant reports and sightings.
 * Historical knowledge is intentionally separated from current/fresh force estimates.
 */

import type { EntitySighting, EvidenceKind } from "./types.ts";
import type { AllianceMemberReport } from "./control-types.ts";

export interface SharedIntelConfig {
  /** A visible sighting older than this is not considered currently live. */
  readonly liveWindowTicks: number;
  /** Sightings inside this window contribute to recent force/threat estimates. */
  readonly freshnessWindowTicks: number;
  /** Confidence decay time constant in ticks. */
  readonly confidenceTauTicks: number;
  /** Minimum decayed confidence retained for historical knowledge. */
  readonly confidenceFloor: number;
}

export const DEFAULT_SHARED_INTEL_CONFIG: SharedIntelConfig = Object.freeze({
  liveWindowTicks: 1,
  freshnessWindowTicks: 8,
  confidenceTauTicks: 8,
  confidenceFloor: 0.05,
});

export type IntelFreshness = "LIVE" | "RECENT" | "HISTORICAL";

export interface FusedEntitySighting extends EntitySighting {
  readonly sourceTenants: readonly string[];
  readonly ageTicks: number;
  readonly decayedConfidence: number;
  readonly freshness: IntelFreshness;
}

export interface SharedIntelCounts {
  readonly currentEnemyUnits: number;
  readonly currentEnemyCores: number;
  readonly recentEnemyUnits: number;
  readonly recentEnemyCores: number;
  readonly historicalEnemyUnits: number;
  readonly historicalEnemyCores: number;
}

export interface SharedIntelView {
  readonly currentTick: number;
  readonly memberReports: readonly AllianceMemberReport[];
  readonly currentlyVisible: readonly FusedEntitySighting[];
  readonly recentFused: readonly FusedEntitySighting[];
  readonly historicalKnown: readonly FusedEntitySighting[];
  readonly counts: SharedIntelCounts;
}

export interface AggregateAllianceIntelInput {
  readonly reports?: readonly AllianceMemberReport[];
  readonly sightings?: readonly EntitySighting[];
  readonly allyEntityIds?: ReadonlySet<string> | readonly string[];
  readonly currentTick: number;
  readonly config?: Partial<SharedIntelConfig>;
}

const EVIDENCE_RANK: Readonly<Record<EvidenceKind, number>> = Object.freeze({
  LIVE: 4,
  CALIBRATION: 3,
  LEADERBOARD: 2,
  HISTORY: 1,
});

function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function sanitizeNonNegativeInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

export function resolveSharedIntelConfig(config: Partial<SharedIntelConfig> = {}): SharedIntelConfig {
  const liveWindowTicks = sanitizeNonNegativeInt(
    config.liveWindowTicks ?? DEFAULT_SHARED_INTEL_CONFIG.liveWindowTicks,
    DEFAULT_SHARED_INTEL_CONFIG.liveWindowTicks,
  );
  const freshnessWindowTicks = Math.max(
    liveWindowTicks,
    sanitizeNonNegativeInt(
      config.freshnessWindowTicks ?? DEFAULT_SHARED_INTEL_CONFIG.freshnessWindowTicks,
      DEFAULT_SHARED_INTEL_CONFIG.freshnessWindowTicks,
    ),
  );
  const confidenceTauTicks = Math.max(
    Number.EPSILON,
    finiteOr(config.confidenceTauTicks ?? DEFAULT_SHARED_INTEL_CONFIG.confidenceTauTicks, DEFAULT_SHARED_INTEL_CONFIG.confidenceTauTicks),
  );
  const confidenceFloor = clamp01(
    finiteOr(config.confidenceFloor ?? DEFAULT_SHARED_INTEL_CONFIG.confidenceFloor, DEFAULT_SHARED_INTEL_CONFIG.confidenceFloor),
  );
  return Object.freeze({ liveWindowTicks, freshnessWindowTicks, confidenceTauTicks, confidenceFloor });
}

function sightingAge(lastSeenTick: number, currentTick: number): number {
  const last = finiteOr(lastSeenTick, currentTick);
  const now = finiteOr(currentTick, last);
  return Math.max(0, Math.trunc(now - last));
}

function decayedConfidence(sighting: EntitySighting, ageTicks: number, config: SharedIntelConfig): number {
  // Malformed confidence is fail-safe: it contributes no threat rather than being
  // promoted to the historical confidence floor.
  if (!Number.isFinite(sighting.confidence)) return 0;
  const base = clamp01(sighting.confidence);
  if (base === 0) return 0;
  const decayed = base * Math.exp(-ageTicks / config.confidenceTauTicks);
  return clamp01(Math.max(config.confidenceFloor, decayed));
}

function winnerCompare(a: EntitySighting, b: EntitySighting): number {
  if (a.lastSeenTick !== b.lastSeenTick) return b.lastSeenTick - a.lastSeenTick;
  if (a.currentlyVisible !== b.currentlyVisible) return a.currentlyVisible ? -1 : 1;
  const evidence = EVIDENCE_RANK[b.evidence] - EVIDENCE_RANK[a.evidence];
  if (evidence !== 0) return evidence;
  const confidence = clamp01(b.confidence) - clamp01(a.confidence);
  if (confidence !== 0) return confidence;
  const tenant = stableCompare(a.sourceTenant, b.sourceTenant);
  if (tenant !== 0) return tenant;
  const owner = stableCompare(a.ownerUsername ?? "", b.ownerUsername ?? "");
  if (owner !== 0) return owner;
  const kind = stableCompare(a.kind, b.kind);
  if (kind !== 0) return kind;
  if (a.position[0] !== b.position[0]) return a.position[0] - b.position[0];
  return a.position[1] - b.position[1];
}

function classifyFreshness(
  winner: EntitySighting,
  ageTicks: number,
  config: SharedIntelConfig,
): IntelFreshness {
  if (winner.currentlyVisible && ageTicks <= config.liveWindowTicks) return "LIVE";
  if (ageTicks <= config.freshnessWindowTicks) return "RECENT";
  return "HISTORICAL";
}

function fusedCompare(a: FusedEntitySighting, b: FusedEntitySighting): number {
  const key = stableCompare(a.key, b.key);
  if (key !== 0) return key;
  return winnerCompare(a, b);
}

/**
 * Deterministically deduplicate sightings by entity key.
 *
 * Winner precedence:
 * newer lastSeenTick > currentlyVisible > evidence > confidence > sourceTenant.
 * All contributing source tenants are retained as a sorted union.
 */
export function fuseEntitySightings(
  sightings: readonly EntitySighting[],
  currentTick: number,
  configInput: Partial<SharedIntelConfig> = {},
): readonly FusedEntitySighting[] {
  const config = resolveSharedIntelConfig(configInput);
  const byKey = new Map<string, EntitySighting[]>();
  for (const sighting of sightings) {
    if (typeof sighting.key !== "string" || sighting.key.length === 0) continue;
    const bucket = byKey.get(sighting.key);
    if (bucket === undefined) byKey.set(sighting.key, [sighting]);
    else bucket.push(sighting);
  }

  const out: FusedEntitySighting[] = [];
  for (const key of [...byKey.keys()].sort(stableCompare)) {
    const bucket = byKey.get(key)!;
    const sorted = [...bucket].sort(winnerCompare);
    const winner = sorted[0]!;
    const sources = [...new Set(bucket.map((s) => s.sourceTenant))].sort(stableCompare);
    const ageTicks = sightingAge(winner.lastSeenTick, currentTick);
    const confidence = clamp01(winner.confidence);
    out.push({
      ...winner,
      confidence,
      sourceTenants: sources,
      ageTicks,
      decayedConfidence: decayedConfidence(winner, ageTicks, config),
      freshness: classifyFreshness(winner, ageTicks, config),
    });
  }
  return out.sort(fusedCompare);
}

/**
 * Build the Alliance shared-intel view.
 *
 * Historical sightings remain queryable but never inflate current/fresh force counts.
 * Ally entity IDs are removed before any enemy aggregation or threat projection.
 */
export function aggregateAllianceIntel(input: AggregateAllianceIntelInput): SharedIntelView {
  const config = resolveSharedIntelConfig(input.config);
  const allyIds = new Set<string>(
    input.allyEntityIds instanceof Set ? [...input.allyEntityIds] : [...(input.allyEntityIds ?? [])],
  );
  const filtered = (input.sightings ?? []).filter((s) => !allyIds.has(s.key) && (s.entityId === undefined || !allyIds.has(s.entityId)));
  const historicalKnown = [...fuseEntitySightings(filtered, input.currentTick, config)];
  const currentlyVisible = historicalKnown.filter((s) => s.freshness === "LIVE");
  const recentFused = historicalKnown.filter((s) => s.freshness !== "HISTORICAL");
  const reports = [...(input.reports ?? [])].sort((a, b) => stableCompare(a.tenantId, b.tenantId) || a.tick - b.tick);

  const countKind = (items: readonly FusedEntitySighting[], kind: EntitySighting["kind"]): number =>
    items.reduce((sum, s) => sum + (s.kind === kind ? 1 : 0), 0);

  return {
    currentTick: sanitizeNonNegativeInt(input.currentTick, 0),
    memberReports: reports,
    currentlyVisible,
    recentFused,
    historicalKnown,
    counts: {
      currentEnemyUnits: countKind(currentlyVisible, "UNIT"),
      currentEnemyCores: countKind(currentlyVisible, "CORE"),
      recentEnemyUnits: countKind(recentFused, "UNIT"),
      recentEnemyCores: countKind(recentFused, "CORE"),
      historicalEnemyUnits: countKind(historicalKnown, "UNIT"),
      historicalEnemyCores: countKind(historicalKnown, "CORE"),
    },
  };
}
