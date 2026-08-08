/**
 * feature-vector-v2: translation-invariant, policy-conditioned real-outcome features.
 *
 * v2 deliberately excludes absolute world coordinates and absolute server tick.
 * Unknown telemetry/policy values are represented explicitly instead of being
 * silently normalized to a plausible default.
 */

import { parseCellKey, type Position, type TickState, type VisibleEntity } from "../../domain/model.ts";

export const FEATURE_VECTOR_V2_SCHEMA_VERSION = "feature-vector-v2" as const;
export const FEATURE_V2_DISTANCE_CLIP = 128;
export const FEATURE_V2_RESOURCE_INNER_RADIUS = 8;
export const FEATURE_V2_RESOURCE_OUTER_RADIUS = 16;
export const FEATURE_V2_OBSTACLE_RADIUS = 5;
export const FEATURE_V2_THREAT_MEMORY_TICKS = 6;

export type FeatureV2Group = "global" | "spatial" | "threat" | "policy" | "timing";

export interface FeatureV2Spec {
  readonly name: string;
  readonly group: FeatureV2Group;
  readonly description: string;
}

export type FeatureV2ThreatLevel = "NORMAL" | "ALERT" | "ENGAGED" | "BREAKOUT";
export type FeatureV2Posture =
  | "balanced"
  | "economy"
  | "defense"
  | "offense"
  | "explore"
  | "harvest"
  | "aggressive";

export interface FeatureV2Context {
  /** Decision telemetry value. null means telemetry did not expose the field. */
  readonly threatLevel: FeatureV2ThreatLevel | null;
  /** Count of non-NORMAL known threat telemetry rows in [tick-5, tick]. null = unavailable. */
  readonly recentNonNormalThreatTicks6?: number | null;
  /** ml-sample-v1 policy context. null means unknown, not a default policy. */
  readonly workerTarget: number | null;
  readonly militaryRatio: number | null;
  readonly posture: FeatureV2Posture | null;
}

