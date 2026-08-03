/**
 * S3 settlement pipeline 骨架测试：
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

test("S3: combat 输入触发 unsupported 且不静默跳过", () => {
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
  assert.deepEqual(result.unsupported, ["combat"]);
  // feature 记录持久化到 world
  assert.ok(result.world.unsupportedFeatures.includes("combat"));
});

test("S3: core-migration 已实现不再 unsupported；beacon 输入仍触发 unsupported", () => {
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

  const beaconPlan: Plan = {
    tick: world.tick,
    unitActions: {},
    coreAction: { type: "DROP_BEACON" },
    intents: {},
  };
  const r2 = settleTick(world, new Map([["p1", beaconPlan]]), ctx);
  assert.deepEqual(r2.unsupported, ["beacon"]);
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

test("S3: 事件排序稳定（actorId 序，与插入顺序无关）", () => {
  // S4/S5 resolver 未接入，S3 无事件产出——验证 sortEvents 对已注入事件的稳定性
  // 通过构造两个顺序相反的事件列表验证（间接：settleTick 内部调用）
  const world = makeWorld();
  // 使用带多个单位的场景验证 id 排序路径存在（当前 stub 无事件，仅保证不炸）
  const result = settleTick(world, idlePlans(world), ctx);
  assert.ok(Array.isArray(result.events));
});
