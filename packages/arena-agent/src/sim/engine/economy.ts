/**
 * Economy resolver（S5）：self-destruct / capacity / upkeep / harvest / deposit /
 * unit-heal / stationary Core action（SPAWN/HEAL/REPAIR_SHIELD）。
 *
 * 约束：
 * - 所有数值只读 rules manifest；
 * - 所有竞争按稳定 raw UUID 序，而不是容器插入顺序；
 * - v0.11 deficit 仍处于 PENDING-VERIFICATION 时，照 manifest 假设执行但
 *   同时产生 rule-assumption unknown，禁止把该窗口计为已验证 MATCH；
 * - 本地 spawn UUID 只保证确定性/唯一性，不冒充服务端真实 UUID。
 */

import { createHash } from "node:crypto";
import { cellKey, type Plan, type Position, type UnitType } from "../../domain/model.ts";
import { compareCodeUnit, compareUuidRaw } from "../deterministic/uuid.ts";
import { CELL_ENTITY_CAPACITY } from "../world/world.ts";
import type { SimPlayer, SimUnit, SimWorld } from "../world/types.ts";
import {
  eventOf,
  outcome,
  type Phase,
  type PhaseContext,
  type ResolutionEvent,
  type UnknownEffect,
} from "./phase.ts";

function capacityOf(ctx: PhaseContext, population: number): number {
  const core = ctx.rules.rules.core;
  return Math.max(core.minCapacity, population * core.capacityPerUnit);
}

function upkeepOf(ctx: PhaseContext, population: number): number {
  const tier = Math.floor(population / ctx.rules.rules.upkeep.tierSize);
  return (tier * (tier + 1)) / 2;
}

function unitCost(ctx: PhaseContext, unitType: UnitType): number {
  const production = ctx.rules.rules.production;
  if (unitType === "WORKER") return production.workerCost;
  if (unitType === "VANGUARD") return production.vanguardCost;
  return production.rangerCost;
}

function unitHp(ctx: PhaseContext, unitType: UnitType): number {
  const units = ctx.rules.rules.units;
  if (unitType === "WORKER") return units.workerHp;
  if (unitType === "VANGUARD") return units.vanguardHp;
  return units.rangerHp;
}

function manhattan(a: Position, b: Position): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function updatePlayers(draft: SimWorld, fn: (players: Map<string, SimPlayer>) => void): void {
  const players = new Map(draft.players);
  fn(players);
  (draft as unknown as { players: Map<string, SimPlayer> }).players = players;
}

function updatePlayer(draft: SimWorld, playerId: string, fn: (player: SimPlayer) => SimPlayer): void {
  updatePlayers(draft, (players) => {
    const player = players.get(playerId);
    if (player !== undefined) players.set(playerId, fn(player));
  });
}

function updatePlayerUnits(
  draft: SimWorld,
  playerId: string,
  fn: (units: readonly SimUnit[]) => readonly SimUnit[],
): void {
  updatePlayer(draft, playerId, (player) => ({ ...player, units: fn(player.units) }));
}

function updateTerrainPiles(
  draft: SimWorld,
  fn: (piles: Map<string, { readonly cell: Position; readonly amount: number }>) => void,
): void {
  const piles = new Map(draft.terrain.piles);
  fn(piles);
  (draft as unknown as { terrain: SimWorld["terrain"] }).terrain = { ...draft.terrain, piles };
}

function findUnit(draft: SimWorld, playerId: string, unitId: string): SimUnit | null {
  return draft.players.get(playerId)?.units.find((unit) => unit.id === unitId) ?? null;
}

function removeUnitOnly(draft: SimWorld, playerId: string, unitId: string): void {
  updatePlayerUnits(draft, playerId, (units) => units.filter((unit) => unit.id !== unitId));
}

function dropWorkerCargo(draft: SimWorld, unit: SimUnit, events: ResolutionEvent[]): void {
  if (unit.unitType !== "WORKER" || unit.cargo <= 0) return;
  const key = cellKey(unit.position);
  updateTerrainPiles(draft, (piles) => {
    const existing = piles.get(key)?.amount ?? 0;
    piles.set(key, { cell: unit.position, amount: existing + unit.cargo });
  });
  events.push(
    eventOf(draft.tick, "WORKER_CARGO_DROPPED", {
      actorId: unit.id,
      position: unit.position,
      values: { amount: unit.cargo },
    }),
  );
}

