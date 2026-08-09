/**
 * 经济闭环长跑测试（2026-08-05 生产死锁回归）：
 * t1 生产实测 capacity_wait:DEPOSIT 死锁——满血 Vanguard 守家站在 Core 格，
 * 满载 Worker 永远无法进入 Core 格回仓（经济停滞、cargoTot 永不清零）。
 *
 * 本测试跑确定性 planner 的多 tick 闭环（决策 → 模拟结算），断言：
 * - 满载 Worker 能回到 Core 格 DEPOSIT（cargo 周期清零，无 capacity_wait:DEPOSIT 死锁）；
 * - 满血军事单位守家锚定在 Core 相邻格（vanguard_home），绝不站 Core 格；
 * - 长跑 200 ticks 不出现"cargoTot 长期非零且不变化"的停滞。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Turn, type PlayerState } from "@arena/arena-hero-ts";

import { DeterministicPlanner } from "../src/planning/deterministic-planner.ts";
import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import type { Position, TickState, UnitAction } from "../src/domain/model.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const CARGO_MAX = 2;

function makeState(tick: number, objects: PlayerState["objects"], resources = 10): TickState {
  const turn = new Turn(
    tick,
    {
      status: "ACTIVE",
      respawn_at_tick: null,
      resources,
      population: objects.filter((o) => o.kind === "UNIT").length,
      population_tier: 0,
      upkeep_next_tick: 0,
      champion_beacon: { position: [100, 100], status: "GROUND", carrier_id: null },
      objects,
      events: [],
    },
    (() => {}) as never,
  );
  return reduceTurn(turn as unknown as TurnLike) as TickState;
}

const coreObj = {
  kind: "CORE", id: "c1", controlled: true, owner_username: "u",
  position: [0, 0], hp: 5, shield: 5, state: "NORMAL",
  move_direction: null, move_progress: null, move_required_ticks: null, destination: null,
} as PlayerState["objects"][number];
const unit = (id: string, x: number, y: number, unitType: "WORKER" | "VANGUARD", cargo = 0, hp = 4) =>
  ({ kind: "UNIT", id, controlled: true, position: [x, y], hp, unit_type: unitType, cargo }) as PlayerState["objects"][number];

/** 模拟结算（贴近服务端可观测语义）：MOVE 推进（容量 2，Core 占 1）；
 *  资源格 HARVEST（cargo<max 成功，否则失败）；Core 格 DEPOSIT（cargo→0）；
 *  Core SPAWN 消耗 5 资源（资源满破锁闭环的关键：让位 → SPAWN → 消耗 →
 *  卸货通道恢复）。 */
function settle(
  actions: Readonly<Record<string, UnitAction>>,
  coreAction: { type: "SPAWN"; unitType: string } | null,
  objects: PlayerState["objects"],
  resourceCells: Set<string>,
  resources: number,
): { objects: PlayerState["objects"]; resources: number } {
  let nextResources = resources;
  if (coreAction?.type === "SPAWN" && resources >= 5) {
    nextResources -= 5;
  }
  const next: Array<PlayerState["objects"][number]> = [coreObj];
  const occupied = new Map<string, number>([["0,0", 1]]);
  for (const o of objects) {
    if (o.kind !== "UNIT") continue;
    const a = actions[o.id];
    let pos = o.position;
    let cargo = o.cargo ?? 0;
    if (a?.type === "MOVE") {
      const nextPos: Position = a.direction === "UP"
        ? [pos[0], pos[1] - 1]
        : a.direction === "DOWN"
          ? [pos[0], pos[1] + 1]
          : a.direction === "LEFT"
            ? [pos[0] - 1, pos[1]]
            : [pos[0] + 1, pos[1]];
      const key = `${nextPos[0]},${nextPos[1]}`;
      if ((occupied.get(key) ?? 0) < 2) {
        pos = nextPos;
        occupied.set(key, (occupied.get(key) ?? 0) + 1);
      }
    } else if (a?.type === "HARVEST" && resourceCells.has(`${pos[0]},${pos[1]}`) && cargo < CARGO_MAX) {
      cargo += 1;
    } else if (a?.type === "DEPOSIT" && pos[0] === 0 && pos[1] === 0 && nextResources < 10) {
      cargo = 0;
      nextResources += 1;
    }
    next.push(unit(o.id, pos[0], pos[1], o.unit_type as "WORKER" | "VANGUARD", cargo, o.hp ?? 4));
  }
  return { objects: next, resources: nextResources };
}

const POLICY: MacroPolicy = { posture: "harvest", workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: null };
const RESOURCE_CELLS = new Set(["16,0", "32,0"]);

