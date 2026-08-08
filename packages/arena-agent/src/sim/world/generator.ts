/**
 * W53 survey-calibrated procedural terrain generator.
 *
 * Key modelling choice: chunk support probability and conditional density are
 * separate. Survey data is sparse: a minority of observed chunks contain known
 * obstacles/resources, while non-empty obstacle chunks can be dense. Treating
 * conditional density as whole-map density creates unrealistically wall-heavy
 * worlds.
 */

import type { Position } from "../../domain/model.ts";
import { mulberry32 } from "../deterministic/rng.ts";
import { compareCodeUnit } from "../deterministic/uuid.ts";
import { CHUNK_SIZE, chunkBounds, chunkKey, chunkOf, chunkQuota } from "./chunks.ts";

export interface WorldDistributionProfileV1 {
  readonly schema: "sim.world-distribution.v1";
  readonly source: string;
  readonly observedChunks: number;
  /** Probability an observed chunk belongs to the natural-resource support. */
  readonly resourceChunkProbability: number;
  /** Probability an observed chunk contains at least one permanent obstacle. */
  readonly obstacleChunkProbability: number;
  /** Conditional obstacle densities among obstacle-bearing chunks. */
  readonly obstacleDensityP10: number;
  readonly obstacleDensityP50: number;
  readonly obstacleDensityP90: number;
  /** Hard component cap. Generated clusters are intentionally <= this bound. */
  readonly maxObstacleComponentSize: number;
  /** Diagnostic live-world player spacing; not consumed by terrain generation. */
  readonly coreNearestChebyshev?: Readonly<{ p10: number; p50: number; p90: number }>;
}

/**
 * Snapshot calibrated from the union of t1-t4 survey DBs on 2026-08-09.
 * These are partial-observation empirical parameters, not server ground truth.
 */
export const W53_GENERATOR_PROFILE_20260809: WorldDistributionProfileV1 = Object.freeze({
  schema: "sim.world-distribution.v1",
  source: "hybrid:survey:t1-t4-union:2026-08-09+arena-evolve-live-calibration",
  observedChunks: 364,
  // Resource support comes from the independent 121/187 explored-chunk calibration
  // in arena-evolve. Our four survey DBs only provide an 8.24% observed lower bound.
  resourceChunkProbability: 0.65,
  // Official-style/reference terrain generates a density draw for every chunk;
  // our 9.34% survey figure is again a partial-observation lower bound.
  obstacleChunkProbability: 1,
  obstacleDensityP10: 6.5 / (CHUNK_SIZE * CHUNK_SIZE),
  obstacleDensityP50: 40.5 / (CHUNK_SIZE * CHUNK_SIZE),
  obstacleDensityP90: 160.8 / (CHUNK_SIZE * CHUNK_SIZE),
  maxObstacleComponentSize: 12,
  coreNearestChebyshev: Object.freeze({ p10: 4, p50: 14, p90: 28 }),
});

export interface GeneratedTerrain {
  readonly obstacles: readonly Position[];
  readonly resources: readonly Position[];
  readonly activeResourceChunks: readonly string[];
  readonly obstacleChunks: readonly string[];
}

export interface GeneratedTerrainOptions {
  readonly profile?: WorldDistributionProfileV1;
  readonly reservedCells?: ReadonlySet<string>;
}

export interface SurveyWorldCalibrationInput {
  readonly observedChunkKeys: readonly string[];
  readonly resourceCells: readonly Position[];
  readonly obstacleCells: readonly Position[];
  readonly coreSightings: readonly {
    readonly owner: string;
    readonly position: Position;
    readonly lastSeenTick: number;
  }[];
}

export interface WorldCalibrationReportV1 {
  readonly schema: "sim.world-calibration-report.v1";
  readonly profile: WorldDistributionProfileV1;
  readonly diagnostics: Readonly<{
    uniqueResourceCells: number;
    uniqueObstacleCells: number;
    uniqueCoreOwners: number;
    resourceBearingChunks: number;
    obstacleBearingChunks: number;
    observedResourceBearingFraction: number;
    observedObstacleBearingFraction: number;
    observedObstacleComponentMax: number;
    observedObstacleComponentsOver12: number;
    conditionalResourceCount: Readonly<{ p10: number; p50: number; p90: number; max: number }>;
    conditionalObstacleCount: Readonly<{ p10: number; p50: number; p90: number; max: number }>;
  }>;
}

export interface WorldCalibrationPriors {
  /** Independent estimate used by generation; observed survey support remains diagnostic. */
  readonly resourceChunkProbability?: number;
  readonly obstacleChunkProbability?: number;
}