function removeUnitAndDropCargo(
  draft: SimWorld,
  playerId: string,
  unit: SimUnit,
  events: ResolutionEvent[],
): void {
  removeUnitOnly(draft, playerId, unit.id);
  dropWorkerCargo(draft, unit, events);
}

function sortedPlayerIds(draft: SimWorld): string[] {
  return [...draft.players.keys()].sort(compareCodeUnit);
}

interface UnitRequest {
  readonly playerId: string;
  readonly unitId: string;
}

function collectUnitRequests(
  draft: SimWorld,
  plans: ReadonlyMap<string, Plan>,
  actionType: string,
): UnitRequest[] {
  const requests: UnitRequest[] = [];
  for (const [playerId, plan] of plans) {
    if (!draft.players.has(playerId)) continue;
    for (const [unitId, action] of Object.entries(plan.unitActions)) {
      if (action.type === actionType && findUnit(draft, playerId, unitId) !== null) {
        requests.push({ playerId, unitId });
      }
    }
  }
  return requests.sort((a, b) => compareUuidRaw(a.unitId, b.unitId));
}

const selfDestructPhase: Phase = {
  id: "P02-self-destruct",
  officialPhase: 2,
  run: (draft, ctx) => {
    const events: ResolutionEvent[] = [];
    for (const request of collectUnitRequests(draft, ctx.plans, "SELF_DESTRUCT")) {
      const unit = findUnit(draft, request.playerId, request.unitId);
      if (unit === null) continue;
      removeUnitAndDropCargo(draft, request.playerId, unit, events);
      events.push(eventOf(draft.tick, "UNIT_SELF_DESTRUCTED", { actorId: unit.id, position: unit.position }));
    }
    return outcome({ events });
  },
};

const capacityShrinkPhase: Phase = {
  id: "P03-capacity-shrink-after-removal",
  officialPhase: 2,
  run: (draft, ctx) => {
    const events: ResolutionEvent[] = [];
    for (const playerId of sortedPlayerIds(draft)) {
      const player = draft.players.get(playerId)!;
      const capacity = capacityOf(ctx, player.units.length);
      if (player.resources <= capacity) continue;
      const amount = player.resources - capacity;
      updatePlayer(draft, playerId, (current) => ({ ...current, resources: capacity }));
      if (player.core !== null) {
        events.push(
          eventOf(draft.tick, "CORE_RESOURCE_OVERFLOW_DESTROYED", {
            actorId: player.core.id,
            position: player.core.position,
            values: { amount, capacity },
          }),
        );
      }
    }
    return outcome({ events });
  },
};

const upkeepPhase: Phase = {
  id: "P04-upkeep-and-deficit",
  officialPhase: 3,
  run: (draft, ctx) => {
    const events: ResolutionEvent[] = [];
    const unknownEffects: UnknownEffect[] = [];
    for (const playerId of sortedPlayerIds(draft)) {
      const player = draft.players.get(playerId)!;
      const due = upkeepOf(ctx, player.units.length);
      if (due === 0) continue;
      const paid = Math.min(player.resources, due);
      const deficit = due - paid;
      updatePlayer(draft, playerId, (current) => ({ ...current, resources: current.resources - paid }));
      if (player.core !== null) {
        events.push(
          eventOf(draft.tick, "UPKEEP_PAID", {
            actorId: player.core.id,
            position: player.core.position,
            values: { due, paid, deficit },
          }),
        );
      }
      if (deficit > 0) {
        applyDeficitDamage(draft, ctx, playerId, deficit, events);
        if (ctx.rules.rules.upkeep.deficitDamage.status !== "VERIFIED") {
          unknownEffects.push({
            tick: draft.tick,
            kind: "rule-assumption",
            note: `upkeep deficit applied using ${ctx.rules.rules.upkeep.deficitDamage.status} v0.11 semantics`,
          });
        }
      }
    }
    return outcome({ events, unknownEffects });
  },
};

