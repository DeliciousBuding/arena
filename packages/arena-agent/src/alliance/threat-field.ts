/**
 * Sparse Alliance threat summaries.
 *
 * This is intentionally not a dense omniscient heatmap. It consumes only fused
 * fresh/recent sightings already known by alliance members and projects them
 * relative to each member core into eight stable sectors.
 */

import type { AllianceMemberReport } from "./types.ts";
import type { FusedEntitySighting, SharedIntelView } from "./shared-intel.ts";

export type ThreatDirection = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

export interface ThreatFieldConfig {
  readonly coreWeight: number;
  readonly unitWeight: number;
  readonly distanceScale: number;
  readonly maxDistance: number;
  readonly highScoreThreshold: number;
  readonly maxSectorScore: number;
}

export const DEFAULT_THREAT_FIELD_CONFIG: ThreatFieldConfig = Object.freeze({
  coreWeight: 4,
  unitWeight: 1,
  distanceScale: 16,
  maxDistance: 96,
  highScoreThreshold: 0.55,
  maxSectorScore: 16,
});

export interface ThreatSector {
  readonly direction: ThreatDirection;
  readonly score: number;
  readonly entityCount: number;
  readonly nearestDistance: number | null;
  readonly entityKeys: readonly string[];
}

export interface TenantThreatSummary {
  readonly tenantId: string;
  readonly corePosition: readonly [number, number] | null;
  readonly sectors: readonly ThreatSector[];
  readonly highDirections: readonly ThreatDirection[];
  readonly multiDirectionPressure: boolean;
  readonly totalScore: number;
}

const DIRECTIONS: readonly ThreatDirection[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function resolveThreatFieldConfig(config: Partial<ThreatFieldConfig> = {}): ThreatFieldConfig {
  return Object.freeze({
    coreWeight: finiteNonNegative(config.coreWeight ?? DEFAULT_THREAT_FIELD_CONFIG.coreWeight, DEFAULT_THREAT_FIELD_CONFIG.coreWeight),
    unitWeight: finiteNonNegative(config.unitWeight ?? DEFAULT_THREAT_FIELD_CONFIG.unitWeight, DEFAULT_THREAT_FIELD_CONFIG.unitWeight),
    distanceScale: finitePositive(config.distanceScale ?? DEFAULT_THREAT_FIELD_CONFIG.distanceScale, DEFAULT_THREAT_FIELD_CONFIG.distanceScale),
    maxDistance: finitePositive(config.maxDistance ?? DEFAULT_THREAT_FIELD_CONFIG.maxDistance, DEFAULT_THREAT_FIELD_CONFIG.maxDistance),
    highScoreThreshold: finiteNonNegative(config.highScoreThreshold ?? DEFAULT_THREAT_FIELD_CONFIG.highScoreThreshold, DEFAULT_THREAT_FIELD_CONFIG.highScoreThreshold),
    maxSectorScore: finitePositive(config.maxSectorScore ?? DEFAULT_THREAT_FIELD_CONFIG.maxSectorScore, DEFAULT_THREAT_FIELD_CONFIG.maxSectorScore),
  });
}

export function threatDirection(
  core: readonly [number, number],
  target: readonly [number, number],
): ThreatDirection {
  const dx = target[0] - core[0];
  const dy = target[1] - core[1];
  if (dx === 0 && dy === 0) return "N";
  if (dx === 0) return dy > 0 ? "N" : "S";
  if (dy === 0) return dx > 0 ? "E" : "W";
  if (dx > 0 && dy > 0) return "NE";
  if (dx > 0 && dy < 0) return "SE";
  if (dx < 0 && dy < 0) return "SW";
  return "NW";
}

function manhattan(
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function contribution(
  sighting: FusedEntitySighting,
  distance: number,
  config: ThreatFieldConfig,
): number {
  if (distance > config.maxDistance) return 0;
  const weight = sighting.kind === "CORE" ? config.coreWeight : config.unitWeight;
  const score = weight * sighting.decayedConfidence / (1 + distance / config.distanceScale);
  return Number.isFinite(score) ? Math.max(0, score) : 0;
}

function nonAdjacentHighPressure(high: readonly ThreatDirection[]): boolean {
  if (high.length < 2) return false;
  const indices = high.map((direction) => DIRECTIONS.indexOf(direction));
  for (let i = 0; i < indices.length; i += 1) {
    for (let j = i + 1; j < indices.length; j += 1) {
      const raw = Math.abs(indices[i]! - indices[j]!);
      const circular = Math.min(raw, DIRECTIONS.length - raw);
      if (circular >= 2) return true;
    }
  }
  return false;
}

function buildTenantThreat(
  report: AllianceMemberReport,
  sightings: readonly FusedEntitySighting[],
  config: ThreatFieldConfig,
): TenantThreatSummary {
  if (report.core === null) {
    return {
      tenantId: report.tenantId,
      corePosition: null,
      sectors: DIRECTIONS.map((direction) => ({
        direction,
        score: 0,
        entityCount: 0,
        nearestDistance: null,
        entityKeys: [],
      })),
      highDirections: [],
      multiDirectionPressure: false,
      totalScore: 0,
    };
  }

  const buckets = new Map<ThreatDirection, { score: number; distances: number[]; keys: string[] }>();
  for (const direction of DIRECTIONS) buckets.set(direction, { score: 0, distances: [], keys: [] });

  for (const sighting of sightings) {
    if (sighting.kind !== "CORE" && sighting.kind !== "UNIT") continue;
    const distance = manhattan(report.core.position, sighting.position);
    const score = contribution(sighting, distance, config);
    if (score <= 0) continue;
    const direction = threatDirection(report.core.position, sighting.position);
    const bucket = buckets.get(direction)!;
    bucket.score = Math.min(config.maxSectorScore, bucket.score + score);
    bucket.distances.push(distance);
    bucket.keys.push(sighting.key);
  }

  const sectors = DIRECTIONS.map((direction): ThreatSector => {
    const bucket = buckets.get(direction)!;
    return {
      direction,
      score: Math.round(bucket.score * 1_000_000) / 1_000_000,
      entityCount: bucket.keys.length,
      nearestDistance: bucket.distances.length === 0 ? null : Math.min(...bucket.distances),
      entityKeys: [...bucket.keys].sort(stableCompare),
    };
  });
  const highDirections = sectors
    .filter((sector) => sector.score >= config.highScoreThreshold)
    .map((sector) => sector.direction);
  const totalScore = Math.round(
    sectors.reduce((sum, sector) => sum + sector.score, 0) * 1_000_000,
  ) / 1_000_000;

  return {
    tenantId: report.tenantId,
    corePosition: report.core.position,
    sectors,
    highDirections,
    multiDirectionPressure: nonAdjacentHighPressure(highDirections),
    totalScore,
  };
}

/**
 * Project sparse threats from fresh/recent shared intel.
 * Historical-only sightings are deliberately excluded.
 */
export function buildAllianceThreatSummaries(
  intel: SharedIntelView,
  configInput: Partial<ThreatFieldConfig> = {},
): readonly TenantThreatSummary[] {
  const config = resolveThreatFieldConfig(configInput);
  const reports = [...intel.memberReports].sort((a, b) => stableCompare(a.tenantId, b.tenantId));
  return reports.map((report) => buildTenantThreat(report, intel.recentFused, config));
}
