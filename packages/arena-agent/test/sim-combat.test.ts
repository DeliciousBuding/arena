/**
 * S10 combat resolver 测试：
 * SWEEP 相邻格多目标伤害、SHOOT 八方向线/射程/障碍阻断、快照同时应用（互杀）、
 * Core 摧毁（护盾优先 → 掉落 cargo → 击杀者资源归属）、确定性排序。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Plan, UnitAction } from "../src/domain/model.ts";
import { loadRulesManifest } from "../src/sim/contracts/rules-manifest.ts";
import { resolveCombat } from "../src/sim/engine/combat.ts";
import { idlePlans, settleTick } from "../src/sim/engine/settlement.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";
import { privateEventsForPlayer } from "../src/sim/visibility/private-events.ts";
import type { SimWorld } from "../src/sim/world/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.11.json");
const rules = loadRulesManifest(MANIFEST_PATH);
const ctx = { rules, rng: null };

const P1_CORE = "11111111-1111-1111-1111-111111111111";
const P1_VANGUARD = "22222222-2222-2222-2222-222222222222";
const P1_WORKER = "33333333-3333-3333-3333-333333333333";
const P2_CORE = "44444444-4444-4444-4444-444444444444";
const P2_VANGUARD = "55555555-5555-5555-5555-555555555555";
const P2_RANGER = "66666666-6666-6666-6666-666666666666";

/** 双玩家场景：p1 Core[0,0] + Vanguard[2,0]；p2 Core[6,6] + Vanguard[3,0] + Ranger[1,4]。 */
function makeWorld(): SimWorld {
  return worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 10,
        core: { id: P1_CORE, position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: P1_VANGUARD, owner: "p1", position: [2, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: P1_WORKER, owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 2 },
        ],
      },
      {
        id: "p2",
        username: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: P2_VANGUARD, owner: "p2", position: [3, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: P2_RANGER, owner: "p2", position: [1, 4], hp: 2, unitType: "RANGER", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: null,
  });
}

function planOf(world: SimWorld, unitActions: Record<string, UnitAction>): Plan {
  return { tick: world.tick, unitActions, coreAction: null, intents: {} };
}

test("S10: SWEEP 对相邻目标格内所有敌方对象造成 1 伤害", () => {
  const world = makeWorld();
  // p1 Vanguard[2,0] SWEEP LEFT → 目标格 [1,0]（空）→ 无命中
  const miss = settleTick(world, new Map([["p1", planOf(world, { [P1_VANGUARD]: { type: "SWEEP", direction: "LEFT" } })]]), ctx);
  assert.deepEqual(miss.events.find((e) => e.eventType === "SWEEP_RESOLVED")?.values, { targets_hit: 0 });
  assert.equal(miss.world.players.get("p1")!.units.find((u) => u.id === P1_VANGUARD)!.hp, 4);

  // p1 Vanguard SWEEP RIGHT → [3,0]（p2 Vanguard 在）→ p2 Vanguard -1
  const hit = settleTick(world, new Map([["p1", planOf(world, { [P1_VANGUARD]: { type: "SWEEP", direction: "RIGHT" } })]]), ctx);
  assert.equal(hit.world.players.get("p2")!.units.find((u) => u.id === P2_VANGUARD)!.hp, 3);
  assert.ok(hit.events.some((e) => e.eventType === "UNIT_DAMAGED" && e.targetId === P2_VANGUARD && e.values?.damage === 1));
});

