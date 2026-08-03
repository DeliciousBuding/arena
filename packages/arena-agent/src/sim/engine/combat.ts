/**
 * Combat resolver（S10）：v0.11 快照式战斗结算。
 *
 * 规则来源：docs/game-rules.md §Combat（官方 15-phase order 第 9 步）。
 *
 * 语义要点：
 * - 冻结不可变 combat snapshot：验证全部锁定攻击 → 累积伤害 → 同时应用 →
 *   之后才移除死亡 Unit / 摧毁 Core；互杀合法，请求顺序不授予先手。
 * - SWEEP（Vanguard）：对相邻目标格内所有敌方 Unit 与敌方 Core 造成 1 伤害；
 *   多次 sweep 叠加。
 * - SHOOT（Ranger）：对 1 个选定敌方对象造成 1 伤害；需水平/垂直/精确 45°
 *   对角八方向线且中间射程格（1-3）无障碍物阻断；Unit/Core/对角旁障碍不阻断。
 * - Core 伤害先消耗 shield 再消耗 hp；Core hp 归零 → fleet 移除 + Worker
 *   cargo 原地掉落 + 击杀者（伤害最高者，平手取低 raw UUID）获得资源。
 * - 出生 Tick 的新生 Unit 不可被攻击；致命伤害不可被后续 HEAL 治疗。
 */

import { cellKey, type Direction, type Plan, type Position } from "../../domain/model.ts";
import { compareUuidRaw } from "../deterministic/uuid.ts";
import type { SimBeacon, SimPlayer, SimWorld } from "../world/types.ts";
import { clampShieldAfterBeaconLoss } from "./beacon.ts";
import { eventOf, outcome, type Phase, type PhaseContext, type ResolutionEvent } from "./phase.ts";

const DIRECTION_DELTA: Readonly<Record<Direction, readonly [number, number]>> = {
  UP: [0, -1],
  DOWN: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
};

/** 战斗快照中可被攻击的对象（Unit 或 Core）。 */
interface CombatTarget {
  readonly id: string;
  readonly playerId: string;
  readonly position: Position;
  readonly kind: "unit" | "core";
  readonly unitType: "WORKER" | "VANGUARD" | "RANGER" | null;
  readonly hp: number;
  readonly shield: number | null;
  /** 本 tick 刚出生（SPAWN 结算于 P11，晚于 P09）——不适用，保留字段以防未来顺序变化。 */
  readonly bornThisTick: boolean;
}

interface LockedAttack {
  readonly actorId: string;
  readonly playerId: string;
  readonly kind: "sweep" | "shoot";
  readonly direction: Direction | null;
  readonly targetId: string | null;
}

interface DamageTarget {
  readonly targetId: string;
  readonly damage: number;
}

export interface CombatResolution {
  readonly events: readonly ResolutionEvent[];
  /** 每个目标收到的总伤害。 */
  readonly damageByTarget: ReadonlyMap<string, number>;
  /** 每个玩家对一个 Core 的总伤害（victimCoreId → playerId → damage）。 */
  readonly damageToCoreByPlayer: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly killedUnits: readonly string[];
  readonly destroyedCores: readonly string[];
}

function stepCell(source: Position, direction: Direction): Position {
  const [dx, dy] = DIRECTION_DELTA[direction];
  return [source[0] + dx, source[1] + dy];
}

function sameCell(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function manhattan(a: Position, b: Position): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

/** 八方向线：水平/垂直/精确 45° 对角，距离 1-3。 */
function isEightDirectionLine(actor: Position, target: Position, maxRange: number): boolean {
  const dx = target[0] - actor[0];
  const dy = target[1] - actor[1];
  const distance = Math.max(Math.abs(dx), Math.abs(dy));
  if (distance < 1 || distance > maxRange) return false;
  if (dx === 0 || dy === 0) return true;
  return Math.abs(dx) === Math.abs(dy);
}

/** 射程线中间格（不含射手格与目标格）。 */
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

/** 快照：unit 全集 + core 全集（含随后可能被杀死的对象）。 */
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
        bornThisTick: false,
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
        bornThisTick: false,
      });
    }
  }
  return targets;
}

