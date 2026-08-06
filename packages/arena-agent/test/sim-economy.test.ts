/**
 * S5 economy resolver 测试：upkeep/容量/self-destruct/harvest/deposit/
 * spawn/heal/repair Golden + 长跑 soak。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreAction, Plan, Position, UnitAction, UnitType } from "../src/domain/model.ts";
import { loadRulesManifest } from "../src/sim/contracts/rules-manifest.ts";
import { createSeededRng } from "../src/sim/deterministic/rng.ts";
import { idlePlans, settleTick, type SettlementContext } from "../src/sim/engine/settlement.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";
import type { SimWorld } from "../src/sim/world/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..", "..");
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.14.json");
const V011_MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.11.json");

const rules = loadRulesManifest(MANIFEST_PATH);
const rng = createSeededRng(42);
const ctx: SettlementContext = { rules, rng: () => rng.next() };
/** v0.11 显式回退（upkeep/deficit 语义为 v0.11-only）。 */
const rulesV011 = loadRulesManifest(V011_MANIFEST_PATH);
const ctxV011: SettlementContext = { rules: rulesV011, rng: () => rng.next() };

/** 固定序号 UUID（raw 序 = 数字序）。 */
const uuid = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

interface PlayerSpec {
  readonly id: string;
  readonly username?: string;
  readonly resources: number;
  readonly core?: Position | null;
  readonly units: readonly { id: string; position: Position; hp?: number; unitType?: UnitType; cargo?: number }[];
}

