/**
 * S11 beacon resolver 测试：
 * PICKUP 同格拾取（低 UUID 争抢）、DROP 仅 carrier、落地 tick 不可再拾取、
 * 失去 Beacon 盾 clamp、持有者 harvest 加成、移动经过不自动拾取。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Plan, UnitAction } from "../src/domain/model.ts";
import { loadRulesManifest } from "../src/sim/contracts/rules-manifest.ts";
import { resolveBeacon } from "../src/sim/engine/beacon.ts";
import { idlePlans, settleTick } from "../src/sim/engine/settlement.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";
import type { SimWorld } from "../src/sim/world/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.11.json");
const rules = loadRulesManifest(MANIFEST_PATH);
const ctx = { rules, rng: null };

const P1_CORE = "11111111-1111-1111-1111-111111111111";
const P1_WORKER_A = "22222222-2222-2222-2222-222222222222";
const P1_WORKER_B = "33333333-3333-3333-3333-333333333333";
const P1_WORKER_C = "77777777-7777-7777-7777-777777777777";
const P2_CORE = "44444444-4444-4444-4444-444444444444";
const P2_WORKER = "55555555-5555-5555-5555-555555555555";

/** Beacon 在 [2,2]；p1 Core[0,0] + Worker A[2,2] + Worker C[2,2] + Worker B[1,2]；p2 Core[6,6] + Worker[3,2]。 */
function makeWorld(opts: {
  beaconStatus?: "GROUND" | "CARRIED";
  beaconCarrierId?: string | null;
  p1Shield?: number;
} = {}): SimWorld {
  return worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 10,
        core: { id: P1_CORE, position: [0, 0], hp: 5, shield: opts.p1Shield ?? 5, state: "NORMAL" },
        units: [
          { id: P1_WORKER_A, owner: "p1", position: [2, 2], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: P1_WORKER_C, owner: "p1", position: [2, 2], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: P1_WORKER_B, owner: "p1", position: [1, 2], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2",
        username: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P2_WORKER, owner: "p2", position: [3, 2], hp: 2, unitType: "WORKER", cargo: 0 }],
      },
    ],
    terrain: { obstacles: [], resources: [[3, 2]] },
    beacon: {
      position: [2, 2],
      status: opts.beaconStatus ?? "GROUND",
      carrierId: opts.beaconCarrierId ?? null,
    },
  });
}

function planOf(world: SimWorld, unitActions: Record<string, UnitAction>): Plan {
  return { tick: world.tick, unitActions, coreAction: null, intents: {} };
}

test("S11: 同格 PICKUP 成功——低 raw UUID 获胜", () => {
  const world = makeWorld();
  // p1 Worker A[2,2] 与 p1 Worker C[2,2] 同格争抢；A(2222...) < C(7777...) → A 赢
  const result = settleTick(
    world,
    new Map([
      ["p1", planOf(world, {
        [P1_WORKER_A]: { type: "PICKUP_BEACON" },
        [P1_WORKER_C]: { type: "PICKUP_BEACON" },
      })],
    ]),
    ctx,
  );
  assert.equal(result.world.beacon!.status, "CARRIED");
  assert.equal(result.world.beacon!.carrierId, P1_WORKER_A);
  assert.ok(result.events.some((e) => e.eventType === "BEACON_PICKED_UP" && e.actorId === P1_WORKER_A));
  assert.ok(result.events.some(
    (e) => e.eventType === "BEACON_PICKUP_FAILED" &&
      e.actorId === P1_WORKER_C &&
      e.reasonCode === "ALREADY_CARRIED",
  ));
  assert.deepEqual(result.unsupported, []);
});

test("S11: 不同格 PICKUP 失败——不在 Beacon 格", () => {
  const world = makeWorld();
  // p1 Worker B[1,2] 不在 Beacon[2,2] → 无效果
  const result = settleTick(
    world,
    new Map([["p1", planOf(world, { [P1_WORKER_B]: { type: "PICKUP_BEACON" } })]]),
    ctx,
  );
  assert.equal(result.world.beacon!.status, "GROUND");
  assert.equal(result.world.beacon!.carrierId, null);
  assert.ok(result.events.some(
    (e) => e.eventType === "BEACON_PICKUP_FAILED" &&
      e.actorId === P1_WORKER_B &&
      e.reasonCode === "BEACON_NOT_PRESENT",
  ));
});

