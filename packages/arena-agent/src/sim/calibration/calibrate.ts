/** Offline calibration runner and discrepancy classifier (S8a). */

import type { PlayerState, WorldObject } from "@arena/arena-hero-ts";
import { cellKey, type Position } from "../../domain/model.ts";
import { loadRulesManifest, manifestHash } from "../contracts/rules-manifest.ts";
import { compareCodeUnit } from "../deterministic/uuid.ts";
import type { UnknownEffect } from "../engine/phase.ts";
import { settleTick } from "../engine/settlement.ts";
import { projectPlayerState } from "../visibility/visibility.ts";
import { worldFromRawState } from "../world/loaders.ts";
import type { SimFeature, SimWorld } from "../world/types.ts";
import { assertWorldInvariants } from "../world/world.ts";
import {
  CalibrationCaseError,
  parseCalibrationCase,
  type CalibrationCaseV1,
} from "./schema.ts";

export type CalibrationStatus = "MATCH" | "MISMATCH" | "INCONCLUSIVE";
export type CalibrationDifferenceClass =
  | "STATE"
  | "ENTITY"
  | "TERRAIN"
  | "EVENT"
  | "EXPECTED_UNKNOWN"
  | "UNSUPPORTED";

export interface CalibrationDifference {
  readonly class: CalibrationDifferenceClass;
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly note: string | null;
}

export interface CalibrationReport {
  readonly schema: "sim-calibration-report-v1";
  readonly caseId: string;
  readonly status: CalibrationStatus;
  readonly rulesVersion: string;
  readonly rulesManifestHash: string;
  readonly predictedState: PlayerState | null;
  readonly observedState: PlayerState;
  readonly differences: readonly CalibrationDifference[];
  readonly unsupported: readonly SimFeature[];
  readonly unknownEffects: readonly UnknownEffect[];
}

interface ComparisonContext {
  readonly refillUnknown: boolean;
  readonly opponentUnknown: boolean;
  readonly beaconUnknown: boolean;
  readonly dynamicStateUnknown: boolean;
  readonly harvestSourceUnknown: boolean;
  readonly beforeObstacles: ReadonlySet<string>;
  readonly beforeResources: ReadonlySet<string>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(compareCodeUnit)) output[key] = canonicalize(source[key]);
  return output;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function parsePosition(position: Position): string {
  return cellKey(position);
}

function spawnIdMap(state: PlayerState): Map<string, string> {
  const ids = state.events
    .filter((event) => event.event_type === "CORE_SPAWN_SUCCEEDED" && event.target_id !== null)
    .map((event) => event.target_id!)
    .sort(compareCodeUnit);
  return new Map(ids.map((id, index) => [id, `<spawn:${index}>`]));
}

function normalizeId(id: string | null, spawnIds: ReadonlyMap<string, string>): string | null {
  if (id === null) return null;
  return spawnIds.get(id) ?? id;
}

function normalizeEntity(object: Exclude<WorldObject, { kind: "OBSTACLE" | "RESOURCE" }>, spawnIds: ReadonlyMap<string, string>): unknown {
  if (object.kind === "CORE") {
    return {
      kind: object.kind,
      id: normalizeId(object.id, spawnIds),
      controlled: object.controlled,
      owner_username: object.owner_username,
      position: parsePosition(object.position),
      hp: object.hp,
      shield: object.shield,
      state: object.state,
      move_direction: object.move_direction,
      move_progress: object.move_progress,
      move_required_ticks: object.move_required_ticks,
      destination: object.destination === null ? null : parsePosition(object.destination),
    };
  }
  return {
    kind: object.kind,
    id: normalizeId(object.id, spawnIds),
    controlled: object.controlled,
    position: parsePosition(object.position),
    hp: object.hp,
    unit_type: object.unit_type,
    cargo: object.cargo,
  };
}

function normalizeState(state: PlayerState): unknown {
  const spawnIds = spawnIdMap(state);
  const obstacles = new Set<string>();
  const resources = new Set<string>();
  const entities: Record<string, unknown> = {};
  for (const object of state.objects) {
    if (object.kind === "OBSTACLE") {
      for (const position of object.positions) obstacles.add(parsePosition(position));
    } else if (object.kind === "RESOURCE") {
      for (const position of object.positions) resources.add(parsePosition(position));
    } else {
      const normalized = normalizeEntity(
        object as Exclude<WorldObject, { kind: "OBSTACLE" | "RESOURCE" }>,
        spawnIds,
      ) as { id: string };
      entities[normalized.id] = normalized;
    }
  }

  const events = state.events.map((event) => ({
      tick: event.tick,
      event_type: event.event_type,
      reason_code: event.reason_code,
      actor_id: normalizeId(event.actor_id, spawnIds),
      target_id: normalizeId(event.target_id, spawnIds),
      position: event.position === null ? null : parsePosition(event.position),
      values: event.values,
    }));

  return {
    status: state.status,
    respawn_at_tick: state.respawn_at_tick,
    resources: state.resources,
    population: state.population,
    population_tier: state.population_tier,
    upkeep_next_tick: state.upkeep_next_tick,
    champion_beacon: {
      position: parsePosition(state.champion_beacon.position),
      status: state.champion_beacon.status,
      carrier_id: normalizeId(state.champion_beacon.carrier_id, spawnIds),
    },
    terrain: {
      obstacles: Object.fromEntries([...obstacles].sort(compareCodeUnit).map((key) => [key, true])),
      resources: Object.fromEntries([...resources].sort(compareCodeUnit).map((key) => [key, true])),
    },
    entities,
    events,
  };
}

