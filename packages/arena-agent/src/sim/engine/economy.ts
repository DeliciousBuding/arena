/**
 * Economy resolver（S5）：self-destruct / capacity / upkeep / harvest / deposit /
 * unit-heal / core-action（SPAWN/HEAL/REPAIR_SHIELD）。
 *
 * 事件与 reason codes 对齐官方 resolution-results.md 与 v0.11 changelog：
 * - UPKEEP_PAID {due, paid, deficit}；UNIT_DAMAGED/UPKEEP_DEFICIT（v0.11：打多余单位）
 * - HARVEST_SUCCEEDED {amount, source}；HARVEST_FAILED（NOT_RESOURCE_CELL/CARGO_FULL/RESOURCE_DEPLETED）
 * - DEPOSIT_SUCCEEDED {amount, capacity, remaining}；DEPOSIT_FAILED（WORKER_EMPTY/CORE_NOT_PRESENT/CORE_RESOURCE_FULL）
 * - CORE_SPAWN_SUCCEEDED {unit_type, cost}；CORE_SPAWN_FAILED（INSUFFICIENT_RESOURCES/CELL_UNIT_LIMIT）
 * - CORE_HEAL_SUCCEEDED / UNIT_HEAL_SUCCEEDED；CORE_ACTION_FAILED
 *
 * 所有资源变化只读 rules contract（ctx.rules），不在代码散落 magic numbers。
 */

import { cellKey, type Plan, type Position, type UnitType } from "../../domain/model.ts";
import { compareUuidRaw, sortByUuidRaw } from "../deterministic/uuid.ts";
import { eventOf, outcome, type Phase, type PhaseContext, type ResolutionEvent } from "./phase.ts";
import { CELL_ENTITY_CAPACITY } from "../world/world.ts";
import type { SimPlayer, SimUnit, SimWorld } from "../world/types.ts";

/* ---------------- 数值（读 rules contract） ---------------- */

function capacityOf(ctx: PhaseContext, population: number): number {
  const core = ctx.rules.rules.core;
  return Math.max(core.minCapacity, population * core.capacityPerUnit);
}

function upkeepOf(ctx: PhaseContext, population: number): number {
  const tier = Math.floor(population / ctx.rules.rules.upkeep.tierSize);
  return (tier * (tier + 1)) / 2;
}

function manhattan(a: Position, b: Position): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

/* ---------------- draft 更新 helper ---------------- */

function updatePlayers(draft: SimWorld, fn: (players: Map<string, SimPlayer>) => Map<string, SimPlayer>): void {
  (draft as unknown as { players: Map<string, SimPlayer> }).players = fn(new Map(draft.players));
}

function updatePlayerUnits(
  draft: SimWorld,
  playerId: string,
  fn: (units: readonly SimUnit[]) => readonly SimUnit[],
): void {
  updatePlayers(draft, (players) => {
    const player = players.get(playerId);
    if (player === undefined) return players;
    players.set(playerId, { ...player, units: fn(player.units) });
    return players;
  });
}

function updateTerrainPiles(
  draft: SimWorld,
  fn: (piles: Map<string, { readonly cell: Position; readonly amount: number }>) => Map<string, { readonly cell: Position; readonly amount: number }>,
): void {
  (draft as { terrain: SimWorld["terrain"] }).terrain = {
    ...draft.terrain,
    piles: fn(new Map(draft.terrain.piles)),
  };
}

function removeUnit(draft: SimWorld, playerId: string, unit: SimUnit, tick: number, events: ResolutionEvent[]): void {
  updatePlayerUnits(draft, playerId, (units) => units.filter((u) => u.id !== unit.id));
  if (unit.cargo > 0) {
    const key = cellKey(unit.position);
    updateTerrainPiles(draft, (piles) => {
      const existing = piles.get(key)?.amount ?? 0;
      piles.set(key, { cell: unit.position, amount: existing + unit.cargo });
      return piles;
    });
  }
  events.push(eventOf(tick, "UNIT_SELF_DESTRUCTED", { actorId: unit.id, position: unit.position }));
}

/* ---------------- P02 self-destruct ---------------- */

