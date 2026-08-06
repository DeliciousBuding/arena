/**
 * Core 迁移（PRE_EVADE-lite）测试（2026-08-06）：
 * coreEvade 配置默认关闭零回归；开启时 12 格内可见敌 → START_MOVE 远离
 * （远离敌人优先、次远离 beacon）；MOVING 状态不生产/heal。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

function makeState(tick: number, enemies: VisibleEntity[], coreState: "NORMAL" | "MOVING" = "NORMAL"): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: coreState, ownerUsername: "p1" },
    units: [],
    workers: [],
    vanguards: [],
    rangers: [],
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

function enemy(id: string, position: readonly [number, number], unitType: "WORKER" | "VANGUARD" | "RANGER" = "VANGUARD"): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 2, unitType };
}

test("coreEvade 默认关闭：12 格内敌人 → 不迁移（历史行为）", () => {
  const planner = new SafetyPlanner(); // 默认 config 无 coreEvade
  const plan = planner.decide({ state: makeState(1, [enemy("e1", [8, 0])]) });
  assert.equal(plan.coreAction?.type, "SPAWN", "默认行为：继续产兵（或 heal 等），不迁移");
});

const EVADE_CONFIG = { ...DEFAULT_SAFETY_CONFIG, coreEvade: true };

test("coreEvade 开启：12 格内敌人 → START_MOVE 远离敌人", () => {
  const planner = new SafetyPlanner(EVADE_CONFIG);
  // 敌在正东 [8,0]：西/北距敌最远（9）且 beacon（东南）最远（201）——
  // 平分局确定性序取 UP（候选序 UP 先）
  const plan = planner.decide({ state: makeState(1, [enemy("e1", [8, 0])]) });
  assert.equal(plan.coreAction?.type, "START_MOVE");
  assert.equal(plan.coreAction?.type === "START_MOVE" ? plan.coreAction.direction : null, "UP");
  assert.equal(plan.intents.core, "core_evade");
});

test("coreEvade 开启：12 格外敌人 → 不迁移", () => {
  const planner = new SafetyPlanner(EVADE_CONFIG);
  const plan = planner.decide({ state: makeState(1, [enemy("e1", [20, 0])]) });
  assert.notEqual(plan.coreAction?.type, "START_MOVE", "12 格外无即时威胁");
});

test("coreEvade 开启：障碍格不选（北侧障碍 → 不选 UP）", () => {
  const planner = new SafetyPlanner(EVADE_CONFIG);
  const state = {
    ...makeState(1, [enemy("e1", [8, 0])]),
    obstacleCells: new Set(["-1,0", "0,-1"]), // 西、北都堵
  };
  const plan = planner.decide({ state });
  assert.equal(plan.coreAction?.type, "START_MOVE");
  assert.equal(plan.coreAction?.type === "START_MOVE" ? plan.coreAction.direction : null, "DOWN");
});

test("coreEvade 开启：MOVING 状态不生产/heal（迁移中）", () => {
  const planner = new SafetyPlanner(EVADE_CONFIG);
  const plan = planner.decide({ state: makeState(1, [], "MOVING") });
  assert.equal(plan.coreAction, null, "迁移中不提交任何 Core 动作");
});

test("coreEvade 开启：多敌多向 → 选最近敌最远方向", () => {
  const planner = new SafetyPlanner(EVADE_CONFIG);
  // 敌东 [6,0]、敌西 [-6,0]：南 [-0,1] 与北 [0,-1] 距最近敌 7（平）——
  // beacon [100,100] 在东南 → 北 [0,-1] beacon 更远 → UP
  const plan = planner.decide({
    state: makeState(1, [enemy("e1", [6, 0]), enemy("e2", [-6, 0])]),
  });
  assert.equal(plan.coreAction?.type, "START_MOVE");
  assert.equal(plan.coreAction?.type === "START_MOVE" ? plan.coreAction.direction : null, "UP");
});
