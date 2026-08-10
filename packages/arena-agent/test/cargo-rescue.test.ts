/**
 * 载货救援测试（2026-08-09，W6，cargo-rescue-v1）：
 * A2 缺陷闭环——载货 worker 不清理旧采集目标（追空矿冻结）、无入口满排队、
 * cargo 被堵无救援、Core 不靠拢（liveness 恢复对 cargo worker 无效，6 tick
 * 无限循环）。reference `cargo_blocked` / `cargo_queue_hold` / `clear_worker_goal`
 * 对照。
 *
 * 1. 满载入口满 → hold 不争抢（worker_hold_cargo_queue intent）；
 * 2. cargo 卡死 N tick → Core 靠拢触发（cargo_blocked_self_heal）；
 * 3. 救援期间产兵暂停（靠拢时 reserve 不被救援消耗——START_MOVE 优先于 SPAWN）；
 * 4. 变体关闭零回归（cargoRescue=false 时 decideWorker/decideCore 行为不变）；
 * 5. 清旧目标：满载 worker 旧目标矿已采空 → 目标清除。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, UnitSnapshot, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import type { SafetyPlannerConfig } from "../src/strategies/safety-planner-config.ts";

const CORE: Position = [0, 0];

function worker(id: string, position: Position, cargo: number, hp = 2): UnitSnapshot {
  return { id, position, hp, unitType: "WORKER", cargo };
}

function makeState(opts: {
  tick?: number;
  workers?: UnitSnapshot[];
  vanguards?: UnitSnapshot[];
  rangers?: UnitSnapshot[];
  resources?: number;
  resourceSpace?: number;
  resourceCells?: Position[];
  obstacleCells?: Position[];
  visibleEnemies?: VisibleEntity[];
  coreState?: "NORMAL" | "MOVING";
  coreHp?: number;
  coreShield?: number;
  corePosition?: Position;
  population?: number;
} = {}): TickState {
  const workers = opts.workers ?? [];
  const vanguards = opts.vanguards ?? [];
  const rangers = opts.rangers ?? [];
  const units = [...workers, ...vanguards, ...rangers];
  return {
    tick: opts.tick ?? 1,
    status: "ACTIVE",
    resources: opts.resources ?? 30,
    resourceCapacity: 30,
    resourceSpace: opts.resourceSpace ?? 30,
    population: opts.population ?? units.length,
    core: {
      id: "c1",
      position: opts.corePosition ?? CORE,
      hp: opts.coreHp ?? 5,
      shield: opts.coreShield ?? 5,
      state: opts.coreState ?? "NORMAL",
      ownerUsername: "p1",
    },
    units,
    workers,
    vanguards,
    rangers,
    visibleEnemies: opts.visibleEnemies ?? [],
    resourceCells: new Set((opts.resourceCells ?? []).map((c) => `${c[0]},${c[1]}`)),
    obstacleCells: new Set((opts.obstacleCells ?? []).map((c) => `${c[0]},${c[1]}`)),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const RESCUE_CONFIG: SafetyPlannerConfig = {
  ...DEFAULT_SAFETY_CONFIG,
  cargoRescue: true,
  // 用较小阈值便于测试：cooldown 30、stall 10、stallCargo 6、minWorkers 2
  // 都是默认值，测试直接用默认即可
};

// ===== 1. 排队 hold =====

test("cargo-rescue：满载 worker 距 Core 1 格 + 核心格入口满（Core+1 worker 占）→ worker_hold_cargo_queue", () => {
  const planner = new SafetyPlanner(RESCUE_CONFIG);
  // Core [0,0]，核心格已有 Core（occ 1）+ 另一满载 worker（occ 2 = 满）。
  // 待测 worker 在 [1,0]（距 Core 1），stepToward 朝 [0,0] → 入口满 → hold。
  const other = worker("w-block", [0, 0], 1);
  const cargoWorker = worker("w-test", [1, 0], 1);
  const plan = planner.decide({
    state: makeState({ workers: [other, cargoWorker], tick: 1 }),
  });
  assert.equal(plan.intents["w-test"], "worker_hold_cargo_queue");
  assert.equal(plan.unitActions["w-test"].type, "WAIT");
});

test("cargo-rescue：满载 worker 距 Core 2 格 + 入口满 → worker_hold_cargo_queue", () => {
  const planner = new SafetyPlanner(RESCUE_CONFIG);
  // Core [0,0]，[1,0] 被一 worker 占（occ 1），[0,0] 有 Core + 一 worker（occ 2 满）。
  // 待测 worker 在 [2,0]（距 2），stepToward 朝 [1,0] → occ 1 < 2 → 不 hold → return_home。
  // 改造：[1,0] 也满（2 个 worker）→ 入口满 → hold。
  const blocker1 = worker("w-b1", [0, 0], 1);
  const blocker2a = worker("w-b2a", [1, 0], 1);
  const blocker2b = worker("w-b2b", [1, 0], 1);
  const cargoWorker = worker("w-test", [2, 0], 1);
  const plan = planner.decide({
    state: makeState({ workers: [blocker1, blocker2a, blocker2b, cargoWorker], tick: 1 }),
  });
  assert.equal(plan.intents["w-test"], "worker_hold_cargo_queue");
  assert.equal(plan.unitActions["w-test"].type, "WAIT");
});

test("cargo-rescue：入口未满（occ<2）→ 正常 return_home（不 hold）", () => {
  const planner = new SafetyPlanner(RESCUE_CONFIG);
  // Core [0,0]，[1,0] 只有 1 个 worker（occ 1 < 2）→ 入口未满 → 正常移动
  const blocker = worker("w-block", [1, 0], 1);
  const cargoWorker = worker("w-test", [2, 0], 1);
  const plan = planner.decide({
    state: makeState({ workers: [blocker, cargoWorker], tick: 1 }),
  });
  assert.equal(plan.unitActions["w-test"].type, "MOVE");
  assert.equal(plan.intents["w-test"], "return_home");
});

test("cargo-rescue：距 Core >2 → 不触发 hold（正常 return_home）", () => {
  const planner = new SafetyPlanner(RESCUE_CONFIG);
  const cargoWorker = worker("w-test", [5, 0], 1);
  const plan = planner.decide({
    state: makeState({ workers: [cargoWorker], tick: 1 }),
  });
  assert.equal(plan.unitActions["w-test"].type, "MOVE");
  assert.equal(plan.intents["w-test"], "return_home");
});

// ===== 2. Core 靠拢（cargoBlockedSelfHeal）=====

test("cargo-rescue：2 个满载 worker cargo 连续 6 tick 不变 + Core NORMAL → Core 靠拢（cargo_blocked_self_heal）", () => {
  const planner = new SafetyPlanner(RESCUE_CONFIG);
  // 2 个满载 worker 距 Core 8 格（> CARGO_RESCUE_MIN_DISTANCE=6 → 可迁移）
  // resourceSpace=0 → worker 即使到核心格也卸不了货 → cargo 不变
  const w1 = worker("w1", [8, 0], 1);
  const w2 = worker("w2", [-8, 0], 1);
  for (let tick = 1; tick <= 7; tick += 1) {
    planner.decide({
      state: makeState({
        tick,
        workers: [w1, w2],
        resourceSpace: 0,
      }),
    });
  }
  // tick 8：stuckSince=2, 8-2=6 >= stallCargoTicks(6) → 触发靠拢
  const plan = planner.decide({
    state: makeState({
      tick: 8,
      workers: [w1, w2],
      resourceSpace: 0,
    }),
  });
  assert.equal(plan.intents.core, "cargo_blocked_self_heal");
  assert.equal(plan.coreAction?.type, "START_MOVE");
});

test("cargo-rescue：仅 1 个满载 worker cargo 不变 → 不触发靠拢（minWorkers=2）", () => {
  const planner = new SafetyPlanner(RESCUE_CONFIG);
  const w1 = worker("w1", [1, 0], 1);
  for (let tick = 1; tick <= 7; tick += 1) {
    planner.decide({
      state: makeState({ tick, workers: [w1], resourceSpace: 30 }),
    });
  }
  const plan = planner.decide({
    state: makeState({ tick: 8, workers: [w1], resourceSpace: 30 }),
  });
  assert.notEqual(plan.intents.core, "cargo_blocked_self_heal",
    "单个 worker cargo 不变不应触发 Core 靠拢（可能是正常排队）");
});

// ===== GAP 5.4：迁移死循环修复 =====

test("GAP 5.4：Core MOVING 期间满载 worker 持货不算被堵（不清零→stuck 不累积）", () => {
  const planner = new SafetyPlanner(RESCUE_CONFIG);
  const w1 = worker("w1", [8, 0], 1);
  const w2 = worker("w2", [-8, 0], 1);
  // tick 1-7：Core NORMAL + resourceSpace=0 → stuck 累积（旧行为，触发靠拢前置）
  for (let tick = 1; tick <= 7; tick += 1) {
    planner.decide({
      state: makeState({ tick, workers: [w1, w2], resourceSpace: 0 }),
    });
  }
  // tick 8：触发靠拢 → Core MOVING（迁移开始）
  const plan8 = planner.decide({
    state: makeState({ tick: 8, workers: [w1, w2], resourceSpace: 0 }),
  });
  assert.equal(plan8.intents.core, "cargo_blocked_self_heal");
  // tick 9-12：Core MOVING（引擎推进中）→ GAP 5.4 清空 stuck → 迁移结束回到
  // NORMAL 后不会因为"迁移期无法卸货"而立即再次触发靠拢（死循环断裂）
  for (let tick = 9; tick <= 12; tick += 1) {
    planner.decide({
      state: makeState({ tick, workers: [w1, w2], resourceSpace: 0, coreState: "MOVING" }),
    });
  }
  // tick 13：Core 回到 NORMAL——stuck 记录已被 MOVING 期清空，6 tick 内不会
  // 立即重触发（迁移循环断裂）；但 resourceSpace=0 让 cargo 继续不变，6 tick
  // 后会重新累积（真实阻塞仍可被救——只是不再自激循环）
  for (let tick = 13; tick <= 17; tick += 1) {
    const plan = planner.decide({
      state: makeState({ tick, workers: [w1, w2], resourceSpace: 0 }),
    });
    assert.notEqual(plan.intents.core, "cargo_blocked_self_heal",
      `tick ${tick} MOVING 期后 stuck 应已清空，不立即重触发（实际 ${plan.intents.core}）`);
  }
});

test("GAP 5.4：满载 worker 距 Core >20 → 不触发靠拢（远归途 worker 非被堵）", () => {
  const planner = new SafetyPlanner(RESCUE_CONFIG);
  // worker 距 Core 25（> CARGO_RESCUE_MAX_DISTANCE=20）——归途采集者，不是被堵
  const w1 = worker("w1", [25, 0], 1);
  const w2 = worker("w2", [-25, 0], 1);
  for (let tick = 1; tick <= 7; tick += 1) {
    planner.decide({
      state: makeState({ tick, workers: [w1, w2], resourceSpace: 0 }),
    });
  }
  const plan = planner.decide({
    state: makeState({ tick: 8, workers: [w1, w2], resourceSpace: 0 }),
  });
  assert.notEqual(plan.intents.core, "cargo_blocked_self_heal",
    "远距满载 worker 不应触发 Core 靠拢（归途非被堵）");
});

test("GAP 5.4：满载 worker 距 Core 15（≤20）→ 仍触发靠拢（近距离阻塞可救）", () => {
  const planner = new SafetyPlanner(RESCUE_CONFIG);
  const w1 = worker("w1", [15, 0], 1);
  const w2 = worker("w2", [-15, 0], 1);
  for (let tick = 1; tick <= 7; tick += 1) {
    planner.decide({
      state: makeState({ tick, workers: [w1, w2], resourceSpace: 0 }),
    });
  }
  const plan = planner.decide({
    state: makeState({ tick: 8, workers: [w1, w2], resourceSpace: 0 }),
  });
  assert.equal(plan.intents.core, "cargo_blocked_self_heal",
    "20 格内满载 worker 仍应触发靠拢（近距离阻塞）");
});

test("GAP 5.5：返航中的满载 worker（位置持续移动）→ 不算被堵 → 不触发靠拢", () => {
  const planner = new SafetyPlanner(RESCUE_CONFIG);
  // w1/w2 每 tick 向 Core 移动 1 格（返航），cargo 不变但位置在动——不是被堵
  const w1 = worker("w1", [15, 0], 1);
  const w2 = worker("w2", [-15, 0], 1);
  for (let tick = 1; tick <= 7; tick += 1) {
    const state = makeState({
      tick,
      workers: [worker("w1", [15 - tick, 0], 1), worker("w2", [-15 + tick, 0], 1)],
      resourceSpace: 0,
    });
    planner.decide({ state });
  }
  const plan = planner.decide({
    state: makeState({ tick: 8, workers: [worker("w1", [7, 0], 1), worker("w2", [-7, 0], 1)], resourceSpace: 0 }),
  });
  assert.notEqual(plan.intents.core, "cargo_blocked_self_heal",
    "返航中（位置移动）的满载 worker 不应触发 Core 靠拢");
});

test("GAP 5.5：位置不动 + cargo 不变（真被堵）→ 仍触发靠拢", () => {
  const planner = new SafetyPlanner(RESCUE_CONFIG);
  const w1 = worker("w1", [8, 0], 1);
  const w2 = worker("w2", [-8, 0], 1);
  for (let tick = 1; tick <= 7; tick += 1) {
    planner.decide({
      state: makeState({ tick, workers: [w1, w2], resourceSpace: 0 }),
    });
  }
  const plan = planner.decide({
    state: makeState({ tick: 8, workers: [w1, w2], resourceSpace: 0 }),
  });
  assert.equal(plan.intents.core, "cargo_blocked_self_heal",
    "静止 + cargo 不变 = 真被堵，应触发靠拢");
});

test("cargo-rescue：cargo 变化（卸货成功）→ 重置 stuck 计数 → 不触发靠拢", () => {
  const planner = new SafetyPlanner(RESCUE_CONFIG);
  const w1 = worker("w1", [0, 0], 1); // 在核心格 → 会 DEPOSIT → cargo 变化
  const w2 = worker("w2", [1, 0], 1);
  for (let tick = 1; tick <= 7; tick += 1) {
    planner.decide({
      state: makeState({ tick, workers: [w1, w2], resourceSpace: 30 }),
    });
  }
  const plan = planner.decide({
    state: makeState({ tick: 8, workers: [w1, w2], resourceSpace: 30 }),
  });
  // w1 在核心格 → DEPOSIT 成功 → cargo 变化 → 不满足"cargo 不变"
  assert.notEqual(plan.intents.core, "cargo_blocked_self_heal");
});

// ===== 3. 救援期间产兵暂停 =====

test("cargo-rescue：靠拢触发时 Core START_MOVE（不 SPAWN，产兵暂停）", () => {
  const planner = new SafetyPlanner(RESCUE_CONFIG);
  const w1 = worker("w1", [8, 0], 1);
  const w2 = worker("w2", [-8, 0], 1);
  // resourceSpace=0：worker 无法卸货 → cargo 不变 → stuck 检测积累
  for (let tick = 1; tick <= 7; tick += 1) {
    planner.decide({
      state: makeState({ tick, workers: [w1, w2], resourceSpace: 0 }),
    });
  }
  // tick 8：触发靠拢
  const plan = planner.decide({
    state: makeState({ tick: 8, workers: [w1, w2], resourceSpace: 0 }),
  });
  // 靠拢 = START_MOVE，不是 SPAWN → 产兵暂停（靠拢期间 reserve 不被消耗）
  assert.equal(plan.coreAction?.type, "START_MOVE");
  assert.notEqual(plan.intents.core, "spawn_worker");
});

test("cargo-rescue：靠拢触发后冷却内不重触发（cooldownTicks=30）", () => {
  const planner = new SafetyPlanner(RESCUE_CONFIG);
  const w1 = worker("w1", [8, 0], 1);
  const w2 = worker("w2", [-8, 0], 1);
  // resourceSpace=0：worker 无法卸货 → cargo 不变
  for (let tick = 1; tick <= 7; tick += 1) {
    planner.decide({
      state: makeState({ tick, workers: [w1, w2], resourceSpace: 0 }),
    });
  }
  // tick 8：触发靠拢
  const plan8 = planner.decide({
    state: makeState({ tick: 8, workers: [w1, w2], resourceSpace: 0 }),
  });
  assert.equal(plan8.intents.core, "cargo_blocked_self_heal");
  // tick 9-37：冷却内不重触发（cooldown=30，8+30=38 → tick 38 才过期）
  for (let tick = 9; tick <= 37; tick += 1) {
    const plan = planner.decide({
      state: makeState({ tick, workers: [w1, w2], resourceSpace: 0 }),
    });
    assert.notEqual(plan.intents.core, "cargo_blocked_self_heal",
      `tick ${tick} 冷却内不应重触发靠拢`);
  }
});

// ===== 4. 变体关闭零回归 =====

test("cargo-rescue：变体关闭（cargoRescue=false）→ decideWorker 行为不变（不 hold_queue）", () => {
  const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG); // cargoRescue 未设
  // 满载 worker 距 Core 1 格，入口满 → 历史行为：照常 return_home（争抢）
  const other = worker("w-block", [0, 0], 1);
  const cargoWorker = worker("w-test", [1, 0], 1);
  const plan = planner.decide({
    state: makeState({ workers: [other, cargoWorker], tick: 1 }),
  });
  assert.notEqual(plan.intents["w-test"], "worker_hold_cargo_queue");
  // 历史行为：照常 return_home（即使入口满也争抢）
  assert.equal(plan.intents["w-test"], "return_home");
});

test("cargo-rescue：变体关闭 → decideCore 行为不变（不触发靠拢）", () => {
  const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  const w1 = worker("w1", [1, 0], 1);
  const w2 = worker("w2", [-1, 0], 1);
  const obstacles: Position[] = [[0, -1], [0, 1]];
  for (let tick = 1; tick <= 7; tick += 1) {
    planner.decide({
      state: makeState({ tick, workers: [w1, w2], obstacleCells: obstacles, resourceSpace: 30 }),
    });
  }
  const plan = planner.decide({
    state: makeState({ tick: 8, workers: [w1, w2], obstacleCells: obstacles, resourceSpace: 30 }),
  });
  assert.notEqual(plan.intents.core, "cargo_blocked_self_heal");
});

// ===== 5. 清旧目标 =====

test("cargo-rescue：满载 worker 的旧采集目标已不在可见资源里 → 清除目标（不追空矿冻结）", () => {
  const planner = new SafetyPlanner(RESCUE_CONFIG);
  // 先设一个采集目标到 worker 记忆（模拟之前采过的矿）
  const mem = planner.world.unitMemory("w-test");
  const oldMine: Position = [5, 5];
  mem.harvestTarget = oldMine;
  mem.workerMode = "go_harvest";
  // 满载 worker 距 Core 5 格，当前可见资源里没有 [5,5]
  const cargoWorker = worker("w-test", [3, 0], 1);
  const plan = planner.decide({
    state: makeState({
      workers: [cargoWorker],
      tick: 1,
      resourceCells: [], // 无可见资源 → oldMine 不在可见资源里
    }),
  });
  // 旧目标应被清除
  assert.equal(mem.harvestTarget, null, "满载 worker 的旧采集目标不在可见资源里 → 应清除");
  assert.equal(mem.workerMode, "patrol");
  // worker 应 return_home（不是 go_harvest_mem）
  assert.equal(plan.intents["w-test"], "return_home");
});

test("cargo-rescue：满载 worker 的旧采集目标仍在可见资源里 → 保留目标", () => {
  const planner = new SafetyPlanner(RESCUE_CONFIG);
  const mem = planner.world.unitMemory("w-test");
  const activeMine: Position = [5, 5];
  mem.harvestTarget = activeMine;
  mem.workerMode = "go_harvest";
  const cargoWorker = worker("w-test", [3, 0], 1);
  planner.decide({
    state: makeState({
      workers: [cargoWorker],
      tick: 1,
      resourceCells: [activeMine], // 旧目标仍在可见资源里
    }),
  });
  // 目标仍在可见资源里 → 不清除（worker 卸完货可折返继续采）
  assert.deepEqual(mem.harvestTarget, activeMine);
});

test("cargo-rescue：变体关闭 → 满载 worker 旧目标不在可见资源 → 不清除（零回归）", () => {
  const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  const mem = planner.world.unitMemory("w-test");
  const oldMine: Position = [5, 5];
  mem.harvestTarget = oldMine;
  mem.workerMode = "go_harvest";
  const cargoWorker = worker("w-test", [3, 0], 1);
  planner.decide({
    state: makeState({
      workers: [cargoWorker],
      tick: 1,
      resourceCells: [],
    }),
  });
  // 变体关闭 → 不清除（历史行为保留旧目标）
  assert.deepEqual(mem.harvestTarget, oldMine);
});

// ===== 附加：靠拢超时撤退 =====

test("cargo-rescue：靠拢超时撤退（stallTicks=10，靠拢后 10 tick 仍未解决 → 放弃）", () => {
  const planner = new SafetyPlanner(RESCUE_CONFIG);
  const w1 = worker("w1", [8, 0], 1);
  const w2 = worker("w2", [-8, 0], 1);
  // resourceSpace=0：worker 无法卸货 → cargo 不变
  for (let tick = 1; tick <= 7; tick += 1) {
    planner.decide({
      state: makeState({ tick, workers: [w1, w2], resourceSpace: 0 }),
    });
  }
  // tick 8：触发靠拢（startedTick=8）
  const plan8 = planner.decide({
    state: makeState({ tick: 8, workers: [w1, w2], resourceSpace: 0 }),
  });
  assert.equal(plan8.intents.core, "cargo_blocked_self_heal");
  // tick 9-17：靠拢进行中（假设路径被堵，Core 仍在原位——测试模拟 Core 未移动）
  // 靠拢 startedTick=8，stallTicks=10 → tick 18 超时
  for (let tick = 9; tick <= 17; tick += 1) {
    planner.decide({
      state: makeState({ tick, workers: [w1, w2], resourceSpace: 0 }),
    });
  }
  // tick 18：超时撤退 → 进入冷却，不再触发靠拢
  const plan18 = planner.decide({
    state: makeState({ tick: 18, workers: [w1, w2], resourceSpace: 0 }),
  });
  assert.notEqual(plan18.intents.core, "cargo_blocked_self_heal",
    "靠拢超时后应撤退，不再触发靠拢");
});
