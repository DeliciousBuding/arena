/**
 * Cross-resolver 集成测试（sim-integration）：
 * combat ↔ beacon / combat ↔ core-migration / core-migration ↔ beacon /
 * combat → respawn / beacon ↔ economy / 三域组合。
 *
 * 规则依据（docs/game-rules.md）：
 * - §Champion Beacon：「If a Beacon carried at the start of the Tick is dropped,
 *   its carrier dies, or the owner's Core is destroyed, it lands at the carrier's
 *   final actual position. No other object may pick it up until the next Tick.」
 * - §Champion Beacon：「The Beacon follows a Unit whenever its move succeeds.」
 * - §Champion Beacon：「A migrating Core's Beacon remains at the Core's logical
 *   position until the fourth-Tick real move succeeds.」
 * - §Combat：Core 伤害先消耗 shield 再消耗 hp；摧毁 Core → fleet 移除、cargo
 *   原地掉落、携带的 Beacon 按 Beacon 规则落地、玩家进入 RESPAWNING。
 * - §Core destruction and respawn：P12 在同一结算 Tick 尝试确定性 replacement；
 *   无合法格时才保持 RESPAWNING 并延迟重试。
 *
 * 结算顺序（settlement.ts）：P05 global movement → P06 core-migration actions → P07 beacon →
 * P08 harvest → P09 combat → P12 respawn-check。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import type { CoreAction, Direction, Plan, Position, UnitAction, UnitType } from "../src/domain/model.ts";
import { loadRulesManifest } from "../src/sim/contracts/rules-manifest.ts";
import { phaseOrder, settleTick, type SettlementContext } from "../src/sim/engine/settlement.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";
import type { SimWorld } from "../src/sim/world/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.11.json");

const rules = loadRulesManifest(MANIFEST_PATH);
const ctx: SettlementContext = { rules, rng: null };

const P1_CORE = "11111111-1111-1111-1111-111111111111";
const P1_WORKER = "22222222-2222-2222-2222-222222222222";
const P1_VANGUARD = "33333333-3333-3333-3333-333333333333";
const P2_CORE = "44444444-4444-4444-4444-444444444444";
const P2_VANGUARD = "55555555-5555-5555-5555-555555555555";
const P2_RANGER = "66666666-6666-6666-6666-666666666666";
const P2_WORKER = "77777777-7777-7777-7777-777777777777";
const P2_WORKER_B = "88888888-8888-8888-8888-888888888888";

interface CoreSpec {
  readonly id: string;
  readonly position: Position;
  readonly hp?: number;
  readonly shield?: number;
  readonly state?: "NORMAL" | "MOVING";
  readonly moveDirection?: Direction | null;
  readonly moveProgress?: number | null;
  readonly moveRequiredTicks?: number | null;
  readonly destination?: Position | null;
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
  readonly resources: number;
  readonly core: CoreSpec | null;
  readonly units?: readonly UnitSpec[];
}

function makeWorld(
  players: readonly PlayerSpec[],
  terrain: { obstacles?: readonly Position[]; resources?: readonly Position[] } = {},
  beacon?: { position: Position; status: "GROUND" | "CARRIED"; carrierId?: string | null } | null,
): SimWorld {
  return worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: players.map((player) => ({
      id: player.id,
      username: player.id,
      resources: player.resources,
      core:
        player.core === null
          ? null
          : {
              id: player.core.id,
              position: player.core.position,
              hp: player.core.hp ?? 5,
              shield: player.core.shield ?? 5,
              state: player.core.state ?? "NORMAL",
              moveDirection: player.core.moveDirection ?? null,
              moveProgress: player.core.moveProgress ?? null,
              moveRequiredTicks: player.core.moveRequiredTicks ?? null,
              destination: player.core.destination ?? null,
            },
      units: (player.units ?? []).map((unit) => ({
        id: unit.id,
        owner: player.id,
        position: unit.position,
        hp: unit.hp ?? 2,
        unitType: unit.unitType ?? "WORKER",
        cargo: unit.cargo ?? 0,
      })),
    })),
    terrain: { obstacles: terrain.obstacles ?? [], resources: terrain.resources ?? [] },
    beacon: beacon ?? null,
  });
}

function planFor(
  world: SimWorld,
  playerId: string,
  actions: Readonly<Record<string, UnitAction>> = {},
  coreAction: CoreAction | null = null,
): Plan {
  return { tick: world.tick, unitActions: { ...actions }, coreAction, intents: {} };
}

function settle(world: SimWorld, plans: ReadonlyMap<string, Plan>): ReturnType<typeof settleTick> {
  return settleTick(world, plans, ctx);
}

function startMove(direction: Direction): CoreAction {
  return { type: "START_MOVE", direction };
}

function shoot(targetId: string, expectedCell: Position): UnitAction {
  return { type: "SHOOT", targetId, expectedCell };
}

/** 持有 Beacon 的 p1 玩家：盾上限 10（maxShieldWithBeacon），可给 shield 7 以验证失去后的 clamp。 */

