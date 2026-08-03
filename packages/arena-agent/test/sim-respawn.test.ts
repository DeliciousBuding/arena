/**
 * P12 respawn resolver 测试：
 * combat 摧毁 → 同 tick respawn、放置约束（20-30 Manhattan / 空格 / 邻居）、
 * 重生资产（5hp/5shield/5 资源/1 Worker）、新 UUID、RESPAWN_DELAYED 与
 * 下一 tick 重试、裸 RESPAWNING unsupported、确定性/纯函数、visibility 映射。
 *
 * 事件与 reason codes 对齐 api-resolution-results.md Beacon and respawn events；
 * 数值对齐 game-rules.md §Core destruction and respawn。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreAction, Plan, Position, UnitAction, UnitType } from "../src/domain/model.ts";
import { loadRulesManifest } from "../src/sim/contracts/rules-manifest.ts";
import { resolveCombat } from "../src/sim/engine/combat.ts";
import {
  RESPAWN_DISTANCE_MAX,
  RESPAWN_DISTANCE_MIN,
  resolveRespawn,
} from "../src/sim/engine/respawn.ts";
import { idlePlans, settleTick, type SettlementContext } from "../src/sim/engine/settlement.ts";
import { projectPlayerState } from "../src/sim/visibility/visibility.ts";
import { worldHash } from "../src/sim/world/canonical.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";
import { WorldInvariantError } from "../src/sim/world/world.ts";
import type { SimPlayer, SimWorld } from "../src/sim/world/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.11.json");

const rules = loadRulesManifest(MANIFEST_PATH);
const ctx: SettlementContext = { rules, rng: null };

const P1_CORE = "11111111-1111-1111-1111-111111111111";
const P1_WORKER = "22222222-2222-2222-2222-222222222222";
const P2_CORE = "33333333-3333-3333-3333-333333333333";
const P2_RANGER = "44444444-4444-4444-4444-444444444444";
const P3_CORE = "55555555-5555-5555-5555-555555555555";

interface CoreSpec {
  readonly id: string;
  readonly position: Position;
  readonly hp?: number;
  readonly shield?: number;
}

interface UnitSpec {
  readonly id: string;
  readonly position: Position;
  readonly hp?: number;
  readonly unitType?: UnitType;
  readonly cargo?: number;
}

interface PlayerSpec {
  readonly id: string;
  readonly username?: string;
  readonly resources: number;
  readonly status?: "ACTIVE" | "RESPAWNING";
  readonly respawnAtTick?: number | null;
  readonly core: CoreSpec | null;
  readonly units?: readonly UnitSpec[];
}

function makeWorld(
  players: readonly PlayerSpec[],
  terrain?: { obstacles?: readonly Position[]; resources?: readonly Position[]; piles?: readonly { readonly cell: Position; readonly amount: number }[] },
  beacon?: { position: Position; status?: "GROUND" | "CARRIED"; carrierId?: string | null },
  tick = 1,
): SimWorld {
  return worldFromScenario({
    rulesVersion: "v0.11",
    tick,
    seed: 7,
    players: players.map((p) => ({
      id: p.id,
      username: p.username ?? p.id,
      resources: p.resources,
      status: p.status ?? "ACTIVE",
      respawnAtTick: p.respawnAtTick ?? null,
      core:
        p.core === null
          ? null
          : {
              id: p.core.id,
              position: p.core.position,
              hp: p.core.hp ?? 5,
              shield: p.core.shield ?? 5,
              state: "NORMAL",
            },
      units: (p.units ?? []).map((u) => ({
        id: u.id,
        owner: p.id,
        position: u.position,
        hp: u.hp ?? 2,
        unitType: u.unitType ?? "WORKER",
        cargo: u.cargo ?? 0,
      })),
    })),
    terrain: {
      obstacles: terrain?.obstacles ?? [],
      resources: terrain?.resources ?? [],
      piles: terrain?.piles ?? [],
    },
    beacon: beacon ?? { position: [100, 100] },
  });
}

function planFor(
  world: SimWorld,
  playerId: string,
  actions: Readonly<Record<string, UnitAction>>,
  coreAction: CoreAction | null = null,
): Plan {
  const unitActions: Record<string, UnitAction> = {};
  for (const [unitId, action] of Object.entries(actions)) {
    unitActions[unitId] = action;
  }
  return { tick: world.tick, unitActions, coreAction, intents: {} };
}

function settle(world: SimWorld, plans: ReadonlyMap<string, Plan>): ReturnType<typeof settleTick> {
  return settleTick(world, plans, ctx);
}

function manhattan(a: Position, b: Position): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

/** 生成距 [cx, cy] Manhattan 距离 ∈ [min, max] 的全部格（与 resolver 环带枚举一致）。 */
function ringCells(cx: number, cy: number, min: number, max: number): Position[] {
  const cells: Position[] = [];
  const seen = new Set<string>();
  for (let d = min; d <= max; d += 1) {
    for (let dy = -d; dy <= d; dy += 1) {
      const dx = d - Math.abs(dy);
      for (const sx of dx === 0 ? [0] : [1, -1]) {
        const cell: Position = [cx + sx * dx, cy + dy];
        const key = `${cell[0]},${cell[1]}`;
        if (!seen.has(key)) {
          seen.add(key);
          cells.push(cell);
        }
      }
    }
  }
  return cells;
}