export const FEATURE_V2_SPECS: readonly FeatureV2Spec[] = Object.freeze([
  { name: "resources", group: "global", description: "Core resources" },
  { name: "resource_capacity", group: "global", description: "Core resource capacity" },
  { name: "resource_ratio", group: "global", description: "resources / resource_capacity" },
  { name: "population", group: "global", description: "Controlled unit population" },
  { name: "workers", group: "global", description: "Worker count" },
  { name: "vanguards", group: "global", description: "Vanguard count" },
  { name: "rangers", group: "global", description: "Ranger count" },
  { name: "military_total", group: "global", description: "Vanguard + Ranger count" },
  { name: "core_hp", group: "global", description: "Controlled Core HP" },
  { name: "core_shield", group: "global", description: "Controlled Core shield" },
  { name: "core_moving", group: "global", description: "1 iff Core is MOVING" },
  { name: "beacon_unknown", group: "global", description: "1 iff beacon status is outside current visibility" },
  { name: "beacon_ground", group: "global", description: "1 iff visible beacon status is GROUND" },
  { name: "beacon_carried", group: "global", description: "1 iff visible beacon status is CARRIED" },
  { name: "carried_resources", group: "global", description: "Total Worker cargo" },
  { name: "deposit_ready_workers", group: "global", description: "Cargo Workers on a stationary Core cell" },
  { name: "harvest_ready_workers", group: "global", description: "Workers with cargo<2 standing on a visible resource cell" },
  { name: "visible_resource_cells", group: "global", description: "Visible resource-cell count" },

  { name: "nearest_enemy_core_dx", group: "spatial", description: "Core-relative dx to nearest visible enemy Core" },
  { name: "nearest_enemy_core_dy", group: "spatial", description: "Core-relative dy to nearest visible enemy Core" },
  { name: "nearest_enemy_core_dist", group: "spatial", description: "Clipped Chebyshev distance to nearest visible enemy Core" },
  { name: "nearest_enemy_combat_dx", group: "spatial", description: "Core-relative dx to nearest visible enemy combat unit" },
  { name: "nearest_enemy_combat_dy", group: "spatial", description: "Core-relative dy to nearest visible enemy combat unit" },
  { name: "nearest_enemy_combat_dist", group: "spatial", description: "Clipped Chebyshev distance to nearest visible enemy combat unit" },
  { name: "nearest_resource_dx", group: "spatial", description: "Core-relative dx to nearest visible resource cell" },
  { name: "nearest_resource_dy", group: "spatial", description: "Core-relative dy to nearest visible resource cell" },
  { name: "nearest_resource_dist", group: "spatial", description: "Clipped Manhattan distance to nearest visible resource cell" },
  { name: "resource_count_within_8", group: "spatial", description: "Visible resource cells within Manhattan radius 8 of Core" },
  { name: "resource_count_9_to_16", group: "spatial", description: "Visible resource cells at Manhattan distance 9..16 from Core" },
  { name: "worker_dist_core_min", group: "spatial", description: "Minimum Worker-to-Core Manhattan distance" },
  { name: "worker_dist_core_mean", group: "spatial", description: "Mean Worker-to-Core Manhattan distance" },
  { name: "worker_dist_core_max", group: "spatial", description: "Maximum Worker-to-Core Manhattan distance" },
  { name: "local_obstacle_density_r5", group: "spatial", description: "Obstacle-cell density in the Manhattan radius-5 Core neighborhood" },

  { name: "visible_enemy_units", group: "threat", description: "Visible enemy UNIT count" },
  { name: "visible_enemy_combat", group: "threat", description: "Visible enemy Vanguard/Ranger count" },
  { name: "visible_enemy_cores", group: "threat", description: "Visible enemy Core count" },
  { name: "threat_unknown", group: "threat", description: "1 iff decision telemetry threatLevel is missing" },
  { name: "threat_normal", group: "threat", description: "Threat level NORMAL" },
  { name: "threat_alert", group: "threat", description: "Threat level ALERT" },
  { name: "threat_engaged", group: "threat", description: "Threat level ENGAGED" },
  { name: "threat_breakout", group: "threat", description: "Threat level BREAKOUT" },
  { name: "owned_damage_events", group: "threat", description: "Observed damage/destruction events targeting controlled entities" },
  { name: "recent_non_normal_threat_ticks_6", group: "threat", description: "Non-NORMAL known threat telemetry rows in the latest 6 ticks; -1 iff unavailable" },

  { name: "worker_target", group: "policy", description: "Behavior-policy workerTarget; 0 iff unknown" },
  { name: "worker_target_known", group: "policy", description: "1 iff workerTarget is known" },
  { name: "military_ratio", group: "policy", description: "Behavior-policy militaryRatio; 0 iff unknown" },
  { name: "military_ratio_known", group: "policy", description: "1 iff militaryRatio is known" },
  { name: "posture_unknown", group: "policy", description: "1 iff behavior-policy posture is unknown" },
  { name: "posture_balanced", group: "policy", description: "Historical posture balanced" },
  { name: "posture_economy", group: "policy", description: "Historical posture economy" },
  { name: "posture_defense", group: "policy", description: "Historical posture defense" },
  { name: "posture_offense", group: "policy", description: "Historical posture offense" },
  { name: "posture_explore", group: "policy", description: "Historical posture explore" },
  { name: "posture_harvest", group: "policy", description: "Current MacroPolicy posture harvest" },
  { name: "posture_aggressive", group: "policy", description: "Current MacroPolicy posture aggressive" },

  { name: "refill_phase_0", group: "timing", description: "tick mod 4 == 0" },
  { name: "refill_phase_1", group: "timing", description: "tick mod 4 == 1" },
  { name: "refill_phase_2", group: "timing", description: "tick mod 4 == 2" },
  { name: "refill_phase_3", group: "timing", description: "tick mod 4 == 3" },
]);

export const FEATURE_V2_NAMES: readonly string[] = Object.freeze(FEATURE_V2_SPECS.map((spec) => spec.name));
export const FEATURE_V2_DIM = FEATURE_V2_NAMES.length;

interface RelativeNearest {
  readonly dx: number;
  readonly dy: number;
  readonly dist: number;
}

function clipSigned(value: number): number {
  return Math.max(-FEATURE_V2_DISTANCE_CLIP, Math.min(FEATURE_V2_DISTANCE_CLIP, value));
}

function manhattan(a: Position, b: Position): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function chebyshev(a: Position, b: Position): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

function nearestEntity(core: Position, entities: readonly VisibleEntity[]): RelativeNearest {
  if (entities.length === 0) return { dx: 0, dy: 0, dist: FEATURE_V2_DISTANCE_CLIP };
  const sorted = [...entities].sort((left, right) => {
    const dl = chebyshev(core, left.position);
    const dr = chebyshev(core, right.position);
    if (dl !== dr) return dl - dr;
    const ldx = left.position[0] - core[0];
    const rdx = right.position[0] - core[0];
    if (ldx !== rdx) return ldx - rdx;
    const ldy = left.position[1] - core[1];
    const rdy = right.position[1] - core[1];
    if (ldy !== rdy) return ldy - rdy;
    return left.id.localeCompare(right.id);
  });
  const position = sorted[0]!.position;
  return {
    dx: clipSigned(position[0] - core[0]),
    dy: clipSigned(position[1] - core[1]),
    dist: Math.min(FEATURE_V2_DISTANCE_CLIP, chebyshev(core, position)),
  };
}