function makeWorld(
  players: readonly PlayerSpec[],
  terrain?: {
    obstacles?: readonly Position[];
    resources?: readonly Position[];
    piles?: readonly { readonly cell: Position; readonly amount: number }[];
  },
  rulesVersion: string = "v0.14",
): SimWorld {
  return worldFromScenario({
    rulesVersion,
    tick: 1,
    players: players.map((p) => ({
      id: p.id,
      username: p.username ?? p.id,
      resources: p.resources,
      core:
        p.core === undefined || p.core === null
          ? null
          : { id: coreUuid(p.id), position: p.core, hp: 5, shield: 5, state: "NORMAL" },
      units: p.units.map((u, i) => ({
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
  });
}

function coreUuid(playerId: string): string {
  const table: Readonly<Record<string, string>> = {
    p1: "11111111-1111-1111-1111-111111111111",
    p2: "22222222-2222-2222-2222-222222222222",
  };
  return table[playerId] ?? "33333333-3333-3333-3333-333333333333";
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

function eventTypes(result: ReturnType<typeof settleTick>): string[] {
  return result.events.map((e) => e.eventType);
}

/* ---------------- upkeep ---------------- */

test("S5: upkeep 足额（population 20 → tier 1 → due 1；v0.11 显式回退）", () => {
  const units = Array.from({ length: 20 }, (_, i) => ({ id: uuid(i + 1), position: [1 + i, 0] as Position }));
  const world = makeWorld([{ id: "p1", resources: 5, core: [0, 0], units }], undefined, "v0.11");
  const result = settleTick(world, new Map([["p1", idlePlans(world).get("p1")!]]), ctxV011);
  const player = result.world.players.get("p1")!;
  assert.equal(player.resources, 4);
  const upkeep = result.events.find((e) => e.eventType === "UPKEEP_PAID");
  assert.ok(upkeep, "UPKEEP_PAID missing");
  assert.deepEqual(upkeep!.values, { due: 1, paid: 1, deficit: 0 });
});

test("S5: upkeep 不足——最近的 19 保护，最远的受伤（v0.11）", () => {
  // 20 units：19 个近（分布在 [1..10, 0/1]，每格 ≤2），1 个远（距离 20）；resources 0 → deficit 1
  const near = Array.from({ length: 19 }, (_, i) => ({ id: uuid(i + 1), position: [1 + Math.floor(i / 2), i % 2] as Position }));
  const far = { id: uuid(30), position: [30, 0] as Position };
  const world = makeWorld([{ id: "p1", resources: 0, core: [0, 0], units: [...near, far] }], undefined, "v0.11");
  const result = settleTick(world, new Map([["p1", idlePlans(world).get("p1")!]]), ctxV011);
  const player = result.world.players.get("p1")!;
  assert.equal(player.resources, 0);
  const farUnit = player.units.find((u) => u.id === far.id)!;
  assert.equal(farUnit.hp, 1, "farthest unit should take 1 deficit damage");
  const damaged = result.events.filter((e) => e.eventType === "UNIT_DAMAGED");
  assert.equal(damaged.length, 1);
  assert.equal(damaged[0].targetId, far.id);
  assert.equal(damaged[0].reasonCode, "UPKEEP_DEFICIT");
  // 近的 units 全部存活满血
  for (const u of near) {
    const unit = player.units.find((x) => x.id === u.id)!;
    assert.equal(unit.hp, 2);
  }
  assert.ok(
    result.unknownEffects.some((effect) => effect.kind === "rule-assumption"),
    "PENDING-VERIFICATION deficit 语义不得伪装成已验证 MATCH",
  );
});

test("S5: deficit 同距按 raw UUID 序受伤", () => {
  // 22 units：20 个近（分布在 [1..10, 0/1]，每格 ≤2）+ 2 个同距远（距离 5）
  // due 1 → deficit 1 → 伤害打在 2 个远者中 UUID 较低的
  const near = Array.from({ length: 20 }, (_, i) => ({ id: uuid(i + 1), position: [1 + Math.floor(i / 2), i % 2] as Position }));
  const farA = { id: uuid(50), position: [20, 0] as Position };
  const farB = { id: uuid(40), position: [0, 20] as Position };
  const world = makeWorld([{ id: "p1", resources: 0, core: [0, 0], units: [...near, farA, farB] }], undefined, "v0.11");
  const result = settleTick(world, new Map([["p1", idlePlans(world).get("p1")!]]), ctxV011);
  const damaged = result.events.filter((e) => e.eventType === "UNIT_DAMAGED");
  assert.equal(damaged.length, 1);
  // 同距（5）→ 较低 raw UUID（uuid(40)）先受伤
  assert.equal(damaged[0].targetId, uuid(40));
});

/* ---------------- capacity / self-destruct ---------------- */

test("S5: capacity floor 10（population 1 → cap 10，超量销毁）", () => {
  const world = makeWorld([{ id: "p1", resources: 12, core: [0, 0], units: [{ id: uuid(1), position: [1, 0] }] }]);
  const result = settle(world, new Map([["p1", idlePlans(world).get("p1")!]]));
  assert.equal(result.world.players.get("p1")!.resources, 10, "cap = max(10, 1×5) = 10，超量 2 销毁");
  const overflow = result.events.find((e) => e.eventType === "CORE_RESOURCE_OVERFLOW_DESTROYED");
  assert.ok(overflow, "overflow event missing");
  assert.deepEqual(overflow!.values, { amount: 2, capacity: 10 });
});

test("S5: self-destruct 后容量收缩 → overflow 销毁", () => {
  // 1 worker + 资源 12：cap = max(10, 1×5) = 10？不对——资源 12 > cap 10 已经超了。
  // 构造：3 workers（cap 15）+ 资源 15 → self-destruct 2 个 → population 1 → cap 10 → 销毁 5
  const units = Array.from({ length: 3 }, (_, i) => ({ id: uuid(i + 1), position: [1 + i, 0] as Position }));
  const world = makeWorld([{ id: "p1", resources: 15, core: [0, 0], units }]);
  const actions: Record<string, UnitAction> = {
    [uuid(2)]: { type: "SELF_DESTRUCT" },
    [uuid(3)]: { type: "SELF_DESTRUCT" },
  };
  const plan = planFor(world, "p1", actions);
  const result = settle(world, new Map([["p1", plan]]));
  const player = result.world.players.get("p1")!;
  assert.equal(player.units.length, 1);
  assert.equal(player.resources, 10, "cap 收缩到 10，超量 5 销毁");
  const overflow = result.events.find((e) => e.eventType === "CORE_RESOURCE_OVERFLOW_DESTROYED");
  assert.ok(overflow, "overflow event missing");
  assert.deepEqual(overflow!.values, { amount: 5, capacity: 10 });
  assert.ok(
    result.events.findIndex((event) => event.eventType === "UNIT_SELF_DESTRUCTED") <
      result.events.findIndex((event) => event.eventType === "CORE_RESOURCE_OVERFLOW_DESTROYED"),
    "事件必须保留 phase 顺序",
  );
});

test("S5: self-destruct Worker cargo 形成持久资源堆并发事件", () => {
  const worker = { id: uuid(1), position: [3, 0] as Position, cargo: 2 };
  const world = makeWorld([{ id: "p1", resources: 5, core: [0, 0], units: [worker] }]);
  const result = settle(
    world,
    new Map([["p1", planFor(world, "p1", { [worker.id]: { type: "SELF_DESTRUCT" } })]]),
  );
  assert.equal(result.world.terrain.piles.get("3,0")?.amount, 2);
  const dropped = result.events.find((event) => event.eventType === "WORKER_CARGO_DROPPED");
  assert.deepEqual(dropped?.values, { amount: 2 });
  assert.ok(eventTypes(result).includes("UNIT_SELF_DESTRUCTED"));
});

test("S5: upkeep 杀死 Worker 只产生 damage/cargo-drop，不伪造 self-destruct", () => {
  const near = Array.from({ length: 19 }, (_, i) => ({
    id: uuid(i + 1),
    position: [1 + Math.floor(i / 2), i % 2] as Position,
  }));
  const far = { id: uuid(30), position: [30, 0] as Position, hp: 1, cargo: 2 };
  const world = makeWorld([{ id: "p1", resources: 0, core: [0, 0], units: [...near, far] }], undefined, "v0.11");
  const result = settleTick(world, new Map([["p1", idlePlans(world).get("p1")!]]), ctxV011);
  assert.equal(result.world.players.get("p1")!.units.some((unit) => unit.id === far.id), false);
  assert.equal(result.world.terrain.piles.get("30,0")?.amount, 2);
  assert.ok(eventTypes(result).includes("WORKER_CARGO_DROPPED"));
  assert.equal(eventTypes(result).includes("UNIT_SELF_DESTRUCTED"), false);
});

/* ---------------- harvest ---------------- */

test("S5: harvest 成功——消耗节点 + cargo +1", () => {
  const world = makeWorld(
    [{ id: "p1", resources: 5, core: [0, 0], units: [{ id: uuid(1), position: [3, 0] }] }],
    { resources: [[3, 0]] },
  );
  const plan = planFor(world, "p1", { [uuid(1)]: { type: "HARVEST" } });
  const result = settle(world, new Map([["p1", plan]]));
  const unit = result.world.players.get("p1")!.units[0];
  assert.equal(unit.cargo, 1);
  assert.equal(result.world.terrain.resources.has("3,0"), false, "node consumed");
  const ev = result.events.find((e) => e.eventType === "HARVEST_SUCCEEDED")!;
  assert.deepEqual(ev.values, { amount: 1, source: "RESOURCE_NODE" });
});

test("S5: harvest 失败——CARGO_FULL / NOT_RESOURCE_CELL", () => {
  const world = makeWorld(
    [{ id: "p1", resources: 5, core: [0, 0], units: [{ id: uuid(1), position: [3, 0], cargo: 1 }] }],
    { resources: [[3, 0]] },
  );
  const plan = planFor(world, "p1", { [uuid(1)]: { type: "HARVEST" } });
  const result = settle(world, new Map([["p1", plan]]));
  assert.ok(eventTypes(result).includes("HARVEST_FAILED"));
  assert.equal(result.events.find((e) => e.eventType === "HARVEST_FAILED")!.reasonCode, "CARGO_FULL");

  const world2 = makeWorld([{ id: "p1", resources: 5, core: [0, 0], units: [{ id: uuid(1), position: [4, 0] }] }]);
  const result2 = settle(world2, new Map([["p1", planFor(world2, "p1", { [uuid(1)]: { type: "HARVEST" } })]]));
  assert.equal(result2.events.find((e) => e.eventType === "HARVEST_FAILED")!.reasonCode, "NOT_RESOURCE_CELL");
});

test("S5: 多 Worker 同资源格——最低 UUID 赢", () => {
  const u1 = uuid(10);
  const u2 = uuid(5);
  const world = makeWorld(
    [{ id: "p1", resources: 5, core: [0, 0], units: [{ id: u1, position: [3, 0] }, { id: u2, position: [3, 0] }] }],
    { resources: [[3, 0]] },
  );
  const plan = planFor(world, "p1", { [u1]: { type: "HARVEST" }, [u2]: { type: "HARVEST" } });
  const result = settle(world, new Map([["p1", plan]]));
  const player = result.world.players.get("p1")!;
  assert.equal(player.units.find((u) => u.id === u2)!.cargo, 1, "lower UUID wins");
  assert.equal(player.units.find((u) => u.id === u1)!.cargo, 0);
  const failed = result.events.find((e) => e.eventType === "HARVEST_FAILED")!;
  assert.equal(failed.actorId, u1);
  assert.equal(failed.reasonCode, "RESOURCE_DEPLETED");
});

test("S5: 未提交 HARVEST 的低 UUID Worker 不参与争抢", () => {
  const actor = uuid(10);
  const idle = uuid(1);
  const world = makeWorld(
    [{ id: "p1", resources: 5, core: [0, 0], units: [{ id: actor, position: [3, 0] }, { id: idle, position: [3, 0] }] }],
    { resources: [[3, 0]] },
  );
  const result = settle(world, new Map([["p1", planFor(world, "p1", { [actor]: { type: "HARVEST" } })]]));
  assert.equal(result.world.players.get("p1")!.units.find((unit) => unit.id === actor)!.cargo, 1);
  assert.equal(result.world.players.get("p1")!.units.find((unit) => unit.id === idle)!.cargo, 0);
});

test("S5: dropped cargo 优先于自然节点，单次最多恢复 Worker 容量", () => {
  const worker = uuid(1);
  const world = makeWorld(
    [{ id: "p1", resources: 5, core: [0, 0], units: [{ id: worker, position: [3, 0] }] }],
    { resources: [[3, 0]], piles: [{ cell: [3, 0], amount: 3 }] },
  );
  const result = settle(world, new Map([["p1", planFor(world, "p1", { [worker]: { type: "HARVEST" } })]]));
  assert.equal(result.world.players.get("p1")!.units[0].cargo, 2);
  assert.equal(result.world.terrain.piles.get("3,0")?.amount, 1);
  assert.equal(result.world.terrain.resources.has("3,0"), true, "回收 pile 不应消耗自然节点");
  assert.deepEqual(result.events.find((event) => event.eventType === "HARVEST_SUCCEEDED")?.values, {
    amount: 2,
    source: "DROPPED_CARGO",
  });
});

/* ---------------- deposit ---------------- */

test("S5: deposit 成功/partial/full", () => {
  // 成功：cargo 1 → resources+1
  const world = makeWorld([{ id: "p1", resources: 5, core: [0, 0], units: [{ id: uuid(1), position: [0, 0], cargo: 1 }] }]);
  const result = settle(world, new Map([["p1", planFor(world, "p1", { [uuid(1)]: { type: "DEPOSIT" } })]]));
  const player = result.world.players.get("p1")!;
  assert.equal(player.resources, 6);
  assert.equal(player.units[0].cargo, 0);
  const ev = result.events.find((e) => e.eventType === "DEPOSIT_SUCCEEDED")!;
  assert.deepEqual(ev.values, { amount: 1, capacity: 10, remaining: 0 });

  // full：resources 已满 cap → CORE_RESOURCE_FULL，cargo 保留
  const world2 = makeWorld([{ id: "p1", resources: 10, core: [0, 0], units: [{ id: uuid(1), position: [0, 0], cargo: 1 }] }]);
  const result2 = settle(world2, new Map([["p1", planFor(world2, "p1", { [uuid(1)]: { type: "DEPOSIT" } })]]));
  const ev2 = result2.events.find((e) => e.eventType === "DEPOSIT_FAILED")!;
  assert.equal(ev2.reasonCode, "CORE_RESOURCE_FULL");
  assert.equal(result2.world.players.get("p1")!.units[0].cargo, 1);
});

/* ---------------- spawn ---------------- */

test("S5: spawn 成功（扣费 + 新单位在 Core 格）", () => {
  const world = makeWorld([{ id: "p1", resources: 5, core: [0, 0], units: [] }]);
  const plan = planFor(world, "p1", {}, { type: "SPAWN", unitType: "WORKER" });
  const result = settle(world, new Map([["p1", plan]]));
  const player = result.world.players.get("p1")!;
  assert.equal(player.resources, 0);
  assert.equal(player.units.length, 1);
  assert.deepEqual(player.units[0].position, [0, 0]);
  const ev = result.events.find((e) => e.eventType === "CORE_SPAWN_SUCCEEDED")!;
  assert.deepEqual(ev.values, { unit_type: "WORKER", cost: 5 });
  assert.match(ev.targetId!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(result.unknownEffects.some((effect) => effect.kind === "server-generated-id"));
});

test("S5: spawn 失败——资源不足 / Core 格满", () => {
  const world = makeWorld([{ id: "p1", resources: 3, core: [0, 0], units: [] }]);
  const result = settle(world, new Map([["p1", planFor(world, "p1", {}, { type: "SPAWN", unitType: "WORKER" })]]));
  const ev = result.events.find((e) => e.eventType === "CORE_SPAWN_FAILED")!;
  assert.equal(ev.reasonCode, "INSUFFICIENT_RESOURCES");
  assert.deepEqual(ev.values, { required: 5 });

  const world2 = makeWorld([{ id: "p1", resources: 20, core: [0, 0], units: [{ id: uuid(1), position: [0, 0] }] }]);
  const result2 = settle(world2, new Map([["p1", planFor(world2, "p1", {}, { type: "SPAWN", unitType: "WORKER" })]]));
  const ev2 = result2.events.find((e) => e.eventType === "CORE_SPAWN_FAILED")!;
  assert.equal(ev2.reasonCode, "CELL_UNIT_LIMIT");
});

/* ---------------- heal / repair ---------------- */

test("S5: unit heal 成功/HP_FULL/不在 Core 格", () => {
  const world = makeWorld([{ id: "p1", resources: 5, core: [0, 0], units: [{ id: uuid(1), position: [0, 0], hp: 1 }] }]);
  const result = settle(world, new Map([["p1", planFor(world, "p1", { [uuid(1)]: { type: "HEAL" } })]]));
  const unit = result.world.players.get("p1")!.units[0];
  assert.equal(unit.hp, 2);
  assert.equal(result.world.players.get("p1")!.resources, 4);
  assert.ok(eventTypes(result).includes("UNIT_HEAL_SUCCEEDED"));

  const world2 = makeWorld([{ id: "p1", resources: 5, core: [0, 0], units: [{ id: uuid(1), position: [0, 0], hp: 2 }] }]);
  const result2 = settle(world2, new Map([["p1", planFor(world2, "p1", { [uuid(1)]: { type: "HEAL" } })]]));
  assert.equal(result2.events.find((e) => e.eventType === "UNIT_HEAL_FAILED")!.reasonCode, "HP_FULL");
});

test("S5: Vanguard HEAL 使用 Vanguard HP 上限而非 Worker 上限", () => {
  const vanguard = uuid(1);
  const world = makeWorld([
    {
      id: "p1",
      resources: 5,
      core: [0, 0],
      units: [{ id: vanguard, position: [0, 0], hp: 1, unitType: "VANGUARD" }],
    },
  ]);
  const result = settle(world, new Map([["p1", planFor(world, "p1", { [vanguard]: { type: "HEAL" } })]]));
  assert.equal(result.world.players.get("p1")!.units[0].hp, 4);
  assert.equal(result.world.players.get("p1")!.resources, 2);
  assert.deepEqual(result.events.find((event) => event.eventType === "UNIT_HEAL_SUCCEEDED")?.values, {
    amount: 3,
    hp: 4,
    cost: 3,
  });
});

test("S5: repair shield 成功", () => {
  const world = worldFromScenario({
    rulesVersion: "v0.14",
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 5,
        core: { id: coreUuid("p1"), position: [0, 0], hp: 5, shield: 4, state: "NORMAL" },
        units: [],
      },
    ],
    terrain: { obstacles: [], resources: [] },
  });
  const result = settle(world, new Map([["p1", planFor(world, "p1", {}, { type: "REPAIR_SHIELD" })]]));
  assert.equal(result.world.players.get("p1")!.core!.shield, 5);
  assert.equal(result.world.players.get("p1")!.resources, 4);
  assert.ok(eventTypes(result).includes("CORE_REPAIR_SUCCEEDED"));
});

test("S5: MOVING Core 拒绝 deposit/heal/Core action，并标记 migration unsupported", () => {
  const worker = uuid(1);
  const world = worldFromScenario({
    rulesVersion: "v0.14",
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 10,
        core: { id: coreUuid("p1"), position: [0, 0], hp: 4, shield: 4, state: "MOVING" },
        units: [{ id: worker, owner: "p1", position: [0, 0], hp: 1, unitType: "WORKER", cargo: 1 }],
      },
    ],
    terrain: { obstacles: [], resources: [] },
  });
  const deposit = settle(
    world,
    new Map([["p1", planFor(world, "p1", { [worker]: { type: "DEPOSIT" } }, { type: "HEAL" })]]),
  );
  assert.equal(deposit.events.find((event) => event.eventType === "DEPOSIT_FAILED")?.reasonCode, "CORE_MOVING");
  assert.equal(deposit.events.find((event) => event.eventType === "CORE_ACTION_FAILED")?.reasonCode, "CORE_ALREADY_MOVING");
  assert.ok(deposit.unsupported.includes("core-migration"));

  const heal = settle(
    world,
    new Map([["p1", planFor(world, "p1", { [worker]: { type: "HEAL" } })]]),
  );
  assert.equal(heal.events.find((event) => event.eventType === "UNIT_HEAL_FAILED")?.reasonCode, "CORE_MOVING");
});

/* ---------------- 经济闭环 + soak ---------------- */

test("S5: harvest→deposit 经济闭环（资源增长）", () => {
  // worker 在资源格 harvest 后移动回 Core 格 deposit（跨 2 tick）
  let world = makeWorld(
    [{ id: "p1", resources: 5, core: [0, 0], units: [{ id: uuid(1), position: [3, 0] }] }],
    { resources: [[3, 0]] },
  );
  // tick 1: harvest
  let result = settle(world, new Map([["p1", planFor(world, "p1", { [uuid(1)]: { type: "HARVEST" } })]]));
  world = result.world;
  assert.equal(world.players.get("p1")!.units[0].cargo, 1);
  // tick 2-4: 移动回 Core（[3,0]→[2,0]→[1,0]→[0,0]）
  for (let step = 0; step < 3; step += 1) {
    result = settle(world, new Map([["p1", planFor(world, "p1", { [uuid(1)]: { type: "MOVE", direction: "LEFT" } })]]));
    world = result.world;
  }
  assert.deepEqual(world.players.get("p1")!.units[0].position, [0, 0], "worker back at core");
  // tick 5: deposit
  result = settle(world, new Map([["p1", planFor(world, "p1", { [uuid(1)]: { type: "DEPOSIT" } })]]));
  assert.equal(result.world.players.get("p1")!.resources, 6, "5 + 1 deposit");
  assert.equal(result.world.players.get("p1")!.units[0].cargo, 0);
});

test("S5: 10000 Tick economy soak 无 invariant failure", () => {
  const world = makeWorld(
    [{ id: "p1", resources: 5, core: [0, 0], units: [{ id: uuid(1), position: [1, 0] }] }],
    { resources: [[2, 0]] },
  );
  let current = world;
  for (let tick = 0; tick < 10_000; tick += 1) {
    current = settle(current, new Map([["p1", idlePlans(current).get("p1")!]])).world;
  }
  assert.equal(current.resolvedTickCount, 10_000);
  assert.equal(current.players.get("p1")!.units.length, 1);
});


test("S5/S11: Beacon carrier self-destruct 后同 Tick 不可被同格对象重拾", () => {
  const carrier = uuid(90);
  const contender = uuid(91);
  const world = worldFromScenario({
    rulesVersion: "v0.14",
    tick: 1,
    seed: 42,
    players: [{
      id: "p1",
      username: "p1",
      resources: 5,
      core: { id: coreUuid("p1"), position: [0, 0], hp: 5, shield: 7, state: "NORMAL" },
      units: [
        { id: carrier, owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
        { id: contender, owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
      ],
    }],
    terrain: { obstacles: [], resources: [] },
    beacon: { position: [1, 0], status: "CARRIED", carrierId: carrier },
  });
  const first = settle(world, new Map([["p1", planFor(world, "p1", {
    [carrier]: { type: "SELF_DESTRUCT" },
    [contender]: { type: "PICKUP_BEACON" },
  })]]));
  assert.equal(first.world.beacon?.status, "GROUND");
  assert.equal(first.world.beacon?.carrierId, null);
  assert.equal(first.world.players.get("p1")!.core!.shield, 5);
  assert.ok(first.events.some((event) => event.eventType === "BEACON_DROPPED_ON_DEATH"));
  assert.ok(!first.events.some((event) => event.eventType === "BEACON_PICKED_UP"));

  const second = settle(first.world, new Map([["p1", planFor(first.world, "p1", {
    [contender]: { type: "PICKUP_BEACON" },
  })]]));
  assert.equal(second.world.beacon?.status, "CARRIED");
  assert.equal(second.world.beacon?.carrierId, contender);
});
/* ---------------- v0.14 动态价格（默认规则路径；v0.11 语义见上方显式回退） ---------------- */

test("S5: spawn 按存活人口计价（pop=20 → 6.5→7），CORE_SPAWN_SUCCEEDED.cost 报实付价", () => {
  const units = Array.from({ length: 20 }, (_, i) => ({ id: uuid(i + 1), position: [1 + i, 0] as Position }));
  const world = makeWorld([{ id: "p1", resources: 100, core: [0, 0], units }]);
  const plan = planFor(world, "p1", {}, { type: "SPAWN", unitType: "WORKER" });
  const result = settle(world, new Map([["p1", plan]]));
  const spawn = result.events.find((e) => e.eventType === "CORE_SPAWN_SUCCEEDED");
  assert.ok(spawn, "CORE_SPAWN_SUCCEEDED missing");
  assert.equal(spawn!.values!.cost, 7);
  assert.equal(result.world.players.get("p1")!.resources, 100 - 7);
  assert.equal(result.world.players.get("p1")!.units.length, 21);
});

test("S5: 维护机制整体移除（无 UPKEEP_PAID/UPKEEP_DEFICIT，unit 不受损）", () => {
  // 21 单位 + 0 resources：v0.11 语义会 UPKEEP_PAID(deficit) + UNIT_DAMAGED；
  // v0.14 维护整体移除，不产生任何维护/判伤事件。
  const units = Array.from({ length: 21 }, (_, i) => ({ id: uuid(i + 1), position: [1 + i, 0] as Position }));
  const world = makeWorld([{ id: "p1", resources: 0, core: [0, 0], units }]);
  const result = settle(world, new Map([["p1", idlePlans(world).get("p1")!]]));
  const maintenanceEvents = result.events.filter(
    (e) => e.eventType === "UPKEEP_PAID" || e.eventType === "UPKEEP_DEFICIT" || e.eventType === "UNIT_DAMAGED",
  );
  assert.deepEqual(maintenanceEvents, []);
  assert.equal(result.world.players.get("p1")!.units.length, 21);
  assert.equal(result.world.players.get("p1")!.resources, 0);
});