/* ---------------- 1. combat ↔ beacon：carrier 死亡 → Beacon 落地 ---------------- */

test("X1: carrier 被 SWEEP 杀死 → Beacon 落地于死亡位置，同 tick 不可拾取，次 tick 可拾取", () => {
  // p1 Worker 携带 Beacon（carrierId=worker）；p2 Vanguard 相邻 SWEEP 击杀；
  // p1 盾 7（持有 Beacon 上限 10）→ 失去 Beacon 后必须 clamp 到 5。
  const world = makeWorld(
    [
      {
        id: "p1",
        resources: 10,
        core: { id: P1_CORE, position: [0, 0], shield: 7 },
        units: [{ id: P1_WORKER, position: [2, 0], hp: 1 }],
      },
      {
        id: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6] },
        units: [
          { id: P2_VANGUARD, position: [3, 0], hp: 4, unitType: "VANGUARD" },
          { id: P2_WORKER_B, position: [3, 1] },
        ],
      },
    ],
    {},
    { position: [2, 0], status: "CARRIED", carrierId: P1_WORKER },
  );

  // tick 1：p2 SWEEP 杀死 carrier；同 tick p2 Worker 尝试 PICKUP → 必须失败
  const tick1 = settle(
    world,
    new Map([
      ["p1", planFor(world, "p1")],
      [
        "p2",
        planFor(world, "p2", {
          [P2_VANGUARD]: { type: "SWEEP", direction: "LEFT" },
          [P2_WORKER_B]: { type: "PICKUP_BEACON" },
        }),
      ],
    ]),
  );
  assert.ok(tick1.events.some((event) => event.eventType === "UNIT_DAMAGED" && event.targetId === P1_WORKER && event.values?.hp === 0));
  // Beacon 落地于 carrier 最终实际位置 [2,0]
  assert.equal(tick1.world.beacon!.status, "GROUND");
  assert.equal(tick1.world.beacon!.carrierId, null);
  assert.deepEqual(tick1.world.beacon!.position, [2, 0]);
  assert.ok(
    tick1.events.some(
      (event) => event.eventType === "BEACON_DROPPED_ON_DEATH" && event.actorId === P1_WORKER && event.position?.[0] === 2 && event.position?.[1] === 0,
    ),
  );
  // 同 tick 无任何拾取成功；失去 Beacon 的盾立即 clamp 5
  assert.ok(!tick1.events.some((event) => event.eventType === "BEACON_PICKED_UP"));
  assert.equal(tick1.world.players.get("p1")!.core!.shield, 5);
  assert.ok(!tick1.events.some((event) => (event.eventType as string) === "CORE_SHIELD_CLAMPED"));

  // tick 2-3：p2 Worker 走到 Beacon 格（[3,1] → [2,1] → [2,0]）
  let tick2 = settle(
    tick1.world,
    new Map([
      ["p1", planFor(tick1.world, "p1")],
      ["p2", planFor(tick1.world, "p2", { [P2_WORKER_B]: { type: "MOVE", direction: "LEFT" } })],
    ]),
  );
  assert.deepEqual(
    tick2.world.players.get("p2")!.units.find((unit) => unit.id === P2_WORKER_B)!.position,
    [2, 1],
  );
  tick2 = settle(
    tick2.world,
    new Map([
      ["p1", planFor(tick2.world, "p1")],
      ["p2", planFor(tick2.world, "p2", { [P2_WORKER_B]: { type: "MOVE", direction: "UP" } })],
    ]),
  );
  assert.deepEqual(
    tick2.world.players.get("p2")!.units.find((unit) => unit.id === P2_WORKER_B)!.position,
    [2, 0],
  );

  // tick 4：次 tick 可正常拾取（死亡落地不残留 drop lock）
  const tick3 = settle(
    tick2.world,
    new Map([
      ["p1", planFor(tick2.world, "p1")],
      ["p2", planFor(tick2.world, "p2", { [P2_WORKER_B]: { type: "PICKUP_BEACON" } })],
    ]),
  );
  assert.equal(tick3.world.beacon!.status, "CARRIED");
  assert.equal(tick3.world.beacon!.carrierId, P2_WORKER_B);
  assert.ok(tick3.events.some((event) => event.eventType === "BEACON_PICKED_UP" && event.actorId === P2_WORKER_B));
});