function respawningPlayer(world: SimWorld, playerId: string): SimPlayer {
  const player = world.players.get(playerId)!;
  assert.equal(player.status, "RESPAWNING");
  return player;
}

/* ---------------- 同 tick respawn（combat 摧毁） ---------------- */

test("P12: combat 摧毁 → 同 tick respawn 成功（ACTIVE、新 core/worker、resources 5）", () => {
  const world = makeWorld([
    {
      id: "p1",
      resources: 10,
      core: { id: P1_CORE, position: [0, 0], hp: 1, shield: 0 },
      units: [{ id: P1_WORKER, position: [0, 1], cargo: 2 }],
    },
    {
      id: "p2",
      resources: 5,
      core: { id: P2_CORE, position: [6, 6] },
      units: [{ id: P2_RANGER, position: [0, 3], unitType: "RANGER" }],
    },
  ]);
  const result = settle(world, new Map([["p2", planFor(world, "p2", { [P2_RANGER]: { type: "SHOOT", targetId: P1_CORE, expectedCell: [0, 0] } })]]));

  const p1 = result.world.players.get("p1")!;
  assert.equal(p1.status, "ACTIVE");
  assert.ok(p1.core !== null);
  assert.equal(p1.units.length, 1);
  assert.equal(p1.resources, rules.rules.core.startingResources);
  assert.deepEqual(result.unsupported, [], "Sim-produced respawn is not unsupported");
  assert.ok(result.events.some((e) => e.eventType === "CORE_DESTROYED" && e.targetId === P1_CORE));
  assert.ok(result.events.some((e) => e.eventType === "CORE_RESPAWNED"), "CORE_RESPAWNED missing");
});

test("P12: respawn 位置——距最近活 Core 20-30 Manhattan，偏好低密度取确定性格 [-30,0]", () => {
  // p2 Core[0,0] 是唯一活 Core；全空地图全部候选密度 0 → 取 (x,y) 字典序最小
  const world = makeWorld([
    { id: "p1", resources: 5, status: "RESPAWNING", respawnAtTick: 1, core: null },
    { id: "p2", resources: 5, core: { id: P2_CORE, position: [0, 0] } },
  ]);
  const result = settle(world, idlePlans(world));
  const core = result.world.players.get("p1")!.core!;
  assert.deepEqual(core.position, [-30, 0], "deterministic spawn cell");
  const distance = manhattan(core.position, [0, 0]);
  assert.ok(distance >= RESPAWN_DISTANCE_MIN && distance <= RESPAWN_DISTANCE_MAX, `distance ${distance}`);
});

test("P12: respawn 后 core 5hp/5shield、worker 2hp 且同格", () => {
  const world = makeWorld([
    { id: "p1", resources: 5, status: "RESPAWNING", respawnAtTick: 1, core: null },
    { id: "p2", resources: 5, core: { id: P2_CORE, position: [0, 0] } },
  ]);
  const result = settle(world, idlePlans(world));
  const player = result.world.players.get("p1")!;
  const core = player.core!;
  assert.equal(core.hp, rules.rules.core.maxHp);
  assert.equal(core.shield, rules.rules.core.maxShield);
  assert.equal(core.state, "NORMAL");
  assert.equal(core.moveDirection, null);
  assert.equal(core.moveProgress, null);
  assert.equal(core.moveRequiredTicks, null);
  assert.equal(core.destination, null);
  assert.equal(player.units.length, rules.rules.core.startingWorkerCount);
  const worker = player.units[0];
  assert.equal(worker.unitType, "WORKER");
  assert.equal(worker.hp, rules.rules.units.workerHp);
  assert.equal(worker.cargo, 0);
  assert.equal(worker.owner, "p1");
  assert.deepEqual(worker.position, core.position, "worker spawns on core cell");
  assert.equal(player.resources, rules.rules.core.startingResources);
});

