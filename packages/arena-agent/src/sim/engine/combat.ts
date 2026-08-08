/**
 * Combat resolver（S10）：v0.11 immutable-snapshot combat settlement.
 *
 * Source of truth: docs/game-rules.md §Combat and
 * docs/api-resolution-results.md §Combat events.
 */

import { cellKey, type Direction, type Plan, type Position } from "../../domain/model.ts";
import type { RulesManifest } from "../contracts/rules-manifest.ts";
import { compareCodeUnit, compareUuidRaw } from "../deterministic/uuid.ts";
import type { SimPlayer, SimUnit, SimWorld } from "../world/types.ts";
import { dropBeaconOnDeath } from "./beacon.ts";
import { eventOf, outcome, type Phase, type ResolutionEvent } from "./phase.ts";

const DIRECTION_DELTA: Readonly<Record<Direction, readonly [number, number]>> = {
  UP: [0, -1],
  DOWN: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
};

interface CombatTarget {
  readonly id: string;
  readonly playerId: string;
  readonly position: Position;
  readonly kind: "unit" | "core";
  readonly unitType: "WORKER" | "VANGUARD" | "RANGER" | null;
  readonly hp: number;
  readonly shield: number | null;
}

interface LockedAttack {
  readonly actorId: string;
  readonly playerId: string;
  readonly kind: "sweep" | "shoot";
  readonly direction: Direction | null;
  readonly targetId: string | null;
  readonly expectedCell: Position | null;
}

export interface CombatResolution {
  readonly events: readonly ResolutionEvent[];
  readonly damageByTarget: ReadonlyMap<string, number>;
  readonly damageToCoreByPlayer: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** targetId -> playerId -> actor IDs that contributed legal damage. */
  readonly contributorsByTarget: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
  readonly killedUnits: readonly string[];
  readonly destroyedCores: readonly string[];
}

interface DestroyedFleetSnapshot {
  readonly player: SimPlayer;
  readonly coreId: string;
  readonly corePosition: Position;
  readonly availableResources: number;
}

function stepCell(source: Position, direction: Direction): Position {
  const [dx, dy] = DIRECTION_DELTA[direction];
  return [source[0] + dx, source[1] + dy];
}

function sameCell(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function isEightDirectionLine(actor: Position, target: Position, maxRange: number): boolean {
  const dx = target[0] - actor[0];
  const dy = target[1] - actor[1];
  const distance = Math.max(Math.abs(dx), Math.abs(dy));
  if (distance < 1 || distance > maxRange) return false;
  return dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy);
}

function intermediateCells(actor: Position, target: Position): Position[] {
  const dx = Math.sign(target[0] - actor[0]);
  const dy = Math.sign(target[1] - actor[1]);
  const cells: Position[] = [];
  let x = actor[0] + dx;
  let y = actor[1] + dy;
  while (x !== target[0] || y !== target[1]) {
    cells.push([x, y]);
    x += dx;
    y += dy;
  }
  return cells;
}

function isObstacleCell(world: SimWorld, cell: Position): boolean {
  return world.terrain.obstacles.has(cellKey(cell));
}

function comparePlayerId(a: string, b: string): number {
  try {
    return compareUuidRaw(a, b);
  } catch {
    // Scenario fixtures may use readable IDs; live IDs still take raw UUID order.
    return compareCodeUnit(a, b);
  }
}

function snapshotTargets(world: SimWorld): CombatTarget[] {
  const targets: CombatTarget[] = [];
  for (const [playerId, player] of world.players) {
    for (const unit of player.units) {
      targets.push({
        id: unit.id,
        playerId,
        position: unit.position,
        kind: "unit",
        unitType: unit.unitType,
        hp: unit.hp,
        shield: null,
      });
    }
    if (player.core !== null) {
      targets.push({
        id: player.core.id,
        playerId,
        position: player.core.position,
        kind: "core",
        unitType: null,
        hp: player.core.hp,
        shield: player.core.shield,
      });
    }
  }
  return targets.sort((a, b) => compareUuidRaw(a.id, b.id));
}

