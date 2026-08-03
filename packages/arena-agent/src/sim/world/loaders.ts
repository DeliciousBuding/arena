/**
 * SimWorld 载入器（S2）：人工 scenario 与真实 raw snapshot（fixture PlayerState）。
 *
 * 所有载入路径都必须：safe coordinate 校验、id 唯一性、规则版本匹配、
 * 构造后通过 world invariants。载入不修改输入文件。
 */

import { readFileSync } from "node:fs";
import { cellKey, type Direction, type Position, type UnitType } from "../../domain/model.ts";
import { assertSafeCoordinate } from "../deterministic/coordinate.ts";
import { assertCanonicalUuid } from "../deterministic/uuid.ts";
import type { SimBeacon, SimCore, SimPlayer, SimTerrain, SimUnit, SimWorld } from "./types.ts";
import { assertWorldInvariants } from "./world.ts";

export class ScenarioLoadError extends Error {
  constructor(message: string) {
    super(`sim scenario: ${message}`);
    this.name = "ScenarioLoadError";
  }
}

interface ScenarioUnit {
  readonly id: string;
  readonly owner: string;
  readonly position: Position;
  readonly hp: number;
  readonly unitType: UnitType;
  readonly cargo: number;
}

interface ScenarioCore {
  readonly id: string;
  readonly position: Position;
  readonly hp: number;
  readonly shield: number;
  readonly state: "NORMAL" | "MOVING";
  readonly moveDirection?: Direction | null;
  readonly moveProgress?: number | null;
  readonly moveRequiredTicks?: number | null;
  readonly destination?: Position | null;
}

interface ScenarioPlayer {
  readonly id: string;
  readonly username: string;
  readonly resources: number;
  readonly core: ScenarioCore | null;
  readonly units: readonly ScenarioUnit[];
}

interface ScenarioFile {
  readonly schema?: string;
  readonly rulesVersion: string;
  readonly tick: number;
  readonly seed: number;
  readonly players: readonly ScenarioPlayer[];
  readonly terrain: {
    readonly obstacles: readonly Position[];
    readonly resources: readonly Position[];
    readonly piles: readonly { readonly cell: Position; readonly amount: number }[];
  };
  readonly beacon: SimBeacon | null;
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScenarioLoadError(`expected object at ${path}`);
  }
  return value as Record<string, unknown>;
}

function asPosition(value: unknown, path: string): Position {
  if (!Array.isArray(value) || value.length !== 2 || value.some((v) => typeof v !== "number")) {
    throw new ScenarioLoadError(`expected [x, y] at ${path}`);
  }
  const position = value as unknown as Position;
  assertSafeCoordinate(position);
  return position;
}

const DIRECTION_DELTA: Readonly<Record<Direction, readonly [number, number]>> = {
  UP: [0, -1],
  DOWN: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
};

/**
 * Core 迁移字段归一化（game-rules.md Four-Tick Core migration）。
 * NORMAL → 四字段恒 null；MOVING → 四字段全给（校验方向/目的地/进度一致）
 * 或全缺（裸 MOVING：外部快照进度未知，settlement 标记 unsupported）。
 */
function migrationFields(
  raw: Record<string, unknown>,
  path: string,
): {
  readonly moveDirection: Direction | null;
  readonly moveProgress: number | null;
  readonly moveRequiredTicks: number | null;
  readonly destination: Position | null;
} {
  const state = raw.state === "MOVING" ? "MOVING" : "NORMAL";
  if (state !== "MOVING") {
    return { moveDirection: null, moveProgress: null, moveRequiredTicks: null, destination: null };
  }
  const moveDirection = raw.moveDirection as Direction | null | undefined;
  const moveProgress = raw.moveProgress as number | null | undefined;
  const moveRequiredTicks = raw.moveRequiredTicks as number | null | undefined;
  const destination = raw.destination as Position | null | undefined;
  const hasDirection = moveDirection !== undefined && moveDirection !== null;
  const hasProgress = moveProgress !== undefined && moveProgress !== null;
  const hasRequired = moveRequiredTicks !== undefined && moveRequiredTicks !== null;
  const hasDestination = destination !== undefined && destination !== null;
  if (!hasDirection && !hasProgress && !hasRequired && !hasDestination) {
    return { moveDirection: null, moveProgress: null, moveRequiredTicks: null, destination: null };
  }
  if (!hasDirection || !hasProgress || !hasRequired || !hasDestination) {
    throw new ScenarioLoadError(`${path}: MOVING core requires all four migration fields or none`);
  }
  const direction = moveDirection!;
  const dest = asPosition(destination!, `${path}.destination`);
  const required = Number(moveRequiredTicks);
  const progress = Number(moveProgress);
  if (!Number.isInteger(required) || required < 1) {
    throw new ScenarioLoadError(`${path}: moveRequiredTicks must be a positive integer`);
  }
  if (!Number.isInteger(progress) || progress < 1 || progress > required) {
    throw new ScenarioLoadError(`${path}: moveProgress must be within 1..moveRequiredTicks`);
  }
  const [dx, dy] = DIRECTION_DELTA[direction];
  if (cellKey(dest) !== cellKey([(raw.position as Position)[0] + dx, (raw.position as Position)[1] + dy])) {
    throw new ScenarioLoadError(`${path}: destination does not match moveDirection from position`);
  }
  return { moveDirection: direction, moveProgress: progress, moveRequiredTicks: required, destination: dest };
}