test("S10: 多 SWEEP 叠加伤害，杀死满 hp 单位", () => {
  const world = makeWorld();
  // p2 两个 Vanguard 都在 [3,0]？不——只用一个：p2 Vanguard 被 p1 Vanguard 杀
  // 构造：p1 Vanguard[2,0] SWEEP RIGHT 攻击 [3,0]；p2 Vanguard[3,0] 4hp 需要 4 次
  // 简化：直接验证叠加——p1 两个 Vanguard 围攻同一目标
  const p1Second = "77777777-7777-7777-7777-777777777777";
  const world2 = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 10,
        core: { id: P1_CORE, position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: P1_VANGUARD, owner: "p1", position: [2, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: p1Second, owner: "p1", position: [3, 1], hp: 4, unitType: "VANGUARD", cargo: 0 },
        ],
      },
      {
        id: "p2",
        username: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P2_VANGUARD, owner: "p2", position: [3, 0], hp: 2, unitType: "VANGUARD", cargo: 0 }],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: null,
  });
  const result = settleTick(
    world2,
    new Map([
      ["p1", planOf(world2, {
        [P1_VANGUARD]: { type: "SWEEP", direction: "RIGHT" },
        [p1Second]: { type: "SWEEP", direction: "UP" },
      })],
    ]),
    ctx,
  );
  // p2 Vanguard 2hp 收到 2 伤害 → 死亡
  assert.equal(result.world.players.get("p2")!.units.find((u) => u.id === P2_VANGUARD), undefined);
  assert.ok(result.events.some((e) => e.eventType === "UNIT_DAMAGED" && e.targetId === P2_VANGUARD && e.values?.hp === 0));
  assert.ok(!result.events.some((e) => e.eventType === "UNIT_DESTROYED"));
});

test("S10: SHOOT 八方向线 1-3 格、障碍阻断、非直线无效", () => {
  const world = makeWorld();
  // p2 Ranger[1,4] SHOOT p1 Vanguard[2,0]：dx=1, dy=-4 非八方向 → 无效
  const notLine = settleTick(
    world,
    new Map([["p2", planOf(world, { [P2_RANGER]: { type: "SHOOT", targetId: P1_VANGUARD, expectedCell: [2, 0] } })]]),
    ctx,
  );
  assert.equal(notLine.world.players.get("p1")!.units.find((u) => u.id === P1_VANGUARD)!.hp, 4);

  // p2 Ranger[1,4] SHOOT p1 Worker[0,1]：dx=-1, dy=-3 非八方向 → 无效
  const notLine2 = settleTick(
    world,
    new Map([["p2", planOf(world, { [P2_RANGER]: { type: "SHOOT", targetId: P1_WORKER, expectedCell: [0, 1] } })]]),
    ctx,
  );
  assert.equal(notLine2.world.players.get("p1")!.units.find((u) => u.id === P1_WORKER)!.hp, 2);

  // p2 Ranger[1,4] SHOOT 45° 线到 [3,2]（空）——目标不存在 → 无效
  const noTarget = settleTick(
    world,
    new Map([["p2", planOf(world, { [P2_RANGER]: { type: "SHOOT", targetId: "99999999-9999-9999-9999-999999999999", expectedCell: [3, 2] } })]]),
    ctx,
  );
  assert.ok(noTarget.events.some((e) => e.eventType === "SHOT_MISSED" && e.reasonCode === "SHOT_MISSED"));
});

test("S10: SHOOT 沿八方向线命中并造成 1 伤害", () => {
  const world = makeWorld();
  // 重新摆放：p2 Ranger[0,4]，p1 Worker[0,1] 在同一竖线 dx=0 距离 3 → 命中
  const world2 = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 10,
        core: { id: P1_CORE, position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P1_WORKER, owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 }],
      },
      {
        id: "p2",
        username: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P2_RANGER, owner: "p2", position: [0, 4], hp: 2, unitType: "RANGER", cargo: 0 }],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: null,
  });
  const result = settleTick(
    world2,
    new Map([["p2", planOf(world2, { [P2_RANGER]: { type: "SHOOT", targetId: P1_WORKER, expectedCell: [0, 1] } })]]),
    ctx,
  );
  assert.equal(result.world.players.get("p1")!.units.find((u) => u.id === P1_WORKER)!.hp, 1);
  assert.ok(result.events.some((e) => e.eventType === "UNIT_DAMAGED" && e.targetId === P1_WORKER && e.values?.damage === 1));

  // 障碍阻断：加障碍 [0,2] → 中间格阻断 → 无效
  const world3 = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 10,
        core: { id: P1_CORE, position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P1_WORKER, owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 }],
      },
      {
        id: "p2",
        username: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P2_RANGER, owner: "p2", position: [0, 4], hp: 2, unitType: "RANGER", cargo: 0 }],
      },
    ],
    terrain: { obstacles: [[0, 2]], resources: [] },
    beacon: null,
  });
  const blocked = settleTick(
    world3,
    new Map([["p2", planOf(world3, { [P2_RANGER]: { type: "SHOOT", targetId: P1_WORKER, expectedCell: [0, 1] } })]]),
    ctx,
  );
  assert.equal(blocked.world.players.get("p1")!.units.find((u) => u.id === P1_WORKER)!.hp, 2);
});

