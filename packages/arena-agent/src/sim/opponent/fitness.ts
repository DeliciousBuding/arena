/**
 * Event-ledger fitness for simulator tournament/evolution evaluation (W51).
 *
 * This is deliberately engine-local. The numeric score is comparable across
 * strategies only when rules/scenario/tick horizon are compatible; it is not a
 * claim that arena-evolve and arena-ts absolute scores share one scale.
 */

import type { ResolutionEvent } from "../engine/phase.ts";
import type { SimPlayer, SimWorld } from "../world/types.ts";
import type { MatchObserver, MatchResult, MatchTickObservation } from "./tournament.ts";

export interface EventLedgerFitnessDetail {
  readonly harvested: number;
  readonly deposited: number;
  readonly damage: number;
  readonly pop: number;
  readonly res: number;
  readonly lost: number;
  readonly respawn: number;
  readonly beacon: number;
  readonly aliveTicks: number;
  readonly healCost: number;
  readonly repairCost: number;
  readonly spawnCost: number;
  readonly overflowDestroyed: number;
  readonly resourcesLost: number;
  /** Diagnostic only: resources captured from destroyed enemy cores. */
  readonly resourcesCaptured: number;
}

export interface EventLedgerFitnessWeights {
  readonly harvested: number;
  readonly deposited: number;
  readonly finalResources: number;
  readonly population: number;
  readonly populationCap: number;
  readonly beacon: number;
  readonly survival: number;
  readonly damage: number;
  readonly unitLoss: number;
  readonly respawn: number;
  readonly healCost: number;
  readonly repairCost: number;
  readonly overflowDestroyed: number;
  readonly resourcesLost: number;
}

/** arena-evolve-inspired weights, adapted to arena-ts event semantics. */
export const DEFAULT_EVENT_LEDGER_FITNESS_WEIGHTS: EventLedgerFitnessWeights = Object.freeze({
  harvested: 0.6,
  deposited: 1.2,
  finalResources: 1,
  population: 0.8,
  populationCap: 40,
  beacon: 0.05,
  survival: 2,
  damage: 0.3,
  unitLoss: 0.8,
  respawn: 2,
  healCost: 0.15,
  repairCost: 0.1,
  overflowDestroyed: 0.5,
  resourcesLost: 1,
});

interface MutableDetail {
  harvested: number;
  deposited: number;
  damage: number;
  pop: number;
  res: number;
  lost: number;
  respawn: number;
  beacon: number;
  aliveTicks: number;
  healCost: number;
  repairCost: number;
  spawnCost: number;
  overflowDestroyed: number;
  resourcesLost: number;
  resourcesCaptured: number;
}

function emptyDetail(): MutableDetail {
  return {
    harvested: 0,
    deposited: 0,
    damage: 0,
    pop: 0,
    res: 0,
    lost: 0,
    respawn: 0,
    beacon: 0,
    aliveTicks: 0,
    healCost: 0,
    repairCost: 0,
    spawnCost: 0,
    overflowDestroyed: 0,
    resourcesLost: 0,
    resourcesCaptured: 0,
  };
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function entityOwners(world: SimWorld): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [playerId, player] of world.players) {
    if (player.core !== null) owners.set(player.core.id, playerId);
    for (const unit of player.units) owners.set(unit.id, playerId);
  }
  return owners;
}

function unitIds(player: SimPlayer | undefined): Set<string> {
  return new Set(player?.units.map((unit) => unit.id) ?? []);
}

function actorOwner(
  event: ResolutionEvent,
  beforeOwners: ReadonlyMap<string, string>,
  afterOwners: ReadonlyMap<string, string>,
): string | null {
  if (event.actorId === null) return null;
  return beforeOwners.get(event.actorId) ?? afterOwners.get(event.actorId) ?? null;
}

function targetOwner(
  event: ResolutionEvent,
  beforeOwners: ReadonlyMap<string, string>,
  afterOwners: ReadonlyMap<string, string>,
): string | null {
  if (event.targetId === null) return null;
  return beforeOwners.get(event.targetId) ?? afterOwners.get(event.targetId) ?? null;
}

/**
 * Score one detail on a 600-tick-equivalent rate scale.
 * Snapshot fields (population/resources) are not time-scaled; accumulated flows
 * are, and survival is normalized to the requested horizon.
 */
export function fitnessFromDetail(
  detail: EventLedgerFitnessDetail,
  maxTicks: number,
  weights: EventLedgerFitnessWeights = DEFAULT_EVENT_LEDGER_FITNESS_WEIGHTS,
): number {
  if (!Number.isSafeInteger(maxTicks) || maxTicks <= 0) {
    throw new RangeError(`maxTicks must be a positive safe integer (got ${String(maxTicks)})`);
  }
  const t = maxTicks / 600;
  return (
    (detail.harvested / t) * weights.harvested +
    (detail.deposited / t) * weights.deposited +
    detail.res * weights.finalResources +
    Math.min(detail.pop, weights.populationCap) * weights.population +
    (detail.beacon / t) * weights.beacon +
    (detail.aliveTicks / maxTicks) * weights.survival +
    (detail.damage / t) * weights.damage -
    (detail.lost / t) * weights.unitLoss -
    (detail.respawn / t) * weights.respawn -
    (detail.healCost / t) * weights.healCost -
    (detail.repairCost / t) * weights.repairCost -
    (detail.overflowDestroyed / t) * weights.overflowDestroyed -
    (detail.resourcesLost / t) * weights.resourcesLost
  );
}