function nearestResource(core: Position, resourceCells: ReadonlySet<string>): RelativeNearest {
  if (resourceCells.size === 0) return { dx: 0, dy: 0, dist: FEATURE_V2_DISTANCE_CLIP };
  const positions = [...resourceCells].map(parseCellKey).sort((left, right) => {
    const dl = manhattan(core, left);
    const dr = manhattan(core, right);
    if (dl !== dr) return dl - dr;
    const ldx = left[0] - core[0];
    const rdx = right[0] - core[0];
    if (ldx !== rdx) return ldx - rdx;
    return (left[1] - core[1]) - (right[1] - core[1]);
  });
  const position = positions[0]!;
  return {
    dx: clipSigned(position[0] - core[0]),
    dy: clipSigned(position[1] - core[1]),
    dist: Math.min(FEATURE_V2_DISTANCE_CLIP, manhattan(core, position)),
  };
}

function ownedDamageEvents(state: TickState): number {
  const ownedIds = new Set(state.units.map((unit) => unit.id));
  if (state.core !== null) ownedIds.add(state.core.id);
  return state.events.filter((event) => {
    if (event.eventType !== "UNIT_DAMAGED" && event.eventType !== "CORE_DAMAGED" && event.eventType !== "CORE_DESTROYED") {
      return false;
    }
    // Simulator damage events use targetId for the damaged entity. Some older/live
    // event projections exposed the damaged entity as actorId instead. Prefer the
    // explicit target when present so an owned attacker damaging an enemy is never
    // misclassified as "damage taken"; only fall back to actorId when targetId is absent.
    if (event.targetId !== null) return ownedIds.has(event.targetId);
    return event.actorId !== null && ownedIds.has(event.actorId);
  }).length;
}

function localObstacleDensity(state: TickState, core: Position): number {
  let obstacleCount = 0;
  for (const key of state.obstacleCells) {
    if (manhattan(core, parseCellKey(key)) <= FEATURE_V2_OBSTACLE_RADIUS) obstacleCount += 1;
  }
  // Number of cells in a Manhattan diamond of radius r = 1 + 2r(r+1).
  const cells = 1 + 2 * FEATURE_V2_OBSTACLE_RADIUS * (FEATURE_V2_OBSTACLE_RADIUS + 1);
  return obstacleCount / cells;
}

