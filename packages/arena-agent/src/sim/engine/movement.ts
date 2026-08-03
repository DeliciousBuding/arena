/**
 * Movement resolver（S4）：v0.11 Unit movement 全局依赖、争抢与容量语义。
 *
 * 官方 reason codes（resolution-results.md）：
 *   MOVE_OUT_OF_BOUNDS / MOVE_BLOCKED_TERRAIN / MOVE_CONTESTED /
 *   MOVE_SWAP_BLOCKED / MOVE_DESTINATION_OCCUPIED / MOVE_DEPENDENCY_FAILED /
 *   CELL_UNIT_LIMIT
 *
 * 事件语义：成功 position = 目的地；失败 position = 原位置。
 *
 * 算法：候选图 + 固定点迭代（不逐 Unit 顺序执行——容器迭代顺序不是规则）。
 * 依赖链（A→B 且 B→C）与失败传播通过 occupant 依赖解析；
 * 同玩家容量竞争按 raw UUID 升序取胜。
 */

import { cellKey, type Direction, type Plan, type Position } from "../../domain/model.ts";
import { sortByUuidRaw } from "../deterministic/uuid.ts";
import type { SimWorld } from "../world/types.ts";
import { CELL_ENTITY_CAPACITY } from "../world/world.ts";
import { eventOf, outcome, type Phase, type PhaseContext, type ResolutionEvent } from "./phase.ts";

const DIRECTION_DELTA: Readonly<Record<Direction, readonly [number, number]>> = {
  UP: [0, -1],
  DOWN: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
};

interface MoveIntent {
  readonly unitId: string;
  readonly playerId: string;
  readonly source: Position;
  readonly dest: Position;
  readonly destKey: string;
}

interface UnitInfo {
  readonly id: string;
  readonly playerId: string;
  readonly position: Position;
}

type MoveStatus = "pending" | "success" | "fail";

export interface MovementResolution {
  readonly events: readonly ResolutionEvent[];
  readonly positions: ReadonlyMap<string, Position>;
  /** 仅用于诊断/测试。 */
  readonly moves: readonly { unitId: string; status: MoveStatus; reason: string | null }[];
}

function stepCell(source: Position, direction: Direction): Position {
  const [dx, dy] = DIRECTION_DELTA[direction];
  return [source[0] + dx, source[1] + dy];
}

/** 收集 plans 中的 MOVE 意图（跳过未知 unit 与非法动作）。 */
function collectMoves(world: SimWorld, plans: ReadonlyMap<string, Plan>): { moves: MoveIntent[]; units: Map<string, UnitInfo> } {
  const units = new Map<string, UnitInfo>();
  for (const [playerId, player] of world.players) {
    for (const unit of player.units) {
      units.set(unit.id, { id: unit.id, playerId, position: unit.position });
    }
  }
  const moves: MoveIntent[] = [];
  for (const [playerId, plan] of plans) {
    for (const [unitId, action] of Object.entries(plan.unitActions)) {
      const unit = units.get(unitId);
      if (unit === undefined || unit.playerId !== playerId) continue;
      if (action.type !== "MOVE") continue;
      const dest = stepCell(unit.position, action.direction);
      moves.push({ unitId, playerId, source: unit.position, dest, destKey: cellKey(dest) });
    }
  }
  // 确定性顺序：结果与输入插入顺序无关（容器迭代顺序不是规则）
  moves.sort((a, b) => a.unitId.localeCompare(b.unitId));
  return { moves, units };
}

/** 初始世界占用索引：cellKey → 实体（unit/core）。 */
function occupancyIndex(world: SimWorld): Map<string, UnitInfo[]> {
  const index = new Map<string, UnitInfo[]>();
  const add = (info: UnitInfo): void => {
    const key = cellKey(info.position);
    index.set(key, [...(index.get(key) ?? []), info]);
  };
  for (const [playerId, player] of world.players) {
    for (const unit of player.units) {
      add({ id: unit.id, playerId, position: unit.position });
    }
    // Core 占位：非 unit，但占用槽位——MVP 结算里 Core 不会移动，作为静止 occupant
    if (player.core !== null) {
      index.set(cellKey(player.core.position), [
        ...(index.get(cellKey(player.core.position)) ?? []),
        { id: `core:${player.core.id}`, playerId, position: player.core.position },
      ]);
    }
  }
  return index;
}

/**
 * 求解移动。纯函数：不修改 world；返回成功者的新位置与全部事件。
 */
