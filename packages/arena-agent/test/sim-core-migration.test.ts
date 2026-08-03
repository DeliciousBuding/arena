/**
 * P06 core-migration resolver 测试：START_MOVE / CANCEL_MOVE / 4-Tick 推进 /
 * 第 4 Tick 真实移动（成功/失败/contested/swap）/ 迁移期间互斥 / 纯函数。
 *
 * 事件与 reason codes 对齐 api-resolution-results.md Movement events；
 * 时序对齐 game-rules.md Authoritative resolution order 5-6。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreAction, Plan, Position, UnitAction, UnitType } from "../src/domain/model.ts";
import { loadRulesManifest } from "../src/sim/contracts/rules-manifest.ts";
import { idlePlans, settleTick, type SettlementContext } from "../src/sim/engine/settlement.ts";
import { worldHash } from "../src/sim/world/canonical.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";
import type { SimWorld } from "../src/sim/world/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.11.json");

const rules = loadRulesManifest(MANIFEST_PATH);
const ctx: SettlementContext = { rules, rng: null };

const P1_CORE = "11111111-1111-1111-1111-111111111111";
const P2_CORE = "22222222-2222-2222-2222-222222222222";

/** 固定序号 UUID（raw 序 = 数字序）。 */
const uuid = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

interface CoreSpec {
  readonly id: string;
  readonly position: Position;
  readonly hp?: number;
  readonly shield?: number;
  readonly state?: "NORMAL" | "MOVING";
  readonly moveDirection?: "UP" | "DOWN" | "LEFT" | "RIGHT" | null;
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
  readonly username?: string;
  readonly resources: number;
  readonly core: CoreSpec | null;
  readonly units?: readonly UnitSpec[];
}