function normalizeScenario(raw: unknown): ScenarioFile {
  const root = assertRecord(raw, "root");
  const rulesVersion = root.rulesVersion;
  if (typeof rulesVersion !== "string" || rulesVersion.length === 0) {
    throw new ScenarioLoadError("missing rulesVersion");
  }
  if (!Array.isArray(root.players)) {
    throw new ScenarioLoadError("missing players");
  }
  const terrain = assertRecord(root.terrain ?? {}, "terrain");
  const players = root.players.map((p, i) => {
    const player = assertRecord(p, `players[${i}]`);
    const id = player.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new ScenarioLoadError(`players[${i}].id missing`);
    }
    const unitsRaw = Array.isArray(player.units) ? player.units : [];
    const units = unitsRaw.map((u, j) => {
      const unit = assertRecord(u, `players[${i}].units[${j}]`);
      const uid = unit.id;
      if (typeof uid !== "string") throw new ScenarioLoadError(`units[${j}].id missing`);
      assertCanonicalUuid(uid);
      return {
        id: uid,
        owner: id,
        position: asPosition(unit.position, `players[${i}].units[${j}].position`),
        hp: Number(unit.hp),
        unitType: unit.unitType as UnitType,
        cargo: Number(unit.cargo ?? 0),
      };
    });
    const coreRaw = player.core;
    let core: ScenarioCore | null = null;
    if (coreRaw !== null && coreRaw !== undefined) {
      const c = assertRecord(coreRaw, `players[${i}].core`);
      const cid = c.id;
      if (typeof cid !== "string") throw new ScenarioLoadError(`players[${i}].core.id missing`);
      assertCanonicalUuid(cid);
      core = {
        id: cid,
        position: asPosition(c.position, `players[${i}].core.position`),
        hp: Number(c.hp),
        shield: Number(c.shield),
        state: c.state === "MOVING" ? "MOVING" : "NORMAL",
        ...migrationFields(c, `players[${i}].core`),
      };
    }
    return { id, username: String(player.username ?? id), resources: Number(player.resources ?? 0), core, units };
  });
  return {
    rulesVersion,
    tick: Number(root.tick ?? 1),
    seed: Number(root.seed ?? 1),
    players,
    terrain: {
      obstacles: Array.isArray(terrain.obstacles)
        ? (terrain.obstacles as unknown[]).map((p, i) => asPosition(p, `terrain.obstacles[${i}]`))
        : [],
      resources: Array.isArray(terrain.resources)
        ? (terrain.resources as unknown[]).map((p, i) => asPosition(p, `terrain.resources[${i}]`))
        : [],
      piles: Array.isArray(terrain.piles)
        ? (terrain.piles as unknown[]).map((rawPile, i) => {
            const pile = assertRecord(rawPile, `terrain.piles[${i}]`);
            const amount = Number(pile.amount);
            if (!Number.isInteger(amount) || amount <= 0) {
              throw new ScenarioLoadError(`terrain.piles[${i}].amount must be a positive integer`);
            }
            return { cell: asPosition(pile.cell, `terrain.piles[${i}].cell`), amount };
          })
        : [],
    },
    beacon:
      root.beacon === null || root.beacon === undefined
        ? null
        : (() => {
            const beacon = assertRecord(root.beacon, "beacon");
            const status = beacon.status === "CARRIED" ? "CARRIED" : "GROUND";
            const carrierId = beacon.carrierId ?? beacon.carrier_id ?? null;
            if (carrierId !== null && typeof carrierId !== "string") {
              throw new ScenarioLoadError("beacon.carrierId must be string or null");
            }
            if (status === "CARRIED" && carrierId === null) {
              throw new ScenarioLoadError("carried beacon requires carrierId");
            }
            if (status === "GROUND" && carrierId !== null) {
              throw new ScenarioLoadError("ground beacon cannot have carrierId");
            }
            return {
              position: asPosition(beacon.position, "beacon.position"),
              status,
              carrierId,
            };
          })(),
  };
}