const selfDestructPhase: Phase = {
  id: "P02-self-destruct",
  officialPhase: 2,
  run: (draft, ctx) => {
    const events: ResolutionEvent[] = [];
    for (const [playerId, plan] of ctx.plans) {
      for (const [unitId, action] of Object.entries(plan.unitActions)) {
        if (action.type !== "SELF_DESTRUCT") continue;
        const player = draft.players.get(playerId);
        if (player === undefined) continue;
        const unit = player.units.find((u) => u.id === unitId);
        if (unit === undefined) continue;
        removeUnit(draft, playerId, unit, draft.tick, events);
      }
    }
    return outcome({ events });
  },
};

/* ---------------- P03 capacity-shrink ---------------- */

const capacityShrinkPhase: Phase = {
  id: "P03-capacity-shrink-after-removal",
  officialPhase: 2,
  run: (draft, ctx) => {
    const events: ResolutionEvent[] = [];
    for (const player of [...draft.players.values()]) {
      const cap = capacityOf(ctx, player.units.length);
      if (player.resources > cap) {
        const amount = player.resources - cap;
        updatePlayers(draft, (players) => {
          const p = players.get(player.id)!;
          players.set(player.id, { ...p, resources: cap });
          return players;
        });
        if (player.core !== null) {
          events.push(
            eventOf(draft.tick, "CORE_RESOURCE_OVERFLOW_DESTROYED", {
              actorId: player.core.id,
              position: player.core.position,
              values: { amount, capacity: cap },
            }),
          );
        }
      }
    }
    return outcome({ events });
  },
};

/* ---------------- P04 upkeep-and-deficit（v0.11） ---------------- */

const upkeepPhase: Phase = {
  id: "P04-upkeep-and-deficit",
  officialPhase: 3,
  run: (draft, ctx) => {
    const events: ResolutionEvent[] = [];
    for (const player of [...draft.players.values()]) {
      const due = upkeepOf(ctx, player.units.length);
      if (due === 0) continue;
      const paid = Math.min(player.resources, due);
      const deficit = due - paid;
      updatePlayers(draft, (players) => {
        const p = players.get(player.id)!;
        players.set(player.id, { ...p, resources: p.resources - paid });
        return players;
      });
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
        applyDeficitDamage(draft, ctx, player.id, deficit, events);
      }
    }
    return outcome({ events });
  },
};

/** v0.11 deficit：最近的 protectionCount 个受保护；其余从远到近受伤，同距 raw UUID 序。 */
function applyDeficitDamage(
  draft: SimWorld,
  ctx: PhaseContext,
  playerId: string,
  deficit: number,
  events: ResolutionEvent[],
): void {
  const player = draft.players.get(playerId);
  if (player === undefined || player.core === null) return;
  const corePos = player.core.position;
  const protection = ctx.rules.rules.upkeep.deficitProtectionCount;

  // 排序：距离从远到近；同距 ascending raw UUID
  const ordered = [...player.units].sort((a, b) => {
    const da = manhattan(a.position, corePos);
    const db = manhattan(b.position, corePos);
    if (da !== db) return db - da;
    return compareUuidRaw(a.id, b.id);
  });
  const atRisk = ordered.slice(0, Math.max(0, ordered.length - protection));

  let remaining = deficit;
  for (const unit of atRisk) {
    if (remaining <= 0) break;
    const damage = Math.min(remaining, unit.hp);
    remaining -= damage;
    const hpAfter = unit.hp - damage;
    events.push(
      eventOf(draft.tick, "UNIT_DAMAGED", {
        reasonCode: "UPKEEP_DEFICIT",
        actorId: unit.id,
        position: unit.position,
        values: { damage, hp: Math.max(0, hpAfter) },
      }),
    );
    if (hpAfter <= 0) {
      removeUnit(draft, playerId, unit, draft.tick, events);
    } else {
      updatePlayerUnits(draft, playerId, (units) =>
        units.map((u) => (u.id === unit.id ? { ...u, hp: hpAfter } : u)),
      );
    }
  }
}

/* ---------------- P08 harvest-and-deposit ---------------- */

const harvestDepositPhase: Phase = {
  id: "P08-harvest-and-deposit",
  officialPhase: 8,
  run: (draft, ctx) => {
    const events: ResolutionEvent[] = [];
    for (const [playerId, plan] of ctx.plans) {
      const player = draft.players.get(playerId);
      if (player === undefined) continue;
      for (const [unitId, action] of Object.entries(plan.unitActions)) {
        const unit = player.units.find((u) => u.id === unitId);
        if (unit === undefined) continue;
        if (action.type === "HARVEST") {
          resolveHarvest(draft, ctx, playerId, unit, events);
        } else if (action.type === "DEPOSIT") {
          resolveDeposit(draft, ctx, playerId, unit, events);
        }
      }
    }
    return outcome({ events });
  },
};

