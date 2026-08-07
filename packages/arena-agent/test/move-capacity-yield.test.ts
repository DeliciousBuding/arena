/**
 * 容量预裁决让位测试（2026-08-07，生产 t2 实证修复）：
 * t2 死锁机制——Ranger 守位让位（ranger_home）目标格被 2 个 cargo
 * worker 的确定性步进争抢 → 预裁决按 priority 淘汰 Ranger（默认 3
 * vs worker 0）→ Ranger 留在 Core 格 → Core 格永不释放 → 全部
 * worker WAIT、经济停摆（>600 tick 实证）。
 * 修复：ranger_home/vanguard_home priority = -1（让位者先走，
 * 通道才解锁）。验证：Ranger 让位 MOVE 不被淘汰 + 至少一个
 * worker 的 MOVE 保留 + 结果不超容量。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, UnitAction } from "../src/domain/model.ts";
import { resolveMoveCapacity } from "../src/planning/deterministic-planner.ts";

const RANGER = "22222222-2222-2222-2222-222222222201";
const W_A = "22222222-2222-2222-2222-222222222202";
const W_B = "22222222-2222-2222-2222-222222222203";
const W_C = "22222222-2222-2222-2222-222222222204";
const W_D = "22222222-2222-2222-2222-222222222205";

/** t2 case（tick 64521）布局：Core[-54,49] + Ranger 占 Core 格 +
 *  4 个带 cargo worker 在 Core 邻格/上方。 */
function makeT2State(): TickState {
  const units = [
    { id: RANGER, position: [-54, 49] as Position, hp: 2, unitType: "RANGER" as const, cargo: 0 },
    { id: W_A, position: [-55, 49] as Position, hp: 2, unitType: "WORKER" as const, cargo: 1 },
    { id: W_B, position: [-55, 48] as Position, hp: 2, unitType: "WORKER" as const, cargo: 1 },
    { id: W_C, position: [-55, 48] as Position, hp: 2, unitType: "WORKER" as const, cargo: 1 },
    { id: W_D, position: [-54, 50] as Position, hp: 2, unitType: "WORKER" as const, cargo: 1 },
  ];
  return {
    tick: 1,
    status: "ACTIVE" as const,
    resources: 3,
    resourceCapacity: 50,
    resourceSpace: 47,
    population: 5,
    core: { id: "c1", position: [-54, 49] as Position, hp: 5, shield: 5, state: "NORMAL" as const, ownerUsername: "p1" },
    units,
    workers: units.filter((u) => u.unitType === "WORKER"),
    vanguards: [],
    rangers: [units[0]],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND" as const, carrierId: null },
    events: [],
  };
}

test("t2 场景：Ranger 让位（ranger_home）优先于 worker 争格——不被淘汰", () => {
  const state = makeT2State();
  const actions: Record<string, UnitAction> = {
    [RANGER]: { type: "MOVE", direction: "UP" }, // [-54,49] → [-54,48]
    [W_A]: { type: "MOVE", direction: "RIGHT" }, // [-55,49] → [-54,49] Core 格
    [W_B]: { type: "MOVE", direction: "RIGHT" }, // [-55,48] → [-54,48] 与 Ranger 争
    [W_C]: { type: "MOVE", direction: "RIGHT" }, // [-55,48] → [-54,48] 与 Ranger 争
    [W_D]: { type: "MOVE", direction: "UP" }, // [-54,50] → [-54,49] Core 格
  };
  const intents: Record<string, string> = {
    [RANGER]: "ranger_home",
    [W_A]: "DEPOSIT",
    [W_B]: "DEPOSIT",
    [W_C]: "DEPOSIT",
    [W_D]: "DEPOSIT",
  };
  const result = resolveMoveCapacity(state, actions, intents, new Set());

  // Ranger 让位必须保留（否则 Core 格永不释放 → 死锁）
  assert.deepEqual(result.unitActions[RANGER], { type: "MOVE", direction: "UP" }, "Ranger 让位不被淘汰");
  assert.equal(result.intents[RANGER], "ranger_home");

  // 至少一个 worker 的 MOVE 保留（回仓通道开始疏通）
  const workerMoves = [W_A, W_B, W_C, W_D].filter(
    (id) => result.unitActions[id]?.type === "MOVE",
  );
  assert.ok(workerMoves.length >= 1, "至少一个 worker 回仓移动保留");
});

test("t2 场景：结果不超容量（预裁决合法性保持）", () => {
  const state = makeT2State();
  const actions: Record<string, UnitAction> = {
    [RANGER]: { type: "MOVE", direction: "UP" },
    [W_A]: { type: "MOVE", direction: "RIGHT" },
    [W_B]: { type: "MOVE", direction: "RIGHT" },
    [W_C]: { type: "MOVE", direction: "RIGHT" },
    [W_D]: { type: "MOVE", direction: "UP" },
  };
  const intents: Record<string, string> = {
    [RANGER]: "ranger_home",
    [W_A]: "DEPOSIT",
    [W_B]: "DEPOSIT",
    [W_C]: "DEPOSIT",
    [W_D]: "DEPOSIT",
  };
  const result = resolveMoveCapacity(state, actions, intents, new Set());

  // 逐格统计最终占用：Core + 不动的单位占原位；移动单位只占目标格——
  // 任何格 ≤ 2
  const occupancy = new Map<string, number>();
  const bump = (x: number, y: number): void => {
    const key = `${x},${y}`;
    occupancy.set(key, (occupancy.get(key) ?? 0) + 1);
  };
  bump(-54, 49); // Core
  const delta: Record<string, [number, number]> = {
    UP: [0, -1], DOWN: [0, 1], LEFT: [-1, 0], RIGHT: [1, 0],
  };
  for (const unit of state.units) {
    const action = result.unitActions[unit.id];
    if (action?.type === "MOVE") {
      const [dx, dy] = delta[action.direction];
      bump(unit.position[0] + dx, unit.position[1] + dy);
    } else {
      bump(unit.position[0], unit.position[1]);
    }
  }
  for (const [key, count] of occupancy) {
    assert.ok(count <= 2, `格 ${key} 占用 ${count} > 2（容量违规）`);
  }
});

