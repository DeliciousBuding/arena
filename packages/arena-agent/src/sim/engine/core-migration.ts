/**
 * Core migration resolver（P06）：v0.11 Four-Tick Core migration。
 *
 * 官方事件与 reason codes（api-resolution-results.md Movement events）：
 *   CORE_MOVE_STARTED（values {destination, progress:1, required:4}）/
 *   CORE_MOVE_PROGRESS / CORE_MOVE_SUCCEEDED / CORE_MOVE_FAILED /
 *   CORE_MOVE_START_FAILED / CORE_MOVE_CANCELLED /
 *   CORE_ACTION_FAILED（CORE_ALREADY_MOVING / CORE_NOT_MOVING）
 *
 * 结算时序（game-rules.md Authoritative resolution order 5-6）：
 *   1) 在途迁移推进：progress+1；第 4 Tick 做真实移动尝试（与 Unit movement
 *      同 Tick 结算后检查，占用以最终位置为准）；
 *   2) 新 START_MOVE / CANCEL_MOVE 校验（"A new START_MOVE is checked after
 *      this Tick's real movement resolves"）。
 *
 * 迁移期间 Core 逻辑位置不变（hp/shield/资源不变）；携带的 Beacon 保持
 * Core 逻辑位置，真实移动成功后跟随（beacon 动作本身仍由其他 resolver 处理）。
 */

import { cellKey, type Direction, type Plan, type Position } from "../../domain/model.ts";
import { compareCodeUnit } from "../deterministic/uuid.ts";
import type { SimCore, SimFeature, SimPlayer, SimWorld } from "../world/types.ts";
import { CELL_ENTITY_CAPACITY } from "../world/world.ts";
import { eventOf, outcome, type Phase, type PhaseContext, type ResolutionEvent } from "./phase.ts";

/** game-rules.md "Four-Tick Core migration"（api-resolution-results.md: progress 1, required 4）。 */
export const CORE_MIGRATION_REQUIRED_TICKS = 4;

const DIRECTION_DELTA: Readonly<Record<Direction, readonly [number, number]>> = {
  UP: [0, -1],
  DOWN: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
};

export interface CompletedMove {
  readonly playerId: string;
  readonly coreId: string;
  readonly to: Position;
}

export interface CoreMigrationResolution {
  readonly events: readonly ResolutionEvent[];
  /** playerId → 新 SimCore（仅迁移相关变更的玩家）。 */
  readonly updatedCores: ReadonlyMap<string, SimCore>;
  /** 本 tick 真实移动成功的 Core（beacon 跟随用）。 */
  readonly completedMoves: readonly CompletedMove[];
}

interface AttemptInfo {
  readonly playerId: string;
  readonly core: SimCore;
  readonly origin: Position;
  readonly dest: Position;
  readonly destKey: string;
}

function stepCell(source: Position, direction: Direction): Position {
  const [dx, dy] = DIRECTION_DELTA[direction];
  return [source[0] + dx, source[1] + dy];
}

function sortedPlayers(world: SimWorld): SimPlayer[] {
  return [...world.players.values()].sort((a, b) => compareCodeUnit(a.id, b.id));
}

/** 玩家在目的地格的己方单位数（P05 已结算，位置即最终位置）。 */
function ownUnitsAt(world: SimWorld, playerId: string, destKey: string): number {
  return world.players
    .get(playerId)
    ?.units.filter((unit) => cellKey(unit.position) === destKey).length ?? 0;
}

/** 目的地是否有敌方实体（unit 或 Core；Core 位置用 effectiveCores 的结算后位置）。 */
function hasEnemyOccupant(
  world: SimWorld,
  effectiveCores: ReadonlyMap<string, SimCore>,
  playerId: string,
  destKey: string,
): boolean {
  for (const player of world.players.values()) {
    if (player.id === playerId) continue;
    const core = effectiveCores.get(player.id) ?? player.core;
    if (core !== null && cellKey(core.position) === destKey) return true;
    if (player.units.some((unit) => cellKey(unit.position) === destKey)) return true;
  }
  return false;
}

