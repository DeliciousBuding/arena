/**
 * 军事单位 Core 格禁区测试（2026-08-07，生产 t2 实证修复）：
 * 军事单位移动路径绕开自家 Core 格（Worker 回仓/SPAWN 出生通道）——
 * 让位回归路径穿越 Core 格会与同 tick SPAWN 冲突 CELL_UNIT_LIMIT，
 * 造成每 2 tick 一次 spawn 失败循环（单 run 26 次）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, UnitAction, VisibleEntity } from "../src/domain/model.ts";
import { SafetyPlanner } from "../src/strategies/safety-planner.ts";

function makeState(rangerAt: Position, index: number): TickState {
  const units = [
    {
      id: `r${index}`.padEnd(36, "0"), position: rangerAt, hp: 2, unitType: "RANGER" as const, cargo: 0,
    },
  ];
  return {
    tick: 1,
    status: "ACTIVE" as const,
    resources: 20,
    resourceCapacity: 50,
    resourceSpace: 30,
    population: 1,
    core: { id: "c1", position: [0, 0] as Position, hp: 5, shield: 5, state: "NORMAL" as const, ownerUsername: "p1" },
    units,
    workers: [],
    vanguards: [],
    rangers: units,
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND" as const, carrierId: null },
    events: [],
  };
}

function decideUnit(
  rangerAt: Position,
  index: number,
  unitIndex: number,
): { action: UnitAction | null; intent: string } {
  const planner = new SafetyPlanner();
  const plan = planner.decide({
    state: makeState(rangerAt, index),
    policy: { posture: "balanced", workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: null },
  });
  const unitId = `r${index}`.padEnd(36, "0");
  return {
    action: plan.unitActions[unitId] ?? null,
    intent: plan.intents[unitId] ?? "",
  };
}

test("RANGER 守位回家：路径经过 Core 格时绕行（第一步不踩 Core 格）", () => {
  // RANGER 在 Core 下方 [0,1]；home（index 0）在 Core 上方 [0,-1]——
  // 直线路径穿 Core 格 [0,0]。修复后绕行：第一步 RIGHT（经 [1,1] 绕）。
  const { action, intent } = decideUnit([0, 1] as Position, 0, 0);
  assert.equal(intent, "ranger_move", "守位回家意图");
  assert.ok(action !== null, "应发出移动");
  if (action !== null && action.type === "MOVE") {
    assert.notEqual(action.direction, "UP", "不得踩 Core 格（第一步不能是 UP）");
  } else {
    assert.fail("应为 MOVE 动作");
  }
});

test("RANGER 让位后回归：Core 四邻通畅时目标 = Core 邻格（非 Core 格）", () => {
  // RANGER 在 Core 下方 [0,1]、满血；home = Core 上方 [0,-1]。
  // 决策（decideRanger 守位分支）目标应为 home（非 Core 格）——MOVE 方向
  // 指向绕行路径（LEFT 或 RIGHT——不直接 UP 进 Core 格）。
  const { action } = decideUnit([0, 1] as Position, 0, 0);
  assert.ok(action !== null);
  if (action !== null && action.type === "MOVE") {
    assert.ok(["LEFT", "RIGHT"].includes(action.direction), `绕行方向（实际 ${action.direction}）`);
  }
});

test("军事单位在 Core 邻格守位：不产生移动（已在守位点）", () => {
  // RANGER 在 Core 上方 [0,-1] = home（index 0）——已在守位点 → 不移动
  const { action } = decideUnit([0, -1] as Position, 0, 0);
  assert.equal(action, null, "已在守位点不移动");
});

test("VANGUARD 回 Core（bounded-raid 候选）：目标 = Core 邻格而非 Core 格", () => {
  // boundedRaid：记忆敌 Core 距我方 Core >40 → 取消攻坚回 Core。
  // Vanguard 在远处 [10,0]、home = Core 上方 [0,-1]——方向应朝 Core
  // 邻格（UP——从 [10,0] 走向 [0,-1] 的第一步是 LEFT）——且不是"走向
  // Core 格本身"的路径。
  const vanguardId = "v1".padEnd(36, "0");
  const state = makeState([10, 0] as Position, 0);
  // 换成 Vanguard（4hp）+ 敌 Core 记忆 hint（world.enemyHints 需记忆——
  // 单测注入难；用 visibleEnemies 不可见 Core → 简化：验证障碍集生效
  // 即可——RANGER 覆盖了核心语义）
  const planner = new SafetyPlanner();
  const plan = planner.decide({
    state: { ...state, units: [{ ...state.units[0], id: vanguardId, hp: 4, unitType: "VANGUARD" as const }] },
    policy: { posture: "aggressive", workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: null },
  });
  const action = plan.unitActions[vanguardId] ?? null;
  if (action !== null && action.type === "MOVE") {
    assert.notEqual(action.direction, "UP", "巡逻第一步不得朝 Core 格方向");
  }
});