function resolveHarvest(
  draft: SimWorld,
  ctx: PhaseContext,
  playerId: string,
  unit: SimUnit,
  events: ResolutionEvent[],
): void {
  const key = cellKey(unit.position);
  if (unit.cargo > 0) {
    events.push(eventOf(draft.tick, "HARVEST_FAILED", { reasonCode: "CARGO_FULL", actorId: unit.id, position: unit.position }));
    return;
  }
  const pile = draft.terrain.piles.get(key);
  const node = draft.terrain.resources.get(key);
  if (pile === undefined && node === undefined) {
    events.push(eventOf(draft.tick, "HARVEST_FAILED", { reasonCode: "NOT_RESOURCE_CELL", actorId: unit.id, position: unit.position }));
    return;
  }
  // 同格多 Worker 争抢：最低 UUID 赢（含 pile 与节点统一竞争）
  const player = draft.players.get(playerId)!;
  const contenders = player.units.filter(
    (u) =>
      u.id !== unit.id &&
      u.cargo === 0 &&
      cellKey(u.position) === key &&
      (draft.terrain.piles.has(key) || draft.terrain.resources.has(key)),
  );
  for (const contender of contenders) {
    if (compareUuidRaw(unit.id, contender.id) > 0) {
      events.push(eventOf(draft.tick, "HARVEST_FAILED", { reasonCode: "RESOURCE_DEPLETED", actorId: unit.id, position: unit.position }));
      return;
    }
  }
  // 成功：先回收 pile（DROPPED_CARGO），否则自然节点；消耗节点
  const fromPile = pile !== undefined;
  const amount = ctx.rules.rules.economy.harvestAmount;
  updatePlayerUnits(draft, playerId, (units) => units.map((u) => (u.id === unit.id ? { ...u, cargo: amount } : u)));
  if (fromPile) {
    updateTerrainPiles(draft, (piles) => {
      const p = piles.get(key)!;
      if (p.amount - amount <= 0) {
        piles.delete(key);
      } else {
        piles.set(key, { cell: p.cell, amount: p.amount - amount });
      }
      return piles;
    });
  } else {
    (draft as unknown as { terrain: SimWorld["terrain"] }).terrain = {
      ...draft.terrain,
      resources: new Map([...draft.terrain.resources].filter(([k]) => k !== key)),
    };
  }
  events.push(
    eventOf(draft.tick, "HARVEST_SUCCEEDED", {
      actorId: unit.id,
      position: unit.position,
      values: { amount, source: fromPile ? "DROPPED_CARGO" : "RESOURCE_NODE" },
    }),
  );
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
  const cap = capacityOf(ctx, player.units.length);
  const space = Math.max(0, cap - player.resources);
  if (space === 0) {
    events.push(
      eventOf(draft.tick, "DEPOSIT_FAILED", {
        reasonCode: "CORE_RESOURCE_FULL",
        actorId: unit.id,
        targetId: core.id,
        position: unit.position,
        values: { capacity: cap },
      }),
    );
    return;
  }
  const amount = Math.min(unit.cargo, space);
  const remaining = unit.cargo - amount;
  updatePlayers(draft, (players) => {
    const p = players.get(playerId)!;
    players.set(playerId, { ...p, resources: p.resources + amount });
    return players;
  });
  updatePlayerUnits(draft, playerId, (units) => units.map((u) => (u.id === unit.id ? { ...u, cargo: remaining } : u)));
  events.push(
    eventOf(draft.tick, "DEPOSIT_SUCCEEDED", {
      actorId: unit.id,
      targetId: core.id,
      position: unit.position,
      values: { amount, capacity: cap, remaining },
    }),
  );
}

/* ---------------- P10 unit-heal ---------------- */