/** 从 scenario JSON 对象构造 SimWorld（构造后过 invariants）。 */
export function worldFromScenario(raw: unknown): SimWorld {
  const scenario = normalizeScenario(raw);
  const players = new Map<string, SimPlayer>();
  const seenPlayerIds = new Set<string>();
  const seenUnitIds = new Set<string>();
  for (const p of scenario.players) {
    if (seenPlayerIds.has(p.id)) throw new ScenarioLoadError(`duplicate player id: ${p.id}`);
    seenPlayerIds.add(p.id);
    const units: SimUnit[] = [];
    for (const u of p.units) {
      if (seenUnitIds.has(u.id)) throw new ScenarioLoadError(`duplicate unit id: ${u.id}`);
      seenUnitIds.add(u.id);
      if (u.owner !== p.id) throw new ScenarioLoadError(`unit ${u.id} owner mismatch`);
      units.push({ ...u });
    }
    const core: SimCore | null =
      p.core === null
        ? null
        : {
            id: p.core.id,
            position: p.core.position,
            hp: p.core.hp,
            shield: p.core.shield,
            state: p.core.state,
            moveDirection: p.core.moveDirection ?? null,
            moveProgress: p.core.moveProgress ?? null,
            moveRequiredTicks: p.core.moveRequiredTicks ?? null,
            destination: p.core.destination ?? null,
          };
    players.set(p.id, {
      id: p.id,
      username: p.username,
      status: "ACTIVE",
      resources: p.resources,
      core,
      units,
    });
  }

  const obstacles = new Set<string>();
  for (const p of scenario.terrain.obstacles) obstacles.add(cellKey(p));
  const resources = new Map<string, { readonly cell: Position }>();
  for (const p of scenario.terrain.resources) resources.set(cellKey(p), { cell: p });
  const piles = new Map<string, { readonly cell: Position; readonly amount: number }>();
  for (const pile of scenario.terrain.piles) {
    const key = cellKey(pile.cell);
    const existing = piles.get(key)?.amount ?? 0;
    piles.set(key, { cell: pile.cell, amount: existing + pile.amount });
  }

  const terrain: SimTerrain = { obstacles, resources, piles };
  const world: SimWorld = {
    tick: scenario.tick,
    resolvedTickCount: 0,
    rulesVersion: scenario.rulesVersion,
    players,
    terrain,
    beacon: scenario.beacon,
    seed: scenario.seed,
    rngStreamPosition: 0,
    unsupportedFeatures: [],
    provenance: { scenario: null, sourceCaseHash: null },
  };
  assertWorldInvariants(world);
  return world;
}

/** 从 scenario JSON 文件路径构造 SimWorld。 */
export function loadScenarioFile(path: string): SimWorld {
  const text = readFileSync(path, "utf8");
  return worldFromScenario(JSON.parse(text));
}

/* ------------------------------------------------------------------ */
/* raw snapshot loader（真实 PlayerState → SimWorld）                  */
/* ------------------------------------------------------------------ */

interface RawObject {
  readonly kind: string;
  readonly id?: string;
  readonly controlled?: boolean;
  readonly position?: Position;
  readonly hp?: number;
  readonly shield?: number;
  readonly state?: string;
  readonly owner_username?: string;
  readonly unit_type?: string;
  readonly cargo?: number | null;
  readonly positions?: readonly Position[];
  readonly move_direction?: string | null;
  readonly move_progress?: number | null;
  readonly move_required_ticks?: number | null;
  readonly destination?: Position | null;
}