function applyDeficitDamage(
  draft: SimWorld,
  ctx: PhaseContext,
  playerId: string,
  deficit: number,
  events: ResolutionEvent[],
): void {
  const player = draft.players.get(playerId);
  if (player === undefined || player.core === null) return;
  const corePosition = player.core.position;
  const protectedCount = ctx.rules.rules.upkeep.deficitProtectionCount;
  const ordered = [...player.units].sort((a, b) => {
    const distanceDelta = manhattan(b.position, corePosition) - manhattan(a.position, corePosition);
    return distanceDelta !== 0 ? distanceDelta : compareUuidRaw(a.id, b.id);
  });
  const atRisk = ordered.slice(0, Math.max(0, ordered.length - protectedCount));

  let remaining = deficit;
  for (const snapshot of atRisk) {
    if (remaining <= 0) break;
    const unit = findUnit(draft, playerId, snapshot.id);
    if (unit === null) continue;
    const damage = Math.min(remaining, unit.hp);
    const hp = unit.hp - damage;
    remaining -= damage;
    events.push(
      eventOf(draft.tick, "UNIT_DAMAGED", {
        reasonCode: "UPKEEP_DEFICIT",
        targetId: unit.id,
        position: unit.position,
        values: { damage, hp: Math.max(0, hp) },
      }),
    );
    if (hp <= 0) {
      removeUnitAndDropCargo(draft, playerId, unit, events);
    } else {
      updatePlayerUnits(draft, playerId, (units) =>
        units.map((current) => (current.id === unit.id ? { ...current, hp } : current)),
      );
    }
  }
}

const harvestDepositPhase: Phase = {
  id: "P08-harvest-and-deposit",
  officialPhase: 8,
  run: (draft, ctx) => {
    const events: ResolutionEvent[] = [];
    resolveHarvestRequests(draft, ctx, events);
    resolveDepositRequests(draft, ctx, events);
    return outcome({ events });
  },
};

function resolveHarvestRequests(draft: SimWorld, ctx: PhaseContext, events: ResolutionEvent[]): void {
  const byCell = new Map<string, UnitRequest[]>();
  for (const request of collectUnitRequests(draft, ctx.plans, "HARVEST")) {
    const unit = findUnit(draft, request.playerId, request.unitId);
    if (unit === null || unit.unitType !== "WORKER") continue;
    const key = cellKey(unit.position);
    byCell.set(key, [...(byCell.get(key) ?? []), request]);
  }

  for (const key of [...byCell.keys()].sort(compareCodeUnit)) {
    const requests = byCell.get(key)!;
    const eligible: UnitRequest[] = [];
    for (const request of requests) {
      const unit = findUnit(draft, request.playerId, request.unitId);
      if (unit === null) continue;
      if (unit.cargo > 0) {
        events.push(
          eventOf(draft.tick, "HARVEST_FAILED", {
            reasonCode: "CARGO_FULL",
            actorId: unit.id,
            position: unit.position,
          }),
        );
      } else {
        eligible.push(request);
      }
    }
    if (eligible.length === 0) continue;

    const hasPile = draft.terrain.piles.has(key);
    const hasNode = draft.terrain.resources.has(key);
    if (!hasPile && !hasNode) {
      for (const request of eligible) {
        const unit = findUnit(draft, request.playerId, request.unitId)!;
        events.push(
          eventOf(draft.tick, "HARVEST_FAILED", {
            reasonCode: "NOT_RESOURCE_CELL",
            actorId: unit.id,
            position: unit.position,
          }),
        );
      }
      continue;
    }

    eligible.sort((a, b) => compareUuidRaw(a.unitId, b.unitId));
    const winner = eligible[0];
    const winnerUnit = findUnit(draft, winner.playerId, winner.unitId)!;
    applyHarvest(draft, ctx, winner.playerId, winnerUnit, key, events);
    for (const loser of eligible.slice(1)) {
      const unit = findUnit(draft, loser.playerId, loser.unitId)!;
      events.push(
        eventOf(draft.tick, "HARVEST_FAILED", {
          reasonCode: "RESOURCE_DEPLETED",
          actorId: unit.id,
          position: unit.position,
        }),
      );
    }
  }
}