test("P12: 新 UUID 与旧不同、core/worker 互不相同、均为 canonical", () => {
  const world = makeWorld([
    {
      id: "p1",
      resources: 5,
      status: "RESPAWNING",
      respawnAtTick: 1,
      core: null,
    },
    { id: "p2", resources: 5, core: { id: P2_CORE, position: [0, 0] } },
  ]);
  const result = settle(world, idlePlans(world));
  const player = result.world.players.get("p1")!;
  assert.notEqual(player.core!.id, P1_CORE, "core UUID never reused");
  assert.notEqual(player.core!.id, player.units[0].id, "core and worker UUIDs differ");
  assert.match(player.core!.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.match(player.units[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  // 与现存实体不冲突
  assert.notEqual(player.core!.id, P2_CORE);
});

test("P12: CORE_RESPAWNED 事件字段（target_id 新 Core、position、values）", () => {
  const world = makeWorld([
    { id: "p1", resources: 5, status: "RESPAWNING", respawnAtTick: 1, core: null },
    { id: "p2", resources: 5, core: { id: P2_CORE, position: [0, 0] } },
  ]);
  const result = settle(world, idlePlans(world));
  const event = result.events.find((e) => e.eventType === "CORE_RESPAWNED");
  assert.ok(event, "CORE_RESPAWNED missing");
  const player = result.world.players.get("p1")!;
  assert.equal(event!.targetId, player.core!.id);
  assert.deepEqual(event!.position, player.core!.position);
  assert.deepEqual(event!.values, {
    resources: rules.rules.core.startingResources,
    workers: rules.rules.core.startingWorkerCount,
  });
  assert.equal(event!.tick, world.tick);
});

/* ---------------- 放置失败与重试 ---------------- */

test("P12: 无活 Core → 找不到合法 cell → RESPAWN_DELAYED/NO_LEGAL_SPAWN + respawnAtTick 记录", () => {
  const world = makeWorld([{ id: "p1", resources: 5, status: "RESPAWNING", respawnAtTick: 1, core: null }]);
  const result = settle(world, idlePlans(world));
  const p1 = respawningPlayer(result.world, "p1");
  assert.equal(p1.respawnAtTick, world.tick + 1, "retry scheduled for next tick");
  assert.equal(p1.core, null);
  assert.equal(p1.units.length, 0);
  assert.equal(p1.resources, 5, "resources unchanged while respawning");
  const delayed = result.events.find((e) => e.eventType === "RESPAWN_DELAYED");
  assert.ok(delayed, "RESPAWN_DELAYED missing");
  assert.equal(delayed!.reasonCode, "NO_LEGAL_SPAWN");
  assert.equal(delayed!.actorId, null);
  assert.equal(delayed!.targetId, null);
  assert.equal(delayed!.position, null);
  assert.equal(delayed!.values, null);
  assert.ok(!result.events.some((e) => e.eventType === "CORE_RESPAWNED"));
});

test("P12: 环带全部障碍 → 保持 RESPAWNING（活 Core 存在也找不到合法格）", () => {
  const ring = ringCells(0, 0, RESPAWN_DISTANCE_MIN, RESPAWN_DISTANCE_MAX);
  const world = makeWorld(
    [
      { id: "p1", resources: 5, status: "RESPAWNING", respawnAtTick: 1, core: null },
      { id: "p2", resources: 5, core: { id: P2_CORE, position: [0, 0] } },
    ],
    { obstacles: ring },
  );
  const result = settle(world, idlePlans(world));
  const p1 = respawningPlayer(result.world, "p1");
  assert.equal(p1.respawnAtTick, world.tick + 1);
  assert.ok(result.events.some((e) => e.eventType === "RESPAWN_DELAYED"));
});

test("P12: 下一 tick 重试成功（respawnAtTick 到期，新确定性候选集）", () => {
  // tick 1：环带全障碍 → RESPAWN_DELAYED，respawnAtTick = 2
  const ring = ringCells(0, 0, RESPAWN_DISTANCE_MIN, RESPAWN_DISTANCE_MAX);
  const world1 = makeWorld(
    [
      { id: "p1", resources: 5, status: "RESPAWNING", respawnAtTick: 1, core: null },
      { id: "p2", resources: 5, core: { id: P2_CORE, position: [0, 0] } },
    ],
    { obstacles: ring },
  );
  const r1 = settle(world1, idlePlans(world1));
  assert.equal(r1.world.players.get("p1")!.status, "RESPAWNING");
  assert.equal(r1.world.players.get("p1")!.respawnAtTick, 2);

  // tick 2：候选集变化（障碍移除）→ 到期重试成功
  const world2 = makeWorld(
    [
      { id: "p1", resources: 5, status: "RESPAWNING", respawnAtTick: 2, core: null },
      { id: "p2", resources: 5, core: { id: P2_CORE, position: [0, 0] } },
    ],
    {},
    { position: [100, 100] },
    2,
  );
  const r2 = settle(world2, idlePlans(world2));
  const p1 = r2.world.players.get("p1")!;
  assert.equal(p1.status, "ACTIVE");
  assert.ok(p1.core !== null);
  assert.equal(p1.respawnAtTick, null);
  assert.ok(r2.events.some((e) => e.eventType === "CORE_RESPAWNED"));
  assert.deepEqual(r2.unsupported, []);
});

test("P12: 未到期（respawnAtTick > 当前 Tick）不重试、无事件", () => {
  const world = makeWorld([
    { id: "p1", resources: 5, status: "RESPAWNING", respawnAtTick: 5, core: null },
    { id: "p2", resources: 5, core: { id: P2_CORE, position: [0, 0] } },
  ]);
  const result = settle(world, idlePlans(world));
  const p1 = respawningPlayer(result.world, "p1");
  assert.equal(p1.respawnAtTick, 5, "schedule untouched");
  assert.deepEqual(result.events, [], "no respawn events before due tick");
  assert.deepEqual(result.unsupported, []);
});

test("P12: 裸 RESPAWNING（缺 respawnAtTick，外部快照）→ unsupported 且不解析", () => {
  const world = makeWorld([
    { id: "p1", resources: 5, status: "RESPAWNING", respawnAtTick: null, core: null },
    { id: "p2", resources: 5, core: { id: P2_CORE, position: [0, 0] } },
  ]);
  const result = settle(world, idlePlans(world));
  assert.ok(result.unsupported.includes("respawn"), `unsupported=${result.unsupported}`);
  const p1 = respawningPlayer(result.world, "p1");
  assert.equal(p1.respawnAtTick, null, "bare state untouched (retry schedule unknown)");
  assert.deepEqual(result.events, []);
});

/* ---------------- 多玩家与确定性 ---------------- */

test("P12: 同 tick 多玩家重生——按 playerId 序增量处理，位置不冲突", () => {
  // p1 先处理（compareCodeUnit）→ [-30,0]（p3 Core[0,0] 环带字典序最小）；
  // p2 后处理时 p1 的新 Core 已是活 Core → 候选集为 [0,0] 与 [-30,0] 的环带
  // 并集；两者密度均 0 → 取字典序最小 [-60,0]（距 [-30,0] 恰 30，合法）。
  const world = makeWorld([
    { id: "p1", resources: 5, status: "RESPAWNING", respawnAtTick: 1, core: null },
    { id: "p2", resources: 5, status: "RESPAWNING", respawnAtTick: 1, core: null },
    { id: "p3", resources: 5, core: { id: P3_CORE, position: [0, 0] } },
  ]);
  const result = settle(world, idlePlans(world));
  assert.equal(result.world.players.get("p1")!.status, "ACTIVE");
  assert.equal(result.world.players.get("p2")!.status, "ACTIVE");
  const core1 = result.world.players.get("p1")!.core!;
  const core2 = result.world.players.get("p2")!.core!;
  assert.deepEqual(core1.position, [-30, 0]);
  assert.deepEqual(core2.position, [-60, 0]);
  assert.notEqual(core1.id, core2.id);
  // 两个新 Core 相互距离 ≥ 20（各自距最近活 Core 均 20-30）
  assert.ok(manhattan(core1.position, [0, 0]) >= RESPAWN_DISTANCE_MIN);
  assert.ok(manhattan(core2.position, [0, 0]) >= RESPAWN_DISTANCE_MIN);
  assert.equal(result.events.filter((e) => e.eventType === "CORE_RESPAWNED").length, 2);
});

test("P12: 玩家插入顺序无关——settlement 输出 hash 一致", () => {
  const players: PlayerSpec[] = [
    { id: "p1", resources: 5, status: "RESPAWNING", respawnAtTick: 1, core: null },
    { id: "p2", resources: 5, status: "RESPAWNING", respawnAtTick: 1, core: null },
    { id: "p3", resources: 5, core: { id: P3_CORE, position: [0, 0] } },
  ];
  const a = makeWorld([...players]);
  const b = makeWorld([...players].reverse());
  const hashA = worldHash(settle(a, idlePlans(a)).world);
  const hashB = worldHash(settle(b, idlePlans(b)).world);
  assert.equal(hashA, hashB);
});

/* ---------------- 纯函数 ---------------- */

test("P12: settleTick 不修改原 world（纯函数）", () => {
  const world = makeWorld([
    {
      id: "p1",
      resources: 10,
      core: { id: P1_CORE, position: [0, 0], hp: 1, shield: 0 },
    },
    {
      id: "p2",
      resources: 5,
      core: { id: P2_CORE, position: [6, 6] },
      units: [{ id: P2_RANGER, position: [0, 3], unitType: "RANGER" }],
    },
  ]);
  const before = worldHash(world);
  settle(world, new Map([["p2", planFor(world, "p2", { [P2_RANGER]: { type: "SHOOT", targetId: P1_CORE, expectedCell: [0, 0] } })]]));
  assert.equal(worldHash(world), before, "original world untouched");
});

test("P12: resolveRespawn 纯函数直接调用——原 world 不变", () => {
  const world = makeWorld([
    { id: "p1", resources: 5, status: "RESPAWNING", respawnAtTick: 1, core: null },
    { id: "p2", resources: 5, core: { id: P2_CORE, position: [0, 0] } },
  ]);
  const before = worldHash(world);
  const resolution = resolveRespawn(world, rules);
  assert.equal(resolution.updatedPlayers.size, 1);
  assert.equal(worldHash(world), before, "resolveRespawn must not mutate world");
});

/* ---------------- 不变量与 visibility ---------------- */

test("P12: RESPAWNING 玩家带 core/units 违反 invariant（构造拒绝）", () => {
  assert.throws(
    () =>
      makeWorld([
        { id: "p1", resources: 5, status: "RESPAWNING", respawnAtTick: 1, core: { id: P1_CORE, position: [0, 0] } },
        { id: "p2", resources: 5, core: { id: P2_CORE, position: [0, 0] } },
      ]),
    WorldInvariantError,
  );
  assert.throws(
    () =>
      makeWorld([
        { id: "p1", resources: 5, status: "RESPAWNING", respawnAtTick: 1, core: null, units: [{ id: P1_WORKER, position: [0, 1] }] },
        { id: "p2", resources: 5, core: { id: P2_CORE, position: [0, 0] } },
      ]),
    WorldInvariantError,
  );
});

test("P12: visibility 映射 respawn_at_tick（RESPAWNING 有值、ACTIVE null）", () => {
  const world = makeWorld(
    [
      { id: "p1", resources: 5, status: "RESPAWNING", respawnAtTick: 2, core: null },
      { id: "p2", resources: 5, core: { id: P2_CORE, position: [50, 50] } },
    ],
    {},
    { position: [100, 100], status: "GROUND", carrierId: null },
  );
  const state = projectPlayerState(world, "p1", rules);
  assert.equal(state.status, "RESPAWNING");
  assert.equal(state.respawn_at_tick, 2, "wire respawn_at_tick maps deferred retry tick");

  const active = projectPlayerState(world, "p2", rules);
  assert.equal(active.status, "ACTIVE");
  assert.equal(active.respawn_at_tick, null, "ACTIVE players carry null respawn_at_tick");
});

/* ---------------- 与 combat 快照 API 的关系 ---------------- */

test("P12: resolveCombat 不受 respawn 影响（纯战斗快照）", () => {
  const world = makeWorld([
    {
      id: "p1",
      resources: 10,
      core: { id: P1_CORE, position: [0, 0], hp: 1, shield: 0 },
      units: [{ id: P1_WORKER, position: [0, 1], cargo: 2 }],
    },
    {
      id: "p2",
      resources: 5,
      core: { id: P2_CORE, position: [6, 6] },
      units: [{ id: P2_RANGER, position: [0, 3], unitType: "RANGER" }],
    },
  ]);
  const combat = resolveCombat(world, new Map([["p2", planFor(world, "p2", { [P2_RANGER]: { type: "SHOOT", targetId: P1_CORE, expectedCell: [0, 0] } })]]));
  assert.ok(combat.destroyedCores.includes(P1_CORE));
  // combat 是快照函数：不产生 respawn 副作用
  assert.ok(!combat.events.some((e) => e.eventType === "CORE_RESPAWNED"));
  assert.equal(world.players.get("p1")!.status, "ACTIVE", "world untouched by snapshot");
});
