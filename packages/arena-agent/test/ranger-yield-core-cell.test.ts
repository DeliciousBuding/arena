/**
 * Ranger 守位让位测试（2026-08-07，生产 t2 实证修复）：
 * Ranger 无可见敌人时守位目标 = Core 格本身 → Core 格 cell 容量 2 满
 * （Core+Ranger）→ 带 cargo Worker 无法进入 DEPOSIT → 经济永久停摆
 * （t2 资源恒 3、>600 tick 0 动作）。修复：Ranger 守位锚点改用
 * homeCell（Core 四邻轮转，与 Vanguard 对齐），满血已在 Core 格则
 * 移出让出回仓通道。settle 链验证：让位后 Worker 进 Core 格 DEPOSIT
 * 成功、经济恢复。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import type { CoreAction, Plan, Position, TickState, UnitAction, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import { loadRulesManifest } from "../src/sim/contracts/rules-manifest.ts";
import { settleTick } from "../src/sim/engine/settlement.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.11.json");
const rules = loadRulesManifest(MANIFEST_PATH);
const ctx = { rules, rng: null };

const P1_CORE = "11111111-1111-1111-1111-111111111111";
const P1_RANGER = "22222222-2222-2222-2222-222222222222";
const P1_WORKER = "33333333-3333-3333-3333-333333333333";
const P2_CORE = "44444444-4444-4444-4444-444444444444";

function makeState(tick: number, rangerPosition: Position, enemies: VisibleEntity[] = []): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 2,
    core: { id: P1_CORE, position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [
      { id: P1_RANGER, position: rangerPosition, hp: 2, unitType: "RANGER", cargo: 0 },
      { id: P1_WORKER, position: [1, 0], hp: 2, unitType: "WORKER", cargo: 1 },
    ],
    workers: [{ id: P1_WORKER, position: [1, 0], hp: 2, unitType: "WORKER", cargo: 1 }],
    vanguards: [],
    rangers: [{ id: P1_RANGER, position: rangerPosition, hp: 2, unitType: "RANGER", cargo: 0 }],
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

test("Ranger 满血站在 Core 格、无敌人 → 让位（ranger_home，移出回仓通道）", () => {
  const planner = new SafetyPlanner();
  const plan = planner.decide({ state: makeState(1, [0, 0]) });
  assert.equal(plan.intents[P1_RANGER], "ranger_home", "守位锚点应为 Core 邻格而非 Core 格");
  const action = plan.unitActions[P1_RANGER];
  assert.equal(action.type, "MOVE");
  // Core [0,0] 四邻：UP [0,-1]（非障碍）→ homeCell 首选 UP
  assert.equal(action.type === "MOVE" ? action.direction : null, "UP");
});

test("Ranger 不在 Core 格、无敌人 → 守位 homeCell（原行为回归）", () => {
  const planner = new SafetyPlanner();
  const plan = planner.decide({ state: makeState(1, [2, 0]) });
  assert.equal(plan.intents[P1_RANGER], "ranger_move", "回守位锚点");
  const action = plan.unitActions[P1_RANGER];
  assert.equal(action.type, "MOVE");
  assert.equal(action.type === "MOVE" ? action.direction : null, "LEFT", "[2,0] → 锚点 [0,-1] 需先左移");
});

test("Ranger 受伤在 Core 格 → 治疗优先（HEAL，占格是短时的）", () => {
  const planner = new SafetyPlanner();
  const base = makeState(1, [0, 0]);
  const state: TickState = {
    ...base,
    units: [{ ...base.units[0], hp: 1 }, { ...base.units[1] }],
    rangers: [{ ...base.rangers[0], hp: 1 }],
  };
  const plan = planner.decide({ state });
  const action = plan.unitActions[P1_RANGER];
  assert.equal(action.type, "HEAL", "受伤在 Core 格治疗优先（回仓通道短时占用可接受）");
});

test("Ranger 四邻全障碍 → 无锚点 → 不 MOVE（原地守位）", () => {
  const planner = new SafetyPlanner();
  const state: TickState = { ...makeState(1, [0, 0]), obstacleCells: new Set(["0,-1", "1,0", "0,1", "-1,0"]) };
  const plan = planner.decide({ state });
  assert.equal(plan.unitActions[P1_RANGER], undefined, "无合法锚点则不发动作（隐式 WAIT，不堵不挪）");
});

test("Ranger 让位：Core 四邻全堵（障碍+单位）→ 选单占用邻格（可挤入）", () => {
  const planner = new SafetyPlanner();
  // Core [0,0]：UP 障碍、RIGHT 被 2 单位占、LEFT 被 1 单位占、DOWN 空
  // → 空位 DOWN 优先？不——DOWN 空 → yieldAnchor 第一遍选中 DOWN。
  // 构造四邻全堵（无空位）：UP 障碍、RIGHT/DOWN/LEFT 各 1 单位
  const state: TickState = {
    ...makeState(1, [0, 0]),
    obstacleCells: new Set(["0,-1"]),
    units: [
      { id: P1_RANGER, position: [0, 0] as Position, hp: 2, unitType: "RANGER" as const, cargo: 0 },
      { id: P1_WORKER, position: [1, 0] as Position, hp: 2, unitType: "WORKER" as const, cargo: 1 },
      { id: "44444444-4444-4444-4444-444444444401", position: [0, 1] as Position, hp: 2, unitType: "WORKER" as const, cargo: 1 },
      { id: "44444444-4444-4444-4444-444444444402", position: [-1, 0] as Position, hp: 2, unitType: "WORKER" as const, cargo: 1 },
    ],
    workers: [],
    rangers: [{ id: P1_RANGER, position: [0, 0] as Position, hp: 2, unitType: "RANGER" as const, cargo: 0 }],
  };
  const plan = planner.decide({ state });
  assert.equal(plan.intents[P1_RANGER], "ranger_home", "四邻全堵也尝试让位（挤入单占用格）");
  const action = plan.unitActions[P1_RANGER];
  assert.equal(action.type, "MOVE", "有单占用邻格 → 让位动作发出（预裁决裁决容量）");
});

test("Ranger 让位：Core 四邻全堵且全被占 2 → 无锚点 → 原地等（不 MOVE）", () => {
  const planner = new SafetyPlanner();
  // UP 障碍、RIGHT/DOWN/LEFT 各 2 单位 → yieldAnchor 返回 null → 原地
  const state: TickState = {
    ...makeState(1, [0, 0]),
    obstacleCells: new Set(["0,-1"]),
    units: [
      { id: P1_RANGER, position: [0, 0] as Position, hp: 2, unitType: "RANGER" as const, cargo: 0 },
      { id: P1_WORKER, position: [1, 0] as Position, hp: 2, unitType: "WORKER" as const, cargo: 1 },
      { id: "44444444-4444-4444-4444-444444444401", position: [1, 0] as Position, hp: 2, unitType: "WORKER" as const, cargo: 1 },
      { id: "44444444-4444-4444-4444-444444444402", position: [0, 1] as Position, hp: 2, unitType: "WORKER" as const, cargo: 1 },
      { id: "44444444-4444-4444-4444-444444444403", position: [0, 1] as Position, hp: 2, unitType: "WORKER" as const, cargo: 1 },
      { id: "44444444-4444-4444-4444-444444444404", position: [-1, 0] as Position, hp: 2, unitType: "WORKER" as const, cargo: 1 },
      { id: "44444444-4444-4444-4444-444444444405", position: [-1, 0] as Position, hp: 2, unitType: "WORKER" as const, cargo: 1 },
    ],
    workers: [],
    rangers: [{ id: P1_RANGER, position: [0, 0] as Position, hp: 2, unitType: "RANGER" as const, cargo: 0 }],
  };
  const plan = planner.decide({ state });
  assert.equal(plan.unitActions[P1_RANGER], undefined, "无锚点 → 不发动作（隐式 WAIT，等下一 tick）");
});

test("Ranger 让位：可见敌人时目标远离敌人（官方 egress 语义）", () => {
  const planner = new SafetyPlanner();
  // Core [0,0]，四邻全空；敌人 [0,-5]（Core 上方、射程外且预测步
  // [0,-4] 仍射程外——预测射击不触发）→ 让位目标远离敌人
  // （选 DOWN 而非 UP——距离 6 vs 4）
  const enemy: VisibleEntity = { id: "e1", kind: "UNIT", position: [0, -5], hp: 4, unitType: "VANGUARD" };
  const plan = planner.decide({ state: makeState(1, [0, 0], [enemy]) });
  assert.equal(plan.intents[P1_RANGER], "ranger_home");
  const action = plan.unitActions[P1_RANGER];
  assert.equal(action.type, "MOVE");
  assert.equal(
    action.type === "MOVE" ? action.direction : null,
    "DOWN",
    "敌人上方 → 让位目标选最远方向 DOWN（不走进敌人怀里）",
  );
});

test("Ranger 让位：敌人距离平局保持确定性原序（DOWN 先于 LEFT）", () => {
  const planner = new SafetyPlanner();
  // 敌人 [0,5]（Core 下方、射程外）→ DOWN [0,1] 距离 4 排除；UP
  // [0,-1]/LEFT [-1,0]/RIGHT [1,0] 距离 6 平局 → 原序 UP 先（index 0）
  const enemy: VisibleEntity = { id: "e1", kind: "UNIT", position: [0, 5], hp: 4, unitType: "VANGUARD" };
  const plan = planner.decide({ state: makeState(1, [0, 0], [enemy]) });
  const action = plan.unitActions[P1_RANGER];
  assert.equal(action.type, "MOVE");
  assert.equal(
    action.type === "MOVE" ? action.direction : null,
    "UP",
    "敌人下方 → 平局候选按确定性原序 UP",
  );
});

test("Ranger 有可见敌人 → 追击/守位优先于让位（战斗行为不变）", () => {
  const planner = new SafetyPlanner();
  const enemy: VisibleEntity = { id: "e1", kind: "UNIT", position: [3, 0], hp: 4, unitType: "VANGUARD" };
  const plan = planner.decide({ state: makeState(1, [0, 0], [enemy]) });
  assert.notEqual(plan.intents[P1_RANGER], "ranger_home", "有敌时不执行让位逻辑");
  assert.notEqual(plan.intents[P1_RANGER], "ranger_move", "有敌时优先射击/追敌");
});

test("settle 链：Ranger 让位后带 cargo Worker 进 Core 格 DEPOSIT、经济恢复", () => {
  // world：p1 Core[0,0] + Ranger[0,0]（占 Core 格）+ Worker[1,0] cargo=1；
  // p2 远在 [10,10] 无威胁。手工 plan 链验证引擎行为：
  // tick1 Ranger MOVE UP（让位）→ tick2 Worker MOVE LEFT 进 Core 格 →
  // tick3 Worker DEPOSIT → 资源 10 → 11
  const world = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1", username: "p1", resources: 5,
        core: { id: P1_CORE, position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: P1_RANGER, owner: "p1", position: [0, 0], hp: 2, unitType: "RANGER", cargo: 0 },
          { id: P1_WORKER, owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 1 },
        ],
      },
      {
        id: "p2", username: "p2", resources: 10,
        core: { id: P2_CORE, position: [10, 10], hp: 5, shield: 5, state: "NORMAL" },
        units: [],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: null,
  });

  const planOf = (w: { tick: number }, unitActions: Record<string, UnitAction>, coreAction: CoreAction | null = null): Plan =>
    ({ tick: w.tick, unitActions, coreAction, intents: {} });
  const idle = (w: { tick: number }): Plan => planOf(w, { [P1_RANGER]: { type: "WAIT" }, [P1_WORKER]: { type: "WAIT" } });

  // tick1：Ranger 让位 UP，Worker 等待（Core 格满无法进入）
  const tick1 = settleTick(world, new Map([["p1", planOf(world, { [P1_RANGER]: { type: "MOVE", direction: "UP" } })], ["p2", idle(world)]]), ctx);
  const ranger1 = tick1.world.players.get("p1")!.units.find((u) => u.id === P1_RANGER)!;
  assert.deepEqual(ranger1.position, [0, -1], "Ranger 移出 Core 格");

  // tick2：Worker 进入 Core 格（容量 2 = Core+Worker）
  const tick2 = settleTick(tick1.world, new Map([["p1", planOf(tick1.world, { [P1_RANGER]: { type: "WAIT" }, [P1_WORKER]: { type: "MOVE", direction: "LEFT" } })], ["p2", idle(tick1.world)]]), ctx);
  const worker2 = tick2.world.players.get("p1")!.units.find((u) => u.id === P1_WORKER)!;
  assert.deepEqual(worker2.position, [0, 0], "Worker 进入 Core 格");

  // tick3：DEPOSIT 成功 → 资源 5 → 6（Core 容量 max(10, 2×5)=10，5 未满）
  const tick3 = settleTick(tick2.world, new Map([["p1", planOf(tick2.world, { [P1_RANGER]: { type: "WAIT" }, [P1_WORKER]: { type: "DEPOSIT" } })], ["p2", idle(tick2.world)]]), ctx);
  const p1After = tick3.world.players.get("p1")!;
  assert.equal(p1After.resources, 6, "DEPOSIT 成功、经济恢复");
  assert.ok(
    tick3.events.some((e) => e.eventType === "DEPOSIT_SUCCEEDED" && e.actorId === P1_WORKER),
    "DEPOSIT_SUCCEEDED 事件",
  );
});
