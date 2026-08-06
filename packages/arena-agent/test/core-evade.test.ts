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

test("aggressive + 敌方 Core 记忆：无可见敌人时向前推进（offensive memory）", () => {
  // 2026-08-07 竞品 threat-response offensive Core memory 对齐：aggressive
  // Vanguard 在"曾见过敌方 Core、当前无可见敌人"时向记忆位置推进，而不是
  // 只在自家 Core 附近 scavenge 巡逻（模拟器 v0.14 实证的盲区）。
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" });
  const vanguard: TickState["units"][number] = {
    id: "v1",
    position: [4, 0],
    hp: 4,
    unitType: "VANGUARD",
    cargo: 0,
  };
  const enemyCore: VisibleEntity = {
    id: "ec1",
    kind: "CORE",
    position: [20, 0],
    hp: 5,
    unitType: "VANGUARD",
  };
  const stateWithEnemyCore: TickState = {
    ...makeState(1, [enemyCore]),
    units: [vanguard],
    vanguards: [vanguard],
    population: 2,
  };
  // tick 1：看见敌方 Core（写入 EnemyMemory）
  planner.decide({ state: stateWithEnemyCore });
  // tick 2：敌人离开视野——aggressive Vanguard 应朝记忆的 Core 位置（东）推进
  const stateNoEnemies: TickState = {
    ...makeState(2, []),
    units: [vanguard],
    vanguards: [vanguard],
    population: 2,
  };
  const plan = planner.decide({ state: stateNoEnemies });
  const vanguardAction = plan.unitActions["v1"];
  assert.ok(vanguardAction !== undefined, "Vanguard 应有动作");
  assert.equal(vanguardAction.type, "MOVE");
  assert.equal(vanguardAction.type === "MOVE" ? vanguardAction.direction : null, "RIGHT");
  assert.equal(plan.intents["v1"], "vanguard_pressure_memory");
});

test("defensive + 敌方 Core 记忆：无可见敌人时仍守家（不前压）", () => {
  // 记忆推进仅 aggressive 生效；defensive（生产默认）行为零变化。
  const planner = new SafetyPlanner(); // 默认 defensive
  const vanguard: TickState["units"][number] = {
    id: "v1",
    position: [4, 0],
    hp: 4,
    unitType: "VANGUARD",
    cargo: 0,
  };
  const enemyCore: VisibleEntity = {
    id: "ec1",
    kind: "CORE",
    position: [20, 0],
    hp: 5,
    unitType: "VANGUARD",
  };
  planner.decide({
    state: { ...makeState(1, [enemyCore]), units: [vanguard], vanguards: [vanguard], population: 2 },
  });
  const plan = planner.decide({
    state: { ...makeState(2, []), units: [vanguard], vanguards: [vanguard], population: 2 },
  });
  const vanguardAction = plan.unitActions["v1"];
  // defensive：无可见敌人 → 不主动向敌方 Core 推进（历史行为：MOVE 目标为
  // 守家/巡逻，绝不带 vanguard_pressure_memory 意图）
  assert.notEqual(plan.intents["v1"], "vanguard_pressure_memory");
});

test("coreEvade 开启：远距确认追击（score≥3）→ START_MOVE（B3）", () => {
  // 2026-08-07 B3 对齐：score≥3 持续逼近的远距敌（>12 格）也触发 Core 迁移
  // （竞品 confirmed distant pursuit → PRE_EVADE）。先观察两 tick 累积
  // pursuitScore，第三 tick 敌人仍远距（15 格）→ 触发迁移。
  const planner = new SafetyPlanner(EVADE_CONFIG);
  // tick 1: 敌 16 格（远距）
  planner.decide({ state: makeState(1, [enemy("e1", [16, 0])]) });
  // tick 2: 敌 15 格（逼近 +2 → score 2）
  planner.decide({ state: makeState(2, [enemy("e1", [15, 0])]) });
  // tick 3: 敌 14 格（逼近 +2 → score 4 ≥3）——仍 >12 格（14 格），
  // 但 confirmedPursuit 成立 → 触发迁移
  const plan = planner.decide({ state: makeState(3, [enemy("e1", [14, 0])]) });
  assert.equal(plan.coreAction?.type, "START_MOVE", "远距确认追击应触发迁移");
});

test("coreEvade + TTR：扣 attack-range 的 TTR≤16 触发（B1）", () => {
  // 2026-08-07 B1 公式对齐：remaining = max(0, d − attack_range)，
  // TTR = remaining × gap / closed ≤16。Vanguard attack_range=1：
  // 敌 12 格 → 10 格（closed=2, gap=1, remaining=9）→ TTR=4.5 ≤16 触发。
  const planner = new SafetyPlanner({ ...EVADE_CONFIG, coreEvadeTtr: true });
  planner.decide({ state: makeState(1, [enemy("e1", [12, 0])]) });
  const plan = planner.decide({ state: makeState(2, [enemy("e1", [10, 0])]) });
  assert.equal(plan.coreAction?.type, "START_MOVE");
  assert.equal(plan.intents.core, "core_evade_ttr");
});

test("coreEvadeScoring：Ranger 斜线不构成投影伤害（C6 合法攻击判定）", () => {
  // 2026-08-07 C6 对齐：投影伤害用 rule-correct 合法攻击——Ranger 仅八方向
  // 直线（中间格无障碍）；旧 Manhattan ≤3 代理把 (2,1) 斜线也算 1 伤。
  // 敌 Ranger [2,0]：候选 DOWN [0,1] 距敌 Chebyshev 2 但非八方向直线 →
  // 投影伤害 0（旧实现误判 1）；LEFT [-1,0] 距敌 3 直线 → 伤害 1。
  // 新实现选 DOWN（伤害 0 + beacon 较近），旧实现会选 LEFT。
  const planner = new SafetyPlanner({ ...EVADE_CONFIG, coreEvadeScoring: true });
  const plan = planner.decide({ state: makeState(1, [enemy("e1", [2, 0], "RANGER")]) });
  assert.equal(plan.coreAction?.type, "START_MOVE");
  assert.equal(plan.coreAction?.type === "START_MOVE" ? plan.coreAction.direction : null, "DOWN");
});

test("coreEvadeScoring：Ranger 直线被障碍遮挡 → 投影伤害 0", () => {
  // 敌 Ranger [3,0]，中间格 [2,0] 是障碍 → 候选 RIGHT [1,0] 无法被射击
  // （lineBlocked → 投影伤害 0；旧 Manhattan 代理会误判 1 伤并排除该方向）。
  // RIGHT 虽伤害 0 但距离向量 [2] 仍最差；LEFT/UP/DOWN 同距 [4]，beacon
  // [100,100] 小优 → DOWN（cheb 100）胜 UP/LEFT（101）。
  const planner = new SafetyPlanner({ ...EVADE_CONFIG, coreEvadeScoring: true });
  const state = {
    ...makeState(1, [enemy("e1", [3, 0], "RANGER")]),
    obstacleCells: new Set(["2,0"]),
  };
  const plan = planner.decide({ state });
  assert.equal(plan.coreAction?.type, "START_MOVE");
  assert.equal(plan.coreAction?.type === "START_MOVE" ? plan.coreAction.direction : null, "DOWN");
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
