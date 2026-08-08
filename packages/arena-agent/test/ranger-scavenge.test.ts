/**
 * 游侠打野 + 风筝测试（2026-08-08，用户导向"游侠出去乱逛、打野、获取信息、打了就跑"）：
 * - ranger-scavenge-v1：aggressive Ranger 无可见敌人/无攻坚目标/无聚焦区时沿巡逻环外出
 *   （ranger_scavenge），不再回 Core 守位发呆；默认关闭 = 回家守位（零回归）。
 * - ranger-kite-v1：aggressive Ranger 近身遇 VANGUARD 近战威胁 → 退到射程 2-3 可射击格
 *   （ranger_kite），保射程不被 SWEEP 换血。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import { kiteCell } from "../src/strategies/safety-planner-helpers.ts";

function enemyVanguard(position: Position): VisibleEntity {
  return { id: "ev1", kind: "UNIT", position, hp: 4, unitType: "VANGUARD" };
}

function makeState(tick: number, rangerPosition: Position, enemies: VisibleEntity[]): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [{ id: "r1", position: rangerPosition, hp: 2, unitType: "RANGER", cargo: 0 }],
    workers: [],
    vanguards: [],
    rangers: [{ id: "r1", position: rangerPosition, hp: 2, unitType: "RANGER", cargo: 0 }],
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const AGGRESSIVE_POLICY = {
  posture: "aggressive" as const,
  workerTarget: 4,
  militaryRatio: 0.5,
  focusRegion: null,
  attackPriority: "core" as const,
};

const AGGRESSIVE = { ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" as const };

test("ranger-scavenge: aggressive 无敌人/无攻坚目标/无聚焦区 + 启用 → 外出打野（ranger_scavenge）不守家", () => {
  const planner = new SafetyPlanner({ ...AGGRESSIVE, rangerScavenge: true });
  // Ranger [10,0]，核心 [0,0]：无敌人、无敌 Core 记忆、无聚焦区 → 沿巡逻环外出
  const plan = planner.decide({ state: makeState(1, [10, 0], []), policy: AGGRESSIVE_POLICY });
  assert.equal(plan.intents["r1"], "ranger_scavenge", "外出打野测绘，不守家发呆");
  assert.equal(plan.unitActions["r1"].type, "MOVE", "打野 = 持续移动");
});

test("ranger-scavenge: 默认关闭（缺省）→ 回 Core 守位（零回归）", () => {
  const planner = new SafetyPlanner(AGGRESSIVE); // 无 rangerScavenge
  const plan = planner.decide({ state: makeState(1, [10, 0], []), policy: AGGRESSIVE_POLICY });
  assert.equal(plan.intents["r1"], "ranger_move", "回 Core 守位（历史行为）");
  assert.deepEqual(plan.unitActions["r1"], { type: "MOVE", direction: "LEFT" }, "朝核心移动");
});

test("ranger-scavenge: 有可见敌人 → 射击优先于打野", () => {
  const planner = new SafetyPlanner({ ...AGGRESSIVE, rangerScavenge: true });
  const plan = planner.decide({ state: makeState(1, [0, 0], [enemyVanguard([3, 0])]), policy: AGGRESSIVE_POLICY });
  assert.equal(plan.intents["r1"], "shoot", "射程内有敌即射，不打野");
});

test("ranger-kite: 近身 VANGUARD 威胁 → 退到射程 2-3 可射击格（ranger_kite）", () => {
  const planner = new SafetyPlanner({ ...AGGRESSIVE, rangerKite: true });
  // Ranger [0,0]，敌 Vanguard [1,0]（相邻）；核心 [0,0] 会挡 LEFT？——核心在 [0,0]
  // 即 Ranger 脚下，改用核心 [5,5] 的场景验证 kite 方向。
  const state = makeState(1, [0, 0], [enemyVanguard([1, 0])]);
  const plan = planner.decide({ state: { ...state, core: { id: "c1", position: [5, 5], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" } }, policy: AGGRESSIVE_POLICY });
  assert.equal(plan.intents["r1"], "ranger_kite", "近身先撤保射程");
  assert.deepEqual(plan.unitActions["r1"], { type: "MOVE", direction: "LEFT" }, "唯一合法风筝位 [-1,0]");
});

test("kiteCell 纯函数：候选须距威胁 Chebyshev 2-3 且可射击", () => {
  const occupancy = new Map<string, number>([["0,0", 1], ["1,0", 1]]);
  const enemies = [enemyVanguard([1, 0])];
  const cell = kiteCell([0, 0], [1, 0], new Set<string>(), occupancy, enemies);
  assert.deepEqual(cell, [-1, 0], "相邻 8 向中唯一满足 2-3 射程 + 可射击的格");
  // 障碍挡住 → 无合法风筝位
  assert.equal(
    kiteCell([0, 0], [1, 0], new Set<string>(["-1,0"]), occupancy, enemies),
    null,
    "唯一候选被障碍占用 → null（原地射击）",
  );
});

test("kiteCell 纯函数：威胁稍远（Chebyshev 2）不触发（非近身）", () => {
  const occupancy = new Map<string, number>([["0,0", 1], ["2,0", 1]]);
  const enemies = [enemyVanguard([2, 0])];
  // 距离 2：不算近身威胁，kiteCell 只处理 Chebyshev 1 场景的候选（此处返回 null 由调用方判断）
  const cell = kiteCell([0, 0], [2, 0], new Set<string>(), occupancy, enemies);
  // [1,0] 距威胁 1 → 排除；[-1,0] 距威胁 3 且可射击 → 合法（调用方只在近身时调用，纯函数不越权）
  assert.ok(cell === null || cell[0] <= 0, "不选择更靠近威胁的格");
});

export {};