/** 收集计划中的攻击（SWEEP/SHOOT），确定性排序（与输入顺序无关）。 */
function collectAttacks(world: SimWorld, plans: ReadonlyMap<string, Plan>): LockedAttack[] {
  const attacks: LockedAttack[] = [];
  for (const [playerId, plan] of plans) {
    for (const [unitId, action] of Object.entries(plan.unitActions)) {
      if (action.type === "SWEEP") {
        attacks.push({ actorId: unitId, playerId, kind: "sweep", direction: action.direction, targetId: null });
      } else if (action.type === "SHOOT") {
        attacks.push({ actorId: unitId, playerId, kind: "shoot", direction: null, targetId: action.targetId });
      }
    }
  }
  attacks.sort((a, b) => compareUuidRaw(a.actorId, b.actorId));
  return attacks;
}

/** 攻击者是否存活（在快照中，且未被本 tick 杀死——快照语义：攻击者死亡仍可攻击）。 */
function actorExists(targets: readonly CombatTarget[], actorId: string): boolean {
  return targets.some((t) => t.id === actorId && t.kind === "unit");
}

/** 对单个攻击返回命中的目标列表（SWEEP 可多目标，SHOOT 至多 1）。 */
function hitTargets(
  world: SimWorld,
  targets: readonly CombatTarget[],
  attack: LockedAttack,
): CombatTarget[] {
  if (!actorExists(targets, attack.actorId)) return [];
  const actor = targets.find((t) => t.id === attack.actorId)!;

  if (attack.kind === "sweep") {
    const dest = stepCell(actor.position, attack.direction!);
    return targets.filter(
      (target) => target.playerId !== attack.playerId && sameCell(target.position, dest),
    );
  }

  // SHOOT：目标必须存在、属于敌方、八方向线 1-3、中间格无障碍
  const target = targets.find((t) => t.id === attack.targetId);
  if (target === undefined || target.playerId === attack.playerId) return [];
  if (!isEightDirectionLine(actor.position, target.position, 3)) return [];
  for (const cell of intermediateCells(actor.position, target.position)) {
    if (isObstacleCell(world, cell)) return [];
  }
  return [target];
}

/**
 * 结算一次战斗。纯函数，不修改 world。
 * 所有验证针对冻结快照；伤害累积后同时应用。
 */
export function resolveCombat(world: SimWorld, plans: ReadonlyMap<string, Plan>): CombatResolution {
  const targets = snapshotTargets(world);
  const attacks = collectAttacks(world, plans);

  // 1. 验证（对快照）+ 累积伤害
  const damageByTarget = new Map<string, number>();
  for (const attack of attacks) {
    for (const hit of hitTargets(world, targets, attack)) {
      damageByTarget.set(hit.id, (damageByTarget.get(hit.id) ?? 0) + 1);
    }
  }

  // 2. 按目标应用伤害（同时）：unit 直接扣 hp；core 先盾后 hp
  const events: ResolutionEvent[] = [];
  const killedUnits: string[] = [];
  const destroyedCores: string[] = [];
  const hpAfter = new Map<string, number>();

  for (const target of targets) {
    const incoming = damageByTarget.get(target.id) ?? 0;
    if (incoming <= 0) continue;
    if (target.kind === "unit") {
      const hp = Math.max(0, target.hp - incoming);
      hpAfter.set(target.id, hp);
      events.push(
        eventOf(world.tick, "UNIT_DAMAGED", {
          reasonCode: "COMBAT",
          targetId: target.id,
          position: target.position,
          values: { damage: incoming, hp },
        }),
      );
      if (hp <= 0) killedUnits.push(target.id);
    } else {
      const absorbedByShield = Math.min(target.shield ?? 0, incoming);
      const absorbedByHp = incoming - absorbedByShield;
      const shield = (target.shield ?? 0) - absorbedByShield;
      const hp = Math.max(0, target.hp - absorbedByHp);
      events.push(
        eventOf(world.tick, "CORE_DAMAGED", {
          reasonCode: "COMBAT",
          targetId: target.id,
          position: target.position,
          values: { damage: incoming, hp, shield },
        }),
      );
      if (hp <= 0) destroyedCores.push(target.id);
    }
  }

  // 3. 每个玩家对一个 Core 的总伤害（击杀者归属用）
  const damageToCoreByPlayer = new Map<string, Map<string, number>>();
  for (const attack of attacks) {
    for (const hit of hitTargets(world, targets, attack)) {
      if (hit.kind !== "core") continue;
      let byPlayer = damageToCoreByPlayer.get(hit.id);
      if (byPlayer === undefined) {
        byPlayer = new Map();
        damageToCoreByPlayer.set(hit.id, byPlayer);
      }
      byPlayer.set(attack.playerId, (byPlayer.get(attack.playerId) ?? 0) + 1);
    }
  }

  return {
    events,
    damageByTarget,
    damageToCoreByPlayer,
    killedUnits: [...new Set(killedUnits)].sort(compareUuidRaw),
    destroyedCores: [...new Set(destroyedCores)].sort(compareUuidRaw),
  };
}