const unitHealPhase: Phase = {
  id: "P10-unit-heal",
  officialPhase: 10,
  run: (draft, ctx) => {
    const events: ResolutionEvent[] = [];
    const healers: { playerId: string; unit: SimUnit }[] = [];
    for (const [playerId, plan] of ctx.plans) {
      const player = draft.players.get(playerId);
      if (player === undefined) continue;
      for (const [unitId, action] of Object.entries(plan.unitActions)) {
        if (action.type !== "HEAL") continue;
        const unit = player.units.find((u) => u.id === unitId);
        if (unit !== undefined) healers.push({ playerId, unit });
      }
    }
    healers.sort((a, b) => compareUuidRaw(a.unit.id, b.unit.id));
    for (const { playerId, unit } of healers) {
      resolveUnitHeal(draft, ctx, playerId, unit, events);
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
  if (unit.hp >= ctx.rules.rules.units.workerHp) {
    events.push(eventOf(draft.tick, "UNIT_HEAL_FAILED", { reasonCode: "HP_FULL", actorId: unit.id, position: unit.position }));
    return;
  }
  const missing = ctx.rules.rules.units.workerHp - unit.hp;
  const cost = Math.min(missing, player.resources);
  if (cost === 0) {
    events.push(eventOf(draft.tick, "UNIT_HEAL_FAILED", { reasonCode: "INSUFFICIENT_RESOURCES", actorId: unit.id, position: unit.position }));
    return;
  }
  updatePlayers(draft, (players) => {
    const p = players.get(playerId)!;
    players.set(playerId, { ...p, resources: p.resources - cost });
    return players;
  });
  updatePlayerUnits(draft, playerId, (units) => units.map((u) => (u.id === unit.id ? { ...u, hp: unit.hp + cost } : u)));
  events.push(
    eventOf(draft.tick, "UNIT_HEAL_SUCCEEDED", {
      actorId: unit.id,
      position: unit.position,
      values: { amount: cost, hp: unit.hp + cost, cost },
    }),
  );
}

/* ---------------- P11 stationary-core-action ---------------- */

const coreActionPhase: Phase = {
  id: "P11-stationary-core-action",
  officialPhase: 11,
  run: (draft, ctx) => {
    const events: ResolutionEvent[] = [];
    for (const [playerId, plan] of ctx.plans) {
      const player = draft.players.get(playerId);
      if (player === undefined || player.core === null) continue;
      const action = plan.coreAction;
      if (action === null) continue;
      switch (action.type) {
        case "SPAWN":
          resolveSpawn(draft, ctx, playerId, player, action.unitType, events);
          break;
        case "HEAL":
          resolveCoreHeal(draft, ctx, playerId, events);
          break;
        case "REPAIR_SHIELD":
          resolveRepairShield(draft, ctx, playerId, events);
          break;
        default:
          break; // WAIT 等无操作
      }
    }
    return outcome({ events });
  },
};

function resolveSpawn(
  draft: SimWorld,
  ctx: PhaseContext,
  playerId: string,
  player: SimPlayer,
  unitType: UnitType,
  events: ResolutionEvent[],
): void {
  const core = player.core!;
  const cost = unitCost(ctx, unitType);
  // Core 格容量：Core 占 1 槽 → 同格 Unit 数 ≤ 1
  const colocated = player.units.filter((u) => cellKey(u.position) === cellKey(core.position)).length;
  if (colocated >= CELL_ENTITY_CAPACITY - 1) {
    events.push(
      eventOf(draft.tick, "CORE_SPAWN_FAILED", {
        reasonCode: "CELL_UNIT_LIMIT",
        actorId: core.id,
        position: core.position,
        values: { limit: CELL_ENTITY_CAPACITY },
      }),
    );
    return;
  }
  if (player.resources < cost) {
    events.push(
      eventOf(draft.tick, "CORE_SPAWN_FAILED", {
        reasonCode: "INSUFFICIENT_RESOURCES",
        actorId: core.id,
        position: core.position,
        values: { required: cost },
      }),
    );
    return;
  }
  const newId = deterministicUnitId(ctx, playerId);
  const maxHp = unitHp(ctx, unitType);
  const newUnit: SimUnit = {
    id: newId,
    owner: playerId,
    position: core.position,
    hp: maxHp,
    unitType,
    cargo: 0,
  };
  updatePlayers(draft, (players) => {
    const p = players.get(playerId)!;
    players.set(playerId, { ...p, resources: p.resources - cost, units: [...p.units, newUnit] });
    return players;
  });
  events.push(
    eventOf(draft.tick, "CORE_SPAWN_SUCCEEDED", {
      actorId: core.id,
      targetId: newId,
      position: core.position,
      values: { unit_type: unitType, cost },
    }),
  );
}

function resolveCoreHeal(draft: SimWorld, ctx: PhaseContext, playerId: string, events: ResolutionEvent[]): void {
  const player = draft.players.get(playerId)!;
  const core = player.core!;
  const maxHp = ctx.rules.rules.core.maxHp;
  if (core.hp >= maxHp) {
    events.push(eventOf(draft.tick, "CORE_HEAL_FAILED", { reasonCode: "HP_FULL", actorId: core.id, position: core.position }));
    return;
  }
  const missing = maxHp - core.hp;
  const cost = Math.min(missing, player.resources);
  if (cost === 0) {
    events.push(
      eventOf(draft.tick, "CORE_HEAL_FAILED", { reasonCode: "INSUFFICIENT_RESOURCES", actorId: core.id, position: core.position }),
    );
    return;
  }
  updatePlayers(draft, (players) => {
    const p = players.get(playerId)!;
    players.set(playerId, { ...p, resources: p.resources - cost, core: { ...p.core!, hp: core.hp + cost } });
    return players;
  });
  events.push(
    eventOf(draft.tick, "CORE_HEAL_SUCCEEDED", {
      actorId: core.id,
      position: core.position,
      values: { amount: cost, hp: core.hp + cost, cost },
    }),
  );
}

function resolveRepairShield(draft: SimWorld, ctx: PhaseContext, playerId: string, events: ResolutionEvent[]): void {
  const player = draft.players.get(playerId)!;
  const core = player.core!;
  const cap = ctx.rules.rules.core.maxShield;
  if (core.shield >= cap) {
    events.push(eventOf(draft.tick, "CORE_SHIELD_REPAIR_FAILED", { reasonCode: "SHIELD_FULL", actorId: core.id, position: core.position }));
    return;
  }
  if (player.resources < ctx.rules.rules.economy.repairShieldCost) {
    events.push(
      eventOf(draft.tick, "CORE_SHIELD_REPAIR_FAILED", {
        reasonCode: "INSUFFICIENT_RESOURCES",
        actorId: core.id,
        position: core.position,
      }),
    );
    return;
  }
  const cost = ctx.rules.rules.economy.repairShieldCost;
  updatePlayers(draft, (players) => {
    const p = players.get(playerId)!;
    players.set(playerId, { ...p, resources: p.resources - cost, core: { ...p.core!, shield: core.shield + 1 } });
    return players;
  });
  events.push(
    eventOf(draft.tick, "CORE_SHIELD_REPAIRED", {
      actorId: core.id,
      position: core.position,
      values: { shield: core.shield + 1, cost },
    }),
  );
}

/* ---------------- helpers ---------------- */

function unitCost(ctx: PhaseContext, unitType: UnitType): number {
  const p = ctx.rules.rules.production;
  return unitType === "WORKER" ? p.workerCost : unitType === "VANGUARD" ? p.vanguardCost : p.rangerCost;
}

function unitHp(ctx: PhaseContext, unitType: UnitType): number {
  const u = ctx.rules.rules.units;
  return unitType === "WORKER" ? u.workerHp : unitType === "VANGUARD" ? u.vanguardHp : u.rangerHp;
}

/** 确定性 spawn ID：seeded RNG 生成 canonical UUID（服务端为 deterministic 校验；客户端可预测）。 */
function deterministicUnitId(ctx: PhaseContext, playerId: string): string {
  const rng = ctx.rng;
  const hex = (): string =>
    Math.floor((rng !== null ? rng() : 0.5) * 0x100000000)
      .toString(16)
      .padStart(8, "0");
  const a = hex();
  const b = hex().slice(0, 4);
  const c = hex().slice(0, 4);
  const d = hex().slice(0, 4);
  const e = hex() + hex().slice(0, 4); // 12 位
  return `${a}-${b}-${c}-${d}-${e}`.toLowerCase();
}

/* ---------------- 导出 ---------------- */

export const economyPhases: readonly Phase[] = [
  selfDestructPhase,
  capacityShrinkPhase,
  upkeepPhase,
  harvestDepositPhase,
  unitHealPhase,
  coreActionPhase,
];

export { sortByUuidRaw };