/** Collect only actions valid for the actor's owned unit type. */
function collectAttacks(world: SimWorld, plans: ReadonlyMap<string, Plan>): LockedAttack[] {
  const attacks: LockedAttack[] = [];
  for (const [playerId, plan] of plans) {
    const player = world.players.get(playerId);
    if (player === undefined) continue;
    for (const [unitId, action] of Object.entries(plan.unitActions)) {
      const actor = player.units.find((unit) => unit.id === unitId);
      if (actor === undefined) continue;
      if (action.type === "SWEEP" && actor.unitType === "VANGUARD") {
        attacks.push({
          actorId: unitId,
          playerId,
          kind: "sweep",
          direction: action.direction,
          targetId: null,
          expectedCell: null,
        });
      } else if (action.type === "SHOOT" && actor.unitType === "RANGER") {
        attacks.push({
          actorId: unitId,
          playerId,
          kind: "shoot",
          direction: null,
          targetId: action.targetId,
          expectedCell: action.expectedCell,
        });
      }
    }
  }
  return attacks.sort((a, b) => compareUuidRaw(a.actorId, b.actorId));
}

function sweepTargets(
  targets: readonly CombatTarget[],
  attack: LockedAttack,
  actor: CombatTarget,
): { readonly position: Position; readonly hits: CombatTarget[] } {
  const position = stepCell(actor.position, attack.direction!);
  return {
    position,
    hits: targets.filter(
      (target) => target.playerId !== attack.playerId && sameCell(target.position, position),
    ),
  };
}

function shotTarget(
  world: SimWorld,
  targets: readonly CombatTarget[],
  attack: LockedAttack,
  actor: CombatTarget,
): CombatTarget | null {
  const expected = attack.expectedCell;
  if (expected === null) return null;
  if (!isEightDirectionLine(actor.position, expected, 3)) return null;
  if (intermediateCells(actor.position, expected).some((cell) => isObstacleCell(world, cell))) {
    return null;
  }
  // Upstream v0.12 cell fire: with a target_id, precision mode hits only the
  // named object if it remains hostile and at expected_cell. Without one, the
  // shot hits the lowest-HP hostile then present in the cell (raw UUID breaks
  // HP ties).
  if (attack.targetId !== null) {
    const target = targets.find((candidate) => candidate.id === attack.targetId);
    if (target === undefined || target.playerId === attack.playerId) return null;
    if (!sameCell(target.position, expected)) return null;
    return target;
  }
  const occupants = targets.filter(
    (candidate) => candidate.playerId !== attack.playerId && sameCell(candidate.position, expected),
  );
  if (occupants.length === 0) return null;
  return occupants.sort((a, b) => a.hp - b.hp || compareUuidRaw(a.id, b.id))[0];
}

function addContribution(
  contributors: Map<string, Map<string, Set<string>>>,
  targetId: string,
  playerId: string,
  actorId: string,
): void {
  let byPlayer = contributors.get(targetId);
  if (byPlayer === undefined) {
    byPlayer = new Map();
    contributors.set(targetId, byPlayer);
  }
  let actors = byPlayer.get(playerId);
  if (actors === undefined) {
    actors = new Set();
    byPlayer.set(playerId, actors);
  }
  actors.add(actorId);
}