/** P09 combat phase：把战斗结算应用到 draft。 */
export const combatPhase: Phase = {
  id: "P09-combat",
  officialPhase: 9,
  run: (draft, ctx) => {
    if (!ctx.features.has("combat")) return outcome({});
    const resolution = resolveCombat(draft, ctx.plans);
    const events = [...resolution.events];
    // 先应用非致命伤害（unit hp / core shield+hp），再处理死亡/摧毁
    applyDamage(draft, resolution);
    if (resolution.destroyedCores.length > 0) {
      applyCoreDestruction(draft, resolution, events);
    }
    if (resolution.killedUnits.length > 0) {
      applyUnitDeaths(draft, resolution.killedUnits, events);
    }
    return outcome({ events });
  },
};

/** 把非致命伤害写回 draft（unit hp、core shield/hp）。 */
function applyDamage(draft: SimWorld, resolution: CombatResolution): void {
  const players = new Map(draft.players);
  for (const [playerId, player] of draft.players) {
    let changed = false;
    let core = player.core;
    if (core !== null) {
      const coreDamage = resolution.damageByTarget.get(core.id) ?? 0;
      if (coreDamage > 0) {
        const absorbedByShield = Math.min(core.shield, coreDamage);
        const absorbedByHp = coreDamage - absorbedByShield;
        core = { ...core, shield: core.shield - absorbedByShield, hp: Math.max(0, core.hp - absorbedByHp) };
        changed = true;
      }
    }
    const units = player.units.map((unit) => {
      const unitDamage = resolution.damageByTarget.get(unit.id) ?? 0;
      if (unitDamage <= 0) return unit;
      changed = true;
      return { ...unit, hp: Math.max(0, unit.hp - unitDamage) };
    });
    if (changed) {
      players.set(playerId, { ...player, core, units });
    }
  }
  (draft as unknown as { players: Map<string, SimPlayer> }).players = players;
}

function applyCoreDestruction(
  draft: SimWorld,
  resolution: CombatResolution,
  events: ResolutionEvent[],
): void {
  const players = new Map(draft.players);
  for (const coreId of resolution.destroyedCores) {
    const victim = [...players.values()].find((p) => p.core?.id === coreId);
    if (victim === undefined || victim.core === null) continue;

    // 击杀者 = 本 tick 对该 Core 伤害最高的玩家；平手取低 raw player UUID；
    // 击杀者 Core 必须存活（在结算后仍存在）。
    const byPlayer = resolution.damageToCoreByPlayer.get(coreId) ?? new Map<string, number>();
    let winner: string | null = null;
    let winnerDamage = 0;
    for (const [attackerId, dealt] of byPlayer) {
      if (winner === null || dealt > winnerDamage ||
          (dealt === winnerDamage && compareUuidRaw(attackerId, winner) < 0)) {
        winner = attackerId;
        winnerDamage = dealt;
      }
    }
    if (winner !== null) {
      const winnerPlayer = players.get(winner);
      if (winnerPlayer === undefined || winnerPlayer.core === null) winner = null;
    }

    // cargo 原地掉落（Worker）
    for (const unit of victim.units) {
      if (unit.unitType === "WORKER" && unit.cargo > 0) {
        dropCargo(draft, unit.position, unit.cargo);
      }
    }

    // game-rules.md §Champion Beacon：「…or the owner's Core is destroyed, it lands
    // at the carrier's final actual position」——摧毁 Core 前落地（carrier 是它的
    // Core 或它的 Unit；迁移中的 Core 逻辑位置即最终实际位置）。
    // 盾 clamp 跳过：victim 的 Core 本 tick 被摧毁，无盾可 clamp。
    const beacon = draft.beacon;
    if (beacon !== null && beacon.status === "CARRIED" && beacon.carrierId !== null) {
      const carriedByCore = beacon.carrierId === victim.core.id;
      const carriedByUnit = victim.units.find((unit) => unit.id === beacon.carrierId);
      const carrierPosition = carriedByCore ? victim.core.position : carriedByUnit?.position;
      if (carrierPosition !== undefined) {
        dropCarriedBeacon(draft, beacon.carrierId, carrierPosition, events, { clampShield: false });
      }
    }

    // fleet 移除 → RESPAWNING（respawn 由 P12 respawn resolver 处理）；
    // respawnAtTick = 当前结算 Tick：P12 在本 Tick 内立即尝试放置。
    players.set(victim.id, {
      ...victim,
      core: null,
      units: [],
      status: "RESPAWNING",
      respawnAtTick: draft.tick,
    });

    const loot = winner !== null ? victim.resources : 0;
    if (winner !== null && loot > 0) {
      const winnerPlayer = players.get(winner)!;
      players.set(winner, { ...winnerPlayer, resources: winnerPlayer.resources + loot });
    }
    events.push(
      eventOf(draft.tick, "CORE_DESTROYED", {
        reasonCode: "COMBAT",
        targetId: coreId,
        position: victim.core.position,
        values: { winner, loot, damage: winnerDamage },
      }),
    );
  }
  (draft as unknown as { players: Map<string, SimPlayer> }).players = players;
}