/** START_MOVE 合法性（api-resolution-results.md CORE_MOVE_START_FAILED reasons）。 */
function startFailureReason(
  world: SimWorld,
  effectiveCores: ReadonlyMap<string, SimCore>,
  playerId: string,
  dest: Position,
): string | null {
  const [x, y] = dest;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return "CORE_DESTINATION_OUT_OF_BOUNDS";
  const destKey = cellKey(dest);
  // 地形表：Core 不可迁入 OBSTACLE 或 RESOURCE 格（game-rules.md Terrain kinds）
  if (world.terrain.obstacles.has(destKey) || world.terrain.resources.has(destKey)) {
    return "CORE_DESTINATION_TERRAIN_BLOCKED";
  }
  if (hasEnemyOccupant(world, effectiveCores, playerId, destKey)) return "CORE_DESTINATION_OCCUPIED";
  if (ownUnitsAt(world, playerId, destKey) + 1 > CELL_ENTITY_CAPACITY) return "CELL_UNIT_LIMIT";
  return null;
}

/**
 * 第 4 Tick 真实移动尝试（纯函数）。
 * "The real move joins the same global dependency graph as Unit movement"——
 * MVP 用 P05 结算后的最终位置近似依赖图：静态地形/占用/容量直接判，
 * 跨玩家同目的地 → MOVE_CONTESTED，双向互换 → MOVE_SWAP_BLOCKED，
 * 敌方 Core 同 Tick 成功离开 → 依赖成立（固定点推进）。
 */
function resolveAttempts(
  world: SimWorld,
  attempts: readonly AttemptInfo[],
  events: ResolutionEvent[],
): { updatedCores: Map<string, SimCore>; completedMoves: CompletedMove[] } {
  const updatedCores = new Map<string, SimCore>();
  const completedMoves: CompletedMove[] = [];
  if (attempts.length === 0) return { updatedCores, completedMoves };

  const status = new Map<string, "pending" | "fail" | "success">(
    attempts.map((attempt) => [attempt.playerId, "pending"]),
  );
  const reason = new Map<string, string | null>(attempts.map((attempt) => [attempt.playerId, null]));
  const byId = new Map(attempts.map((attempt) => [attempt.playerId, attempt]));

  const fail = (playerId: string, r: string): void => {
    if (status.get(playerId) === "pending") {
      status.set(playerId, "fail");
      reason.set(playerId, r);
    }
  };

  // 1. 静态失败：坐标溢出 / 地形（障碍+资源格）/ 己方单位容量
  for (const attempt of attempts) {
    const [x, y] = attempt.dest;
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
      fail(attempt.playerId, "MOVE_OUT_OF_BOUNDS");
      continue;
    }
    if (world.terrain.obstacles.has(attempt.destKey) || world.terrain.resources.has(attempt.destKey)) {
      fail(attempt.playerId, "CORE_DESTINATION_TERRAIN_BLOCKED");
      continue;
    }
    if (ownUnitsAt(world, attempt.playerId, attempt.destKey) + 1 > CELL_ENTITY_CAPACITY) {
      fail(attempt.playerId, "CELL_UNIT_LIMIT");
    }
  }

  // 2. 双向 swap：A→B 且 B→A → 双方失败（与 Unit movement 同语义）
  for (const a of attempts) {
    if (status.get(a.playerId) !== "pending") continue;
    for (const b of attempts) {
      if (a.playerId === b.playerId) continue;
      if (cellKey(b.origin) === a.destKey && cellKey(a.origin) === b.destKey) {
        fail(a.playerId, "MOVE_SWAP_BLOCKED");
        fail(b.playerId, "MOVE_SWAP_BLOCKED");
      }
    }
  }

  // 3. 固定点迭代：contested / 占用依赖（敌方 Core 同 Tick 离开才放行）
  let changed = true;
  while (changed) {
    changed = false;

    // 3a. 跨玩家同目的地 → MOVE_CONTESTED
    const byDest = new Map<string, AttemptInfo[]>();
    for (const attempt of attempts) {
      if (status.get(attempt.playerId) === "pending") {
        byDest.set(attempt.destKey, [...(byDest.get(attempt.destKey) ?? []), attempt]);
      }
    }
    for (const destKey of [...byDest.keys()].sort(compareCodeUnit)) {
      const arrivals = byDest.get(destKey)!;
      if (new Set(arrivals.map((attempt) => attempt.playerId)).size > 1) {
        for (const arrival of arrivals) {
          fail(arrival.playerId, "MOVE_CONTESTED");
          changed = true;
        }
      }
    }

    // 3b. 占用依赖
    for (const attempt of attempts) {
      if (status.get(attempt.playerId) !== "pending") continue;
      for (const player of world.players.values()) {
        if (player.id === attempt.playerId) continue;
        // 敌方 unit 已在最终位置（本阶段不移动）→ 占据者留下
        if (player.units.some((unit) => cellKey(unit.position) === attempt.destKey)) {
          fail(attempt.playerId, "MOVE_DESTINATION_OCCUPIED");
          changed = true;
          break;
        }
        const enemyCore = player.core;
        if (enemyCore === null || cellKey(enemyCore.position) !== attempt.destKey) continue;
        const enemyAttempt = byId.get(player.id);
        if (enemyAttempt === undefined || status.get(player.id) === "fail") {
          fail(attempt.playerId, "MOVE_DESTINATION_OCCUPIED");
          changed = true;
          break;
        }
        // 敌方 Core 本 tick 成功离开 → 依赖成立，本轮保持 pending（固定点推进）
      }
    }
  }

  // 4. 归一化 + 事件
  for (const attempt of attempts) {
    if (status.get(attempt.playerId) === "pending") {
      status.set(attempt.playerId, "success");
    }
    const core = attempt.core;
    if (status.get(attempt.playerId) === "success") {
      updatedCores.set(attempt.playerId, {
        ...core,
        position: attempt.dest,
        state: "NORMAL",
        moveDirection: null,
        moveProgress: null,
        moveRequiredTicks: null,
        destination: null,
      });
      completedMoves.push({ playerId: attempt.playerId, coreId: core.id, to: attempt.dest });
      events.push(eventOf(world.tick, "CORE_MOVE_SUCCEEDED", { actorId: core.id, position: attempt.dest }));
    } else {
      updatedCores.set(attempt.playerId, {
        ...core,
        state: "NORMAL",
        moveDirection: null,
        moveProgress: null,
        moveRequiredTicks: null,
        destination: null,
      });
      events.push(
        eventOf(world.tick, "CORE_MOVE_FAILED", {
          reasonCode: reason.get(attempt.playerId) ?? null,
          actorId: core.id,
          position: attempt.origin,
        }),
      );
    }
  }
  return { updatedCores, completedMoves };
}