test("X1b: 本 tick 移动过的 carrier 死亡 → Beacon 落地于移动后的最终实际位置", () => {
  // p1 Worker 从 [2,0] 移动到 [3,0]（P05），随后被 p2 Vanguard SWEEP（P09）击杀；
  // "lands at the carrier's final actual position" = 移动后的位置 [3,0]。
  const world = makeWorld(
    [
      {
        id: "p1",
        resources: 10,
        core: { id: P1_CORE, position: [0, 0] },
        units: [{ id: P1_WORKER, position: [2, 0], hp: 1 }],
      },
      {
        id: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6] },
        units: [{ id: P2_VANGUARD, position: [4, 0], hp: 4, unitType: "VANGUARD" }],
      },
    ],
    {},
    { position: [2, 0], status: "CARRIED", carrierId: P1_WORKER },
  );
  const result = settle(
    world,
    new Map([
      ["p1", planFor(world, "p1", { [P1_WORKER]: { type: "MOVE", direction: "RIGHT" } })],
      ["p2", planFor(world, "p2", { [P2_VANGUARD]: { type: "SWEEP", direction: "LEFT" } })],
    ]),
  );
  assert.ok(result.events.some((event) => event.eventType === "UNIT_MOVE_SUCCEEDED" && event.actorId === P1_WORKER));
  assert.ok(result.events.some((event) => event.eventType === "UNIT_DAMAGED" && event.targetId === P1_WORKER && event.values?.hp === 0));
  assert.equal(result.world.beacon!.status, "GROUND");
  assert.equal(result.world.beacon!.carrierId, null);
  assert.deepEqual(result.world.beacon!.position, [3, 0], "beacon lands at moved (final) position");
  assert.ok(
    result.events.some(
      (event) => event.eventType === "BEACON_DROPPED_ON_DEATH" && event.actorId === P1_WORKER && event.position?.[0] === 3,
    ),
  );
});