test("S10 v0.12: cell fire——无 target_id 命中该格最低 HP 敌对单位", () => {
  // p2 Ranger[0,4] 向 [0,1] 格 cell fire；该格有 p1 Worker(2hp) 与 p1 另一 Worker(1hp)
  const lowHpWorker = "88888888-8888-8888-8888-888888888888";
  const world = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 10,
        core: { id: P1_CORE, position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: P1_WORKER, owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: lowHpWorker, owner: "p1", position: [0, 1], hp: 1, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2",
        username: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P2_RANGER, owner: "p2", position: [0, 4], hp: 2, unitType: "RANGER", cargo: 0 }],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: null,
  });
  const result = settleTick(
    world,
    new Map([["p2", planOf(world, { [P2_RANGER]: { type: "SHOOT", targetId: null, expectedCell: [0, 1] } })]]),
    ctx,
  );
  // 低 HP Worker(1hp) 被命中并死亡；满 HP Worker(2hp) 无损
  assert.equal(result.world.players.get("p1")!.units.find((u) => u.id === lowHpWorker), undefined);
  assert.equal(result.world.players.get("p1")!.units.find((u) => u.id === P1_WORKER)!.hp, 2);
  const hit = result.events.find((e) => e.eventType === "SHOT_HIT");
  assert.ok(hit !== undefined);
  assert.equal(hit.targetId, lowHpWorker);
});

test("S10 v0.12: cell fire 空格——SHOT_MISSED 且 target_id 为 null", () => {
  const world = makeWorld();
  // p2 Ranger[1,4] 向空格 [3,2]（八方向线内）cell fire → 空格无目标 → SHOT_MISSED
  const result = settleTick(
    world,
    new Map([["p2", planOf(world, { [P2_RANGER]: { type: "SHOOT", targetId: null, expectedCell: [3, 2] } })]]),
    ctx,
  );
  const missed = result.events.find((e) => e.eventType === "SHOT_MISSED");
  assert.ok(missed !== undefined);
  assert.equal(missed.targetId, null);
});

test("S10: 快照同时应用——互杀合法", () => {
  // p1 Vanguard[1,0] 与 p2 Vanguard[2,0] 各 SWEEP 对方格；双方 hp 1 → 互杀
  const world = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 10,
        core: { id: P1_CORE, position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P1_VANGUARD, owner: "p1", position: [1, 0], hp: 1, unitType: "VANGUARD", cargo: 0 }],
      },
      {
        id: "p2",
        username: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P2_VANGUARD, owner: "p2", position: [2, 0], hp: 1, unitType: "VANGUARD", cargo: 0 }],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: null,
  });
  const result = settleTick(
    world,
    new Map([
      ["p1", planOf(world, { [P1_VANGUARD]: { type: "SWEEP", direction: "RIGHT" } })],
      ["p2", planOf(world, { [P2_VANGUARD]: { type: "SWEEP", direction: "LEFT" } })],
    ]),
    ctx,
  );
  assert.equal(result.world.players.get("p1")!.units.length, 0);
  assert.equal(result.world.players.get("p2")!.units.length, 0);
});