test("S11: DROP 仅当前 carrier——落地于 carrier 位置，本 tick 不可再拾取", () => {
  const world = makeWorld({ beaconStatus: "CARRIED", beaconCarrierId: P1_WORKER_A });
  // A 在 [2,2] 携带，DROP → 落地 [2,2]；同 tick p2 Worker[2,2] 想拾取 → 失败
  const result = settleTick(
    world,
    new Map([
      ["p1", planOf(world, { [P1_WORKER_A]: { type: "DROP_BEACON" } })],
      ["p2", planOf(world, { [P2_WORKER]: { type: "PICKUP_BEACON" } })],
    ]),
    ctx,
  );
  assert.equal(result.world.beacon!.status, "GROUND");
  assert.equal(result.world.beacon!.carrierId, null);
  assert.equal(result.world.beacon!.position[0], 2);
  assert.equal(result.world.beacon!.position[1], 2);
  assert.ok(result.events.some((e) => e.eventType === "BEACON_DROPPED" && e.actorId === P1_WORKER_A));
  // p2 本 tick 拾取失败，公开原因仍不泄漏额外状态。
  assert.ok(!result.events.some((e) => e.eventType === "BEACON_PICKED_UP"));
  assert.ok(result.events.some(
    (e) => e.eventType === "BEACON_PICKUP_FAILED" &&
      e.actorId === P2_WORKER &&
      e.reasonCode === "BEACON_NOT_PRESENT",
  ));
});

test("S11: 非 carrier DROP 无效", () => {
  const world = makeWorld({ beaconStatus: "CARRIED", beaconCarrierId: P1_WORKER_A });
  // p2 Worker 不是 carrier，DROP 无效果
  const result = settleTick(
    world,
    new Map([["p2", planOf(world, { [P2_WORKER]: { type: "DROP_BEACON" } })]]),
    ctx,
  );
  assert.equal(result.world.beacon!.status, "CARRIED");
  assert.equal(result.world.beacon!.carrierId, P1_WORKER_A);
  assert.ok(result.events.some(
    (e) => e.eventType === "BEACON_DROP_FAILED" &&
      e.actorId === P2_WORKER &&
      e.reasonCode === "NOT_BEACON_CARRIER",
  ));
});


test("S11 contract: 迁移 Core PICKUP/DROP 都返回 CORE_MOVING", () => {
  const movingCore = {
    id: P1_CORE,
    position: [0, 0] as const,
    hp: 5,
    shield: 5,
    state: "MOVING" as const,
    moveDirection: "RIGHT" as const,
    moveProgress: 1,
    moveRequiredTicks: 4,
    destination: [1, 0] as const,
  };
  const base = {
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [{
      id: "p1",
      username: "p1",
      resources: 5,
      core: movingCore,
      units: [],
    }],
    terrain: { obstacles: [], resources: [] },
  } as const;

  const pickupWorld = worldFromScenario({
    ...base,
    beacon: { position: [0, 0], status: "GROUND", carrierId: null },
  });
  const pickup = settleTick(
    pickupWorld,
    new Map([["p1", {
      tick: pickupWorld.tick,
      unitActions: {},
      coreAction: { type: "PICKUP_BEACON" },
      intents: {},
    }]]),
    ctx,
  );
  assert.ok(pickup.events.some(
    (event) => event.eventType === "BEACON_PICKUP_FAILED" &&
      event.actorId === P1_CORE &&
      event.reasonCode === "CORE_MOVING",
  ));

  const dropWorld = worldFromScenario({
    ...base,
    beacon: { position: [0, 0], status: "CARRIED", carrierId: P1_CORE },
  });
  const drop = settleTick(
    dropWorld,
    new Map([["p1", {
      tick: dropWorld.tick,
      unitActions: {},
      coreAction: { type: "DROP_BEACON" },
      intents: {},
    }]]),
    ctx,
  );
  assert.equal(drop.world.beacon?.status, "CARRIED");
  assert.ok(drop.events.some(
    (event) => event.eventType === "BEACON_DROP_FAILED" &&
      event.actorId === P1_CORE &&
      event.reasonCode === "CORE_MOVING",
  ));
});

