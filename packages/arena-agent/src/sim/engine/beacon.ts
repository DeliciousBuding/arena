/**
 * Beacon resolver（S11）：v0.11 Champion Beacon 拾取/丢弃结算。
 *
 * 规则来源：docs/game-rules.md §Champion Beacon（官方 15-phase order 第 5 步，
 * 在 movement 之后、harvest/deposit 之前）。
 *
 * 语义要点：
 * - PICKUP_BEACON：与地面 Beacon 同格的 Unit 或非迁移 Core 可拾取；
 *   多对象争抢时最低 carrier UUID（raw 升序）获胜；移动经过不自动拾取。
 * - DROP_BEACON：仅当前 carrier 可用；落地于 carrier 当前实际位置；
 *   落地后本 Tick 不可再被拾取（phase-local pickup lock）。
 * - 持有 Beacon 时该玩家 Core 盾上限 5→10（maxShieldWithBeacon）；
 *   失去 Beacon 时盾 >5 立即 clamp 到 5（不改动 Core hp）。
 * - 持有者 Worker 收获 2 而非 1（harvestAmountWithBeacon，economy 读取）。
 */

import { cellKey, type Plan, type Position } from "../../domain/model.ts";
import { compareUuidRaw } from "../deterministic/uuid.ts";
import type { SimBeacon, SimPlayer, SimWorld } from "../world/types.ts";
import { eventOf, outcome, type Phase, type PhaseContext, type ResolutionEvent } from "./phase.ts";

/** PICKUP_BEACON / DROP_BEACON 请求。 */
interface BeaconRequest {
  readonly actorId: string;
  readonly playerId: string;
  readonly kind: "pickup" | "drop";
}

/**
 * 收集 Beacon 动作请求（PICKUP/DROP），确定性排序（与输入顺序无关）。
 * actorId 使用真实 UUID（unit id 或 core id，全局唯一，天然区分）。
 */
function collectRequests(world: SimWorld, plans: ReadonlyMap<string, Plan>): BeaconRequest[] {
  const requests: BeaconRequest[] = [];
  for (const [playerId, plan] of plans) {
    for (const [unitId, action] of Object.entries(plan.unitActions)) {
      if (action.type === "PICKUP_BEACON") {
        requests.push({ actorId: unitId, playerId, kind: "pickup" });
      } else if (action.type === "DROP_BEACON") {
        requests.push({ actorId: unitId, playerId, kind: "drop" });
      }
    }
    const core = world.players.get(playerId)?.core;
    if (plan.coreAction?.type === "PICKUP_BEACON" && core != null) {
      requests.push({ actorId: core.id, playerId, kind: "pickup" });
    } else if (plan.coreAction?.type === "DROP_BEACON" && core != null) {
      requests.push({ actorId: core.id, playerId, kind: "drop" });
    }
  }
  requests.sort((a, b) => compareUuidRaw(a.actorId, b.actorId));
  return requests;
}

interface BeaconActorState {
  readonly position: Position;
  readonly movingCore: boolean;
}

/** Resolve one owned actor without conflating a moving Core with a missing actor. */
function actorState(world: SimWorld, request: BeaconRequest): BeaconActorState | null {
  const player = world.players.get(request.playerId);
  if (player === undefined) return null;
  if (player.core !== null && player.core.id === request.actorId) {
    return { position: player.core.position, movingCore: player.core.state === "MOVING" };
  }
  const unit = player.units.find((candidate) => candidate.id === request.actorId);
  return unit === undefined ? null : { position: unit.position, movingCore: false };
}

export interface BeaconResolution {
  readonly events: readonly ResolutionEvent[];
  /** 新 beacon 状态（未变化则 null）。 */
  readonly nextBeacon: SimBeacon | null;
  /** 本 tick 是否发生了 pickup/drop（供 economy 的 harvest 加成查询）。 */
  readonly carrierChanged: boolean;
}

/**
 * 结算 Beacon 动作。纯函数，不修改 world。
 * 返回事件与新的 beacon 状态（若变化）。
 */
