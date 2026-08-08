/**
 * Respawn resolver（P13）：v0.11 Core 摧毁后的确定性重生。
 *
 * 规则来源：docs/game-rules.md §Core destruction and respawn（官方 resolution
 * order 第 12 步 "immediately attempt to respawn newly destroyed Cores and
 * process any previously delayed spawn retries"）。
 *
 * 语义要点：
 * - 无重生冷却：combat（P09）把玩家置为 RESPAWNING + respawnAtTick = 当前结算
 *   Tick，本 phase 在同一结算 Tick 内立即尝试放置 replacement；正常情况
 *   下一发布状态已 ACTIVE，含 CORE_DESTROYED + CORE_RESPAWNED 两个事件；
 * - 成功：Core（maxHp/maxShield）+ 1 Worker（workerHp）+ startingResources，
 *   全部全新 UUID，无 spawn protection，状态回 ACTIVE；
 * - 放置：可通行且空（无障碍格/自然资源格/掉落堆/实体）的格，距最近活
 *   Core（其他玩家的，含本 tick 已 respawn 的）20-30 Manhattan，至少 2 个
 *   可通行邻居，偏好附近实体密度更低；
 * - 找不到合法格 → 保持 RESPAWNING，respawnAtTick = 下一 Tick（新确定性
 *   候选集重试）；裸 RESPAWNING（respawnAtTick === null，外部快照带入、
 *   重试进度未知）与未到期（respawnAtTick > 当前 Tick）跳过不解析——
 *   settlement 对前者标记 unsupported，fail closed。
 *
 * 确定性：玩家按 compareCodeUnit 排序逐个处理，处理结果增量可见（先
 * respawn 的玩家的新 Core/Worker 影响后续玩家的候选集与密度）；候选排序
 * 只依赖（密度, x, y）数值，与容器插入顺序无关。密度半径等未公开的
 * server 算法细节以本文件常量固定并文档化。
 */

import { createHash } from "node:crypto";
import { cellKey, type Position } from "../../domain/model.ts";
import type { RulesManifest } from "../contracts/rules-manifest.ts";
import { compareCodeUnit } from "../deterministic/uuid.ts";
import type { SimCore, SimFeature, SimPlayer, SimUnit, SimWorld } from "../world/types.ts";
import { eventOf, outcome, type Phase, type PhaseContext, type ResolutionEvent, type UnknownEffect } from "./phase.ts";

/** 距最近活 Core 的 Manhattan 距离区间（game-rules.md Core destruction and respawn）。 */
export const RESPAWN_DISTANCE_MIN = 20;
export const RESPAWN_DISTANCE_MAX = 30;
/** 至少 2 个可通行（非障碍）邻居（game-rules.md）。 */
export const RESPAWN_MIN_PASSABLE_NEIGHBORS = 2;
/**
 * 附近实体密度统计半径（server resolver 未公开；固定常量保证确定性）。
 * 密度 = 该半径内（含本格）的 Unit+Core 数量，越低越优先。
 */
export const RESPAWN_DENSITY_RADIUS = 5;

const DIRECTION_DELTA: Readonly<Record<"UP" | "DOWN" | "LEFT" | "RIGHT", readonly [number, number]>> = {
  UP: [0, -1],
  DOWN: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
};

export interface RespawnResolution {
  readonly events: readonly ResolutionEvent[];
  readonly unknownEffects: readonly UnknownEffect[];
  /** playerId → 更新后的玩家（仅 RESPAWNING 且本 tick 尝试过的）。 */
  readonly updatedPlayers: ReadonlyMap<string, SimPlayer>;
}

/** 结算中的增量工作视图：玩家副本 + 实体/活 Core 派生索引。 */
interface WorkingState {
  /** 当前结算 Tick（draft.tick）。 */
  readonly tick: number;
  /** 世界随机源种子（重生 UUID 派生用）。 */
  readonly seed: number;
  readonly players: Map<string, SimPlayer>;
  /** 全部活 Core 位置（含本 tick 已 respawn 的；RESPAWNING 玩家无 Core）。 */
  readonly corePositions: Position[];
  /** 全部实体位置（Unit+Core；密度统计用）。 */
  readonly entityPositions: Position[];
  /** cellKey → 实体数（空格判定用）。 */
  readonly entityCountByCell: Map<string, number>;
}