interface RawPlayerState {
  readonly status: string;
  readonly resources: number;
  readonly objects: readonly RawObject[];
  readonly champion_beacon?: {
    readonly position: Position;
    readonly status?: "GROUND" | "CARRIED" | null;
    readonly carrier_id?: string | null;
  } | null;
}

/**
 * 从真实 PlayerState（fixture JSON 结构）构造 SimWorld。
 * 只载入 controlled 对象（己方视图）；uncontrolled（敌人）在 MVP 无对手阶段
 * 忽略并在 provenance 标注。返回 { world, droppedEnemies }。
 */
export function worldFromRawState(raw: RawPlayerState, playerId: string, rulesVersion: string): SimWorld {
  const obstacles = new Set<string>();
  const resourceCells = new Map<string, { readonly cell: Position }>();
  const units: SimUnit[] = [];
  let core: SimCore | null = null;
  let droppedEnemies = 0;

  for (const obj of raw.objects) {
    switch (obj.kind) {
      case "OBSTACLE":
        for (const p of obj.positions ?? []) {
          assertSafeCoordinate(p);
          obstacles.add(cellKey(p));
        }
        break;
      case "RESOURCE":
        for (const p of obj.positions ?? []) {
          assertSafeCoordinate(p);
          resourceCells.set(cellKey(p), { cell: p });
        }
        break;
      case "CORE": {
        assertSafeCoordinate(obj.position!);
        if (obj.controlled === true) {
          assertCanonicalUuid(obj.id!);
          core = {
            id: obj.id!,
            position: obj.position!,
            hp: Number(obj.hp),
            shield: Number(obj.shield),
            state: obj.state === "MOVING" ? "MOVING" : "NORMAL",
            moveDirection: (obj.move_direction as Direction | null) ?? null,
            moveProgress:
              obj.move_progress === null || obj.move_progress === undefined
                ? null
                : Number(obj.move_progress),
            moveRequiredTicks:
              obj.move_required_ticks === null || obj.move_required_ticks === undefined
                ? null
                : Number(obj.move_required_ticks),
            destination:
              obj.destination === null || obj.destination === undefined
                ? null
                : asPosition(obj.destination, "core.destination"),
          };
        } else {
          droppedEnemies += 1;
        }
        break;
      }
      case "UNIT": {
        assertSafeCoordinate(obj.position!);
        if (obj.controlled === true) {
          assertCanonicalUuid(obj.id!);
          units.push({
            id: obj.id!,
            owner: playerId,
            position: obj.position!,
            hp: Number(obj.hp),
            unitType: (obj.unit_type as UnitType) ?? "WORKER",
            cargo: Number(obj.cargo ?? 0),
          });
        } else {
          droppedEnemies += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  const player: SimPlayer = {
    id: playerId,
    username: raw.objects.find((o) => o.kind === "CORE" && o.controlled === true)?.owner_username ?? "sim-player",
    status: raw.status === "RESPAWNING" ? "RESPAWNING" : "ACTIVE",
    resources: Number(raw.resources),
    core,
    units,
  };

  const world: SimWorld = {
    tick: 1,
    resolvedTickCount: 0,
    rulesVersion,
    players: new Map([[playerId, player]]),
    terrain: { obstacles, resources: resourceCells, piles: new Map() },
    beacon:
      raw.champion_beacon === null || raw.champion_beacon === undefined
        ? null
        : {
            position: raw.champion_beacon.position,
            status: raw.champion_beacon.status === "CARRIED" ? "CARRIED" : "GROUND",
            carrierId: raw.champion_beacon.carrier_id ?? null,
          },
    seed: 1,
    rngStreamPosition: 0,
    unsupportedFeatures: [],
    provenance: {
      scenario: null,
      sourceCaseHash: droppedEnemies > 0 ? `dropped-enemies:${droppedEnemies}` : null,
    },
  };
  assertWorldInvariants(world);
  return world;
}

/** 从 fixture JSON 文件路径构造 SimWorld（raw snapshot loader）。 */
export function loadRawStateFile(path: string, playerId: string, rulesVersion: string): SimWorld {
  const text = readFileSync(path, "utf8");
  return worldFromRawState(JSON.parse(text), playerId, rulesVersion);
}