function applyUnitDeaths(
  draft: SimWorld,
  killedUnits: readonly string[],
  events: ResolutionEvent[],
): void {
  const dead = new Set(killedUnits);
  // game-rules.md §Champion Beacon：「…its carrier dies, it lands at the carrier's
  // final actual position」——必须先落地（含盾 clamp），因为 clamp 需要 carrier
  // 仍在其 owner 的 units 列表中判定归属。
  for (const player of draft.players.values()) {
    const carrier = player.units.find(
      (unit) => dead.has(unit.id) && draft.beacon?.carrierId === unit.id,
    );
    if (carrier !== undefined) {
      dropCarriedBeacon(draft, carrier.id, carrier.position, events);
    }
  }
  const players = new Map(draft.players);
  for (const [playerId, player] of draft.players) {
    if (!player.units.some((u) => dead.has(u.id))) continue;
    players.set(playerId, {
      ...player,
      units: player.units.filter((unit) => {
        if (!dead.has(unit.id)) return true;
        if (unit.unitType === "WORKER" && unit.cargo > 0) {
          dropCargo(draft, unit.position, unit.cargo);
        }
        events.push(
          eventOf(draft.tick, "UNIT_DESTROYED", {
            reasonCode: "COMBAT",
            targetId: unit.id,
            position: unit.position,
          }),
        );
        return false;
      }),
    });
  }
  (draft as unknown as { players: Map<string, SimPlayer> }).players = players;
}

/**
 * 携带的 Beacon 落地（§Champion Beacon）：carrier 死亡或 owner Core 被摧毁时
 * 落在 carrier 最终实际位置。P09 在 P07 之后，本 tick 已无拾取阶段——
 * "No other object may pick it up until the next Tick" 天然满足。
 * 默认同时处理失去 Beacon 的盾 clamp（与 P07 DROP 路径共用同一规则）；
 * owner Core 被摧毁的场景跳过 clamp（无盾可 clamp）。
 */
function dropCarriedBeacon(
  draft: SimWorld,
  carrierId: string,
  position: Position,
  events: ResolutionEvent[],
  options: { clampShield?: boolean } = {},
): void {
  const beacon = draft.beacon;
  if (beacon === null || beacon.status !== "CARRIED" || beacon.carrierId !== carrierId) return;
  const nextBeacon: SimBeacon = { position, status: "GROUND", carrierId: null };
  (draft as unknown as { beacon: SimWorld["beacon"] }).beacon = nextBeacon;
  if (options.clampShield !== false) {
    clampShieldAfterBeaconLoss(draft, beacon, nextBeacon, events);
  }
  events.push(eventOf(draft.tick, "BEACON_DROPPED", { actorId: carrierId, position }));
}

function dropCargo(draft: SimWorld, position: Position, amount: number): void {
  const key = cellKey(position);
  const piles = new Map(draft.terrain.piles);
  piles.set(key, { cell: position, amount: (piles.get(key)?.amount ?? 0) + amount });
  (draft as unknown as { terrain: SimWorld["terrain"] }).terrain = { ...draft.terrain, piles };
}