function manhattan(a: Position, b: Position): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function buildWorkingState(world: SimWorld): WorkingState {
  const players = new Map<string, SimPlayer>();
  const corePositions: Position[] = [];
  const entityPositions: Position[] = [];
  const entityCountByCell = new Map<string, number>();
  const addEntity = (position: Position): void => {
    entityPositions.push(position);
    const key = cellKey(position);
    entityCountByCell.set(key, (entityCountByCell.get(key) ?? 0) + 1);
  };
  for (const [playerId, player] of world.players) {
    players.set(playerId, player);
    if (player.core !== null) {
      corePositions.push(player.core.position);
      addEntity(player.core.position);
    }
    for (const unit of player.units) addEntity(unit.position);
  }
  return { tick: world.tick, seed: world.seed, players, corePositions, entityPositions, entityCountByCell };
}

function entityIdExists(working: WorkingState, id: string): boolean {
  for (const player of working.players.values()) {
    if (player.core?.id === id) return true;
    if (player.units.some((unit) => unit.id === id)) return true;
  }
  return false;
}

/**
 * 确定性重生 UUID（与 economy.deterministicUnitId 同模式：sha256 + UUID v4
 * 位设置）。输入含 "respawn" + kind 标记，与常规 spawn ID 互不冲突；
 * server UUID 算法未公开，本地只保证确定性/唯一性。
 */