test("经济闭环：满载 Worker 能回仓 DEPOSIT（无 capacity_wait 死锁）", () => {
  const planner = new DeterministicPlanner();
  let objects: PlayerState["objects"] = [coreObj, unit("w1", 16, 0, "WORKER", CARGO_MAX), unit("w2", 32, 0, "WORKER", CARGO_MAX)];
  let resources = 10;
  let cargoTot = CARGO_MAX * 2;
  let cleared = false;
  let stuckTicks = 0;
  for (let tick = 100; tick < 300; tick++) {
    const state = { ...makeState(tick, objects, resources), resourceCells: RESOURCE_CELLS } as TickState;
    const plan = planner.decide({ state, policy: POLICY });
    const waitDeposit = Object.values(plan.intents ?? {}).filter((i) => i === "capacity_wait:DEPOSIT").length;
    const settled = settle(
      plan.unitActions,
      plan.coreAction?.type === "SPAWN" ? plan.coreAction : null,
      objects,
      RESOURCE_CELLS,
      resources,
    );
    objects = settled.objects;
    resources = settled.resources;
    const nextCargoTot = objects.reduce((s, o) => s + (o.kind === "UNIT" ? (o.cargo ?? 0) : 0), 0);
    if (nextCargoTot === 0) cleared = true;
    if (nextCargoTot === cargoTot) stuckTicks += 1;
    else stuckTicks = 0;
    cargoTot = nextCargoTot;
    assert.ok(
      stuckTicks < 24,
      `经济停滞 ${stuckTicks} ticks（cargoTot=${cargoTot} 不变化）——疑似死锁 @tick ${tick}`,
    );
    assert.ok(waitDeposit < 2, `capacity_wait:DEPOSIT 持续出现（${waitDeposit}）@tick ${tick}`);
  }
  assert.equal(cleared, true, "满载 cargo 必须能周期回仓清零");
});

test("守家锚点：满血军事单位不站 Core 格（vanguard_home 移出）", () => {
  const planner = new DeterministicPlanner();
  // 满血 Vanguard 站在 Core 格（生产死锁起点）
  const state: TickState = { ...makeState(100, [coreObj, unit("v1", 0, 0, "VANGUARD", 0, 4), unit("w1", 1, 0, "WORKER", CARGO_MAX)]), resourceCells: RESOURCE_CELLS };
  const plan = planner.decide({ state, policy: POLICY });
  const vanguard = plan.unitActions["v1"];
  assert.equal(vanguard?.type, "MOVE", "满血 Vanguard 在 Core 格必须移出");
  assert.equal(plan.intents?.["v1"], "vanguard_home");
  const worker = plan.unitActions["w1"];
  assert.notEqual(plan.intents?.["w1"], "capacity_wait:DEPOSIT", "Worker 回仓不得被 Vanguard 占格阻塞");
});

test("守家锚点：Vanguard 无敌人时回防到 Core 相邻格而非 Core 格", () => {
  const planner = new DeterministicPlanner();
  const state: TickState = { ...makeState(100, [coreObj, unit("v1", 5, 0, "VANGUARD", 0, 4)]), resourceCells: new Set() };
  const plan = planner.decide({ state, policy: POLICY });
  const vanguard = plan.unitActions["v1"];
  assert.equal(vanguard?.type, "MOVE", "无敌人时 Vanguard 回防移动");
  const destination: Position = vanguard?.type === "MOVE"
    ? vanguard.direction === "UP" ? [5, -1] : vanguard.direction === "DOWN" ? [5, 1] : vanguard.direction === "LEFT" ? [4, 0] : [6, 0]
    : [0, 0];
  assert.notDeepEqual(destination, [0, 0], "回防目标不得是 Core 格本身");
});

test("资源满破锁：满载 Worker 在 Core 格算占位 → 本 tick SPAWN 被拦（防叠加超容量）", () => {
  const planner = new DeterministicPlanner();
  // 2026-08-05 ed3bc549 起 permanentOccupantsOnCore 算所有占位（含满载
  // worker）——防 DEPOSIT_SUCCEEDED 同 tick SPAWN 叠加超容量被服务端拒
  // （t1 tick 80585-80586 实证 CELL_UNIT_LIMIT）。资源满 + 满载 worker 占
  // core 格 → permanentOccupantsOnCore=1 → SPAWN 分支跳过 → 本 tick null；
  // worker 让位 MOVE（见下用例"资源满让位"）→ 下 tick core 格空 → SPAWN 产
  // → 资源消耗 → 卸货通道恢复。死锁由"让位"打破，非本 tick SPAWN。
  const state: TickState = {
    ...makeState(100, [coreObj, unit("w1", 0, 0, "WORKER", 1), unit("w2", 5, 0, "WORKER", 1)]),
    resourceCells: RESOURCE_CELLS,
  };
  const plan = planner.decide({ state, policy: POLICY });
  assert.notEqual(plan.coreAction?.type, "SPAWN", "满载 worker 占 core 格 → 本 tick SPAWN 被拦（让位后下 tick 产）");
});