/** 处理 plans 中的 START_MOVE / CANCEL_MOVE（其余 core action 归 P11）。 */
function resolvePlanActions(
  world: SimWorld,
  plans: ReadonlyMap<string, Plan>,
  effectiveCores: Map<string, SimCore>,
  events: ResolutionEvent[],
): void {
  for (const playerId of [...world.players.keys()].sort(compareCodeUnit)) {
    const plan = plans.get(playerId);
    if (plan === undefined || plan.coreAction === null || plan.coreAction === undefined) continue;
    const action = plan.coreAction;
    if (action.type === "WAIT") continue;
    if (action.type !== "START_MOVE" && action.type !== "CANCEL_MOVE") continue;
    const core = effectiveCores.get(playerId) ?? world.players.get(playerId)!.core;
    if (core === null) continue;

    if (action.type === "START_MOVE") {
      if (core.state === "MOVING") {
        events.push(
          eventOf(world.tick, "CORE_ACTION_FAILED", {
            reasonCode: "CORE_ALREADY_MOVING",
            actorId: core.id,
            position: core.position,
          }),
        );
        continue;
      }
      const dest = stepCell(core.position, action.direction);
      const failure = startFailureReason(world, effectiveCores, playerId, dest);
      if (failure !== null) {
        events.push(
          eventOf(world.tick, "CORE_MOVE_START_FAILED", {
            reasonCode: failure,
            actorId: core.id,
            position: core.position,
          }),
        );
        continue;
      }
      effectiveCores.set(playerId, {
        ...core,
        state: "MOVING",
        moveDirection: action.direction,
        moveProgress: 1,
        moveRequiredTicks: CORE_MIGRATION_REQUIRED_TICKS,
        destination: dest,
      });
      events.push(
        eventOf(world.tick, "CORE_MOVE_STARTED", {
          actorId: core.id,
          position: core.position,
          values: { destination: dest, progress: 1, required: CORE_MIGRATION_REQUIRED_TICKS },
        }),
      );
    } else {
      // CANCEL_MOVE
      if (core.state !== "MOVING") {
        events.push(
          eventOf(world.tick, "CORE_ACTION_FAILED", {
            reasonCode: "CORE_NOT_MOVING",
            actorId: core.id,
            position: core.position,
          }),
        );
        continue;
      }
      effectiveCores.set(playerId, {
        ...core,
        state: "NORMAL",
        moveDirection: null,
        moveProgress: null,
        moveRequiredTicks: null,
        destination: null,
      });
      events.push(eventOf(world.tick, "CORE_MOVE_CANCELLED", { actorId: core.id, position: core.position }));
    }
  }
}