/**
 * Read-only tournament observer that converts authoritative before/after worlds
 * and settlement events into per-player fitness ledgers.
 */
export class FitnessLedgerCollector implements MatchObserver {
  private readonly details = new Map<string, MutableDetail>();

  private detailFor(playerId: string): MutableDetail {
    let detail = this.details.get(playerId);
    if (detail === undefined) {
      detail = emptyDetail();
      this.details.set(playerId, detail);
    }
    return detail;
  }

  onTick(args: MatchTickObservation): void {
    void args.tick;
    void args.plans;
    const beforeOwners = entityOwners(args.before);
    const afterOwners = entityOwners(args.after);

    for (const [playerId, afterPlayer] of args.after.players) {
      const detail = this.detailFor(playerId);
      detail.pop = afterPlayer.units.length;
      detail.res = afterPlayer.resources;
      if (afterPlayer.status === "ACTIVE" && afterPlayer.core !== null) detail.aliveTicks += 1;

      const beforeUnits = unitIds(args.before.players.get(playerId));
      const afterUnits = unitIds(afterPlayer);
      for (const id of beforeUnits) {
        if (!afterUnits.has(id)) detail.lost += 1;
      }
    }
    // A player may vanish from an exotic test world; still preserve its unit-loss accounting.
    for (const [playerId, beforePlayer] of args.before.players) {
      if (args.after.players.has(playerId)) continue;
      const detail = this.detailFor(playerId);
      detail.lost += beforePlayer.units.length;
      detail.pop = 0;
      detail.res = 0;
    }

    for (const event of args.events) {
      const actor = actorOwner(event, beforeOwners, afterOwners);
      const target = targetOwner(event, beforeOwners, afterOwners);
      const amount = finiteNonNegative(event.values?.amount);
      const cost = finiteNonNegative(event.values?.cost);

      switch (event.eventType) {
        case "HARVEST_SUCCEEDED":
          if (actor !== null) this.detailFor(actor).harvested += amount;
          break;
        case "DEPOSIT_SUCCEEDED":
          if (actor !== null) this.detailFor(actor).deposited += amount;
          break;
        case "SHOT_HIT":
          if (actor !== null) this.detailFor(actor).damage += finiteNonNegative(event.values?.damage);
          break;
        case "SWEEP_RESOLVED":
          if (actor !== null) this.detailFor(actor).damage += finiteNonNegative(event.values?.targets_hit);
          break;
        case "CORE_DESTROYED":
          if (target !== null) this.detailFor(target).respawn += 1;
          break;
        case "UNIT_HEAL_SUCCEEDED":
        case "CORE_HEAL_SUCCEEDED":
          if (actor !== null) this.detailFor(actor).healCost += cost;
          break;
        case "CORE_REPAIR_SUCCEEDED":
          if (actor !== null) this.detailFor(actor).repairCost += cost;
          break;
        case "CORE_SPAWN_SUCCEEDED":
          if (actor !== null) this.detailFor(actor).spawnCost += cost;
          break;
        case "CORE_RESOURCE_OVERFLOW_DESTROYED":
          if (actor !== null) this.detailFor(actor).overflowDestroyed += amount;
          break;
        case "CORE_RESOURCES_CAPTURED": {
          if (actor !== null) this.detailFor(actor).resourcesCaptured += amount;
          if (target !== null) {
            // Victim loses its entire available inventory: captured + overflow-destroyed remainder.
            const available = finiteNonNegative(event.values?.available);
            this.detailFor(target).resourcesLost += available > 0 ? available : amount;
          }
          break;
        }
        case "CORE_RESOURCES_DESTROYED":
          if (target !== null) this.detailFor(target).resourcesLost += amount;
          break;
        default:
          break;
      }
    }

    const beacon = args.after.beacon;
    if (beacon?.status === "CARRIED" && beacon.carrierId !== null) {
      const owner = afterOwners.get(beacon.carrierId) ?? beforeOwners.get(beacon.carrierId);
      if (owner !== undefined) this.detailFor(owner).beacon += 1;
    }
  }

  /** Final snapshot normalization from MatchResult keeps the public tournament contract small. */
  finalize(match: MatchResult): void {
    for (const playerId of match.players) {
      const detail = this.detailFor(playerId);
      detail.pop = match.finalPopulation[playerId] ?? detail.pop;
      detail.res = match.finalResources[playerId] ?? detail.res;
    }
  }

  detail(playerId: string): EventLedgerFitnessDetail {
    const detail = this.detailFor(playerId);
    return Object.freeze({ ...detail });
  }

  score(
    playerId: string,
    maxTicks: number,
    weights: EventLedgerFitnessWeights = DEFAULT_EVENT_LEDGER_FITNESS_WEIGHTS,
  ): number {
    return fitnessFromDetail(this.detail(playerId), maxTicks, weights);
  }
}