/** Pure immutable-snapshot combat resolution. */
export function resolveCombat(world: SimWorld, plans: ReadonlyMap<string, Plan>): CombatResolution {
  const targets = snapshotTargets(world);
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const attacks = collectAttacks(world, plans);
  const events: ResolutionEvent[] = [];
  const damageByTarget = new Map<string, number>();
  const damageToCoreByPlayer = new Map<string, Map<string, number>>();
  const contributorsByTarget = new Map<string, Map<string, Set<string>>>();

  for (const attack of attacks) {
    const actor = targetById.get(attack.actorId);
    if (actor === undefined || actor.kind !== "unit" || actor.playerId !== attack.playerId) continue;

    let hits: readonly CombatTarget[];
    if (attack.kind === "sweep") {
      const sweep = sweepTargets(targets, attack, actor);
      hits = sweep.hits;
      events.push(eventOf(world.tick, "SWEEP_RESOLVED", {
        actorId: attack.actorId,
        position: sweep.position,
        values: { targets_hit: hits.length },
      }));
    } else {
      const hit = shotTarget(world, targets, attack, actor);
      hits = hit === null ? [] : [hit];
      if (hit === null) {
        events.push(eventOf(world.tick, "SHOT_MISSED", {
          reasonCode: "SHOT_MISSED",
          actorId: attack.actorId,
          targetId: attack.targetId,
          position: attack.expectedCell,
        }));
      } else {
        events.push(eventOf(world.tick, "SHOT_HIT", {
          actorId: attack.actorId,
          targetId: hit.id,
          position: hit.position,
          values: { damage: 1 },
        }));
      }
    }

    for (const hit of hits) {
      damageByTarget.set(hit.id, (damageByTarget.get(hit.id) ?? 0) + 1);
      addContribution(contributorsByTarget, hit.id, attack.playerId, attack.actorId);
      if (hit.kind === "core") {
        let byPlayer = damageToCoreByPlayer.get(hit.id);
        if (byPlayer === undefined) {
          byPlayer = new Map();
          damageToCoreByPlayer.set(hit.id, byPlayer);
        }
        byPlayer.set(attack.playerId, (byPlayer.get(attack.playerId) ?? 0) + 1);
      }
    }
  }

  const killedUnits: string[] = [];
  const destroyedCores: string[] = [];
  for (const target of targets) {
    const incoming = damageByTarget.get(target.id) ?? 0;
    if (incoming <= 0) continue;
    if (target.kind === "unit") {
      const hp = Math.max(0, target.hp - incoming);
      events.push(eventOf(world.tick, "UNIT_DAMAGED", {
        reasonCode: "ATTACK",
        targetId: target.id,
        position: target.position,
        values: { damage: incoming, hp },
      }));
      if (hp === 0) killedUnits.push(target.id);
    } else {
      const shieldDamage = Math.min(target.shield ?? 0, incoming);
      const hpDamage = Math.min(target.hp, incoming - shieldDamage);
      events.push(eventOf(world.tick, "CORE_DAMAGED", {
        reasonCode: "ATTACK",
        targetId: target.id,
        position: target.position,
        values: {
          damage: shieldDamage + hpDamage,
          shield_damage: shieldDamage,
          hp_damage: hpDamage,
        },
      }));
      if (target.hp - hpDamage <= 0) destroyedCores.push(target.id);
    }
  }

  return {
    events,
    damageByTarget,
    damageToCoreByPlayer,
    contributorsByTarget,
    killedUnits: [...new Set(killedUnits)].sort(compareUuidRaw),
    destroyedCores: [...new Set(destroyedCores)].sort(compareUuidRaw),
  };
}

function applyDamage(draft: SimWorld, resolution: CombatResolution): void {
  const players = new Map(draft.players);
  for (const [playerId, player] of draft.players) {
    let changed = false;
    let core = player.core;
    if (core !== null) {
      const damage = resolution.damageByTarget.get(core.id) ?? 0;
      if (damage > 0) {
        const shieldDamage = Math.min(core.shield, damage);
        core = {
          ...core,
          shield: core.shield - shieldDamage,
          hp: Math.max(0, core.hp - (damage - shieldDamage)),
        };
        changed = true;
      }
    }
    const units = player.units.map((unit) => {
      const damage = resolution.damageByTarget.get(unit.id) ?? 0;
      if (damage <= 0) return unit;
      changed = true;
      return { ...unit, hp: Math.max(0, unit.hp - damage) };
    });
    if (changed) players.set(playerId, { ...player, core, units });
  }
  (draft as unknown as { players: Map<string, SimPlayer> }).players = players;
}

function participantPlayerIds(resolution: CombatResolution, targetId: string): string[] {
  return [...(resolution.contributorsByTarget.get(targetId)?.keys() ?? [])].sort(comparePlayerId);
}

function participantUsernames(
  players: ReadonlyMap<string, SimPlayer>,
  resolution: CombatResolution,
  targetId: string,
): string[] {
  return participantPlayerIds(resolution, targetId)
    .map((playerId) => players.get(playerId)?.username)
    .filter((username): username is string => username !== undefined);
}

function emitParticipation(
  tick: number,
  resolution: CombatResolution,
  targetId: string,
  position: Position,
  reasonCode: "UNIT" | "CORE",
  events: ResolutionEvent[],
): void {
  for (const playerId of participantPlayerIds(resolution, targetId)) {
    events.push(eventOf(tick, "DESTRUCTION_PARTICIPATION", {
      reasonCode,
      targetId,
      position,
      recipientPlayerId: playerId,
    }));
  }
}