function isUncontrolledEntity(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>).controlled === false;
}

function classifyDifference(
  path: string,
  expected: unknown,
  actual: unknown,
  context: ComparisonContext,
): CalibrationDifferenceClass {
  if (context.beaconUnknown && path.startsWith("$.champion_beacon")) return "EXPECTED_UNKNOWN";
  if (context.refillUnknown && path.startsWith("$.terrain.resources")) return "EXPECTED_UNKNOWN";
  if (context.dynamicStateUnknown && !path.startsWith("$.terrain.obstacles")) {
    return "EXPECTED_UNKNOWN";
  }
  if (
    context.harvestSourceUnknown &&
    (path.startsWith("$.events") || path.endsWith(".cargo") || path.startsWith("$.terrain.resources"))
  ) {
    return "EXPECTED_UNKNOWN";
  }
  if (path.startsWith("$.terrain.obstacles.") && expected === true && actual === undefined) {
    const key = path.slice("$.terrain.obstacles.".length);
    if (!context.beforeObstacles.has(key)) return "EXPECTED_UNKNOWN";
  }
  if (path.startsWith("$.terrain.resources.") && expected === true && actual === undefined) {
    const key = path.slice("$.terrain.resources.".length);
    if (!context.beforeResources.has(key)) return "EXPECTED_UNKNOWN";
  }
  if (context.opponentUnknown && path.startsWith("$.entities") &&
      (isUncontrolledEntity(expected) || isUncontrolledEntity(actual))) {
    return "EXPECTED_UNKNOWN";
  }
  if (path.startsWith("$.entities")) return "ENTITY";
  if (path.startsWith("$.terrain")) return "TERRAIN";
  if (path.startsWith("$.events")) return "EVENT";
  return "STATE";
}

function collectDifferences(
  expected: unknown,
  actual: unknown,
  context: ComparisonContext,
  path = "$",
  output: CalibrationDifference[] = [],
): CalibrationDifference[] {
  if (canonicalJson(expected) === canonicalJson(actual)) return output;
  const expectedRecord = typeof expected === "object" && expected !== null && !Array.isArray(expected)
    ? expected as Record<string, unknown>
    : null;
  const actualRecord = typeof actual === "object" && actual !== null && !Array.isArray(actual)
    ? actual as Record<string, unknown>
    : null;
  if (expectedRecord !== null && actualRecord !== null) {
    const keys = new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)]);
    for (const key of [...keys].sort(compareCodeUnit)) {
      collectDifferences(expectedRecord[key], actualRecord[key], context, `${path}.${key}`, output);
    }
    return output;
  }
  output.push({
    class: classifyDifference(path, expected, actual, context),
    path,
    expected,
    actual,
    note: null,
  });
  return output;
}

function hasUncontrolledObjects(state: PlayerState): boolean {
  return state.objects.some((object) =>
    (object.kind === "CORE" || object.kind === "UNIT") && object.controlled === false,
  );
}

function terrainKeys(state: PlayerState, kind: "OBSTACLE" | "RESOURCE"): Set<string> {
  const keys = new Set<string>();
  for (const object of state.objects) {
    if (object.kind !== kind) continue;
    for (const position of object.positions) keys.add(parsePosition(position));
  }
  return keys;
}

function observedDroppedCargoHarvest(calibrationCase: CalibrationCaseV1): boolean {
  const hasHarvest = Object.values(calibrationCase.plan.unitActions).some(
    (action) => action.type === "HARVEST",
  );
  if (!hasHarvest) return false;
  return calibrationCase.after.state.events.some(
    (event) =>
      event.event_type === "HARVEST_SUCCEEDED" &&
      event.values?.source === "DROPPED_CARGO",
  );
}

function controlledEntityIds(state: PlayerState): Set<string> {
  const ids = new Set<string>();
  for (const object of state.objects) {
    if ((object.kind === "CORE" || object.kind === "UNIT") && object.controlled) ids.add(object.id);
  }
  return ids;
}

function prepareWorld(calibrationCase: CalibrationCaseV1): SimWorld {
  const loaded = worldFromRawState(
    calibrationCase.before.state,
    calibrationCase.tenantId,
    calibrationCase.rulesVersion,
  );
  const controlledIds = controlledEntityIds(calibrationCase.before.state);
  const replayBeacon =
    loaded.beacon?.status === "CARRIED" &&
    loaded.beacon.carrierId !== null &&
    !controlledIds.has(loaded.beacon.carrierId)
      ? { ...loaded.beacon, status: "GROUND" as const, carrierId: null }
      : loaded.beacon;
  const world: SimWorld = {
    ...loaded,
    beacon: replayBeacon,
    tick: calibrationCase.before.tick,
    resolvedTickCount: calibrationCase.before.tick - 1,
    seed: calibrationCase.seed,
    provenance: {
      scenario: calibrationCase.caseId,
      sourceCaseHash: calibrationCase.metadata.sourceCommit,
    },
  };
  assertWorldInvariants(world);
  return world;
}

