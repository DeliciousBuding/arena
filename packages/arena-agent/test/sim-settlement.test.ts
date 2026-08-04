/**
 * S3 settlement pipeline 合同测试：
 * phase 顺序、atomicity（原 world 不变）、unsupported 分类、unknown 语义、
 * no-op tick、事件稳定排序。
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Plan } from "../src/domain/model.ts";
import { loadRulesManifest } from "../src/sim/contracts/rules-manifest.ts";
import { idlePlans, phaseOrder, settleTick, SettlementError } from "../src/sim/engine/settlement.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";
import { worldHash } from "../src/sim/world/canonical.ts";
import type { SimWorld } from "../src/sim/world/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = join(here, "..", "src", "sim", "contracts");
const MANIFEST_PATH = join(CONTRACT_DIR, "rules-v0.11.json");

const rules = loadRulesManifest(MANIFEST_PATH);
const ctx = { rules, rng: null };

const SCENARIO = {
  rulesVersion: "v0.11",
  tick: 1,
  seed: 7,
  players: [
    {
      id: "p1",
      username: "p1",
      resources: 5,
      core: {
        id: "11111111-1111-1111-1111-111111111111",
        position: [0, 0],
        hp: 5,
        shield: 5,
        state: "NORMAL",
      },
      units: [
        {
          id: "22222222-2222-2222-2222-222222222222",
          owner: "p1",
          position: [1, 0],
          hp: 2,
          unitType: "WORKER",
          cargo: 0,
        },
      ],
    },
  ],
  terrain: { obstacles: [[2, 2]], resources: [[3, 0]] },
  beacon: { position: [0, 0] },
};

function makeWorld(): SimWorld {
  return worldFromScenario(SCENARIO);
}

test("S3: 15 个内部 phase 按固定顺序运行", () => {
  const order = phaseOrder();
  assert.equal(order.length, 15);
  assert.deepEqual(order.slice(0, 4), ["P01-lock-final-plans", "P02-self-destruct", "P03-capacity-shrink-after-removal", "P04-upkeep-and-deficit"]);
  assert.deepEqual(order.slice(-2), ["P14-invariant-check-and-commit", "P15-next-observation"]);
});

test("S3: no-op tick——世界推进且原 world 不被修改", () => {
  const world = makeWorld();
  const beforeHash = worldHash(world);
  const result = settleTick(world, idlePlans(world), ctx);
  assert.equal(result.world.tick, world.tick + 1);
  assert.equal(result.world.resolvedTickCount, 1);
  // 原 world 未被修改（hash 不变）
  assert.equal(worldHash(world), beforeHash);
  // 世界内容不变（tick 外字段）
  assert.equal(result.world.players.get("p1")!.resources, 5);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.unsupported, []);
});

test("S3: 空 plans 拒绝", () => {
  const world = makeWorld();
  assert.throws(() => settleTick(world, new Map(), ctx), SettlementError);
});

test("S3: combat 已实现——SHOOT/SWEEP 不再触发 unsupported", () => {
  const world = makeWorld();
  const plans = idlePlans(world);
  const unit = world.players.get("p1")!.units[0];
  const combatPlan: Plan = {
    tick: world.tick,
    unitActions: { [unit.id]: { type: "SHOOT", targetId: "00000000-0000-0000-0000-000000000000", expectedCell: [1, 1] } },
    coreAction: null,
    intents: {},
  };
  const result = settleTick(world, new Map([["p1", combatPlan]]), ctx);
  assert.deepEqual(result.unsupported, []);
  // feature 不再被标记为 unsupported
  assert.ok(!result.world.unsupportedFeatures.includes("combat"));
});

test("S3: core-migration 与 beacon 均已实现，不再触发 unsupported", () => {
  const world = makeWorld();
  const migratePlan: Plan = {
    tick: world.tick,
    unitActions: {},
    coreAction: { type: "START_MOVE", direction: "RIGHT" },
    intents: {},
  };
  const r1 = settleTick(world, new Map([["p1", migratePlan]]), ctx);
  assert.deepEqual(r1.unsupported, []);
  assert.equal(r1.world.players.get("p1")!.core!.state, "MOVING");
  assert.ok(r1.events.some((event) => event.eventType === "CORE_MOVE_STARTED"));

  // beacon 已实现：DROP_BEACON 不再触发 unsupported
  const beaconPlan: Plan = {
    tick: world.tick,
    unitActions: {},
    coreAction: { type: "DROP_BEACON" },
    intents: {},
  };
  const r2 = settleTick(world, new Map([["p1", beaconPlan]]), ctx);
  assert.deepEqual(r2.unsupported, []);
});

test("S3: refill cadence 记录 unknown 效应，不伪装成 MATCH", () => {
  const world = makeWorld();
  let result = settleTick(world, idlePlans(world), ctx);
  // resolvedTickCount 1..4：第 4 个 resolved tick 触发 refill unknown
  for (let i = 0; i < 2; i += 1) {
    result = settleTick(result.world, idlePlans(result.world), ctx);
  }
  assert.equal(result.unknownEffects.length, 0, "refill not yet at cadence");
  result = settleTick(result.world, idlePlans(result.world), ctx);
  assert.equal(result.unknownEffects.length, 1);
  assert.equal(result.unknownEffects[0].kind, "refill");
});

test("S3: phase 内事件排序稳定（actorId 序，与对象插入顺序无关）", () => {
  const low = "22222222-2222-2222-2222-222222222222";
  const high = "33333333-3333-3333-3333-333333333333";
  const makeOrderedWorld = (reverse: boolean): SimWorld => worldFromScenario({
    ...SCENARIO,
    players: [{
      ...SCENARIO.players[0],
      units: (reverse
        ? [
            { id: high, owner: "p1", position: [2, 0], hp: 2, unitType: "WORKER", cargo: 0 },
            { id: low, owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          ]
        : [
            { id: low, owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
            { id: high, owner: "p1", position: [2, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          ]) as typeof SCENARIO.players[0]["units"],
    }],
  });
  const settleOrdered = (world: SimWorld) => {
    const plan: Plan = {
      tick: world.tick,
      unitActions: {
        [high]: { type: "SELF_DESTRUCT" },
        [low]: { type: "SELF_DESTRUCT" },
      },
      coreAction: null,
      intents: {},
    };
    return settleTick(world, new Map([["p1", plan]]), ctx).events.map((event) => ({
      eventType: event.eventType,
      actorId: event.actorId,
      targetId: event.targetId,
      reasonCode: event.reasonCode,
    }));
  };
  const forward = settleOrdered(makeOrderedWorld(false));
  const reversed = settleOrdered(makeOrderedWorld(true));
  assert.deepEqual(reversed, forward);
  assert.deepEqual(
    forward.filter((event) => event.eventType === "UNIT_SELF_DESTRUCTED").map((event) => event.actorId),
    [low, high],
  );
});

test("S3 v0.12: Core SELF_DESTRUCT destroys fleet and respawns same Tick", () => {
  // 需要第二个活 Core 作为 respawn 距离参照（P12 在 20-30 Manhattan 放置）
  const world = worldFromScenario({
    ...SCENARIO,
    players: [
      ...SCENARIO.players,
      {
        id: "p2",
        username: "p2",
        resources: 5,
        core: {
          id: "44444444-4444-4444-4444-444444444444",
          position: [50, 50],
          hp: 5,
          shield: 5,
          state: "NORMAL",
        },
        units: [],
      },
    ],
  });
  const coreId = SCENARIO.players[0].core.id;
  const workerId = SCENARIO.players[0].units[0].id;
  const plan: Plan = {
    tick: world.tick,
    unitActions: {},
    coreAction: { type: "SELF_DESTRUCT" },
    intents: {},
  };
  const result = settleTick(world, new Map([["p1", plan]]), ctx);
  const events = result.events;
  // CORE_DESTROYED with reason SELF_DESTRUCT, no destroyed_by
  const destroyed = events.find((e) => e.eventType === "CORE_DESTROYED" && e.actorId === coreId);
  assert.ok(destroyed !== undefined);
  assert.equal(destroyed.reasonCode, "SELF_DESTRUCT");
  assert.equal(destroyed.values?.destroyed_by, undefined);
  // Units removed; CORE_RESPAWNED appears (same-Tick respawn flow)
  assert.ok(events.some((e) => e.eventType === "UNIT_SELF_DESTRUCTED" && e.actorId === workerId));
  assert.ok(events.some((e) => e.eventType === "CORE_RESPAWNED"));
  const player = result.world.players.get("p1")!;
  assert.equal(player.status, "ACTIVE"); // respawned this Tick
  assert.notEqual(player.core?.id, coreId); // fresh Core UUID
  assert.equal(player.core?.hp, 5);
  assert.equal(player.units.length, 1); // respawn Worker
});

test("S3 v0.12: Core SELF_DESTRUCT drops carried Beacon at Core cell", () => {
  const world = worldFromScenario({
    ...SCENARIO,
    players: [
      ...SCENARIO.players,
      {
        id: "p2",
        username: "p2",
        resources: 5,
        core: {
          id: "44444444-4444-4444-4444-444444444444",
          position: [50, 50],
          hp: 5,
          shield: 5,
          state: "NORMAL",
        },
        units: [],
      },
    ],
    beacon: { position: [0, 0], status: "CARRIED", carrierId: SCENARIO.players[0].core.id },
  });
  const plan: Plan = {
    tick: world.tick,
    unitActions: {},
    coreAction: { type: "SELF_DESTRUCT" },
    intents: {},
  };
  const result = settleTick(world, new Map([["p1", plan]]), ctx);
  const beacon = result.world.beacon!;
  assert.equal(beacon.status, "GROUND");
  assert.deepEqual(beacon.position, [0, 0]); // dropped at Core position
  assert.ok(result.events.some((e) => e.eventType === "BEACON_DROPPED_ON_DEATH"));
});