test("S10: Core 伤害先护盾后 HP，摧毁时掉落 cargo + 击杀者得资源", () => {
  // p1 Worker[0,1] cargo=2（被 p2 摧毁时掉落 [0,1]）
  // p2 Vanguard[1,4]（含 3 个）SHOOT p1 Core[0,0]：竖线距离 4？不——重新设计
  // p2 Ranger[0,4] SHOOT p1 Core[0,0]：dx=0 dy=-4 距离 4 > 3 → 无效。改放 [0,3]。
  const world = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 10,
        core: { id: P1_CORE, position: [0, 0], hp: 1, shield: 0, state: "NORMAL" },
        units: [{ id: P1_WORKER, owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 2 }],
      },
      {
        id: "p2",
        username: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P2_RANGER, owner: "p2", position: [0, 3], hp: 2, unitType: "RANGER", cargo: 0 }],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: null,
  });
  const result = settleTick(
    world,
    new Map([
      ["p2", planOf(world, { [P2_RANGER]: { type: "SHOOT", targetId: P1_CORE, expectedCell: [0, 0] } })],
    ]),
    ctx,
  );
  // p1 Core hp 1 → 摧毁；fleet 移除 → cargo 掉落 [0,1]；击杀者 p2 得资源；
  // 同 Tick P12 respawn resolver 立即放置 replacement → 发布状态已 ACTIVE
  const p1 = result.world.players.get("p1")!;
  assert.equal(p1.status, "ACTIVE", "same-tick respawn returns player to ACTIVE");
  assert.ok(p1.core !== null, "p1 has respawned core");
  assert.notEqual(p1.core!.id, P1_CORE, "fresh core UUID");
  assert.equal(p1.core!.hp, 5);
  assert.equal(p1.core!.shield, 5);
  assert.equal(p1.units.length, 1, "starting worker count");
  assert.equal(p1.units[0].unitType, "WORKER");
  assert.equal(p1.units[0].hp, 2);
  assert.equal(p1.units[0].cargo, 0);
  assert.equal(p1.resources, 5, "starting resources after respawn");
  assert.equal(result.world.terrain.piles.get("0,1")?.amount, 2);
  // p2 post-combat capacity = max(10, 1×5) = 10，所以只存 5、其余 5 销毁。
  assert.equal(result.world.players.get("p2")!.resources, 10);
  assert.deepEqual(
    result.events.find((e) => e.eventType === "CORE_RESOURCES_CAPTURED")?.values,
    { amount: 5, available: 10, destroyed: 5, capacity: 10 },
  );
  assert.ok(result.events.some((e) => e.eventType === "CORE_DESTROYED" && e.targetId === P1_CORE));
  assert.ok(result.events.some((e) => e.eventType === "CORE_RESPAWNED"), "CORE_RESPAWNED missing");
});

test("S10: 护盾吸收 Core 伤害——hp 不变", () => {
  const world = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 10,
        core: { id: P1_CORE, position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [],
      },
      {
        id: "p2",
        username: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P2_RANGER, owner: "p2", position: [0, 3], hp: 2, unitType: "RANGER", cargo: 0 }],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: null,
  });
  const result = settleTick(
    world,
    new Map([
      ["p2", planOf(world, { [P2_RANGER]: { type: "SHOOT", targetId: P1_CORE, expectedCell: [0, 0] } })],
    ]),
    ctx,
  );
  const p1 = result.world.players.get("p1")!;
  assert.equal(p1.core!.hp, 5);
  assert.equal(p1.core!.shield, 4);
  assert.ok(result.events.some((e) => e.eventType === "CORE_DAMAGED" && e.targetId === P1_CORE));
});

test("S10: resolveCombat 纯函数——原 world 不变", () => {
  const world = makeWorld();
  const before = JSON.stringify(world);
  const plans = new Map([
    ["p1", planOf(world, { [P1_VANGUARD]: { type: "SWEEP", direction: "RIGHT" } })],
  ]);
  const resolution = resolveCombat(world, plans);
  assert.equal(JSON.stringify(world), before);
  assert.ok(resolution.damageByTarget.get(P2_VANGUARD) === 1);
});