export function resolveBeacon(
  world: SimWorld,
  plans: ReadonlyMap<string, Plan>,
  pickupLockedCells: ReadonlySet<string> = new Set(),
): BeaconResolution {
  const beacon = world.beacon;
  if (beacon === null) return { events: [], nextBeacon: null, carrierChanged: false };

  const requests = collectRequests(world, plans);
  const events: ResolutionEvent[] = [];
  let nextBeacon: SimBeacon = beacon;
  const droppedThisTick = new Set<Position>();

  // 1. DROP：失败必须使用公开契约 reason；成功后本 Tick 的落地点锁定。
  for (const request of requests) {
    if (request.kind !== "drop") continue;
    const actor = actorState(world, request);
    if (actor === null) continue; // locked plan referenced a non-owned/missing actor
    if (actor.movingCore) {
      events.push(eventOf(world.tick, "BEACON_DROP_FAILED", {
        reasonCode: "CORE_MOVING",
        actorId: request.actorId,
        position: actor.position,
      }));
      continue;
    }
    if (nextBeacon.status !== "CARRIED" || nextBeacon.carrierId !== request.actorId) {
      events.push(eventOf(world.tick, "BEACON_DROP_FAILED", {
        reasonCode: "NOT_BEACON_CARRIER",
        actorId: request.actorId,
        position: actor.position,
      }));
      continue;
    }
    nextBeacon = { position: actor.position, status: "GROUND", carrierId: null };
    droppedThisTick.add(actor.position);
    events.push(eventOf(world.tick, "BEACON_DROPPED", {
      actorId: request.actorId,
      position: actor.position,
    }));
  }

  // 2. PICKUP：先发出所有动态失败，再按 raw UUID 选唯一成功者。
  const eligible: Array<{ readonly request: BeaconRequest; readonly actor: BeaconActorState }> = [];
  for (const request of requests) {
    if (request.kind !== "pickup") continue;
    const actor = actorState(world, request);
    if (actor === null) continue;
    if (actor.movingCore) {
      events.push(eventOf(world.tick, "BEACON_PICKUP_FAILED", {
        reasonCode: "CORE_MOVING",
        actorId: request.actorId,
        position: actor.position,
      }));
      continue;
    }
    if (nextBeacon.status === "CARRIED") {
      events.push(eventOf(world.tick, "BEACON_PICKUP_FAILED", {
        reasonCode: "ALREADY_CARRIED",
        actorId: request.actorId,
        position: actor.position,
      }));
      continue;
    }
    const actorCell = cellKey(actor.position);
    const droppedHere = [...droppedThisTick].some((position) => cellKey(position) === actorCell);
    if (
      actorCell !== cellKey(nextBeacon.position) ||
      pickupLockedCells.has(actorCell) ||
      droppedHere
    ) {
      events.push(eventOf(world.tick, "BEACON_PICKUP_FAILED", {
        reasonCode: "BEACON_NOT_PRESENT",
        actorId: request.actorId,
        position: actor.position,
      }));
      continue;
    }
    eligible.push({ request, actor });
  }

  if (eligible.length > 0) {
    eligible.sort((a, b) => compareUuidRaw(a.request.actorId, b.request.actorId));
    const winner = eligible[0];
    nextBeacon = { position: nextBeacon.position, status: "CARRIED", carrierId: winner.request.actorId };
    events.push(eventOf(world.tick, "BEACON_PICKED_UP", {
      actorId: winner.request.actorId,
      position: nextBeacon.position,
    }));
    for (const loser of eligible.slice(1)) {
      events.push(eventOf(world.tick, "BEACON_PICKUP_FAILED", {
        reasonCode: "ALREADY_CARRIED",
        actorId: loser.request.actorId,
        position: loser.actor.position,
      }));
    }
  }

  const carrierChanged = nextBeacon.status !== beacon.status || nextBeacon.carrierId !== beacon.carrierId;
  return { events, nextBeacon: carrierChanged ? nextBeacon : null, carrierChanged };
}

/** P07 beacon phase：把 Beacon 结算应用到 draft，并处理失去 Beacon 的盾 clamp。 */
export const beaconPhase: Phase = {
  id: "P07-beacon",
  officialPhase: 5,
  run: (draft, ctx) => {
    if (!ctx.features.has("beacon")) return outcome({});
    const beforeBeacon = draft.beacon;
    const resolution = resolveBeacon(draft, ctx.plans, ctx.beaconPickupLockedCells);
    const events = [...resolution.events];
    if (resolution.nextBeacon !== null) {
      (draft as unknown as { beacon: SimBeacon }).beacon = resolution.nextBeacon;
      clampShieldAfterBeaconLoss(draft, beforeBeacon, resolution.nextBeacon);
    }
    return outcome({ events });
  },
};

/** 失去 Beacon 时：Core 盾 >5（无 Beacon 上限）立即 clamp 到 5。 */
export function clampShieldAfterBeaconLoss(
  draft: SimWorld,
  beforeBeacon: SimBeacon | null,
  nextBeacon: SimBeacon,
): void {
  if (nextBeacon.status === "CARRIED") return; // 仍被持有或换手，无 clamp
  const players = new Map(draft.players);
  for (const [playerId, player] of draft.players) {
    if (player.core === null || player.core.shield <= 5) continue;
    // 之前持有 Beacon 的玩家（carrier 是它的 unit 或 Core）在落地后失去加成
    const wasCarrier =
      beforeBeacon !== null &&
      beforeBeacon.status === "CARRIED" &&
      beforeBeacon.carrierId !== null &&
      (beforeBeacon.carrierId === player.core.id ||
        player.units.some((unit) => unit.id === beforeBeacon.carrierId));
    if (!wasCarrier) continue;
    players.set(playerId, {
      ...player,
      core: { ...player.core, shield: 5 },
    });
  }
  (draft as unknown as { players: Map<string, SimPlayer> }).players = players;
}

/**
 * Drop a carried Beacon because its carrier died or its owner's Core was
 * destroyed. The resulting event is distinct from a voluntary DROP_BEACON.
 */
export function dropBeaconOnDeath(
  draft: SimWorld,
  carrierId: string,
  position: Position,
  events: ResolutionEvent[],
  options: { readonly clampShield?: boolean; readonly pickupLockedCells?: Set<string> } = {},
): boolean {
  const beacon = draft.beacon;
  if (beacon === null || beacon.status !== "CARRIED" || beacon.carrierId !== carrierId) return false;
  const nextBeacon: SimBeacon = { position, status: "GROUND", carrierId: null };
  (draft as unknown as { beacon: SimWorld["beacon"] }).beacon = nextBeacon;
  if (options.clampShield !== false) clampShieldAfterBeaconLoss(draft, beacon, nextBeacon);
  options.pickupLockedCells?.add(cellKey(position));
  events.push(eventOf(draft.tick, "BEACON_DROPPED_ON_DEATH", { actorId: carrierId, position }));
  return true;
}
