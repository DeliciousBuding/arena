/**
 * W50 outcome.jsonl 经济计数器测试（P0；W51 fitness 硬前置）。
 *
 * 覆盖两档：
 * 1. 纯函数 countOutcomeEvents：合成事件流断言四计数器
 *    （grossDeposit=7 / spawnCount=1 / healCount=2 / unitLossCount=1，
 *     CORE_RESOURCE_OVERFLOW_DESTROYED 不计 unitLoss）。
 * 2. calibration 回放：真实 settleTick 事件流 → countOutcomeEvents
 *    四字段非负 + 守恒抽查（grossDeposit ≤ coreResourceDelta + 支出），
 *    且 events 数组不被函数修改；schema 校验通过。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CoreAction, Plan, Position, UnitAction, UnitType } from "../src/domain/model.ts";
import { countOutcomeEvents, OUTCOME_COUNT_EVENT_TYPES, type OutcomeCountEvent } from "../src/telemetry/decision-trace.ts";
import { OutcomeTraceSchema } from "../src/telemetry/schema.ts";
import { Value } from "typebox/value";
import { loadRulesManifest } from "../src/sim/contracts/rules-manifest.ts";
import { createSeededRng } from "../src/sim/deterministic/rng.ts";
import { idlePlans, settleTick, type SettlementContext } from "../src/sim/engine/settlement.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";
import type { SimWorld } from "../src/sim/world/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..", "..");
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.14.json");
const rules = loadRulesManifest(MANIFEST_PATH);
const rng = createSeededRng(42);
const ctx: SettlementContext = { rules, rng: () => rng.next() };

/** 固定序号 UUID（raw 序 = 数字序）。 */
const uuid = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