function applyHarvest(
  draft: SimWorld,
  ctx: PhaseContext,
  playerId: string,
  unit: SimUnit,
  key: string,
  events: ResolutionEvent[],
): void {
  const pile = draft.terrain.piles.get(key);
  const fromPile = pile !== undefined;
  const beaconBonus = playerHoldsBeacon(draft, playerId);
  const harvestAmount = beaconBonus
    ? ctx.rules.rules.economy.harvestAmountWithBeacon
    : ctx.rules.rules.economy.harvestAmount;
  const amount = fromPile
    ? Math.min(ctx.rules.rules.units.workerCargoCapacity, pile.amount)
    : Math.min(ctx.rules.rules.units.workerCargoCapacity, harvestAmount);

  updatePlayerUnits(draft, playerId, (units) =>
    units.map((current) => (current.id === unit.id ? { ...current, cargo: amount } : current)),
  );
  if (fromPile) {
    updateTerrainPiles(draft, (piles) => {
      const current = piles.get(key)!;
      const remaining = current.amount - amount;
      if (remaining === 0) piles.delete(key);
      else piles.set(key, { cell: current.cell, amount: remaining });
    });
  } else {
    const resources = new Map(draft.terrain.resources);
    resources.delete(key);
    (draft as unknown as { terrain: SimWorld["terrain"] }).terrain = { ...draft.terrain, resources };
  }
  events.push(
    eventOf(draft.tick, "HARVEST_SUCCEEDED", {
      actorId: unit.id,
      position: unit.position,
      values: { amount, source: fromPile ? "DROPPED_CARGO" : "RESOURCE_NODE" },
    }),
  );
}

/** 该玩家是否持有 Beacon（carrier 是其 unit 或 Core）。 */
function playerHoldsBeacon(draft: SimWorld, playerId: string): boolean {
  const beacon = draft.beacon;
  if (beacon === null || beacon.status !== "CARRIED" || beacon.carrierId === null) return false;
  const player = draft.players.get(playerId);
  if (player === undefined) return false;
  if (beacon.carrierId === `core:${player.core?.id ?? ""}`) return true;
  return player.units.some((unit) => unit.id === beacon.carrierId);
}

function resolveDepositRequests(draft: SimWorld, ctx: PhaseContext, events: ResolutionEvent[]): void {
  for (const request of collectUnitRequests(draft, ctx.plans, "DEPOSIT")) {
    const unit = findUnit(draft, request.playerId, request.unitId);
    if (unit === null || unit.unitType !== "WORKER") continue;
    resolveDeposit(draft, ctx, request.playerId, unit, events);
  }
}

function resolveDeposit(
  draft: SimWorld,
  ctx: PhaseContext,
  playerId: string,
  unit: SimUnit,
  events: ResolutionEvent[],
): void {
  const player = draft.players.get(playerId)!;
  if (unit.cargo <= 0) {
    events.push(eventOf(draft.tick, "DEPOSIT_FAILED", { reasonCode: "WORKER_EMPTY", actorId: unit.id, position: unit.position }));
    return;
  }
  const core = player.core;
  if (core === null || cellKey(core.position) !== cellKey(unit.position)) {
    events.push(eventOf(draft.tick, "DEPOSIT_FAILED", { reasonCode: "CORE_NOT_PRESENT", actorId: unit.id, position: unit.position }));
    return;
  }
  if (core.state === "MOVING") {
    events.push(eventOf(draft.tick, "DEPOSIT_FAILED", { reasonCode: "CORE_MOVING", actorId: unit.id, targetId: core.id, position: unit.position }));
    return;
  }
  const capacity = capacityOf(ctx, player.units.length);
  const space = Math.max(0, capacity - player.resources);
  if (space === 0) {
    events.push(eventOf(draft.tick, "DEPOSIT_FAILED", { reasonCode: "CORE_RESOURCE_FULL", actorId: unit.id, targetId: core.id, position: unit.position, values: { capacity } }));
    return;
  }
  const amount = Math.min(unit.cargo, space);
  const remaining = unit.cargo - amount;
  updatePlayer(draft, playerId, (current) => ({ ...current, resources: current.resources + amount }));
  updatePlayerUnits(draft, playerId, (units) => units.map((current) => (current.id === unit.id ? { ...current, cargo: remaining } : current)));
  events.push(eventOf(draft.tick, "DEPOSIT_SUCCEEDED", { actorId: unit.id, targetId: core.id, position: unit.position, values: { amount, capacity, remaining } }));
}

const unitHealPhase: Phase = {
  id: "P10-unit-heal",
  officialPhase: 10,
  run: (draft, ctx) => {
    const events: ResolutionEvent[] = [];
    for (const request of collectUnitRequests(draft, ctx.plans, "HEAL")) {
      const unit = findUnit(draft, request.playerId, request.unitId);
      if (unit !== null) resolveUnitHeal(draft, ctx, request.playerId, unit, events);
    }
    return outcome({ events });
  },
};

