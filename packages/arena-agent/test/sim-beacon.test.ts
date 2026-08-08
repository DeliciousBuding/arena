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

test("S11: 迁移 Core 携带 Beacon——真实移动前保持逻辑位置，完成后跟随", () => {
  // 官方 champion-beacon.md："A migrating Core keeps it at the Core's current
  // logical position until the fourth-Tick real move goes through"——
  // 迁移 1-3 tick Core 位置不变（Beacon 保持逻辑位置），第 4 tick 真实
  // 移动（CORE_MOVE_SUCCEEDED）→ Beacon 跟随到新位置。
  const world1 = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 5,
        core: { id: P1_CORE, position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: { position: [0, 0], status: "GROUND", carrierId: null },
  });
  // tick1：Core 同格拾取 Beacon
  const world2 = settleTick(
    world1,
    new Map([["p1", { tick: 1, unitActions: {}, coreAction: { type: "PICKUP_BEACON" }, intents: {} }]]),
    ctx,
  ).world;
  assert.equal(world2.beacon?.status, "CARRIED");
  assert.equal(world2.beacon?.carrierId, P1_CORE);
  // tick2：START_MOVE（目的地 [1,0]，4 tick）
  const world3 = settleTick(
    world2,
    new Map([["p1", { tick: 2, unitActions: {}, coreAction: { type: "START_MOVE", direction: "RIGHT" }, intents: {} }]]),
    ctx,
  ).world;
  assert.equal(world3.players.get("p1")!.core!.state, "MOVING");
  // tick3-4：迁移 progress（Core 位置不变 → Beacon 保持 [0,0] 逻辑位置）
  const world4 = settleTick(
    world3,
    new Map([["p1", { tick: 3, unitActions: {}, coreAction: null, intents: {} }]]),
    ctx,
  ).world;
  assert.equal(world4.players.get("p1")!.core!.position[0], 0, "迁移中 Core 位置不变");
  assert.equal(world4.beacon?.position[0], 0, "迁移中 Beacon 保持逻辑位置");
  const world5 = settleTick(
    world4,
    new Map([["p1", { tick: 4, unitActions: {}, coreAction: null, intents: {} }]]),
    ctx,
  ).world;
  assert.equal(world5.players.get("p1")!.core!.position[0], 0, "第 3 tick 仍未移动");
  assert.equal(world5.beacon?.position[0], 0, "Beacon 仍未跟随");
  // tick5：第 4 tick 真实移动 → Core 到 [1,0]，Beacon 跟随
  const world6 = settleTick(
    world5,
    new Map([["p1", { tick: 5, unitActions: {}, coreAction: null, intents: {} }]]),
    ctx,
  ).world;
  assert.equal(world6.players.get("p1")!.core!.position[0], 1, "Core 完成迁移");
  assert.equal(world6.beacon?.position[0], 1, "Beacon 跟随到新位置");
});

// W46: Beacon carrier 移动坐标同步回归测试。
// 实现已存在于 movement.ts:357-365（carrier 移动成功 → resolution.positions
// 命中 carrierId → Beacon position 同步；移动失败不命中 → Beacon 不漂移）。
// 以下 3 用例覆盖 unit carrier 成功/失败与 Core carrier 4-tick 迁移；
// 反向验证：删除 movement.ts 的同步块会使"成功同步"用例转红。

test("S11 (W46): unit carrier 移动成功 → Beacon position 同步到新格", () => {
  // p1 Worker A 携带 Beacon 在 [2,2]；MOVE UP → [2,1]（空、非障碍）
  const world = makeWorld({ beaconStatus: "CARRIED", beaconCarrierId: P1_WORKER_A });
  const result = settleTick(
    world,
    new Map([["p1", planOf(world, { [P1_WORKER_A]: { type: "MOVE", direction: "UP" } })]]),
    ctx,
  );
  const carrier = result.world.players.get("p1")!.units.find((u) => u.id === P1_WORKER_A)!;
  assert.equal(carrier.position[0], 2, "carrier 移动到 [2,1]");
  assert.equal(carrier.position[1], 1);
  assert.equal(result.world.beacon!.status, "CARRIED", "仍携带");
  assert.equal(result.world.beacon!.carrierId, P1_WORKER_A);
  assert.equal(result.world.beacon!.position[0], 2, "Beacon 跟随 carrier 到 [2,1]");
  assert.equal(result.world.beacon!.position[1], 1);
  assert.ok(
    result.events.some((e) => e.eventType === "UNIT_MOVE_SUCCEEDED" && e.actorId === P1_WORKER_A),
    "carrier MOVE 成功事件存在",
  );
});