const P1_CORE = "11111111-1111-1111-1111-111111111111";

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
): SimWorld {
  return worldFromScenario({
    rulesVersion: "v0.14",
    tick: 1,
    players: players.map((p) => ({
      id: p.id,
      username: p.username ?? p.id,
      resources: p.resources,
      core:
        p.core === undefined || p.core === null
          ? null
          : { id: coreUuid(p.id), position: p.core, hp: 5, shield: 5, state: "NORMAL" },
      units: p.units.map((u) => ({
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
    p1: P1_CORE,
    p2: "22222222-2222-2222-2222-222222222222",
  };
  return table[playerId] ?? "33333333-3333-3333-3333-333333333333";
}

function planFor(
  world: SimWorld,
  actions: Readonly<Record<string, UnitAction>>,
  coreAction: CoreAction | null = null,
): Plan {
  const unitActions: Record<string, UnitAction> = { ...actions };
  return { tick: world.tick, unitActions, coreAction, intents: {} };
}

/** 合成事件构造器：只填 eventType + values，模拟 sim 引擎发射形态。 */
function syntheticEvent(
  eventType: string,
  values: Record<string, unknown> = {},
): OutcomeCountEvent {
  return { eventType, values };
}

/* ---------------- 纯函数合成事件断言 ---------------- */

test("W50: 合成事件流 → grossDeposit=7 / spawnCount=1 / healCount=2 / unitLossCount=1", () => {
  const events: readonly OutcomeCountEvent[] = [
    // 两次卸货：3 + 4 = 7（grossDeposit）
    syntheticEvent(OUTCOME_COUNT_EVENT_TYPES.DEPOSIT_SUCCEEDED, { amount: 3, capacity: 10, remaining: 0 }),
    syntheticEvent(OUTCOME_COUNT_EVENT_TYPES.DEPOSIT_SUCCEEDED, { amount: 4, capacity: 10, remaining: 0 }),
    // 一次产出
    syntheticEvent(OUTCOME_COUNT_EVENT_TYPES.CORE_SPAWN_SUCCEEDED, { unit_type: "WORKER", cost: 5 }),
    // 两次治疗：unit + core（healCount，不含 REPAIR）
    syntheticEvent(OUTCOME_COUNT_EVENT_TYPES.UNIT_HEAL_SUCCEEDED, { amount: 1, hp: 2, cost: 1 }),
    syntheticEvent(OUTCOME_COUNT_EVENT_TYPES.CORE_HEAL_SUCCEEDED, { amount: 2, hp: 5, cost: 2 }),
    // 一次单位损失
    syntheticEvent(OUTCOME_COUNT_EVENT_TYPES.UNIT_SELF_DESTRUCTED, {}),
  ];
  const counts = countOutcomeEvents(events);
  assert.equal(counts.grossDeposit, 7);
  assert.equal(counts.spawnCount, 1);
  assert.equal(counts.healCount, 2);
  assert.equal(counts.unitLossCount, 1);
});

test("W50: CORE_RESOURCE_OVERFLOW_DESTROYED 不计 unitLoss（显式名单拦截）", () => {
  const events: readonly OutcomeCountEvent[] = [
    // 容量溢出销毁资源（W45 新事件）——非单位损失
    syntheticEvent("CORE_RESOURCE_OVERFLOW_DESTROYED", { amount: 4, capacity: 10 }),
    // CORE_DESTROYED 也不计 unitLoss（核心摧毁，非单位损失）
    syntheticEvent("CORE_DESTROYED", { reasonCode: "ATTACK" }),
    // REPAIR 不算 heal
    syntheticEvent("CORE_REPAIR_SUCCEEDED", { amount: 1, cost: 1 }),
    // 真正的单位损失
    syntheticEvent(OUTCOME_COUNT_EVENT_TYPES.UNIT_DESTROYED, {}),
    syntheticEvent(OUTCOME_COUNT_EVENT_TYPES.UNIT_SELF_DESTRUCTED, {}),
  ];
  const counts = countOutcomeEvents(events);
  assert.equal(counts.unitLossCount, 2, "仅 UNIT_DESTROYED + UNIT_SELF_DESTRUCTED");
  assert.equal(counts.healCount, 0, "REPAIR 不计 heal");
  assert.equal(counts.grossDeposit, 0);
  assert.equal(counts.spawnCount, 0);
});

test("W50: DEPOSIT_SUCCEEDED.amount 缺失/非有限数 → 0 贡献（不抛错）", () => {
  const events: readonly OutcomeCountEvent[] = [
    syntheticEvent(OUTCOME_COUNT_EVENT_TYPES.DEPOSIT_SUCCEEDED, {}), // amount 缺失
    syntheticEvent(OUTCOME_COUNT_EVENT_TYPES.DEPOSIT_SUCCEEDED, { amount: "oops" }), // 非数
    syntheticEvent(OUTCOME_COUNT_EVENT_TYPES.DEPOSIT_SUCCEEDED, { amount: Number.NaN }), // NaN
    syntheticEvent(OUTCOME_COUNT_EVENT_TYPES.DEPOSIT_SUCCEEDED, { amount: Number.POSITIVE_INFINITY }), // Infinity
    syntheticEvent(OUTCOME_COUNT_EVENT_TYPES.DEPOSIT_SUCCEEDED, { amount: 2 }), // 有效
  ];
  const counts = countOutcomeEvents(events);
  assert.equal(counts.grossDeposit, 2, "仅有限数值 amount 累计");
});

test("W50: 输入数组不被修改（透传只读引用）", () => {
  const events: OutcomeCountEvent[] = [
    syntheticEvent(OUTCOME_COUNT_EVENT_TYPES.DEPOSIT_SUCCEEDED, { amount: 1 }),
    syntheticEvent(OUTCOME_COUNT_EVENT_TYPES.UNIT_SELF_DESTRUCTED, {}),
  ];
  const snapshot = events.map((e) => ({ ...e, values: { ...e.values } }));
  countOutcomeEvents(events);
  assert.deepEqual(events, snapshot, "events 数组与元素结构不被函数修改");
});

/* ---------------- calibration 回放：守恒抽查 ---------------- */

test("W50: calibration 回放 outcome 四字段非负 + 守恒（grossDeposit ≤ delta + 支出）", () => {
  // 场景：worker1 卸货 2 + core HEAL（Core 格 occupancy 上限 2 = core+1，
  //   任何 worker 在 Core 格即阻塞 SPAWN，故用 CORE_HEAL 制造支出；
  //   workerCargoCapacity=2）。Core hp 4 → 5，healCostPerHp=1。
  //   resources: 5 → +2(deposit) → -1(core heal) = 6
  //   coreResourceDelta = 6 - 5 = 1
  //   grossDeposit = 2, 支出 = healCost(1) = 1
  //   守恒：grossDeposit(2) ≤ delta(1) + 支出(1) = 2 ✓（等式）
  const world = makeWorld([{
    id: "p1",
    resources: 5,
    core: [0, 0] as [number, number],
    units: [
      { id: uuid(1), position: [0, 0], cargo: 2 }, // depositor
    ],
  }]);
  // Core hp 显式设为 4（< maxHp 5）以触发 CORE_HEAL_SUCCEEDED。
  (world.players.get("p1")!.core as { hp: number }).hp = 4;
  const plan = planFor(
    world,
    { [uuid(1)]: { type: "DEPOSIT" } },
    { type: "HEAL" }, // coreAction: Core 自愈
  );
  const result = settleTick(world, new Map([["p1", plan]]), ctx);
  const eventsBefore = [...result.events];
  const counts = countOutcomeEvents(result.events);

  // 四字段非负
  assert.ok(counts.grossDeposit >= 0, "grossDeposit 非负");
  assert.ok(counts.spawnCount >= 0, "spawnCount 非负");
  assert.ok(counts.healCount >= 0, "healCount 非负");
  assert.ok(counts.unitLossCount >= 0, "unitLossCount 非负");

  // 本场景应触发 deposit(2) + core heal(1)
  assert.equal(counts.grossDeposit, 2, "卸货总量 = 2");
  assert.equal(counts.spawnCount, 0, "本场景无 spawn");
  assert.equal(counts.healCount, 1, "一次 core heal（不含 repair）");
  assert.equal(counts.unitLossCount, 0, "无单位损失");

  // 守恒：grossDeposit ≤ coreResourceDelta + 支出
  const resourcesBefore = 5;
  const resourcesAfter = result.world.players.get("p1")!.resources;
  const coreResourceDelta = resourcesAfter - resourcesBefore;
  const spawnCost = result.events
    .filter((e) => e.eventType === OUTCOME_COUNT_EVENT_TYPES.CORE_SPAWN_SUCCEEDED)
    .reduce((sum, e) => sum + (typeof e.values?.cost === "number" ? (e.values.cost as number) : 0), 0);
  const healCost = result.events
    .filter((e) =>
      e.eventType === OUTCOME_COUNT_EVENT_TYPES.UNIT_HEAL_SUCCEEDED
      || e.eventType === OUTCOME_COUNT_EVENT_TYPES.CORE_HEAL_SUCCEEDED)
    .reduce((sum, e) => sum + (typeof e.values?.cost === "number" ? (e.values.cost as number) : 0), 0);
  const spending = spawnCost + healCost;
  assert.ok(
    counts.grossDeposit <= coreResourceDelta + spending + 1e-9,
    `守恒失败：grossDeposit(${counts.grossDeposit}) > delta(${coreResourceDelta}) + 支出(${spending})`,
  );

  // events 数组不被函数修改（只读透传）
  assert.deepEqual(result.events, eventsBefore, "countOutcomeEvents 不修改输入 events");
});

test("W50: outcome.jsonl schema 校验通过（含四计数器字段）", () => {
  // 构造一个最小合法的 OutcomeTraceRecord，附四计数器，过 schema。
  const record = {
    processRunId: "proc-1",
    tenantId: "t1",
    tick: 7,
    coreResourcesBefore: 5,
    coreResourcesAfter: 8,
    coreResourceDelta: 3,
    grossDeposit: 3,
    spawnCount: 1,
    healCount: 0,
    unitLossCount: 0,
    events: ["DEPOSIT_SUCCEEDED", "CORE_SPAWN_SUCCEEDED"],
  };
  assert.ok(Value.Check(OutcomeTraceSchema, record), "OutcomeTraceSchema 应接受含四计数器的 record");
});

test("W50: schema 仍接受缺省四计数器（向后兼容，旧 jsonl 不破坏）", () => {
  const record = {
    processRunId: "proc-1",
    tenantId: "t1",
    tick: 7,
    coreResourcesBefore: 5,
    coreResourcesAfter: 5,
    coreResourceDelta: 0,
    events: [],
  };
  assert.ok(Value.Check(OutcomeTraceSchema, record), "四计数器缺省时 schema 仍通过（Optional）");
});

// 静态引用，防止未使用告警（REPO_ROOT 用于路径可读性核对）。
void REPO_ROOT;
void idlePlans;