function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const low = Math.floor(index);
  const high = Math.min(low + 1, sorted.length - 1);
  const fraction = index - low;
  return sorted[low]! * (1 - fraction) + sorted[high]! * fraction;
}

function componentSizes(cells: ReadonlySet<string>): number[] {
  const left = new Set(cells);
  const sizes: number[] = [];
  while (left.size > 0) {
    const first = left.values().next().value as string;
    left.delete(first);
    const comma = first.indexOf(",");
    const stack: Position[] = [[Number(first.slice(0, comma)), Number(first.slice(comma + 1))]];
    let size = 0;
    while (stack.length > 0) {
      const [x, y] = stack.pop()!;
      size += 1;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
        const key = cellKey(nx, ny);
        if (!left.delete(key)) continue;
        stack.push([nx, ny]);
      }
    }
    sizes.push(size);
  }
  return sizes;
}

/** Pure survey -> distribution reduction; DB access stays in the calibration CLI. */
export function calibrateWorldDistribution(
  input: SurveyWorldCalibrationInput,
  source: string,
  priors: WorldCalibrationPriors = {},
): WorldCalibrationReportV1 {
  const observedChunks = new Set(input.observedChunkKeys);
  if (observedChunks.size === 0) throw new Error("world calibration requires observed chunks");
  const resourceKeys = new Set(input.resourceCells.map(([x, y]) => cellKey(x, y)));
  const obstacleKeys = new Set(input.obstacleCells.map(([x, y]) => cellKey(x, y)));
  const resourceCounts = new Map<string, number>();
  const obstacleCounts = new Map<string, number>();
  for (const key of resourceKeys) {
    const comma = key.indexOf(",");
    const [cx, cy] = chunkOf(Number(key.slice(0, comma)), Number(key.slice(comma + 1)));
    const ck = chunkKey(cx, cy);
    if (observedChunks.has(ck)) resourceCounts.set(ck, (resourceCounts.get(ck) ?? 0) + 1);
  }
  for (const key of obstacleKeys) {
    const comma = key.indexOf(",");
    const [cx, cy] = chunkOf(Number(key.slice(0, comma)), Number(key.slice(comma + 1)));
    const ck = chunkKey(cx, cy);
    if (observedChunks.has(ck)) obstacleCounts.set(ck, (obstacleCounts.get(ck) ?? 0) + 1);
  }
  const resourceNonzero = [...resourceCounts.values()];
  const obstacleNonzero = [...obstacleCounts.values()];

  const latestCores = new Map<string, { position: Position; tick: number }>();
  for (const sighting of input.coreSightings) {
    const previous = latestCores.get(sighting.owner);
    if (previous === undefined || sighting.lastSeenTick > previous.tick) {
      latestCores.set(sighting.owner, { position: sighting.position, tick: sighting.lastSeenTick });
    }
  }
  const corePositions = [...latestCores.values()].map((entry) => entry.position);
  const nearest: number[] = [];
  for (let i = 0; i < corePositions.length; i += 1) {
    let best = Number.POSITIVE_INFINITY;
    for (let j = 0; j < corePositions.length; j += 1) {
      if (i === j) continue;
      best = Math.min(
        best,
        Math.max(
          Math.abs(corePositions[i]![0] - corePositions[j]![0]),
          Math.abs(corePositions[i]![1] - corePositions[j]![1]),
        ),
      );
    }
    if (Number.isFinite(best)) nearest.push(best);
  }
  const components = componentSizes(obstacleKeys);
  const cellsPerChunk = CHUNK_SIZE * CHUNK_SIZE;
  const profile: WorldDistributionProfileV1 = Object.freeze({
    schema: "sim.world-distribution.v1",
    source,
    observedChunks: observedChunks.size,
    resourceChunkProbability: priors.resourceChunkProbability ?? resourceCounts.size / observedChunks.size,
    obstacleChunkProbability: priors.obstacleChunkProbability ?? obstacleCounts.size / observedChunks.size,
    obstacleDensityP10: quantile(obstacleNonzero, 0.1) / cellsPerChunk,
    obstacleDensityP50: quantile(obstacleNonzero, 0.5) / cellsPerChunk,
    obstacleDensityP90: quantile(obstacleNonzero, 0.9) / cellsPerChunk,
    maxObstacleComponentSize: 12,
    coreNearestChebyshev: Object.freeze({
      p10: quantile(nearest, 0.1),
      p50: quantile(nearest, 0.5),
      p90: quantile(nearest, 0.9),
    }),
  });
  validateWorldDistributionProfile(profile);
  return Object.freeze({
    schema: "sim.world-calibration-report.v1",
    profile,
    diagnostics: Object.freeze({
      uniqueResourceCells: resourceKeys.size,
      uniqueObstacleCells: obstacleKeys.size,
      uniqueCoreOwners: latestCores.size,
      resourceBearingChunks: resourceCounts.size,
      obstacleBearingChunks: obstacleCounts.size,
      observedResourceBearingFraction: resourceCounts.size / observedChunks.size,
      observedObstacleBearingFraction: obstacleCounts.size / observedChunks.size,
      observedObstacleComponentMax: components.length === 0 ? 0 : Math.max(...components),
      observedObstacleComponentsOver12: components.filter((size) => size > 12).length,
      conditionalResourceCount: Object.freeze({
        p10: quantile(resourceNonzero, 0.1),
        p50: quantile(resourceNonzero, 0.5),
        p90: quantile(resourceNonzero, 0.9),
        max: resourceNonzero.length === 0 ? 0 : Math.max(...resourceNonzero),
      }),
      conditionalObstacleCount: Object.freeze({
        p10: quantile(obstacleNonzero, 0.1),
        p50: quantile(obstacleNonzero, 0.5),
        p90: quantile(obstacleNonzero, 0.9),
        max: obstacleNonzero.length === 0 ? 0 : Math.max(...obstacleNonzero),
      }),
    }),
  });
}