test("资源满让位：满载 Worker 在 Core 格且无法卸货时 MOVE 让出 Core 格", () => {
  const planner = new DeterministicPlanner();
  // 资源满（resourceSpace=0）时 DEPOSIT 不合法（validator 会移除）——原地等待
  // 会永久占住 Core 格（SPAWN 被服务端容量拒）。必须让位到 Core 相邻格：
  // SPAWN 成功后资源消耗、卸货通道恢复，Worker 再回来卸货。
  const state: TickState = {
    ...makeState(100, [coreObj, unit("w1", 0, 0, "WORKER", 1)]),
    resourceCells: RESOURCE_CELLS,
  };
  const plan = planner.decide({ state, policy: POLICY });
  const action = plan.unitActions["w1"];
  assert.equal(action?.type, "MOVE", "资源满时满载 Worker 在 Core 格必须让位（而非原地等待 DEPOSIT）");
  assert.equal(plan.intents["w1"], "DEPOSIT", "让位仍是回仓意图（资源恢复后回来卸货）");
});

test("资源未满：满载 Worker 在 Core 格正常 DEPOSIT", () => {
  const planner = new DeterministicPlanner();
  const state: TickState = {
    ...makeState(100, [coreObj, unit("w1", 0, 0, "WORKER", 1)], 3),
    resourceCells: RESOURCE_CELLS,
  };
  const plan = planner.decide({ state, policy: POLICY });
  const action = plan.unitActions["w1"];
  assert.equal(action?.type, "DEPOSIT", "资源未满时满载 Worker 直接卸货");
});

test("空载单位占 Core 格仍阻塞 SPAWN（容量安全）", () => {
  const planner = new DeterministicPlanner();
  // 空载 Worker 在 Core 格是正常占位（SPAWN 会叠加容量）——必须仍被抑制。
  const state: TickState = {
    ...makeState(100, [coreObj, unit("w1", 0, 0, "WORKER", 0), unit("w2", 5, 0, "WORKER", 1)]),
    resourceCells: RESOURCE_CELLS,
  };
  const plan = planner.decide({ state, policy: POLICY });
  assert.notEqual(plan.coreAction?.type, "SPAWN", "空载占位仍应抑制 SPAWN");
});

test("militaryRatio 消费：workers 达 target 后按策略产兵（VANGUARD）", () => {
  const planner = new DeterministicPlanner();
  // v0.2.11：生产 A/B 实测清场方经济 2-4× 优于被压方（敌群挡回仓/采集）。
  // militaryRatio=0.4 + workers 已达 target（4）→ 应 SPAWN VANGUARD。
  // 2026-08-10 用户裁决"守卫起码 8 个"：军事 0 < 8 且 worker 起步 → P1 危机
  // 爆兵接管（intent spawn_emergency_military，产出同为 VANGUARD）。
  const policyWithMilitary: MacroPolicy = { posture: "balanced", workerTarget: 4, militaryRatio: 0.4, focusRegion: null, attackPriority: null };
  const state: TickState = {
    ...makeState(100, [coreObj, unit("w1", 1, 0, "WORKER", 1), unit("w2", 2, 0, "WORKER", 1), unit("w3", 3, 0, "WORKER", 1), unit("w4", 4, 0, "WORKER", 1)], 15),
    resourceCells: RESOURCE_CELLS,
  };
  const plan = planner.decide({ state, policy: policyWithMilitary });
  assert.equal(plan.coreAction?.type, "SPAWN", "workers 达 target 且 militaryRatio>0 应产兵");
  assert.equal(plan.coreAction?.unitType, "VANGUARD", "vanguards 少时先产 VANGUARD");
  assert.equal(plan.intents.core, "spawn_emergency_military");
});