test("S10 contract: Worker/Vanguard/Ranger 只能使用各自攻击类型", () => {
  const world = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 5,
        core: { id: P1_CORE, position: [0, 2], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: P1_WORKER, owner: "p1", position: [0, 0], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: P1_VANGUARD, owner: "p1", position: [0, 1], hp: 4, unitType: "VANGUARD", cargo: 0 },
        ],
      },
      {
        id: "p2",
        username: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [5, 5], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: P2_VANGUARD, owner: "p2", position: [1, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: P2_RANGER, owner: "p2", position: [1, 1], hp: 2, unitType: "RANGER", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: null,
  });
  const result = settleTick(
    world,
    new Map([
      ["p1", planOf(world, {
        [P1_WORKER]: { type: "SWEEP", direction: "RIGHT" },
        [P1_VANGUARD]: { type: "SHOOT", targetId: P2_RANGER, expectedCell: [1, 1] },
      })],
      ["p2", planOf(world, {
        [P2_RANGER]: { type: "SWEEP", direction: "LEFT" },
      })],
    ]),
    ctx,
  );
  assert.equal(result.world.players.get("p2")!.units.find((u) => u.id === P2_VANGUARD)!.hp, 4);
  assert.equal(result.world.players.get("p2")!.units.find((u) => u.id === P2_RANGER)!.hp, 2);
  assert.equal(result.world.players.get("p1")!.units.find((u) => u.id === P1_VANGUARD)!.hp, 4);
  assert.ok(!result.events.some((event) => ["SWEEP_RESOLVED", "SHOT_HIT", "SHOT_MISSED"].includes(event.eventType)));
});

test("S10 contract: moved/incorrect expected_cell 统一 SHOT_MISSED，不形成 fog oracle", () => {
  const world = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 5,
        core: { id: P1_CORE, position: [5, 5], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P1_WORKER, owner: "p1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 }],
      },
      {
        id: "p2",
        username: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P2_RANGER, owner: "p2", position: [0, 3], hp: 2, unitType: "RANGER", cargo: 0 }],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: null,
  });
  const expectedCell: [number, number] = [0, 0];
  const result = settleTick(
    world,
    new Map([["p2", planOf(world, {
      [P2_RANGER]: { type: "SHOOT", targetId: P1_WORKER, expectedCell },
    })]]),
    ctx,
  );
  assert.equal(result.world.players.get("p1")!.units[0].hp, 2);
  const miss = result.events.find((event) => event.eventType === "SHOT_MISSED");
  assert.equal(miss?.reasonCode, "SHOT_MISSED");
  assert.equal(miss?.actorId, P2_RANGER);
  assert.equal(miss?.targetId, P1_WORKER);
  assert.deepEqual(miss?.position, expectedCell);
});

test("S10 contract: combat kill 事件对齐且 participation 仅投递给攻击者", () => {
  const world = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "victim",
        resources: 5,
        core: { id: P1_CORE, position: [5, 5], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P1_WORKER, owner: "p1", position: [0, 1], hp: 1, unitType: "WORKER", cargo: 2 }],
      },
      {
        id: "p2",
        username: "attacker",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P2_RANGER, owner: "p2", position: [0, 3], hp: 2, unitType: "RANGER", cargo: 0 }],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: null,
  });
  const result = settleTick(
    world,
    new Map([["p2", planOf(world, {
      [P2_RANGER]: { type: "SHOOT", targetId: P1_WORKER, expectedCell: [0, 1] },
    })]]),
    ctx,
  );
  const hit = result.events.find((event) => event.eventType === "SHOT_HIT");
  assert.deepEqual(hit?.values, { damage: 1 });
  const damage = result.events.find((event) => event.eventType === "UNIT_DAMAGED");
  assert.equal(damage?.reasonCode, "ATTACK");
  assert.deepEqual(damage?.values, { damage: 1, hp: 0 });
  assert.ok(!result.events.some((event) => event.eventType === "UNIT_DESTROYED"));
  assert.deepEqual(
    result.events.find((event) => event.eventType === "WORKER_CARGO_DROPPED")?.values,
    { amount: 2 },
  );
  const attackerEvents = privateEventsForPlayer(world, result.world, "p2", result.events);
  const victimEvents = privateEventsForPlayer(world, result.world, "p1", result.events);
  assert.ok(attackerEvents.some((event) => event.eventType === "DESTRUCTION_PARTICIPATION"));
  assert.ok(!victimEvents.some((event) => event.eventType === "DESTRUCTION_PARTICIPATION"));
});