test("vanguard_home 同样最高优先（与 ranger_home 对称）", () => {
  const state = makeT2State();
  const actions: Record<string, UnitAction> = {
    [RANGER]: { type: "MOVE", direction: "UP" },
    [W_B]: { type: "MOVE", direction: "RIGHT" },
    [W_C]: { type: "MOVE", direction: "RIGHT" },
  };
  const intents: Record<string, string> = {
    [RANGER]: "vanguard_home", // Vanguard 的让位意图（同语义）
    [W_B]: "DEPOSIT",
    [W_C]: "DEPOSIT",
  };
  const result = resolveMoveCapacity(state, actions, intents, new Set());
  assert.deepEqual(result.unitActions[RANGER], { type: "MOVE", direction: "UP" }, "vanguard_home 不被淘汰");
});


test("go_harvest_mem 容量被拒 → capacity_reroute 绕行（非死 WAIT）", () => {
  // t2 生产实证：5 worker 持续 capacity_wait:go_harvest_mem——记忆矿目标格满
  // 时旧逻辑只能 WAIT 死等（位置不动 → stuck 回退 → 重新选同一矿再卡）；
  // 修复：go_harvest_mem 也纳入可绕行意图 → 绕到相邻格继续接近目标。
  const W1 = "22222222-2222-2222-2222-222222222210";
  const W2 = "22222222-2222-2222-2222-222222222211";
  const W3 = "22222222-2222-2222-2222-222222222212";
  const state: TickState = {
    tick: 1,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 50,
    resourceSpace: 40,
    population: 3,
    core: { id: "c1", position: [0, 0] as Position, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [
      { id: W1, position: [1, 0] as Position, hp: 2, unitType: "WORKER", cargo: 0 },
      { id: W2, position: [2, 0] as Position, hp: 2, unitType: "WORKER", cargo: 0 },
      { id: W3, position: [2, 0] as Position, hp: 2, unitType: "WORKER", cargo: 0 },
    ],
    workers: [
      { id: W1, position: [1, 0] as Position, hp: 2, unitType: "WORKER", cargo: 0 },
      { id: W2, position: [2, 0] as Position, hp: 2, unitType: "WORKER", cargo: 0 },
      { id: W3, position: [2, 0] as Position, hp: 2, unitType: "WORKER", cargo: 0 },
    ],
    vanguards: [],
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
  // w1 想去 [2,0]（记忆矿方向），但 [2,0] 已有 2 单位（满容量 2）
  const actions: Record<string, UnitAction> = {
    [W1]: { type: "MOVE", direction: "RIGHT" }, // [1,0] → [2,0] 超容量
    [W2]: { type: "WAIT" },
    [W3]: { type: "WAIT" },
  };
  const intents: Record<string, string> = {
    [W1]: "go_harvest_mem",
    [W2]: "go_harvest_mem",
    [W3]: "go_harvest_mem",
  };
  const result = resolveMoveCapacity(state, actions, intents, new Set());
  const w1Action = result.unitActions[W1];
  assert.ok(w1Action !== undefined, "w1 应有动作");
  assert.equal(w1Action.type, "MOVE", `w1 应绕行继续推进而非死等，实际=${JSON.stringify(w1Action)}`);
  assert.ok(
    (result.intents?.[W1] ?? "").startsWith("capacity_reroute:"),
    `w1 意图应为 capacity_reroute:go_harvest_mem，实际=${result.intents?.[W1]}`,
  );
});

test("go_harvest（可见矿）容量被拒 → capacity_reroute 绕行", () => {
  const W1 = "22222222-2222-2222-2222-222222222220";
  const W2 = "22222222-2222-2222-2222-222222222221";
  const W3 = "22222222-2222-2222-2222-222222222222";
  const state: TickState = {
    tick: 1,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 50,
    resourceSpace: 40,
    population: 3,
    core: { id: "c1", position: [0, 0] as Position, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [
      { id: W1, position: [1, 0] as Position, hp: 2, unitType: "WORKER", cargo: 0 },
      { id: W2, position: [2, 0] as Position, hp: 2, unitType: "WORKER", cargo: 0 },
      { id: W3, position: [2, 0] as Position, hp: 2, unitType: "WORKER", cargo: 0 },
    ],
    workers: [
      { id: W1, position: [1, 0] as Position, hp: 2, unitType: "WORKER", cargo: 0 },
      { id: W2, position: [2, 0] as Position, hp: 2, unitType: "WORKER", cargo: 0 },
      { id: W3, position: [2, 0] as Position, hp: 2, unitType: "WORKER", cargo: 0 },
    ],
    vanguards: [],
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
  const actions: Record<string, UnitAction> = {
    [W1]: { type: "MOVE", direction: "RIGHT" },
    [W2]: { type: "WAIT" },
    [W3]: { type: "WAIT" },
  };
  const intents: Record<string, string> = {
    [W1]: "go_harvest",
    [W2]: "go_harvest",
    [W3]: "go_harvest",
  };
  const result = resolveMoveCapacity(state, actions, intents, new Set());
  assert.equal(result.unitActions[W1]?.type, "MOVE", "go_harvest 也应绕行");
  assert.ok(
    (result.intents?.[W1] ?? "").startsWith("capacity_reroute:"),
    `实际=${result.intents?.[W1]}`,
  );
});