test("X1c: 携带者 Unit 移动成功 → Beacon 跟随（§Champion Beacon）", () => {
  // "The Beacon follows a Unit whenever its move succeeds."
  const world = makeWorld(
    [
      {
        id: "p1",
        resources: 10,
        core: { id: P1_CORE, position: [0, 0] },
        units: [{ id: P1_WORKER, position: [2, 0] }],
      },
      { id: "p2", resources: 5, core: { id: P2_CORE, position: [6, 6] } },
    ],
    {},
    { position: [2, 0], status: "CARRIED", carrierId: P1_WORKER },
  );
  const result = settle(
    world,
    new Map([
      ["p1", planFor(world, "p1", { [P1_WORKER]: { type: "MOVE", direction: "RIGHT" } })],
      ["p2", planFor(world, "p2")],
    ]),
  );
  assert.equal(result.world.beacon!.status, "CARRIED");
  assert.equal(result.world.beacon!.carrierId, P1_WORKER);
  assert.deepEqual(result.world.beacon!.position, [3, 0], "beacon follows successful move");
});

/* ---------------- 2. combat ↔ core-migration：MOVING Core 可被攻击 ---------------- */

test("X2: 迁移中的 Core 可被 SHOOT——先盾后 HP，迁移不被战斗打断", () => {
  const world = makeWorld(
    [
      { id: "p1", resources: 5, core: { id: P1_CORE, position: [0, 0] } },
      {
        id: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6] },
        units: [{ id: P2_RANGER, position: [0, 3], hp: 2, unitType: "RANGER" }],
      },
    ],
    { obstacles: [], resources: [] },
    null,
  );
  // tick 1：P06 START_MOVE → MOVING；P09 射击命中（结算顺序 P06 在 P09 之前）
  let result = settle(
    world,
    new Map([
      ["p1", planFor(world, "p1", {}, startMove("RIGHT"))],
      ["p2", planFor(world, "p2", { [P2_RANGER]: shoot(P1_CORE, [0, 0]) })],
    ]),
  );
  assert.ok(result.events.some((event) => event.eventType === "CORE_MOVE_STARTED"));
  assert.ok(result.events.some((event) => event.eventType === "CORE_DAMAGED" && event.targetId === P1_CORE));
  let core = result.world.players.get("p1")!.core!;
  assert.equal(core.state, "MOVING", "core keeps migrating after being shot");
  assert.equal(core.shield, 4, "damage absorbed by shield first");
  assert.equal(core.hp, 5);

  // tick 2：迁移推进 + 再次射击 → 盾继续扣
  result = settle(
    result.world,
    new Map([
      ["p1", planFor(result.world, "p1")],
      ["p2", planFor(result.world, "p2", { [P2_RANGER]: shoot(P1_CORE, [0, 0]) })],
    ]),
  );
  core = result.world.players.get("p1")!.core!;
  assert.equal(core.moveProgress, 2, "migration still advances while under fire");
  assert.equal(core.shield, 3);

  // tick 3：Core 仍在逻辑位置 [0,0]，射击继续命中 → 盾 2
  result = settle(
    result.world,
    new Map([
      ["p1", planFor(result.world, "p1")],
      ["p2", planFor(result.world, "p2", { [P2_RANGER]: shoot(P1_CORE, [0, 0]) })],
    ]),
  );
  core = result.world.players.get("p1")!.core!;
  assert.equal(core.moveProgress, 3);
  assert.equal(core.shield, 2);

  // tick 4：真实移动成功（Core 离开 [0,0]，Ranger 不再在线路上）→ 位置 [1,0]
  result = settle(
    result.world,
    new Map([
      ["p1", planFor(result.world, "p1")],
      ["p2", planFor(result.world, "p2", { [P2_RANGER]: shoot(P1_CORE, [0, 0]) })],
    ]),
  );
  assert.ok(result.events.some((event) => event.eventType === "CORE_MOVE_SUCCEEDED"));
  core = result.world.players.get("p1")!.core!;
  assert.deepEqual(core.position, [1, 0], "migration completes despite combat");
  assert.equal(core.state, "NORMAL");
  assert.equal(core.shield, 2, "3 combat ticks cost exactly 1 shield each");
});

/* ---------------- 3. core-migration ↔ beacon：迁移 Core 携带 Beacon ---------------- */