test("S11 (W46): unit carrier 移动失败 → Beacon position 不漂移", () => {
  // p1 Worker A 携带 Beacon 在 [2,2]；MOVE RIGHT 目标 [3,2] 被 p2 Worker 占据
  // 且 p2 Worker 不离开 → 跨玩家占位失败 → carrier 不动，Beacon 保持 [2,2]。
  const world = makeWorld({ beaconStatus: "CARRIED", beaconCarrierId: P1_WORKER_A });
  const result = settleTick(
    world,
    new Map([
      ["p1", planOf(world, { [P1_WORKER_A]: { type: "MOVE", direction: "RIGHT" } })],
      ["p2", planOf(world, { [P2_WORKER]: { type: "WAIT" } })],
    ]),
    ctx,
  );
  const carrier = result.world.players.get("p1")!.units.find((u) => u.id === P1_WORKER_A)!;
  assert.equal(carrier.position[0], 2, "carrier 移动失败保持 [2,2]");
  assert.equal(carrier.position[1], 2);
  assert.equal(result.world.beacon!.status, "CARRIED");
  assert.equal(result.world.beacon!.carrierId, P1_WORKER_A);
  assert.equal(result.world.beacon!.position[0], 2, "Beacon 不漂移，保持 [2,2]");
  assert.equal(result.world.beacon!.position[1], 2);
  assert.ok(
    result.events.some((e) => e.eventType === "UNIT_MOVE_FAILED" && e.actorId === P1_WORKER_A),
    "carrier MOVE 失败事件存在",
  );
});

test("S11 (W46): Core carrier 4-tick 迁移——进度 tick 保持逻辑位置，完成落位同步", () => {
  // 官方 champion-beacon.md:56-58：迁移中 Core 逻辑位置不变，Beacon 保持该
  // 逻辑位置；第 4 tick 真实移动 → Beacon 跟随到新格。
  // 时间线（moveRequiredTicks=4，progress 起始 1，progress+1>=4 时到期）：
  //   tick1 START_MOVE → MOVING(progress1)；tick2/3 progress(2,3) 仍 MOVING；
  //   tick4 progress4 到期 → 真实移动 → NORMAL、Core/Beacon 落位 [1,0]。
  const baseWorld = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 5,
        core: { id: P1_CORE, position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: { position: [0, 0], status: "CARRIED", carrierId: P1_CORE },
  });
  // tick1：START_MOVE RIGHT（4-tick 迁移，目的地 [1,0]）
  const world2 = settleTick(
    baseWorld,
    new Map([["p1", { tick: 1, unitActions: {}, coreAction: { type: "START_MOVE", direction: "RIGHT" }, intents: {} }]]),
    ctx,
  ).world;
  assert.equal(world2.players.get("p1")!.core!.state, "MOVING");
  assert.deepEqual(world2.beacon!.position, [0, 0], "START_MOVE 后 Beacon 仍在 [0,0]");
  // tick2-3：进度推进，Core 逻辑位置不变 → Beacon 保持 [0,0]
  let progressWorld = world2;
  for (let tick = 2; tick <= 3; tick += 1) {
    progressWorld = settleTick(
      progressWorld,
      new Map([["p1", { tick, unitActions: {}, coreAction: null, intents: {} }]]),
      ctx,
    ).world;
    const core = progressWorld.players.get("p1")!.core!;
    assert.equal(core.state, "MOVING", `tick ${tick} 仍 MOVING`);
    assert.equal(core.position[0], 0, `tick ${tick} Core 逻辑位置不变`);
    assert.equal(core.position[1], 0);
    assert.deepEqual(
      progressWorld.beacon!.position,
      [0, 0],
      `tick ${tick} Beacon 保持逻辑位置 [0,0]`,
    );
    assert.equal(progressWorld.beacon!.carrierId, P1_CORE, "carrier 不变");
  }
  // tick4：progress 到期 → 第 4 tick 真实移动 → Core 到 [1,0]，Beacon 跟随
  const finalWorld = settleTick(
    progressWorld,
    new Map([["p1", { tick: 4, unitActions: {}, coreAction: null, intents: {} }]]),
    ctx,
  ).world;
  const finalCore = finalWorld.players.get("p1")!.core!;
  assert.equal(finalCore.state, "NORMAL", "迁移完成回 NORMAL");
  assert.equal(finalCore.position[0], 1, "Core 完成迁移到 [1,0]");
  assert.equal(finalCore.position[1], 0);
  assert.deepEqual(finalWorld.beacon!.position, [1, 0], "Beacon 最终落位同步到 [1,0]");
  assert.equal(finalWorld.beacon!.carrierId, P1_CORE);
});
