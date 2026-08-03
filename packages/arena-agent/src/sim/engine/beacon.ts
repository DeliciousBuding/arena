/**
 * Beacon resolver（S11）：v0.11 Champion Beacon 拾取/丢弃结算。
 *
 * 规则来源：docs/game-rules.md §Champion Beacon（官方 15-phase order 第 7 步，
 * 在 movement 之后、harvest/deposit 之前）。
 *
 * 语义要点：
 * - PICKUP_BEACON：与地面 Beacon 同格的 Unit 或非迁移 Core 可拾取；
 *   多对象争抢时最低 carrier UUID（raw 升序）获胜；移动经过不自动拾取。
 * - DROP_BEACON：仅当前 carrier 可用；落地于 carrier 当前实际位置；
 *   落地后本 Tick 不可再被拾取（dropLocked 标记到下一 Tick）。
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
 * Core 动作以 `core:<coreId>` 标记（区别于 unit UUID，避免与 unit 冲突）。
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
      requests.push({ actorId: `core:${core.id}`, playerId, kind: "pickup" });
    } else if (plan.coreAction?.type === "DROP_BEACON" && core != null) {
      requests.push({ actorId: `core:${core.id}`, playerId, kind: "drop" });
    }
  }
  requests.sort((a, b) => compareUuidRaw(a.actorId, b.actorId));
  return requests;
}

/** 找 actor 的实际位置（unit 或 Core）。 */
function actorPosition(world: SimWorld, request: BeaconRequest): Position | null {
  const player = world.players.get(request.playerId);
  if (player === undefined) return null;
  if (request.actorId.startsWith("core:")) {
    if (player.core === null) return null;
    return player.core.position;
  }
  const unit = player.units.find((u) => u.id === request.actorId);
  return unit?.position ?? null;
}

/** actor 是否仍存在（unit 存活 / Core 存在且非迁移）。 */
function actorAlive(world: SimWorld, request: BeaconRequest): boolean {
  const player = world.players.get(request.playerId);
  if (player === undefined) return false;
  if (request.actorId.startsWith("core:")) {
    return player.core !== null && player.core.state !== "MOVING";
  }
  return player.units.some((u) => u.id === request.actorId);
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
export function resolveBeacon(world: SimWorld, plans: ReadonlyMap<string, Plan>): BeaconResolution {
  const beacon = world.beacon;
  if (beacon === null) return { events: [], nextBeacon: null, carrierChanged: false };

  const requests = collectRequests(world, plans);
  const events: ResolutionEvent[] = [];
  let nextBeacon: SimBeacon = beacon;
  const droppedThisTick = new Set<Position>();

  // 1. DROP：仅当前 carrier；落地于 carrier 当前位置
  for (const request of requests) {
    if (request.kind !== "drop") continue;
    if (nextBeacon.status !== "CARRIED" || nextBeacon.carrierId !== request.actorId) continue;
    if (!actorAlive(world, request)) continue;
    const position = actorPosition(world, request);
    if (position === null) continue;
    nextBeacon = { position, status: "GROUND", carrierId: null };
    droppedThisTick.add(position);
    events.push(
      eventOf(world.tick, "BEACON_DROPPED", {
        actorId: request.actorId,
        position,
      }),
    );
  }

  // 2. PICKUP：同格多争抢者，最低 carrier UUID 获胜；落地后本 tick 不可拾取
  const pickupRequests = requests.filter(
    (request) =>
      request.kind === "pickup" &&
      nextBeacon.status === "GROUND" &&
      actorAlive(world, request),
  );
  if (pickupRequests.length > 0) {
    // 同格候选：与地面 Beacon 同格
    const sameCell = pickupRequests.filter((request) => {
      const position = actorPosition(world, request);
      return position !== null && cellKey(position) === cellKey(nextBeacon.position);
    });
    // 本 tick 刚落地的格不可拾取
    const eligible = sameCell.filter((request) => {
      const position = actorPosition(world, request)!;
      return ![...droppedThisTick].some((dropped) => cellKey(dropped) === cellKey(position));
    });
    if (eligible.length > 0) {
      const winner = [...eligible].sort((a, b) => compareUuidRaw(a.actorId, b.actorId))[0];
      nextBeacon = { position: nextBeacon.position, status: "CARRIED", carrierId: winner.actorId };
      events.push(
        eventOf(world.tick, "BEACON_PICKED_UP", {
          actorId: winner.actorId,
          position: nextBeacon.position,
        }),
      );
      // 落选者：HARVEST 失败事件（与线上语义对齐：其他争抢者动作无效）
      for (const loser of eligible.slice(1)) {
        const position = actorPosition(world, loser)!;
        events.push(
          eventOf(world.tick, "BEACON_PICKUP_FAILED", {
            reasonCode: "BEACON_CONTESTED",
            actorId: loser.actorId,
            position,
          }),
        );
      }
    }
  }

  const carrierChanged = nextBeacon.status !== beacon.status || nextBeacon.carrierId !== beacon.carrierId;
  return { events, nextBeacon: carrierChanged ? nextBeacon : null, carrierChanged };
}

/** P07 beacon phase：把 Beacon 结算应用到 draft，并处理失去 Beacon 的盾 clamp。 */
export const beaconPhase: Phase = {
  id: "P07-beacon",
  officialPhase: 7,
  run: (draft, ctx) => {
    if (!ctx.features.has("beacon")) return outcome({});
    const beforeBeacon = draft.beacon;
    const resolution = resolveBeacon(draft, ctx.plans);
    const events = [...resolution.events];
    if (resolution.nextBeacon !== null) {
      (draft as unknown as { beacon: SimBeacon }).beacon = resolution.nextBeacon;
      clampShieldAfterBeaconLoss(draft, beforeBeacon, resolution.nextBeacon, events);
    }
    return outcome({ events });
  },
};

/** 失去 Beacon 时：Core 盾 >5（无 Beacon 上限）立即 clamp 到 5。 */
function clampShieldAfterBeaconLoss(
  draft: SimWorld,
  beforeBeacon: SimBeacon | null,
  nextBeacon: SimBeacon,
  events: ResolutionEvent[],
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
      (beforeBeacon.carrierId === `core:${player.core.id}` ||
        player.units.some((unit) => unit.id === beforeBeacon.carrierId));
    if (!wasCarrier) continue;
    players.set(playerId, {
      ...player,
      core: { ...player.core, shield: 5 },
    });
    events.push(
      eventOf(draft.tick, "CORE_SHIELD_CLAMPED", {
        actorId: player.core.id,
        position: player.core.position,
        values: { shield: 5, previousShield: player.core.shield },
      }),
    );
  }
  (draft as unknown as { players: Map<string, SimPlayer> }).players = players;
}