function makeWorld(
  players: readonly PlayerSpec[],
  terrain?: { obstacles?: readonly Position[]; resources?: readonly Position[] },
  beacon?: { position: Position; status?: "GROUND" | "CARRIED"; carrierId?: string | null },
): SimWorld {
  return worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    players: players.map((p) => ({
      id: p.id,
      username: p.username ?? p.id,
      resources: p.resources,
      core:
        p.core === null
          ? null
          : {
              id: p.core.id,
              position: p.core.position,
              hp: p.core.hp ?? 5,
              shield: p.core.shield ?? 5,
              state: p.core.state ?? "NORMAL",
              moveDirection: p.core.moveDirection ?? null,
              moveProgress: p.core.moveProgress ?? null,
              moveRequiredTicks: p.core.moveRequiredTicks ?? null,
              destination: p.core.destination ?? null,
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

function startMove(direction: "UP" | "DOWN" | "LEFT" | "RIGHT"): CoreAction {
  return { type: "START_MOVE", direction };
}

/* ---------------- START_MOVE / CANCEL_MOVE ---------------- */

test("P06: START_MOVE 成功——NORMAL → MOVING，CORE_MOVE_STARTED（progress 1/4）", () => {
  const world = makeWorld([{ id: "p1", resources: 5, core: { id: P1_CORE, position: [0, 0] } }]);
  const result = settle(world, new Map([["p1", planFor(world, "p1", {}, startMove("RIGHT"))]]));
  const core = result.world.players.get("p1")!.core!;
  assert.equal(core.state, "MOVING");
  assert.equal(core.moveDirection, "RIGHT");
  assert.equal(core.moveProgress, 1);
  assert.equal(core.moveRequiredTicks, 4);
  assert.deepEqual(core.destination, [1, 0]);
  assert.deepEqual(core.position, [0, 0], "logical position unchanged while moving");
  const started = result.events.find((event) => event.eventType === "CORE_MOVE_STARTED");
  assert.ok(started, "CORE_MOVE_STARTED missing");
  assert.deepEqual(started!.values, { destination: [1, 0], progress: 1, required: 4 });
  assert.deepEqual(started!.position, [0, 0]);
  assert.deepEqual(result.unsupported, []);
});

test("P06: CANCEL_MOVE 成功——MOVING → NORMAL，进度清零，可重新 START_MOVE", () => {
  let world = makeWorld([{ id: "p1", resources: 5, core: { id: P1_CORE, position: [0, 0] } }]);
  world = settle(world, new Map([["p1", planFor(world, "p1", {}, startMove("RIGHT"))]])).world;
  const result = settle(world, new Map([["p1", planFor(world, "p1", {}, { type: "CANCEL_MOVE" })]]));
  assert.ok(result.events.some((event) => event.eventType === "CORE_MOVE_CANCELLED"));
  const core = result.world.players.get("p1")!.core!;
  assert.equal(core.state, "NORMAL");
  assert.equal(core.moveDirection, null);
  assert.equal(core.moveProgress, null);
  assert.equal(core.moveRequiredTicks, null);
  assert.equal(core.destination, null);
  assert.deepEqual(core.position, [0, 0], "position unchanged by cancel");

  const again = settle(result.world, new Map([["p1", planFor(result.world, "p1", {}, startMove("DOWN"))]]));
  assert.equal(again.world.players.get("p1")!.core!.state, "MOVING");
  assert.deepEqual(again.world.players.get("p1")!.core!.destination, [0, 1]);
});

test("P06: START_MOVE 失败——已 MOVING → CORE_ACTION_FAILED/CORE_ALREADY_MOVING，原迁移继续推进", () => {
  const world = makeWorld([
    {
      id: "p1",
      resources: 5,
      core: {
        id: P1_CORE,
        position: [0, 0],
        state: "MOVING",
        moveDirection: "RIGHT",
        moveProgress: 2,
        moveRequiredTicks: 4,
        destination: [1, 0],
      },
    },
  ]);
  const result = settle(world, new Map([["p1", planFor(world, "p1", {}, startMove("DOWN"))]]));
  const failed = result.events.find((event) => event.eventType === "CORE_ACTION_FAILED");
  assert.ok(failed, "CORE_ACTION_FAILED missing");
  assert.equal(failed!.reasonCode, "CORE_ALREADY_MOVING");
  const core = result.world.players.get("p1")!.core!;
  assert.equal(core.state, "MOVING");
  assert.equal(core.moveDirection, "RIGHT", "original migration untouched");
  assert.equal(core.moveProgress, 3, "in-progress migration still advances this tick");
});

test("P06: CANCEL_MOVE 失败——NORMAL → CORE_ACTION_FAILED/CORE_NOT_MOVING", () => {
  const world = makeWorld([{ id: "p1", resources: 5, core: { id: P1_CORE, position: [0, 0] } }]);
  const result = settle(world, new Map([["p1", planFor(world, "p1", {}, { type: "CANCEL_MOVE" })]]));
  const failed = result.events.find((event) => event.eventType === "CORE_ACTION_FAILED");
  assert.ok(failed, "CORE_ACTION_FAILED missing");
  assert.equal(failed!.reasonCode, "CORE_NOT_MOVING");
  assert.equal(result.world.players.get("p1")!.core!.state, "NORMAL");
});

/* ---------------- START_MOVE 合法性 ---------------- */

test("P06: START_MOVE 失败——目标格障碍/资源格 → CORE_MOVE_START_FAILED/CORE_DESTINATION_TERRAIN_BLOCKED", () => {
  const blocked = makeWorld(
    [{ id: "p1", resources: 5, core: { id: P1_CORE, position: [0, 0] } }],
    { obstacles: [[1, 0]] },
  );
  const r1 = settle(blocked, new Map([["p1", planFor(blocked, "p1", {}, startMove("RIGHT"))]]));
  const failed1 = r1.events.find((event) => event.eventType === "CORE_MOVE_START_FAILED");
  assert.ok(failed1, "CORE_MOVE_START_FAILED missing for obstacle");
  assert.equal(failed1!.reasonCode, "CORE_DESTINATION_TERRAIN_BLOCKED");
  assert.equal(r1.world.players.get("p1")!.core!.state, "NORMAL", "failed start leaves NORMAL");

  // 地形表：Core 不可迁入 RESOURCE 格（game-rules.md Terrain kinds）
  const resource = makeWorld(
    [{ id: "p1", resources: 5, core: { id: P1_CORE, position: [0, 0] } }],
    { resources: [[1, 0]] },
  );
  const r2 = settle(resource, new Map([["p1", planFor(resource, "p1", {}, startMove("RIGHT"))]]));
  const failed2 = r2.events.find((event) => event.eventType === "CORE_MOVE_START_FAILED");
  assert.ok(failed2, "CORE_MOVE_START_FAILED missing for resource cell");
  assert.equal(failed2!.reasonCode, "CORE_DESTINATION_TERRAIN_BLOCKED");
});

test("P06: START_MOVE 目标格敌方单位 → CORE_DESTINATION_OCCUPIED；己方单位不阻挡（容量内）", () => {
  const enemy = makeWorld([
    { id: "p1", resources: 5, core: { id: P1_CORE, position: [0, 0] } },
    {
      id: "p2",
      resources: 5,
      core: { id: P2_CORE, position: [10, 10] },
      units: [{ id: uuid(2), position: [1, 0] }],
    },
  ]);
  const r1 = settle(enemy, new Map([["p1", planFor(enemy, "p1", {}, startMove("RIGHT"))]]));
  const failed = r1.events.find((event) => event.eventType === "CORE_MOVE_START_FAILED");
  assert.ok(failed, "CORE_MOVE_START_FAILED missing for enemy occupant");
  assert.equal(failed!.reasonCode, "CORE_DESTINATION_OCCUPIED");
  assert.equal(r1.world.players.get("p1")!.core!.state, "NORMAL");

  const friendly = makeWorld([
    {
      id: "p1",
      resources: 5,
      core: { id: P1_CORE, position: [0, 0] },
      units: [{ id: uuid(1), position: [1, 0] }],
    },
  ]);
  const r2 = settle(friendly, new Map([["p1", planFor(friendly, "p1", {}, startMove("RIGHT"))]]));
  assert.equal(r2.world.players.get("p1")!.core!.state, "MOVING", "friendly unit at dest allowed");
});

test("P06: START_MOVE 失败——己方单位占满目的地 → CELL_UNIT_LIMIT", () => {
  const world = makeWorld([
    {
      id: "p1",
      resources: 5,
      core: { id: P1_CORE, position: [0, 0] },
      units: [
        { id: uuid(1), position: [1, 0] },
        { id: uuid(2), position: [1, 0] },
      ],
    },
  ]);
  const result = settle(world, new Map([["p1", planFor(world, "p1", {}, startMove("RIGHT"))]]));
  const failed = result.events.find((event) => event.eventType === "CORE_MOVE_START_FAILED");
  assert.ok(failed, "CORE_MOVE_START_FAILED missing for capacity");
  assert.equal(failed!.reasonCode, "CELL_UNIT_LIMIT");
});

/* ---------------- 4-Tick 推进与真实移动 ---------------- */

test("P06: 迁移 4 Tick 完成——事件序列、位置更新、状态回 NORMAL、hp/shield 不变", () => {
  let world = makeWorld([{ id: "p1", resources: 5, core: { id: P1_CORE, position: [0, 0] } }]);
  const tickEvents: string[][] = [];

  // tick 1: START_MOVE → progress 1/4
  let result = settle(world, new Map([["p1", planFor(world, "p1", {}, startMove("RIGHT"))]]));
  tickEvents.push(result.events.map((event) => event.eventType));
  world = result.world;

  // tick 2-3: WAIT 不停迁移（progress 2/4, 3/4）
  for (let step = 0; step < 2; step += 1) {
    result = settle(world, new Map([["p1", planFor(world, "p1", {}, null)]]));
    tickEvents.push(result.events.map((event) => event.eventType));
    world = result.world;
  }
  assert.equal(world.players.get("p1")!.core!.moveProgress, 3);

  // tick 4: 真实移动成功 + 本 tick 新 START_MOVE（"checked after real movement resolves"）
  result = settle(world, new Map([["p1", planFor(world, "p1", {}, startMove("RIGHT"))]]));
  tickEvents.push(result.events.map((event) => event.eventType));
  world = result.world;

  assert.deepEqual(tickEvents, [
    ["CORE_MOVE_STARTED"],
    ["CORE_MOVE_PROGRESS"],
    ["CORE_MOVE_PROGRESS"],
    ["CORE_MOVE_SUCCEEDED", "CORE_MOVE_STARTED"],
  ]);
  const core = world.players.get("p1")!.core!;
  assert.deepEqual(core.position, [1, 0], "real move applied on 4th tick");
  assert.equal(core.state, "MOVING", "new START_MOVE began after completion");
  assert.deepEqual(core.destination, [2, 0]);
  assert.equal(core.moveProgress, 1);
  assert.equal(core.hp, 5, "hp unchanged by migration");
  assert.equal(core.shield, 5, "shield unchanged by migration");
  assert.deepEqual(result.unsupported, []);
});

test("P06: 第 4 Tick 真实移动失败——目标格障碍 → CORE_MOVE_FAILED，Core 留原地回 NORMAL", () => {
  const world = makeWorld(
    [
      {
        id: "p1",
        resources: 5,
        core: {
          id: P1_CORE,
          position: [0, 0],
          state: "MOVING",
          moveDirection: "RIGHT",
          moveProgress: 3,
          moveRequiredTicks: 4,
          destination: [1, 0],
        },
      },
    ],
    { obstacles: [[1, 0]] },
  );
  const result = settle(world, new Map([["p1", planFor(world, "p1", {}, null)]]));
  const failed = result.events.find((event) => event.eventType === "CORE_MOVE_FAILED");
  assert.ok(failed, "CORE_MOVE_FAILED missing");
  assert.equal(failed!.reasonCode, "CORE_DESTINATION_TERRAIN_BLOCKED");
  assert.deepEqual(failed!.position, [0, 0], "failure reports unchanged origin");
  const core = result.world.players.get("p1")!.core!;
  assert.deepEqual(core.position, [0, 0], "core stays in place");
  assert.equal(core.state, "NORMAL", "failed attempt returns to NORMAL");
  assert.equal(core.moveDirection, null, "migration progress cleared");
});

test("P06: 第 4 Tick 跨玩家同目的地 → 双方 CORE_MOVE_FAILED/MOVE_CONTESTED", () => {
  const world = makeWorld([
    {
      id: "p1",
      resources: 5,
      core: { id: P1_CORE, position: [0, 0], state: "MOVING", moveDirection: "RIGHT", moveProgress: 3, moveRequiredTicks: 4, destination: [1, 0] },
    },
    {
      id: "p2",
      resources: 5,
      core: { id: P2_CORE, position: [2, 0], state: "MOVING", moveDirection: "LEFT", moveProgress: 3, moveRequiredTicks: 4, destination: [1, 0] },
    },
  ]);
  const result = settle(world, new Map([["p1", planFor(world, "p1", {}, null)]]));
  const failures = result.events.filter((event) => event.eventType === "CORE_MOVE_FAILED");
  assert.equal(failures.length, 2, "both competing cores fail");
  for (const failure of failures) {
    assert.equal(failure.reasonCode, "MOVE_CONTESTED");
  }
  assert.deepEqual(result.world.players.get("p1")!.core!.position, [0, 0]);
  assert.deepEqual(result.world.players.get("p2")!.core!.position, [2, 0]);
  assert.equal(result.world.players.get("p1")!.core!.state, "NORMAL");
});


test("P05/P06: Unit 与第 4 Tick Core 同抢目的地 → 双方 MOVE_CONTESTED", () => {
  const p2Worker = uuid(70);
  const world = makeWorld([
    {
      id: "p1",
      resources: 5,
      core: { id: P1_CORE, position: [0, 0], state: "MOVING", moveDirection: "RIGHT", moveProgress: 3, moveRequiredTicks: 4, destination: [1, 0] },
    },
    {
      id: "p2",
      resources: 5,
      core: { id: P2_CORE, position: [5, 5] },
      units: [{ id: p2Worker, position: [2, 0] }],
    },
  ]);
  const result = settle(world, new Map([
    ["p1", planFor(world, "p1", {}, null)],
    ["p2", planFor(world, "p2", { [p2Worker]: { type: "MOVE", direction: "LEFT" } }, null)],
  ]));
  assert.deepEqual(result.world.players.get("p1")!.core!.position, [0, 0]);
  assert.deepEqual(result.world.players.get("p2")!.units[0].position, [2, 0]);
  assert.ok(result.events.some(
    (event) => event.eventType === "CORE_MOVE_FAILED" &&
      event.actorId === P1_CORE &&
      event.reasonCode === "MOVE_CONTESTED",
  ));
  assert.ok(result.events.some(
    (event) => event.eventType === "UNIT_MOVE_FAILED" &&
      event.actorId === p2Worker &&
      event.reasonCode === "MOVE_CONTESTED",
  ));
});

test("P05/P06: Unit 可进入第 4 Tick Core 成功离开的原格", () => {
  const p2Worker = uuid(71);
  const world = makeWorld([
    {
      id: "p1",
      resources: 5,
      core: { id: P1_CORE, position: [1, 0], state: "MOVING", moveDirection: "RIGHT", moveProgress: 3, moveRequiredTicks: 4, destination: [2, 0] },
    },
    {
      id: "p2",
      resources: 5,
      core: { id: P2_CORE, position: [5, 5] },
      units: [{ id: p2Worker, position: [0, 0] }],
    },
  ]);
  const result = settle(world, new Map([
    ["p1", planFor(world, "p1", {}, null)],
    ["p2", planFor(world, "p2", { [p2Worker]: { type: "MOVE", direction: "RIGHT" } }, null)],
  ]));
  assert.deepEqual(result.world.players.get("p1")!.core!.position, [2, 0]);
  assert.deepEqual(result.world.players.get("p2")!.units[0].position, [1, 0]);
  assert.ok(result.events.some((event) => event.eventType === "CORE_MOVE_SUCCEEDED" && event.actorId === P1_CORE));
  assert.ok(result.events.some((event) => event.eventType === "UNIT_MOVE_SUCCEEDED" && event.actorId === p2Worker));
});

test("P06: 第 4 Tick 双向 swap → 双方 CORE_MOVE_FAILED/MOVE_SWAP_BLOCKED", () => {
  const world = makeWorld([
    {
      id: "p1",
      resources: 5,
      core: { id: P1_CORE, position: [0, 0], state: "MOVING", moveDirection: "RIGHT", moveProgress: 3, moveRequiredTicks: 4, destination: [1, 0] },
    },
    {
      id: "p2",
      resources: 5,
      core: { id: P2_CORE, position: [1, 0], state: "MOVING", moveDirection: "LEFT", moveProgress: 3, moveRequiredTicks: 4, destination: [0, 0] },
    },
  ]);
  const result = settle(world, new Map([["p1", planFor(world, "p1", {}, null)]]));
  const failures = result.events.filter((event) => event.eventType === "CORE_MOVE_FAILED");
  assert.equal(failures.length, 2, "swap never succeeds");
  for (const failure of failures) {
    assert.equal(failure.reasonCode, "MOVE_SWAP_BLOCKED");
  }
});

/* ---------------- 迁移期间互斥 ---------------- */

test("P06: 迁移中不能 spawn——CORE_ACTION_FAILED/CORE_ALREADY_MOVING，资源不消耗", () => {
  const world = makeWorld([
    {
      id: "p1",
      resources: 10,
      core: { id: P1_CORE, position: [0, 0], state: "MOVING", moveDirection: "RIGHT", moveProgress: 1, moveRequiredTicks: 4, destination: [1, 0] },
    },
  ]);
  const result = settle(world, new Map([["p1", planFor(world, "p1", {}, { type: "SPAWN", unitType: "WORKER" })]]));
  const failed = result.events.find((event) => event.eventType === "CORE_ACTION_FAILED");
  assert.ok(failed, "CORE_ACTION_FAILED missing");
  assert.equal(failed!.reasonCode, "CORE_ALREADY_MOVING");
  const player = result.world.players.get("p1")!;
  assert.equal(player.resources, 10, "no spawn cost while moving");
  assert.equal(player.units.length, 0, "no unit spawned while moving");
});

test("P06: 迁移中 Worker deposit 被拒（CORE_MOVING）", () => {
  const worker = uuid(1);
  const world = makeWorld([
    {
      id: "p1",
      resources: 5,
      core: { id: P1_CORE, position: [0, 0], state: "MOVING", moveDirection: "RIGHT", moveProgress: 1, moveRequiredTicks: 4, destination: [1, 0] },
      units: [{ id: worker, position: [0, 0], cargo: 1 }],
    },
  ]);
  const result = settle(world, new Map([["p1", planFor(world, "p1", { [worker]: { type: "DEPOSIT" } }, null)]]));
  const failed = result.events.find((event) => event.eventType === "DEPOSIT_FAILED");
  assert.ok(failed, "DEPOSIT_FAILED missing");
  assert.equal(failed!.reasonCode, "CORE_MOVING");
});

/* ---------------- 外部快照（裸 MOVING）与纯函数 ---------------- */

test("P06: 裸 MOVING（无迁移字段）不推进并标记 unsupported", () => {
  const world = makeWorld([{ id: "p1", resources: 5, core: { id: P1_CORE, position: [0, 0], state: "MOVING" } }]);
  const result = settle(world, new Map([["p1", planFor(world, "p1", {}, null)]]));
  assert.ok(result.unsupported.includes("core-migration"));
  const core = result.world.players.get("p1")!.core!;
  assert.equal(core.state, "MOVING", "bare MOVING not advanced");
  assert.equal(core.moveProgress, null);
  assert.deepEqual(result.events, []);
});

test("P06: settleTick 不修改原 world（纯函数）", () => {
  const world = makeWorld([{ id: "p1", resources: 5, core: { id: P1_CORE, position: [0, 0] } }]);
  const before = worldHash(world);
  settle(world, new Map([["p1", planFor(world, "p1", {}, startMove("RIGHT"))]]));
  assert.equal(worldHash(world), before, "original world untouched");
});

test("P06: 携带 Beacon 的 Core 迁移期间 Beacon 保持逻辑位置，完成后跟随", () => {
  let world = makeWorld(
    [{ id: "p1", resources: 5, core: { id: P1_CORE, position: [0, 0] } }],
    {},
    { position: [0, 0], status: "CARRIED", carrierId: P1_CORE },
  );
  world = settle(world, new Map([["p1", planFor(world, "p1", {}, startMove("RIGHT"))]])).world;
  assert.deepEqual(world.beacon!.position, [0, 0], "beacon stays at logical position while moving");
  for (let step = 0; step < 3; step += 1) {
    world = settle(world, new Map([["p1", planFor(world, "p1", {}, null)]])).world;
  }
  assert.deepEqual(world.beacon!.position, [1, 0], "beacon follows after real move");
});

/* ---------------- idle 计划与迁移推进 ---------------- */

test("P06: idlePlans 不打断迁移（WAIT 语义）", () => {
  let world = makeWorld([{ id: "p1", resources: 5, core: { id: P1_CORE, position: [0, 0] } }]);
  world = settle(world, new Map([["p1", planFor(world, "p1", {}, startMove("RIGHT"))]])).world;
  world = settle(world, idlePlans(world)).world;
  const core = world.players.get("p1")!.core!;
  assert.equal(core.state, "MOVING");
  assert.equal(core.moveProgress, 2, "idle tick advances migration");
  assert.deepEqual(core.position, [0, 0]);
});