test("militaryRatio=0：workers 达 target 后按守卫底线产兵（2026-08-10 用户裁决）", () => {
  const planner = new DeterministicPlanner();
  // 旧语义：militaryRatio=0 时达 target 停产。2026-08-10 用户裁决推翻：
  // "守卫起码 8 个（4V+4R），军事减少太多才允许紧急爆兵"——military 0 < 8
  // 且 worker 起步（>=4）→ P1 危机爆兵补 Vanguard（家不空防优先）。
  const state: TickState = {
    ...makeState(100, [coreObj, unit("w1", 1, 0, "WORKER", 1), unit("w2", 2, 0, "WORKER", 1), unit("w3", 3, 0, "WORKER", 1), unit("w4", 4, 0, "WORKER", 1)], 15),
    resourceCells: RESOURCE_CELLS,
  };
  const plan = planner.decide({ state, policy: POLICY });
  assert.deepEqual(plan.coreAction, { type: "SPAWN", unitType: "VANGUARD" });
  assert.equal(plan.intents.core, "spawn_emergency_military");
});

test("militaryRatio 消费：workers 未达 target 仍补 Worker（经济优先）", () => {
  const planner = new DeterministicPlanner();
  const policyWithMilitary: MacroPolicy = { posture: "balanced", workerTarget: 6, militaryRatio: 0.4, focusRegion: null, attackPriority: null };
  const state: TickState = {
    ...makeState(100, [coreObj, unit("w1", 1, 0, "WORKER", 1), unit("w2", 2, 0, "WORKER", 1)], 15),
    resourceCells: RESOURCE_CELLS,
  };
  const plan = planner.decide({ state, policy: policyWithMilitary });
  assert.equal(plan.coreAction?.type, "SPAWN", "workers 未达 target 应补员");
  assert.equal(plan.coreAction?.unitType, "WORKER", "经济优先：先补 Worker 不产兵");
});

test("回仓绕行：满载 Worker 回 Core 路径上的敌方格并入障碍（不 capacity_wait 死锁）", () => {
  const planner = new DeterministicPlanner();
  // 生产实测：w1 满载在 [-316,57]（dist 32），回 Core 直线路径被敌方 Worker
  // 占位 → 容量裁决保守拒绝 → capacity_wait:DEPOSIT 永久等待。修复：敌方格
  // 并入绕行障碍，回仓路线自动绕开。
  const state: TickState = {
    ...makeState(100, [coreObj, unit("w1", 16, 0, "WORKER", 1)]),
    resourceCells: new Set<string>(),
    visibleEnemies: [
      { id: "enemy1", kind: "UNIT", position: [15, 0], hp: 2, unitType: "WORKER", ownerUsername: "enemy" },
    ],
  };
  const plan = planner.decide({ state, policy: POLICY });
  const action = plan.unitActions["w1"];
  assert.equal(action?.type, "MOVE", "回仓路径被敌占时绕行而非等待");
  const destination: Position = action?.type === "MOVE"
    ? action.direction === "UP" ? [16, -1] : action.direction === "DOWN" ? [16, 1] : action.direction === "LEFT" ? [15, 0] : [17, 0]
    : [0, 0];
  assert.notDeepEqual(destination, [15, 0], "不得走入敌方格");
});

test("敌方 CORE 挡路：回仓路径被敌方 CORE 占位时绕行（生产实测最后一层死锁）", () => {
  const planner = new DeterministicPlanner();
  // 生产实测：w1 满载 @[-316,57]，敌方 CORE @[-317,57] 挡在 LEFT 一步——BFS
  // 的 enemyUnits 只含 kind=UNIT，敌方 CORE 未并入障碍 → 走 LEFT → 容量裁决
  // hostile 拒 → capacity_wait:DEPOSIT 循环。修复：可见敌人全部（含 CORE）
  // 占用格并入绕行障碍。
  const state: TickState = {
    ...makeState(100, [coreObj, unit("w1", -316, 57, "WORKER", 1)]),
    resourceCells: new Set<string>(),
    visibleEnemies: [
      { id: "enemyCore", kind: "CORE", position: [-317, 57], hp: 5, ownerUsername: "enemy" },
      { id: "enemyW1", kind: "UNIT", position: [-313, 57], hp: 2, unitType: "WORKER", ownerUsername: "enemy" },
    ],
  };
  const plan = planner.decide({ state, policy: POLICY });
  const action = plan.unitActions["w1"];
  assert.equal(action?.type, "MOVE", "敌方 CORE 挡路时绕行而非 capacity_wait");
  const destination: Position = action?.type === "MOVE"
    ? action.direction === "UP" ? [-316, 56] : action.direction === "DOWN" ? [-316, 58] : action.direction === "LEFT" ? [-317, 57] : [-315, 57]
    : [0, 0];
  assert.notDeepEqual(destination, [-317, 57], "不得走入敌方 CORE 格");
  assert.notDeepEqual(destination, [-313, 57], "不得走入敌方 Worker 格");
});