test("X3: 迁移 Core 携带 Beacon——CANCEL/重启后 4 Tick 完成，Beacon 跟随到新位置", () => {
  const world = makeWorld(
    [
      { id: "p1", resources: 5, core: { id: P1_CORE, position: [0, 0] } },
      {
        id: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6] },
        units: [{ id: P2_WORKER, position: [5, 5] }],
      },
    ],
    {},
    { position: [0, 0], status: "CARRIED", carrierId: P1_CORE },
  );

  // tick 1：START_MOVE → MOVING；迁移期间 Beacon 保持在逻辑位置；他人 PICKUP 失败
  let result = settle(
    world,
    new Map([
      ["p1", planFor(world, "p1", {}, startMove("RIGHT"))],
      ["p2", planFor(world, "p2", { [P2_WORKER]: { type: "PICKUP_BEACON" } })],
    ]),
  );
  assert.deepEqual(result.world.beacon!.position, [0, 0], "beacon stays at logical position while migrating");
  assert.ok(!result.events.some((event) => event.eventType === "BEACON_PICKED_UP"));

  // tick 2：CANCEL_MOVE → NORMAL；Beacon 仍由 Core 持有
  result = settle(
    result.world,
    new Map([
      ["p1", planFor(result.world, "p1", {}, { type: "CANCEL_MOVE" })],
      ["p2", planFor(result.world, "p2")],
    ]),
  );
  assert.equal(result.world.players.get("p1")!.core!.state, "NORMAL");
  assert.equal(result.world.beacon!.status, "CARRIED");
  assert.equal(result.world.beacon!.carrierId, P1_CORE);

  // tick 3：重新 START_MOVE → 再 4 Tick 完成
  result = settle(
    result.world,
    new Map([
      ["p1", planFor(result.world, "p1", {}, startMove("RIGHT"))],
      ["p2", planFor(result.world, "p2")],
    ]),
  );
  assert.equal(result.world.players.get("p1")!.core!.state, "MOVING");
  for (let step = 0; step < 3; step += 1) {
    result = settle(
      result.world,
      new Map([
        ["p1", planFor(result.world, "p1")],
        ["p2", planFor(result.world, "p2")],
      ]),
    );
  }
  assert.ok(result.events.some((event) => event.eventType === "CORE_MOVE_SUCCEEDED"));
  assert.deepEqual(result.world.players.get("p1")!.core!.position, [1, 0]);
  assert.deepEqual(result.world.beacon!.position, [1, 0], "beacon follows after real move succeeds");
  assert.equal(result.world.beacon!.status, "CARRIED");
  assert.equal(result.world.beacon!.carrierId, P1_CORE);
});

/* ---------------- 4. combat 摧毁 Core → 同 Tick respawn ---------------- */

test("X4: combat 摧毁 Core → CORE_DESTROYED/cargo 掉落 + P12 同 Tick respawn", () => {
  const world = makeWorld(
    [
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
        units: [{ id: P2_RANGER, position: [0, 3], hp: 2, unitType: "RANGER" }],
      },
    ],
    {},
    null,
  );
  const result = settle(
    world,
    new Map([
      ["p1", planFor(world, "p1")],
      ["p2", planFor(world, "p2", { [P2_RANGER]: shoot(P1_CORE, [0, 0]) })],
    ]),
  );
  // 事件与掉落正确
  const destroyed = result.events.find((event) => event.eventType === "CORE_DESTROYED");
  assert.ok(destroyed, "CORE_DESTROYED missing");
  assert.equal(destroyed!.targetId, P1_CORE);
  assert.deepEqual(destroyed!.position, [0, 0]);
  assert.deepEqual(destroyed!.values, { destroyed_by: ["p2"] });
  const p1 = result.world.players.get("p1")!;
  // respawn 已实现：P12 同 tick 放置 replacement → ACTIVE
  assert.equal(p1.status, "ACTIVE");
  assert.ok(p1.core !== null, "replacement core placed same tick");
  assert.equal(p1.core.hp, 5);
  assert.equal(p1.resources, 5);
  assert.equal(p1.units.length, 1, "replacement worker");
  assert.equal(result.world.terrain.piles.get("0,1")?.amount, 2, "worker cargo dropped in place");
  assert.equal(result.world.players.get("p2")!.resources, 10, "capture respects post-combat capacity");
  assert.deepEqual(
    result.events.find((event) => event.eventType === "CORE_RESOURCES_CAPTURED")?.values,
    { amount: 5, available: 10, destroyed: 5, capacity: 10 },
  );
  // respawn 已实现 → 不再 fail-closed unsupported
  assert.ok(!result.unsupported.includes("respawn"), "respawn resolver handles destruction");
  assert.ok(result.events.some((event) => event.eventType === "CORE_RESPAWNED"));
});