test("S11: 失去 Beacon 时盾 >5 clamp 到 5", () => {
  // p1 持有 Beacon 且盾 7（超过无 Beacon 上限 5）
  const world = makeWorld({ beaconStatus: "CARRIED", beaconCarrierId: P1_WORKER_A, p1Shield: 7 });
  const result = settleTick(
    world,
    new Map([["p1", planOf(world, { [P1_WORKER_A]: { type: "DROP_BEACON" } })]]),
    ctx,
  );
  assert.equal(result.world.players.get("p1")!.core!.shield, 5);
  assert.ok(!result.events.some((e) => e.eventType === "CORE_SHIELD_CLAMPED"), "no invented wire event");
});

test("S11: 未失去 Beacon 时盾不 clamp", () => {
  const world = makeWorld({ beaconStatus: "CARRIED", beaconCarrierId: P1_WORKER_A, p1Shield: 7 });
  const result = settleTick(world, idlePlans(world), ctx);
  assert.equal(result.world.players.get("p1")!.core!.shield, 7);
  assert.ok(!result.events.some((e) => e.eventType === "CORE_SHIELD_CLAMPED"));
});

test("S11: 持有者 harvest 加成 2，非持有者 1", () => {
  // p1 持有 Beacon（A 在 [2,2]，资源在 [3,2]）；p1 Worker B[1,2] HARVEST 需要到 [3,2]——用 A 在 [3,2]？
  // 简化：p1 Worker A 持有 Beacon 且站在资源格 [2,2]，HARVEST → 2
  const world = makeWorld({ beaconStatus: "CARRIED", beaconCarrierId: P1_WORKER_A });
  const worldHarvest = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 10,
        core: { id: P1_CORE, position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P1_WORKER_A, owner: "p1", position: [2, 2], hp: 2, unitType: "WORKER", cargo: 0 }],
      },
      {
        id: "p2",
        username: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P2_WORKER, owner: "p2", position: [3, 2], hp: 2, unitType: "WORKER", cargo: 0 }],
      },
    ],
    terrain: { obstacles: [], resources: [[2, 2], [3, 2]] },
    beacon: { position: [2, 2], status: "CARRIED", carrierId: P1_WORKER_A },
  });
  const result = settleTick(
    worldHarvest,
    new Map([
      ["p1", planOf(worldHarvest, { [P1_WORKER_A]: { type: "HARVEST" } })],
      ["p2", planOf(worldHarvest, { [P2_WORKER]: { type: "HARVEST" } })],
    ]),
    ctx,
  );
  const p1Worker = result.world.players.get("p1")!.units.find((u) => u.id === P1_WORKER_A)!;
  const p2Worker = result.world.players.get("p2")!.units.find((u) => u.id === P2_WORKER)!;
  assert.equal(p1Worker.cargo, 2, "持有者收获 2");
  assert.equal(p2Worker.cargo, 1, "非持有者收获 1");
  assert.deepEqual(
    result.events.find((event) => event.eventType === "BEACON_HARVEST_BONUS")?.values,
    { amount: 1 },
  );
});

test("S11: 移动经过 Beacon 不自动拾取", () => {
  const world = makeWorld();
  // p1 Worker B[1,2] MOVE RIGHT → [2,2]（Beacon 格）但不 PICKUP → 仍 GROUND
  const result = settleTick(
    world,
    new Map([["p1", planOf(world, { [P1_WORKER_B]: { type: "MOVE", direction: "RIGHT" } })]]),
    ctx,
  );
  assert.equal(result.world.beacon!.status, "GROUND");
  assert.equal(result.world.beacon!.carrierId, null);
});

test("S11: resolveBeacon 纯函数——原 world 不变", () => {
  const world = makeWorld();
  const before = JSON.stringify(world);
  const plans = new Map([
    ["p1", planOf(world, { [P1_WORKER_A]: { type: "PICKUP_BEACON" } })],
  ]);
  const resolution = resolveBeacon(world, plans);
  assert.equal(JSON.stringify(world), before);
  assert.equal(resolution.nextBeacon!.status, "CARRIED");
});