/**
 * 结算 Core migration（纯函数：不修改 world）。
 * 返回更新后的 Core（playerId → SimCore）与事件；phase 负责写回 draft。
 */
export function resolveCoreMigration(
  world: SimWorld,
  plans: ReadonlyMap<string, Plan>,
): CoreMigrationResolution {
  const events: ResolutionEvent[] = [];
  const updatedCores = new Map<string, SimCore>();
  const attempts: AttemptInfo[] = [];

  // 1. 在途迁移推进（game-rules.md：WAIT 不停迁移；裸 MOVING 无字段无法推进）
  for (const player of sortedPlayers(world)) {
    const core = player.core;
    if (core === null || core.state !== "MOVING") continue;
    if (
      core.moveDirection === null ||
      core.moveProgress === null ||
      core.moveRequiredTicks === null ||
      core.destination === null
    ) {
      // 裸 MOVING（外部快照）：进度未知，跳过推进；settlement 标记 unsupported
      continue;
    }
    const progress = core.moveProgress + 1;
    if (progress < core.moveRequiredTicks) {
      updatedCores.set(player.id, { ...core, moveProgress: progress });
      events.push(
        eventOf(world.tick, "CORE_MOVE_PROGRESS", {
          actorId: core.id,
          position: core.position,
          values: { progress, required: core.moveRequiredTicks },
        }),
      );
    } else {
      attempts.push({
        playerId: player.id,
        core,
        origin: core.position,
        dest: core.destination,
        destKey: cellKey(core.destination),
      });
    }
  }

  // 2. 第 4 Tick 真实移动尝试
  const attemptResult = resolveAttempts(world, attempts, events);
  for (const [playerId, core] of attemptResult.updatedCores) {
    updatedCores.set(playerId, core);
  }

  // 3. 新 START_MOVE / CANCEL_MOVE（基于推进后的 Core 状态）
  resolvePlanActions(world, plans, updatedCores, events);

  return { events, updatedCores, completedMoves: attemptResult.completedMoves };
}

/** P06 phase：应用 Core migration 结算到 draft。 */
export const coreMigrationPhase: Phase = {
  id: "P06-core-migration",
  officialPhase: 5,
  run: (draft, ctx) => {
    const resolution = resolveCoreMigration(draft, ctx.plans);
    if (resolution.updatedCores.size > 0) {
      const players = new Map(draft.players);
      for (const [playerId, core] of resolution.updatedCores) {
        const player = players.get(playerId);
        if (player === undefined) continue;
        players.set(playerId, { ...player, core });
      }
      (draft as { players: typeof draft.players }).players = players;
    }
    // beacon 跟随：携带者 Core 真实移动成功后 Beacon 跟到新位置（game-rules.md）
    if (resolution.completedMoves.length > 0 && draft.beacon !== null) {
      const movedByCoreId = new Map(resolution.completedMoves.map((move) => [move.coreId, move]));
      const carrierId = draft.beacon.carrierId;
      if (carrierId !== null && movedByCoreId.has(carrierId)) {
        const to = movedByCoreId.get(carrierId)!.to;
        if (cellKey(draft.beacon.position) !== cellKey(to)) {
          (draft as { beacon: SimWorld["beacon"] }).beacon = { ...draft.beacon, position: to };
        }
      }
    }
    // 裸 MOVING（无迁移字段）输入仍属 unsupported：无法确定解析，不得伪装成功
    const unsupported: SimFeature[] = ctx.features.has("core-migration") ? ["core-migration"] : [];
    return outcome({ events: resolution.events, unsupported });
  },
};