/* ---------------- 5. beacon ↔ economy：同 tick harvest 加成 + combat 互不干扰 ---------------- */

test("X5: 持有 Beacon 的 harvest 加成与同 tick combat 伤害互不干扰", () => {
  const world = makeWorld(
    [
      {
        id: "p1",
        resources: 10,
        core: { id: P1_CORE, position: [0, 0] },
        units: [
          { id: P1_WORKER, position: [2, 2] },
          { id: P1_VANGUARD, position: [3, 0], hp: 4, unitType: "VANGUARD" },
        ],
      },
      {
        id: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6] },
        units: [{ id: P2_VANGUARD, position: [4, 0], hp: 4, unitType: "VANGUARD" }],
      },
    ],
    { resources: [[2, 2]] },
    { position: [2, 2], status: "CARRIED", carrierId: P1_WORKER },
  );
  const result = settle(
    world,
    new Map([
      [
        "p1",
        planFor(world, "p1", {
          [P1_WORKER]: { type: "HARVEST" },
          [P1_VANGUARD]: { type: "SWEEP", direction: "RIGHT" },
        }),
      ],
      ["p2", planFor(world, "p2")],
    ]),
  );
  // harvest 加成（持有 Beacon → 2）照常生效
  const worker = result.world.players.get("p1")!.units.find((unit) => unit.id === P1_WORKER)!;
  assert.equal(worker.cargo, 2, "beacon holder harvests 2");
  const harvest = result.events.find((event) => event.eventType === "HARVEST_SUCCEEDED");
  assert.equal(harvest!.values?.amount, 2);
  // combat 同 tick 照常结算
  const vanguard = result.world.players.get("p2")!.units.find((unit) => unit.id === P2_VANGUARD)!;
  assert.equal(vanguard.hp, 3, "combat damage applied in same tick");
  assert.ok(result.events.some((event) => event.eventType === "UNIT_DAMAGED" && event.targetId === P2_VANGUARD));
  // Beacon 未被干扰
  assert.equal(result.world.beacon!.status, "CARRIED");
  assert.equal(result.world.beacon!.carrierId, P1_WORKER);
  assert.deepEqual(result.unsupported, []);
});

/* ---------------- 6. 三域组合：攻击携带 Beacon 的迁移 Core ---------------- */