function dropCargo(
  draft: SimWorld,
  unit: SimUnit,
  events: ResolutionEvent[],
): void {
  if (unit.unitType !== "WORKER" || unit.cargo <= 0) return;
  const key = cellKey(unit.position);
  const piles = new Map(draft.terrain.piles);
  piles.set(key, { cell: unit.position, amount: (piles.get(key)?.amount ?? 0) + unit.cargo });
  (draft as unknown as { terrain: SimWorld["terrain"] }).terrain = { ...draft.terrain, piles };
  events.push(eventOf(draft.tick, "WORKER_CARGO_DROPPED", {
    actorId: unit.id,
    position: unit.position,
    values: { amount: unit.cargo },
  }));
}

function removeCombatDeaths(
  draft: SimWorld,
  resolution: CombatResolution,
  events: ResolutionEvent[],
): DestroyedFleetSnapshot[] {
  const playersBeforeRemoval = new Map(draft.players);
  const killedUnits = new Set(resolution.killedUnits);
  const destroyedCoreIds = new Set(resolution.destroyedCores);
  const destroyedPlayerIds = new Set<string>();
  const destroyedFleets: DestroyedFleetSnapshot[] = [];

  for (const player of playersBeforeRemoval.values()) {
    if (player.core !== null && destroyedCoreIds.has(player.core.id)) {
      destroyedPlayerIds.add(player.id);
      destroyedFleets.push({
        player,
        coreId: player.core.id,
        corePosition: player.core.position,
        availableResources: player.resources,
      });
    }
  }
  destroyedFleets.sort((a, b) => comparePlayerId(a.player.id, b.player.id));

  // Automatic Beacon drop is resolved once, before carriers are removed.
  const beacon = draft.beacon;
  if (beacon !== null && beacon.status === "CARRIED" && beacon.carrierId !== null) {
    for (const player of playersBeforeRemoval.values()) {
      const coreCarrier = player.core?.id === beacon.carrierId ? player.core : null;
      const unitCarrier = player.units.find((unit) => unit.id === beacon.carrierId) ?? null;
      const fleetDestroyed = destroyedPlayerIds.has(player.id);
      if (coreCarrier !== null && fleetDestroyed) {
        dropBeaconOnDeath(draft, coreCarrier.id, coreCarrier.position, events, { clampShield: false });
        break;
      }
      if (unitCarrier !== null && (fleetDestroyed || killedUnits.has(unitCarrier.id))) {
        dropBeaconOnDeath(draft, unitCarrier.id, unitCarrier.position, events, {
          clampShield: !fleetDestroyed,
        });
        break;
      }
    }
  }

  // Cargo from every removed Worker persists and is reported to its owner.
  for (const player of playersBeforeRemoval.values()) {
    const fleetDestroyed = destroyedPlayerIds.has(player.id);
    for (const unit of player.units) {
      if (fleetDestroyed || killedUnits.has(unit.id)) dropCargo(draft, unit, events);
    }
  }

  // Participation is private to each contributing attacker.
  for (const player of playersBeforeRemoval.values()) {
    for (const unit of player.units) {
      if (killedUnits.has(unit.id)) {
        emitParticipation(draft.tick, resolution, unit.id, unit.position, "UNIT", events);
      }
    }
  }
  for (const victim of destroyedFleets) {
    emitParticipation(draft.tick, resolution, victim.coreId, victim.corePosition, "CORE", events);
  }

  const players = new Map<string, SimPlayer>();
  for (const [playerId, player] of draft.players) {
    if (destroyedPlayerIds.has(playerId)) {
      players.set(playerId, {
        ...player,
        status: "RESPAWNING",
        respawnAtTick: draft.tick,
        resources: 0,
        core: null,
        units: [],
      });
    } else {
      players.set(playerId, {
        ...player,
        units: player.units.filter((unit) => !killedUnits.has(unit.id)),
      });
    }
  }
  (draft as unknown as { players: Map<string, SimPlayer> }).players = players;

  for (const victim of destroyedFleets) {
    const destroyedBy = participantUsernames(playersBeforeRemoval, resolution, victim.coreId);
    events.push(eventOf(draft.tick, "CORE_DESTROYED", {
      reasonCode: "ATTACK",
      targetId: victim.coreId,
      position: victim.corePosition,
      ...(destroyedBy.length === 0 ? {} : { values: { destroyed_by: destroyedBy } }),
    }));
  }

  return destroyedFleets;
}