function respawnEntityId(working: WorkingState, playerId: string, kind: string): string {
  const digest = createHash("sha256")
    .update(`${working.tick}\0${working.seed}\0${playerId}\0respawn\0${kind}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  digest[12] = "4";
  digest[16] = ["8", "9", "a", "b"][Number.parseInt(digest[16], 16) & 3];
  const hex = digest.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 候选格是否可通行且空（game-rules.md：passable empty spawn cell）。 */
function isLegalSpawnCell(world: SimWorld, working: WorkingState, cell: Position): boolean {
  const key = cellKey(cell);
  if (world.terrain.obstacles.has(key)) return false;
  // Core 不可置于 RESOURCE 地形（Terrain kinds）；掉落堆也占据"空"格
  if (world.terrain.resources.has(key)) return false;
  if (world.terrain.piles.has(key)) return false;
  if ((working.entityCountByCell.get(key) ?? 0) > 0) return false;

  // 至少 2 个可通行（非障碍）邻居
  let passableNeighbors = 0;
  for (const delta of Object.values(DIRECTION_DELTA)) {
    const neighbor = [cell[0] + delta[0], cell[1] + delta[1]] as Position;
    if (!world.terrain.obstacles.has(cellKey(neighbor))) passableNeighbors += 1;
  }
  if (passableNeighbors < RESPAWN_MIN_PASSABLE_NEIGHBORS) return false;

  // 距最近活 Core 20-30 Manhattan
  let nearest = Number.POSITIVE_INFINITY;
  for (const core of working.corePositions) {
    nearest = Math.min(nearest, manhattan(cell, core));
  }
  return nearest >= RESPAWN_DISTANCE_MIN && nearest <= RESPAWN_DISTANCE_MAX;
}

/** 候选集：每个活 Core 的 20-30 Manhattan 环带（并集去重），确定性枚举。 */
function spawnCandidates(world: SimWorld, working: WorkingState): Position[] {
  const candidates: Position[] = [];
  const seen = new Set<string>();
  const consider = (cell: Position): void => {
    const key = cellKey(cell);
    if (seen.has(key)) return;
    seen.add(key);
    if (isLegalSpawnCell(world, working, cell)) candidates.push(cell);
  };
  for (const [cx, cy] of working.corePositions) {
    for (let d = RESPAWN_DISTANCE_MIN; d <= RESPAWN_DISTANCE_MAX; d += 1) {
      for (let dy = -d; dy <= d; dy += 1) {
        const dx = d - Math.abs(dy);
        consider([cx + dx, cy + dy]);
        if (dx !== 0) consider([cx - dx, cy + dy]);
      }
    }
  }
  return candidates;
}

/** 候选格附近实体密度（Manhattan ≤ RESPAWN_DENSITY_RADIUS 的 Unit+Core 数）。 */
function densityOf(working: WorkingState, cell: Position): number {
  let count = 0;
  for (const entity of working.entityPositions) {
    if (manhattan(cell, entity) <= RESPAWN_DENSITY_RADIUS) count += 1;
  }
  return count;
}

/**
 * 选择 spawn 格：密度低优先，其次 x 升序，再 y 升序（纯数值排序，
 * 与容器插入顺序无关）。找不到合法格返回 null。
 */
function pickSpawnCell(world: SimWorld, working: WorkingState): Position | null {
  const candidates = spawnCandidates(world, working);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const densityDelta = densityOf(working, a) - densityOf(working, b);
    if (densityDelta !== 0) return densityDelta;
    if (a[0] !== b[0]) return a[0] - b[0];
    return a[1] - b[1];
  });
  return candidates[0];
}

/**
 * 结算一次重生（纯函数：不修改 world）。返回更新后的玩家与事件；
 * phase 负责写回 draft。
 */
export function resolveRespawn(world: SimWorld, rules: RulesManifest): RespawnResolution {
  const events: ResolutionEvent[] = [];
  const unknownEffects: UnknownEffect[] = [];
  const updatedPlayers = new Map<string, SimPlayer>();
  const working = buildWorkingState(world);

  const respawning = [...world.players.values()]
    .filter((player) => player.status === "RESPAWNING")
    .sort((a, b) => compareCodeUnit(a.id, b.id));

  for (const player of respawning) {
    // 裸 RESPAWNING（无 respawnAtTick，外部快照）：重试进度未知，跳过；
    // 未到期（respawnAtTick > 当前 Tick）：重试不在本 Tick，跳过。
    if (player.respawnAtTick === null || player.respawnAtTick > working.tick) continue;

    const coreId = respawnEntityId(working, player.id, "core");
    const workerIds = Array.from({ length: rules.rules.core.startingWorkerCount }, (_, index) =>
      index === 0
        ? respawnEntityId(working, player.id, "worker")
        : respawnEntityId(working, player.id, `worker-${index}`),
    );
    if (entityIdExists(working, coreId) || workerIds.some((id) => entityIdExists(working, id))) {
      throw new Error(`respawn: deterministic id collision for player ${player.id}`);
    }

    const cell = pickSpawnCell(world, working);
    if (cell === null) {
      // 保持 RESPAWNING；respawn_at_tick = 下一 Tick（届时用新候选集重试）
      working.players.set(player.id, { ...player, respawnAtTick: working.tick + 1 });
      updatedPlayers.set(player.id, working.players.get(player.id)!);
      events.push(
        eventOf(world.tick, "RESPAWN_DELAYED", {
          reasonCode: "NO_LEGAL_SPAWN",
          recipientPlayerId: player.id,
        }),
      );
      continue;
    }

    const newCore: SimCore = {
      id: coreId,
      position: cell,
      hp: rules.rules.core.maxHp,
      shield: rules.rules.core.maxShield,
      state: "NORMAL",
      moveDirection: null,
      moveProgress: null,
      moveRequiredTicks: null,
      destination: null,
    };
    const newWorkers: SimUnit[] = workerIds.map((id) => ({
      id,
      owner: player.id,
      position: cell,
      hp: rules.rules.units.workerHp,
      unitType: "WORKER",
      cargo: 0,
    }));

    working.players.set(player.id, {
      ...player,
      status: "ACTIVE",
      respawnAtTick: null,
      resources: rules.rules.core.startingResources,
      core: newCore,
      units: newWorkers,
    });
    updatedPlayers.set(player.id, working.players.get(player.id)!);
    working.corePositions.push(cell);
    working.entityPositions.push(cell, ...newWorkers.map((worker) => worker.position));
    const key = cellKey(cell);
    working.entityCountByCell.set(key, (working.entityCountByCell.get(key) ?? 0) + 1 + newWorkers.length);

    events.push(
      eventOf(world.tick, "CORE_RESPAWNED", {
        targetId: coreId,
        position: cell,
        values: {
          resources: rules.rules.core.startingResources,
          workers: rules.rules.core.startingWorkerCount,
        },
      }),
    );
    unknownEffects.push({
      tick: world.tick,
      kind: "server-generated-id",
      note: `respawn uses deterministic local UUIDs for Core ${coreId} and ${workerIds.length} Worker(s); server UUID algorithm is not public`,
    });
  }

  return { events, unknownEffects, updatedPlayers };
}

/** P13 respawn phase：把重生结算应用到 draft。 */
export const respawnPhase: Phase = {
  id: "P13-respawn",
  officialPhase: 12,
  run: (draft, ctx) => {
    const resolution = resolveRespawn(draft, ctx.rules);
    if (resolution.updatedPlayers.size > 0) {
      const players = new Map(draft.players);
      for (const [playerId, player] of resolution.updatedPlayers) {
        players.set(playerId, player);
      }
      (draft as unknown as { players: Map<string, SimPlayer> }).players = players;
    }
    // 裸 RESPAWNING（外部快照）输入仍属 unsupported：无法确定解析，不得伪装成功
    const unsupported: SimFeature[] = ctx.features.has("respawn") ? ["respawn"] : [];
    return outcome({
      events: resolution.events,
      unknownEffects: resolution.unknownEffects,
      unsupported,
    });
  },
};