test("X6: 摧毁携带 Beacon 的迁移 Core → Beacon 落地于 Core 最终实际位置（迁移逻辑位置）", () => {
  // 变体 A：迁移中段（progress 2/4）被摧毁——Core 从未真实移动，
  // 最终实际位置 = 逻辑位置 [0,0]，Beacon 落地于此。
  const midMigration = makeWorld(
    [
      {
        id: "p1",
        resources: 10,
        core: {
          id: P1_CORE,
          position: [0, 0],
          hp: 1,
          shield: 0,
          state: "MOVING",
          moveDirection: "RIGHT",
          moveProgress: 2,
          moveRequiredTicks: 4,
          destination: [1, 0],
        },
        units: [{ id: P1_WORKER, position: [0, 1], cargo: 2 }],
      },
      {
        id: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6] },
        units: [{ id: P2_RANGER, position: [0, 3], hp: 2, unitType: "RANGER" }],
      },
    ],
    {},
    { position: [0, 0], status: "CARRIED", carrierId: P1_CORE },
  );
  const mid = settle(
    midMigration,
    new Map([
      ["p1", planFor(midMigration, "p1")],
      ["p2", planFor(midMigration, "p2", { [P2_RANGER]: shoot(P1_CORE, [0, 0]) })],
    ]),
  );
  assert.ok(mid.events.some((event) => event.eventType === "CORE_MOVE_PROGRESS"));
  assert.ok(mid.events.some((event) => event.eventType === "CORE_DESTROYED" && event.targetId === P1_CORE));
  assert.equal(mid.world.beacon!.status, "GROUND");
  assert.equal(mid.world.beacon!.carrierId, null);
  assert.deepEqual(mid.world.beacon!.position, [0, 0], "beacon lands at migrating core's logical position");
  assert.ok(
    mid.events.some(
      (event) => event.eventType === "BEACON_DROPPED_ON_DEATH" && event.actorId === P1_CORE && event.position?.[0] === 0,
    ),
  );
  assert.equal(mid.world.players.get("p1")!.status, "ACTIVE", "respawn resolver places replacement same tick");

  // 变体 B：第 4 Tick 真实移动先成功（P06，Beacon 跟随到 [1,0]），随后被摧毁（P09）
  // → Beacon 落地于 Core 的新位置 [1,0]（"final actual position"）。
  const fourthTick = makeWorld(
    [
      {
        id: "p1",
        resources: 10,
        core: {
          id: P1_CORE,
          position: [0, 0],
          hp: 1,
          shield: 0,
          state: "MOVING",
          moveDirection: "RIGHT",
          moveProgress: 3,
          moveRequiredTicks: 4,
          destination: [1, 0],
        },
      },
      {
        id: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6] },
        units: [{ id: P2_RANGER, position: [1, 3], hp: 2, unitType: "RANGER" }],
      },
    ],
    {},
    { position: [0, 0], status: "CARRIED", carrierId: P1_CORE },
  );
  const fourth = settle(
    fourthTick,
    new Map([
      ["p1", planFor(fourthTick, "p1")],
      ["p2", planFor(fourthTick, "p2", { [P2_RANGER]: shoot(P1_CORE, [1, 0]) })],
    ]),
  );
  assert.ok(fourth.events.some((event) => event.eventType === "CORE_MOVE_SUCCEEDED"));
  const destroyed = fourth.events.find((event) => event.eventType === "CORE_DESTROYED");
  assert.deepEqual(destroyed!.position, [1, 0], "core destroyed at post-migration position");
  assert.equal(fourth.world.beacon!.status, "GROUND");
  assert.deepEqual(fourth.world.beacon!.position, [1, 0], "beacon lands at core's final actual position");
});

/* ---------------- 结算顺序：集成测试依赖的 phase 顺序快照 ---------------- */

test("X0: 结算顺序 P05 global movement → P06 core-migration actions → P07 beacon → P08 harvest → P09 combat → P13 respawn", () => {
  const order = phaseOrder();
  const indexOf = (id: string): number => order.findIndex((phaseId) => phaseId === id);
  assert.ok(indexOf("P05-global-movement") >= 0);
  assert.ok(indexOf("P06-core-migration-actions") > indexOf("P05-global-movement"));
  assert.ok(indexOf("P07-beacon") > indexOf("P06-core-migration-actions"));
  assert.ok(indexOf("P08-harvest-and-deposit") > indexOf("P07-beacon"));
  assert.ok(indexOf("P09-combat") > indexOf("P08-harvest-and-deposit"));
  assert.ok(indexOf("P13-respawn") > indexOf("P09-combat"));
});