export function resolveMovement(world: SimWorld, plans: ReadonlyMap<string, Plan>): MovementResolution {
  const { moves, units } = collectMoves(world, plans);
  const occupancy = occupancyIndex(world);
  const byUnit = new Map(moves.map((m) => [m.unitId, m]));
  const status = new Map<string, MoveStatus>();
  const reason = new Map<string, string | null>();
  for (const m of moves) {
    status.set(m.unitId, "pending");
    reason.set(m.unitId, null);
  }

  const fail = (unitId: string, r: string): void => {
    if (status.get(unitId) === "pending") {
      status.set(unitId, "fail");
      reason.set(unitId, r);
    }
  };

  // 1. 静态失败：障碍地形
  for (const m of moves) {
    if (world.terrain.obstacles.has(m.destKey)) {
      fail(m.unitId, "MOVE_BLOCKED_TERRAIN");
    }
  }

  // 2. 跨玩家双向 swap 必失败
  for (const m of moves) {
    if (status.get(m.unitId) !== "pending") continue;
    for (const occupant of occupancy.get(m.destKey) ?? []) {
      if (occupant.playerId === m.playerId) continue;
      const occupantMove = byUnit.get(occupant.id);
      if (occupantMove !== undefined && cellKey(occupantMove.dest) === cellKey(m.source)) {
        fail(m.unitId, "MOVE_SWAP_BLOCKED");
        fail(occupantMove.unitId, "MOVE_SWAP_BLOCKED");
      }
    }
  }

  // 3. 固定点迭代：contested / 占用依赖 / 容量淘汰
  const arrivalsOf = (destKey: string): MoveIntent[] =>
    moves.filter((m) => m.destKey === destKey && status.get(m.unitId) !== "fail");

  let changed = true;
  while (changed) {
    changed = false;

    // 3a. 跨玩家同目的地 → MOVE_CONTESTED（该格所有跨玩家到达者全失败）
    for (const [destKey, arrivals] of groupByKey(moves, arrivalsOf)) {
      const players = new Set(arrivals.map((m) => m.playerId));
      if (players.size > 1) {
        for (const m of arrivals) {
          if (status.get(m.unitId) === "pending") {
            fail(m.unitId, "MOVE_CONTESTED");
            changed = true;
          }
        }
      }
    }

    // 3b. 占用依赖（"enter an occupied cell only if occupants leave"——
    //     语义 = 满格才要求离开；空位格可直接进，否则 Worker 无法回 Core 格）
    for (const m of moves) {
      if (status.get(m.unitId) !== "pending") continue;
      const occupants = occupancy.get(m.destKey) ?? [];
      // 3b1. 敌方 occupant 留下 → 敌我不共格（无论容量）
      for (const occupant of occupants) {
        if (occupant.playerId === m.playerId) continue;
        const occupantMove = byUnit.get(occupant.id);
        if (occupantMove === undefined || status.get(occupant.id) === "fail") {
          fail(m.unitId, "MOVE_DESTINATION_OCCUPIED");
          changed = true;
        }
      }
      if (status.get(m.unitId) !== "pending") continue;
      // 3b2. 满格（occupancy = 2）时依赖全部 occupants 成功离开
      if (occupants.length < CELL_ENTITY_CAPACITY) continue;
      for (const occupant of occupants) {
        const occupantMove = byUnit.get(occupant.id);
        if (occupantMove === undefined) {
          fail(m.unitId, occupant.playerId === m.playerId ? "CELL_UNIT_LIMIT" : "MOVE_DESTINATION_OCCUPIED");
          changed = true;
          break;
        }
        if (status.get(occupant.id) === "fail") {
          fail(m.unitId, "MOVE_DEPENDENCY_FAILED");
          changed = true;
          break;
        }
      }
    }

    // 3c. 容量：staying + arrivals ≤ 2；超限按 raw UUID 序淘汰同玩家到达者
    for (const [destKey, arrivals] of groupByKey(moves, arrivalsOf)) {
      const staying = (occupancy.get(destKey) ?? []).filter((o) => {
        const occupantMove = byUnit.get(o.id);
        return occupantMove === undefined || status.get(o.id) === "fail";
      }).length;
      const room = CELL_ENTITY_CAPACITY - staying;
      if (arrivals.length > room) {
        const sorted = sortByUuidRaw(arrivals.map((m) => ({ id: m.unitId }))).map((x) => x.id);
        for (const unitId of sorted.slice(room)) {
          if (status.get(unitId) === "pending") {
            fail(unitId, "CELL_UNIT_LIMIT");
            changed = true;
          }
        }
      }
    }
  }

  // 4. 归一化：迭代只淘汰失败者，剩余 pending 全部为 success
  for (const m of moves) {
    if (status.get(m.unitId) === "pending") {
      status.set(m.unitId, "success");
    }
  }

  // 5. 生成事件与位置
  const events: ResolutionEvent[] = [];
  const positions = new Map<string, Position>();
  for (const m of moves) {
    const st = status.get(m.unitId)!;
    if (st === "success") {
      positions.set(m.unitId, m.dest);
      events.push(eventOf(world.tick, "UNIT_MOVE_SUCCEEDED", { actorId: m.unitId, position: m.dest }));
    } else {
      events.push(eventOf(world.tick, "UNIT_MOVE_FAILED", { reasonCode: reason.get(m.unitId) ?? null, actorId: m.unitId, position: m.source }));
    }
  }

  return {
    events,
    positions,
    moves: moves.map((m) => ({ unitId: m.unitId, status: status.get(m.unitId)!, reason: reason.get(m.unitId) ?? null })),
  };
}

/** 按 destKey 分组（稳定顺序：按 destKey 排序）。 */
function groupByKey(moves: readonly MoveIntent[], filter: (destKey: string) => MoveIntent[]): Map<string, MoveIntent[]> {
  const groups = new Map<string, MoveIntent[]>();
  for (const destKey of new Set(moves.map((m) => m.destKey)).values()) {
    const list = filter(destKey);
    if (list.length > 0) {
      groups.set(destKey, list);
    }
  }
  return groups;
}

/** P05 phase：应用移动结算到 draft。 */
export const movementPhase: Phase = {
  id: "P05-unit-movement",
  officialPhase: 4,
  run: (draft, ctx) => {
    const resolution = resolveMovement(draft, ctx.plans);
    if (resolution.positions.size > 0) {
      // 写回 draft（draft 是 settlement 内部 clone，允许原地更新）
      const players = new Map(draft.players);
      for (const [playerId, player] of draft.players) {
        const moved = player.units.some((u) => resolution.positions.has(u.id));
        if (!moved) continue;
        players.set(playerId, {
          ...player,
          units: player.units.map((u) =>
            resolution.positions.has(u.id) ? { ...u, position: resolution.positions.get(u.id)! } : u,
          ),
        });
      }
      (draft as { players: typeof draft.players }).players = players;
    }
    return outcome({ events: resolution.events });
  },
};