export function runCalibrationCase(rawCase: unknown, rulesPath: string): CalibrationReport {
  const calibrationCase = parseCalibrationCase(rawCase);
  const rules = loadRulesManifest(rulesPath);
  if (calibrationCase.rulesVersion !== rules.rulesVersion) {
    throw new CalibrationCaseError(
      `stale rules: case=${calibrationCase.rulesVersion}, manifest=${rules.rulesVersion}`,
    );
  }

  const beforeWorld = prepareWorld(calibrationCase);
  const result = settleTick(
    beforeWorld,
    new Map([[calibrationCase.tenantId, calibrationCase.plan]]),
    { rules, rng: null },
  );

  const opponentUnknown =
    calibrationCase.metadata.opponentPlans === "absent" ||
    hasUncontrolledObjects(calibrationCase.before.state);
  const beaconUnknown = calibrationCase.before.state.champion_beacon.status === null;
  const refillUnknown = result.unknownEffects.some((effect) => effect.kind === "refill");
  const ruleAssumptionUnknown = result.unknownEffects.some(
    (effect) => effect.kind === "rule-assumption",
  );
  const dynamicStateUnknown =
    opponentUnknown || beaconUnknown || result.unsupported.length > 0 || ruleAssumptionUnknown;
  const harvestSourceUnknown = observedDroppedCargoHarvest(calibrationCase);
  const beforeObstacles = terrainKeys(calibrationCase.before.state, "OBSTACLE");
  const beforeResources = terrainKeys(calibrationCase.before.state, "RESOURCE");
  const differences: CalibrationDifference[] = [];
  for (const feature of result.unsupported) {
    differences.push({
      class: "UNSUPPORTED",
      path: "$.simulation.unsupported",
      expected: null,
      actual: feature,
      note: `feature ${feature} is outside deterministic calibration scope`,
    });
  }
  for (const effect of result.unknownEffects) {
    differences.push({
      class: "EXPECTED_UNKNOWN",
      path: `$.simulation.unknown.${effect.kind}`,
      expected: null,
      actual: effect.note,
      note: effect.note,
    });
  }
  if (opponentUnknown) {
    differences.push({
      class: "EXPECTED_UNKNOWN",
      path: "$.simulation.opponent-action",
      expected: null,
      actual: "uncontrolled objects were present in the private before-state",
      note: "opponent plans and hidden world state were not recorded",
    });
  }
  if (beaconUnknown) {
    differences.push({
      class: "EXPECTED_UNKNOWN",
      path: "$.simulation.beacon",
      expected: null,
      actual: "beacon status was visibility-limited",
      note: "local replay assumes GROUND only to continue deterministic supported phases",
    });
  }
  if (harvestSourceUnknown) {
    differences.push({
      class: "EXPECTED_UNKNOWN",
      path: "$.simulation.resource-source",
      expected: null,
      actual: "DROPPED_CARGO",
      note: "private RESOURCE cells do not reveal whether the source is a natural node or a cargo pile",
    });
  }

  let predictedState: PlayerState | null = null;
  try {
    predictedState = projectPlayerState(result.world, calibrationCase.tenantId, rules, result.events);
  } catch (error) {
    if (result.unsupported.length === 0) throw error;
    differences.push({
      class: "UNSUPPORTED",
      path: "$.simulation.projection",
      expected: null,
      actual: (error as Error).message,
      note: "projection cannot claim wire equivalence for an unsupported world state",
    });
  }

  if (predictedState !== null) {
    collectDifferences(
      normalizeState(calibrationCase.after.state),
      normalizeState(predictedState),
      {
        refillUnknown,
        opponentUnknown,
        beaconUnknown,
        dynamicStateUnknown,
        harvestSourceUnknown,
        beforeObstacles,
        beforeResources,
      },
      "$",
      differences,
    );
  }

  const hardDifferences = differences.filter((difference) =>
    difference.class !== "EXPECTED_UNKNOWN" && difference.class !== "UNSUPPORTED",
  );
  const inconclusive = differences.some((difference) =>
    difference.class === "EXPECTED_UNKNOWN" || difference.class === "UNSUPPORTED",
  );
  const status: CalibrationStatus = hardDifferences.length > 0
    ? "MISMATCH"
    : inconclusive
      ? "INCONCLUSIVE"
      : "MATCH";

  return {
    schema: "sim-calibration-report-v1",
    caseId: calibrationCase.caseId,
    status,
    rulesVersion: rules.rulesVersion,
    rulesManifestHash: manifestHash(rules),
    predictedState,
    observedState: calibrationCase.after.state,
    differences,
    unsupported: result.unsupported,
    unknownEffects: result.unknownEffects,
  };
}