test("S10 economy: combat 减员当 Tick 收缩容量，资源不会延迟到下一 Tick 销毁", () => {
  const extraA = "77777777-7777-7777-7777-777777777777";
  const extraB = "88888888-8888-8888-8888-888888888888";
  const world = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 15,
        core: { id: P1_CORE, position: [5, 5], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: P1_WORKER, owner: "p1", position: [0, 1], hp: 1, unitType: "WORKER", cargo: 0 },
          { id: extraA, owner: "p1", position: [1, 1], hp: 2, unitType: "WORKER", cargo: 0 },
          { id: extraB, owner: "p1", position: [2, 1], hp: 2, unitType: "WORKER", cargo: 0 },
        ],
      },
      {
        id: "p2",
        username: "p2",
        resources: 5,
        core: { id: P2_CORE, position: [6, 6], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P2_RANGER, owner: "p2", position: [0, 3], hp: 2, unitType: "RANGER", cargo: 0 }],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: null,
  });
  const result = settleTick(
    world,
    new Map([["p2", planOf(world, {
      [P2_RANGER]: { type: "SHOOT", targetId: P1_WORKER, expectedCell: [0, 1] },
    })]]),
    ctx,
  );
  assert.equal(result.world.players.get("p1")!.units.length, 2);
  assert.equal(result.world.players.get("p1")!.resources, 10);
  assert.deepEqual(
    result.events.find((event) => event.eventType === "CORE_RESOURCE_OVERFLOW_DESTROYED")?.values,
    { amount: 5, capacity: 10 },
  );
});

test("S10 economy: 双方 Core 同归于尽时不捕获，延迟 respawn 也不保留旧库存", () => {
  const p1Ranger = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const p2Ranger = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const world = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 9,
        core: { id: P1_CORE, position: [0, 0], hp: 1, shield: 0, state: "NORMAL" },
        units: [{ id: p1Ranger, owner: "p1", position: [6, 3], hp: 2, unitType: "RANGER", cargo: 0 }],
      },
      {
        id: "p2",
        username: "p2",
        resources: 8,
        core: { id: P2_CORE, position: [6, 0], hp: 1, shield: 0, state: "NORMAL" },
        units: [{ id: p2Ranger, owner: "p2", position: [0, 3], hp: 2, unitType: "RANGER", cargo: 0 }],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: null,
  });
  const result = settleTick(
    world,
    new Map([
      ["p1", planOf(world, { [p1Ranger]: { type: "SHOOT", targetId: P2_CORE, expectedCell: [6, 0] } })],
      ["p2", planOf(world, { [p2Ranger]: { type: "SHOOT", targetId: P1_CORE, expectedCell: [0, 0] } })],
    ]),
    ctx,
  );
  assert.ok(!result.events.some((event) => event.eventType === "CORE_RESOURCES_CAPTURED"));
  assert.equal(result.world.players.get("p1")!.resources, 0);
  assert.equal(result.world.players.get("p2")!.resources, 0);
  assert.equal(result.world.players.get("p1")!.status, "RESPAWNING");
  assert.equal(result.world.players.get("p2")!.status, "RESPAWNING");
});