function capacityOf(rules: RulesManifest, population: number): number {
  return Math.max(
    rules.rules.core.minCapacity,
    population * rules.rules.core.capacityPerUnit,
  );
}

/** Combat deaths shrink capacity immediately, before captured inventory is stored. */
function shrinkPostCombatCapacity(
  draft: SimWorld,
  rules: RulesManifest,
  events: ResolutionEvent[],
): void {
  const players = new Map(draft.players);
  const ordered = [...draft.players.values()].sort((a, b) => comparePlayerId(a.id, b.id));
  for (const player of ordered) {
    if (player.core === null || player.status !== "ACTIVE") continue;
    const capacity = capacityOf(rules, player.units.length);
    if (player.resources <= capacity) continue;
    const amount = player.resources - capacity;
    players.set(player.id, { ...player, resources: capacity });
    events.push(eventOf(draft.tick, "CORE_RESOURCE_OVERFLOW_DESTROYED", {
      actorId: player.core.id,
      position: player.core.position,
      values: { amount, capacity },
    }));
  }
  (draft as unknown as { players: Map<string, SimPlayer> }).players = players;
}

function captureWinner(
  resolution: CombatResolution,
  coreId: string,
): string | null {
  const damage = resolution.damageToCoreByPlayer.get(coreId);
  if (damage === undefined) return null;
  let winner: string | null = null;
  let bestDamage = -1;
  for (const [playerId, dealt] of damage) {
    if (
      dealt > bestDamage ||
      (dealt === bestDamage && winner !== null && comparePlayerId(playerId, winner) < 0)
    ) {
      winner = playerId;
      bestDamage = dealt;
    }
  }
  return winner;
}

/** Victims resolve by raw player UUID order; no runner-up if the winner's Core died. */
function applyCoreCaptures(
  draft: SimWorld,
  rules: RulesManifest,
  resolution: CombatResolution,
  destroyedFleets: readonly DestroyedFleetSnapshot[],
  events: ResolutionEvent[],
): void {
  const players = new Map(draft.players);
  for (const victim of destroyedFleets) {
    // 官方 resolution-results.md:82 只定义 CORE_RESOURCES_CAPTURED；victim=0
    // 仍静默（无可捕获/可毁资源）。无赢家或赢家当 Tick 阵亡时，受害方残留
    // 库存既不归属赢家也不保留——记为内部统计事件 CORE_RESOURCES_DESTROYED
    // （arena-evolve 自造，不在官方 wire 事件表；不得进入 protocol-bridge 白名单）。
    if (victim.availableResources <= 0) continue;
    const winnerId = captureWinner(resolution, victim.coreId);
    const winner = winnerId === null ? null : players.get(winnerId);
    const winnerCanCapture =
      winner !== undefined && winner !== null &&
      winner.status === "ACTIVE" && winner.core !== null;
    if (winnerId === null || !winnerCanCapture) {
      events.push(eventOf(draft.tick, "CORE_RESOURCES_DESTROYED", {
        targetId: victim.coreId,
        position: victim.corePosition,
        values: { amount: victim.availableResources },
      }));
      continue;
    }

    const winnerActive = winner!;
    const capacity = capacityOf(rules, winnerActive.units.length);
    const amount = Math.min(victim.availableResources, Math.max(0, capacity - winnerActive.resources));
    const destroyed = victim.availableResources - amount;
    players.set(winnerId, { ...winnerActive, resources: winnerActive.resources + amount });
    events.push(eventOf(draft.tick, "CORE_RESOURCES_CAPTURED", {
      actorId: winnerActive.core!.id,
      targetId: victim.coreId,
      position: victim.corePosition,
      values: {
        amount,
        available: victim.availableResources,
        destroyed,
        capacity,
      },
    }));
  }
  (draft as unknown as { players: Map<string, SimPlayer> }).players = players;
}

export const combatPhase: Phase = {
  id: "P09-combat",
  officialPhase: 7,
  run: (draft, ctx) => {
    if (!ctx.features.has("combat")) return outcome({});
    const resolution = resolveCombat(draft, ctx.plans);
    const events = [...resolution.events];
    applyDamage(draft, resolution);
    const destroyedFleets = removeCombatDeaths(draft, resolution, events);
    shrinkPostCombatCapacity(draft, ctx.rules, events);
    applyCoreCaptures(draft, ctx.rules, resolution, destroyedFleets, events);
    return outcome({ events });
  },
};