function validateProbability(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be in [0,1]`);
}

export function validateWorldDistributionProfile(profile: WorldDistributionProfileV1): void {
  if (profile.schema !== "sim.world-distribution.v1") throw new Error("unsupported world distribution schema");
  validateProbability(profile.resourceChunkProbability, "resourceChunkProbability");
  validateProbability(profile.obstacleChunkProbability, "obstacleChunkProbability");
  for (const [name, value] of [
    ["obstacleDensityP10", profile.obstacleDensityP10],
    ["obstacleDensityP50", profile.obstacleDensityP50],
    ["obstacleDensityP90", profile.obstacleDensityP90],
  ] as const) validateProbability(value, name);
  if (!(profile.obstacleDensityP10 <= profile.obstacleDensityP50 && profile.obstacleDensityP50 <= profile.obstacleDensityP90)) {
    throw new Error("obstacle density quantiles must be monotone");
  }
  if (!Number.isSafeInteger(profile.maxObstacleComponentSize) || profile.maxObstacleComponentSize < 1) {
    throw new Error("maxObstacleComponentSize must be a positive safe integer");
  }
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** W47/W53 global clear backbone: all chunk-boundary grid lines remain obstacle/resource free. */
export function isGeneratedBackboneCell(x: number, y: number): boolean {
  const mx = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const my = ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  return mx === 0 || my === 0;
}

function mix32(value: number): number {
  let x = value | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function chunkSeed(seed: number, cx: number, cy: number, stream: number): number {
  return mix32(
    mix32(seed) ^
    Math.imul(cx | 0, 0x9e3779b1) ^
    Math.imul(cy | 0, 0x85ebca6b) ^
    Math.imul(stream | 0, 0xc2b2ae35),
  );
}

function conditionalObstacleDensity(random: () => number, profile: WorldDistributionProfileV1): number {
  const u = random();
  if (u < 0.5) {
    const t = u / 0.5;
    return profile.obstacleDensityP10 + (profile.obstacleDensityP50 - profile.obstacleDensityP10) * t;
  }
  const t = (u - 0.5) / 0.5;
  return profile.obstacleDensityP50 + (profile.obstacleDensityP90 - profile.obstacleDensityP50) * t;
}

function shuffledAvailableCells(
  cx: number,
  cy: number,
  random: () => number,
  reserved: ReadonlySet<string>,
): Position[] {
  const bounds = chunkBounds(cx, cy);
  const cells: Position[] = [];
  for (let y = bounds.y0; y < bounds.y1; y += 1) {
    for (let x = bounds.x0; x < bounds.x1; x += 1) {
      if (isGeneratedBackboneCell(x, y) || reserved.has(cellKey(x, y))) continue;
      cells.push([x, y]);
    }
  }
  // Deterministic Fisher-Yates.
  for (let i = cells.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [cells[i], cells[j]] = [cells[j]!, cells[i]!];
  }
  return cells;
}

function addSeparatedObstacleCluster(
  obstacles: Set<string>,
  cx: number,
  cy: number,
  anchor: Position,
  width: number,
  height: number,
  targetCount: number,
  reserved: ReadonlySet<string>,
): number {
  const bounds = chunkBounds(cx, cy);
  const candidates: Position[] = [];
  for (let dy = 0; dy < height; dy += 1) {
    for (let dx = 0; dx < width; dx += 1) {
      const x = anchor[0] + dx;
      const y = anchor[1] + dy;
      if (x < bounds.x0 || x >= bounds.x1 || y < bounds.y0 || y >= bounds.y1) return 0;
      const key = cellKey(x, y);
      if (isGeneratedBackboneCell(x, y) || reserved.has(key) || obstacles.has(key)) return 0;
      candidates.push([x, y]);
    }
  }
  // Keep clusters disconnected in 4-neighbour topology. This guarantees each
  // connected component is at most the rectangle size (<=4), stricter than 12.
  const own = new Set(candidates.map(([x, y]) => cellKey(x, y)));
  for (const [x, y] of candidates) {
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      const key = cellKey(nx, ny);
      if (!own.has(key) && obstacles.has(key)) return 0;
    }
  }
  let added = 0;
  for (const [x, y] of candidates) {
    if (obstacles.size >= targetCount) break;
    obstacles.add(cellKey(x, y));
    added += 1;
  }
  return added;
}

/**
 * Generate terrain over an explicit chunk set. Each chunk uses an independent
 * deterministic random stream so adding remote chunks does not perturb existing
 * chunks (important for counterfactual/common-random-number stability).
 */
export function generateTerrainForChunks(
  seed: number,
  chunks: readonly (readonly [number, number])[],
  options: GeneratedTerrainOptions = {},
): GeneratedTerrain {
  if (!Number.isSafeInteger(seed)) throw new Error("generated terrain seed must be a safe integer");
  const profile = options.profile ?? W53_GENERATOR_PROFILE_20260809;
  validateWorldDistributionProfile(profile);
  const reserved = options.reservedCells ?? new Set<string>();
  const resourceKeys = new Set<string>();
  const obstacleKeys = new Set<string>();
  const activeResourceChunks: string[] = [];
  const obstacleChunks: string[] = [];
  const sortedChunks = [...chunks].sort(([ax, ay], [bx, by]) => compareCodeUnit(chunkKey(ax, ay), chunkKey(bx, by)));

  for (const [cx, cy] of sortedChunks) {
    const resourceRandom = mulberry32(chunkSeed(seed, cx, cy, 1));
    const resourceActive = resourceRandom() < profile.resourceChunkProbability;
    if (resourceActive) {
      activeResourceChunks.push(chunkKey(cx, cy));
      const cells = shuffledAvailableCells(cx, cy, resourceRandom, reserved);
      const count = Math.min(chunkQuota(cx, cy), cells.length);
      for (let i = 0; i < count; i += 1) resourceKeys.add(cellKey(cells[i]![0], cells[i]![1]));
    }

    const obstacleRandom = mulberry32(chunkSeed(seed, cx, cy, 2));
    if (obstacleRandom() >= profile.obstacleChunkProbability) continue;
    obstacleChunks.push(chunkKey(cx, cy));
    const target = Math.max(1, Math.round(conditionalObstacleDensity(obstacleRandom, profile) * CHUNK_SIZE * CHUNK_SIZE));
    const blocked = new Set([...reserved, ...resourceKeys]);
    const cells = shuffledAvailableCells(cx, cy, obstacleRandom, blocked);
    let attempts = 0;
    let cursor = 0;
    const baseCount = obstacleKeys.size;
    while (obstacleKeys.size - baseCount < target && cursor < cells.length && attempts < cells.length * 4) {
      const anchor = cells[cursor++]!;
      let width = obstacleRandom() < 0.5 ? 1 : 2;
      let height = obstacleRandom() < 0.5 ? 1 : 2;
      while (width * height > profile.maxObstacleComponentSize) {
        if (width >= height && width > 1) width -= 1;
        else if (height > 1) height -= 1;
        else break;
      }
      addSeparatedObstacleCluster(obstacleKeys, cx, cy, anchor, width, height, baseCount + target, blocked);
      attempts += 1;
    }
  }

  const parse = (key: string): Position => {
    const comma = key.indexOf(",");
    return [Number(key.slice(0, comma)), Number(key.slice(comma + 1))];
  };
  const sortCells = (values: Set<string>): Position[] => [...values]
    .sort(compareCodeUnit)
    .map(parse);
  return Object.freeze({
    obstacles: Object.freeze(sortCells(obstacleKeys)),
    resources: Object.freeze(sortCells(resourceKeys)),
    activeResourceChunks: Object.freeze([...activeResourceChunks]),
    obstacleChunks: Object.freeze([...obstacleChunks]),
  });
}

export function squareChunkWindow(radius: number): readonly (readonly [number, number])[] {
  if (!Number.isSafeInteger(radius) || radius < 0) throw new Error("chunk window radius must be a non-negative safe integer");
  const chunks: (readonly [number, number])[] = [];
  for (let cy = -radius; cy <= radius; cy += 1) {
    for (let cx = -radius; cx <= radius; cx += 1) chunks.push([cx, cy]);
  }
  return Object.freeze(chunks);
}