function resolveUnitHeal(
  draft: SimWorld,
  ctx: PhaseContext,
  playerId: string,
  unit: SimUnit,
  events: ResolutionEvent[],
): void {
  const player = draft.players.get(playerId)!;
  const core = player.core;
  if (core === null || cellKey(core.position) !== cellKey(unit.position)) {
    events.push(eventOf(draft.tick, "UNIT_HEAL_FAILED", { reasonCode: "NOT_AT_OWN_CORE", actorId: unit.id, position: unit.position }));
    return;
  }
  if (core.state === "MOVING") {
    events.push(eventOf(draft.tick, "UNIT_HEAL_FAILED", { reasonCode: "CORE_MOVING", actorId: unit.id, position: unit.position }));
    return;
  }
  const maxHp = unitHp(ctx, unit.unitType);
  if (unit.hp >= maxHp) {
    events.push(eventOf(draft.tick, "UNIT_HEAL_FAILED", { reasonCode: "HP_FULL", actorId: unit.id, position: unit.position }));
    return;
  }
  const costPerHp = ctx.rules.rules.economy.healCostPerHp;
  const affordable = costPerHp === 0 ? maxHp - unit.hp : Math.floor(player.resources / costPerHp);
  if (affordable <= 0) {
    events.push(eventOf(draft.tick, "UNIT_HEAL_FAILED", { reasonCode: "INSUFFICIENT_RESOURCES", actorId: unit.id, position: unit.position }));
    return;
  }
  const amount = Math.min(maxHp - unit.hp, affordable);
  const cost = amount * costPerHp;
  updatePlayer(draft, playerId, (current) => ({ ...current, resources: current.resources - cost }));
  updatePlayerUnits(draft, playerId, (units) => units.map((current) => (current.id === unit.id ? { ...current, hp: unit.hp + amount } : current)));
  events.push(eventOf(draft.tick, "UNIT_HEAL_SUCCEEDED", { actorId: unit.id, position: unit.position, values: { amount, hp: unit.hp + amount, cost } }));
}

const coreActionPhase: Phase = {
  id: "P11-stationary-core-action",
  officialPhase: 11,
  run: (draft, ctx) => {
    const events: ResolutionEvent[] = [];
    const unknownEffects: UnknownEffect[] = [];
    for (const playerId of sortedPlayerIds(draft)) {
      const plan = ctx.plans.get(playerId);
      const player = draft.players.get(playerId)!;
      if (plan?.coreAction === null || plan?.coreAction === undefined || player.core === null) continue;
      const action = plan.coreAction;
      if (action.type === "WAIT") continue;
      // START_MOVE / CANCEL_MOVE 由 P06 core-migration resolver 独占处理（本 phase 仅 stationary 动作）
      if (action.type === "START_MOVE" || action.type === "CANCEL_MOVE") continue;
      if (player.core.state === "MOVING") {
        events.push(eventOf(draft.tick, "CORE_ACTION_FAILED", { reasonCode: "CORE_ALREADY_MOVING", actorId: player.core.id, position: player.core.position }));
        continue;
      }
      if (action.type === "SPAWN") resolveSpawn(draft, ctx, playerId, action.unitType, events, unknownEffects);
      else if (action.type === "HEAL") resolveCoreHeal(draft, ctx, playerId, events);
      else if (action.type === "REPAIR_SHIELD") resolveRepairShield(draft, ctx, playerId, events);
    }
    return outcome({ events, unknownEffects });
  },
};