export function extractFeatureVectorV2(state: TickState, context: FeatureV2Context): Float64Array {
  const values: number[] = [];
  const core = state.core;
  const corePosition: Position = core?.position ?? ([0, 0] as const);
  const militaryTotal = state.vanguards.length + state.rangers.length;
  const carriedResources = state.workers.reduce((sum, worker) => sum + worker.cargo, 0);
  const depositReadyWorkers = core?.state === "NORMAL"
    ? state.workers.filter((worker) => worker.cargo > 0 && worker.position[0] === core.position[0] && worker.position[1] === core.position[1]).length
    : 0;
  const harvestReadyWorkers = state.workers.filter((worker) =>
    worker.cargo < 2 && state.resourceCells.has(`${worker.position[0]},${worker.position[1]}`),
  ).length;

  values.push(
    state.resources,
    state.resourceCapacity,
    state.resourceCapacity > 0 ? state.resources / state.resourceCapacity : 0,
    state.population,
    state.workers.length,
    state.vanguards.length,
    state.rangers.length,
    militaryTotal,
    core?.hp ?? 0,
    core?.shield ?? 0,
    core?.state === "MOVING" ? 1 : 0,
    state.beacon.status === null ? 1 : 0,
    state.beacon.status === "GROUND" ? 1 : 0,
    state.beacon.status === "CARRIED" ? 1 : 0,
    carriedResources,
    depositReadyWorkers,
    harvestReadyWorkers,
    state.resourceCells.size,
  );

  const enemyCores = state.visibleEnemies.filter((enemy) => enemy.kind === "CORE");
  const enemyCombat = state.visibleEnemies.filter((enemy) =>
    enemy.kind === "UNIT" && (enemy.unitType === "VANGUARD" || enemy.unitType === "RANGER"),
  );
  const nearestCore = nearestEntity(corePosition, enemyCores);
  const nearestCombat = nearestEntity(corePosition, enemyCombat);
  const nearestRes = nearestResource(corePosition, state.resourceCells);

  let innerResources = 0;
  let outerResources = 0;
  for (const key of state.resourceCells) {
    const distance = manhattan(corePosition, parseCellKey(key));
    if (distance <= FEATURE_V2_RESOURCE_INNER_RADIUS) innerResources += 1;
    else if (distance <= FEATURE_V2_RESOURCE_OUTER_RADIUS) outerResources += 1;
  }

  const workerDistances = state.workers.map((worker) => manhattan(corePosition, worker.position));
  const workerMin = workerDistances.length === 0 ? 0 : Math.min(...workerDistances);
  const workerMax = workerDistances.length === 0 ? 0 : Math.max(...workerDistances);
  const workerMean = workerDistances.length === 0
    ? 0
    : workerDistances.reduce((sum, value) => sum + value, 0) / workerDistances.length;

  values.push(
    nearestCore.dx, nearestCore.dy, nearestCore.dist,
    nearestCombat.dx, nearestCombat.dy, nearestCombat.dist,
    nearestRes.dx, nearestRes.dy, nearestRes.dist,
    innerResources, outerResources,
    Math.min(FEATURE_V2_DISTANCE_CLIP, workerMin),
    Math.min(FEATURE_V2_DISTANCE_CLIP, workerMean),
    Math.min(FEATURE_V2_DISTANCE_CLIP, workerMax),
    localObstacleDensity(state, corePosition),
  );

  const visibleEnemyUnits = state.visibleEnemies.filter((enemy) => enemy.kind === "UNIT").length;
  values.push(
    visibleEnemyUnits,
    enemyCombat.length,
    enemyCores.length,
    context.threatLevel === null ? 1 : 0,
    context.threatLevel === "NORMAL" ? 1 : 0,
    context.threatLevel === "ALERT" ? 1 : 0,
    context.threatLevel === "ENGAGED" ? 1 : 0,
    context.threatLevel === "BREAKOUT" ? 1 : 0,
    ownedDamageEvents(state),
    context.recentNonNormalThreatTicks6 ?? -1,
  );

  const workerTargetKnown = context.workerTarget !== null;
  const militaryRatioKnown = context.militaryRatio !== null;
  values.push(
    context.workerTarget ?? 0,
    workerTargetKnown ? 1 : 0,
    context.militaryRatio ?? 0,
    militaryRatioKnown ? 1 : 0,
    context.posture === null ? 1 : 0,
    context.posture === "balanced" ? 1 : 0,
    context.posture === "economy" ? 1 : 0,
    context.posture === "defense" ? 1 : 0,
    context.posture === "offense" ? 1 : 0,
    context.posture === "explore" ? 1 : 0,
    context.posture === "harvest" ? 1 : 0,
    context.posture === "aggressive" ? 1 : 0,
  );

  const refillPhase = ((state.tick % 4) + 4) % 4;
  values.push(
    refillPhase === 0 ? 1 : 0,
    refillPhase === 1 ? 1 : 0,
    refillPhase === 2 ? 1 : 0,
    refillPhase === 3 ? 1 : 0,
  );

  if (values.length !== FEATURE_V2_DIM) {
    throw new Error(`feature-vector-v2 implementation emitted ${values.length} values, expected ${FEATURE_V2_DIM}`);
  }
  return Float64Array.from(values);
}

export function featureVectorV2ToRecord(vector: Float64Array): Readonly<Record<string, number>> {
  const problems = validateFeatureVectorV2(vector);
  if (problems.length > 0) throw new Error(`invalid feature-vector-v2: ${problems.join("; ")}`);
  return Object.freeze(Object.fromEntries(
    FEATURE_V2_NAMES.map((name, index) => [name, Math.round(vector[index]! * 1e6) / 1e6]),
  ));
}

export function validateFeatureVectorV2(vector: Float64Array): readonly string[] {
  const problems: string[] = [];
  if (vector.length !== FEATURE_V2_DIM) {
    problems.push(`length ${vector.length} != ${FEATURE_V2_DIM}`);
  }
  for (let index = 0; index < Math.min(vector.length, FEATURE_V2_DIM); index += 1) {
    if (!Number.isFinite(vector[index]!)) problems.push(`${FEATURE_V2_NAMES[index]} is not finite`);
  }
  return problems;
}