function resolveSpawn(
  draft: SimWorld,
  ctx: PhaseContext,
  playerId: string,
  unitType: UnitType,
  events: ResolutionEvent[],
  unknownEffects: UnknownEffect[],
): void {
  const player = draft.players.get(playerId)!;
  const core = player.core!;
  const cost = unitCost(ctx, unitType);
  const colocated = player.units.filter((unit) => cellKey(unit.position) === cellKey(core.position)).length;
  if (colocated >= CELL_ENTITY_CAPACITY - 1) {
    events.push(eventOf(draft.tick, "CORE_SPAWN_FAILED", { reasonCode: "CELL_UNIT_LIMIT", actorId: core.id, position: core.position, values: { limit: CELL_ENTITY_CAPACITY } }));
    return;
  }
  if (player.resources < cost) {
    events.push(eventOf(draft.tick, "CORE_SPAWN_FAILED", { reasonCode: "INSUFFICIENT_RESOURCES", actorId: core.id, position: core.position, values: { required: cost } }));
    return;
  }
  const newId = deterministicUnitId(draft, playerId, unitType);
  if (entityIdExists(draft, newId)) {
    events.push(eventOf(draft.tick, "CORE_SPAWN_FAILED", { reasonCode: "DETERMINISTIC_ID_COLLISION", actorId: core.id, position: core.position }));
    return;
  }
  const newUnit: SimUnit = { id: newId, owner: playerId, position: core.position, hp: unitHp(ctx, unitType), unitType, cargo: 0 };
  updatePlayer(draft, playerId, (current) => ({ ...current, resources: current.resources - cost, units: [...current.units, newUnit] }));
  events.push(eventOf(draft.tick, "CORE_SPAWN_SUCCEEDED", { actorId: core.id, targetId: newId, position: core.position, values: { unit_type: unitType, cost } }));
  unknownEffects.push({ tick: draft.tick, kind: "server-generated-id", note: `spawned ${unitType} uses deterministic local UUID ${newId}; server UUID algorithm is not public` });
}

function resolveCoreHeal(draft: SimWorld, ctx: PhaseContext, playerId: string, events: ResolutionEvent[]): void {
  const player = draft.players.get(playerId)!;
  const core = player.core!;
  const maxHp = ctx.rules.rules.core.maxHp;
  if (core.hp >= maxHp) {
    events.push(eventOf(draft.tick, "CORE_HEAL_FAILED", { reasonCode: "HP_FULL", actorId: core.id, position: core.position }));
    return;
  }
  const costPerHp = ctx.rules.rules.economy.healCostPerHp;
  const affordable = costPerHp === 0 ? maxHp - core.hp : Math.floor(player.resources / costPerHp);
  if (affordable <= 0) {
    events.push(eventOf(draft.tick, "CORE_HEAL_FAILED", { reasonCode: "INSUFFICIENT_RESOURCES", actorId: core.id, position: core.position }));
    return;
  }
  const amount = Math.min(maxHp - core.hp, affordable);
  const cost = amount * costPerHp;
  updatePlayer(draft, playerId, (current) => ({ ...current, resources: current.resources - cost, core: { ...current.core!, hp: core.hp + amount } }));
  events.push(eventOf(draft.tick, "CORE_HEAL_SUCCEEDED", { actorId: core.id, position: core.position, values: { amount, hp: core.hp + amount, cost } }));
}

function resolveRepairShield(draft: SimWorld, ctx: PhaseContext, playerId: string, events: ResolutionEvent[]): void {
  const player = draft.players.get(playerId)!;
  const core = player.core!;
  const maxShield = ctx.rules.rules.core.maxShield;
  if (core.shield >= maxShield) {
    events.push(eventOf(draft.tick, "CORE_REPAIR_FAILED", { reasonCode: "SHIELD_FULL", actorId: core.id, position: core.position }));
    return;
  }
  const cost = ctx.rules.rules.economy.repairShieldCost;
  if (player.resources < cost) {
    events.push(eventOf(draft.tick, "CORE_REPAIR_FAILED", { reasonCode: "INSUFFICIENT_RESOURCES", actorId: core.id, position: core.position }));
    return;
  }
  updatePlayer(draft, playerId, (current) => ({ ...current, resources: current.resources - cost, core: { ...current.core!, shield: core.shield + 1 } }));
  events.push(eventOf(draft.tick, "CORE_REPAIR_SUCCEEDED", { actorId: core.id, position: core.position, values: { shield: core.shield + 1, cost } }));
}

function deterministicUnitId(draft: SimWorld, playerId: string, unitType: UnitType): string {
  const digest = createHash("sha256")
    .update(`${draft.rulesVersion}\0${draft.seed}\0${draft.tick}\0${playerId}\0${unitType}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  digest[12] = "4";
  digest[16] = ["8", "9", "a", "b"][Number.parseInt(digest[16], 16) & 3];
  const hex = digest.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function entityIdExists(draft: SimWorld, id: string): boolean {
  for (const player of draft.players.values()) {
    if (player.core?.id === id || player.units.some((unit) => unit.id === id)) return true;
  }
  return false;
}

export const economyPhases: readonly Phase[] = [
  selfDestructPhase,
  capacityShrinkPhase,
  upkeepPhase,
  harvestDepositPhase,
  unitHealPhase,
  coreActionPhase,
];
