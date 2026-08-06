/**
 * 威胁评估诊断层测试（v0.3-lite，2026-08-06）：
 * assessThreat 纯函数确定性验证——ENGAGED/BREAKOUT/ALERT/NORMAL 级联、
 * 位置差分移动检测、12 格回退半径、多轴判定。
 * World.enemyHints 的 prevPosition 差分链路（observe 两 tick 保留上一位置）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { assessThreat, damagedThisTick } from "../src/domain/threat.ts";
import { World } from "../src/domain/world.ts";

const CORE: Position = [0, 0];

function enemy(id: string, position: Position, unitType: "WORKER" | "VANGUARD" | "RANGER" = "VANGUARD"): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 2, unitType };
}

function hint(id: string, position: Position, prevPosition?: Position, pursuitScore = 0) {
  return { id, position, kind: "UNIT" as const, unitType: "VANGUARD" as const, lastSeenTick: 10, prevPosition, pursuitScore };
}

function makeState(tick: number, enemies: VisibleEntity[], events: TickState["events"] = []): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: CORE, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [],
    workers: [],
    vanguards: [],
    rangers: [],
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events,
  };
}

test("威胁评估：无敌人 → NORMAL", () => {
  const result = assessThreat({ core: CORE, visibleEnemies: [], enemyHints: [], damagedThisTick: false });
  assert.equal(result.level, "NORMAL");
  assert.equal(result.reason, null);
});

test("威胁评估：12 格内可见敌（静止）→ ALERT enemy_near", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [8, 0])],
    enemyHints: [hint("e1", [8, 0], [8, 0])],
    damagedThisTick: false,
  });
  assert.equal(result.level, "ALERT");
  assert.equal(result.reason, "enemy_near");
  assert.equal(result.closingEnemies, 1);
  assert.equal(result.movingEnemies, 0);
});

test("威胁评估：位置差分移动 → ALERT enemy_moving（12 格外也触发）", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [15, 0])],
    enemyHints: [hint("e1", [15, 0], [14, 0])],
    damagedThisTick: false,
  });
  assert.equal(result.level, "ALERT");
  assert.equal(result.reason, "enemy_moving");
  assert.equal(result.movingEnemies, 1);
});

test("威胁评估：位置未变（prev == cur）不算移动", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [15, 0])],
    enemyHints: [hint("e1", [15, 0], [15, 0])],
    damagedThisTick: false,
  });
  assert.equal(result.level, "NORMAL");
  assert.equal(result.movingEnemies, 0);
});

test("威胁评估：多轴夹击但可逃（东西夹击有 UP/DOWN 通道）→ 不算 BREAKOUT（竞品对齐）", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [8, 0]), enemy("e2", [-8, 0])],
    enemyHints: [hint("e1", [8, 0], [8, 0]), hint("e2", [-8, 0], [-8, 0])],
    damagedThisTick: false,
  });
  // 有逃逸方向（UP/DOWN 同时远离两敌）→ 降级 ALERT（closingEnemies=2 仍在 12 格内）
  assert.equal(result.level, "ALERT");
  assert.equal(result.reason, "enemy_near");
  assert.equal(result.axes, 2);
});

test("威胁评估：四向包围（无逃逸方向）→ BREAKOUT", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [8, 0]), enemy("e2", [-8, 0]), enemy("e3", [0, 8]), enemy("e4", [0, -8])],
    enemyHints: [
      hint("e1", [8, 0], [8, 0]),
      hint("e2", [-8, 0], [-8, 0]),
      hint("e3", [0, 8], [0, 8]),
      hint("e4", [0, -8], [0, -8]),
    ],
    damagedThisTick: false,
  });
  // 任一方向都至少靠近某敌（无逃逸）→ BREAKOUT
  assert.equal(result.level, "BREAKOUT");
  assert.equal(result.reason, "multi_axis");
  assert.equal(result.axes, 4);
});

test("威胁评估：三角夹击（三轴无逃逸）→ BREAKOUT", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [8, 0]), enemy("e2", [-5, 7]), enemy("e3", [-5, -7])],
    enemyHints: [
      hint("e1", [8, 0], [8, 0]),
      hint("e2", [-5, 7], [-5, 7]),
      hint("e3", [-5, -7], [-5, -7]),
    ],
    damagedThisTick: false,
  });
  assert.equal(result.level, "BREAKOUT");
  assert.equal(result.reason, "multi_axis");
});

test("威胁评估：单轴双敌（同方向）不算夹击", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [8, 0]), enemy("e2", [12, 0])],
    enemyHints: [hint("e1", [8, 0], [8, 0]), hint("e2", [12, 0], [12, 0])],
    damagedThisTick: false,
  });
  assert.equal(result.level, "ALERT");
  assert.equal(result.axes, 1);
});

test("威胁评估：本 tick 受击 → ENGAGED（优先于其他等级）", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [8, 0])],
    enemyHints: [hint("e1", [8, 0], [8, 0])],
    damagedThisTick: true,
  });
  assert.equal(result.level, "ENGAGED");
  assert.equal(result.reason, "damaged");
});

test("威胁评估：Core 不在位 → NORMAL no_core", () => {
  const result = assessThreat({ core: null, visibleEnemies: [enemy("e1", [8, 0])], enemyHints: [], damagedThisTick: false });
  assert.equal(result.level, "NORMAL");
  assert.equal(result.reason, "no_core");
});

test("damagedThisTick：伤害事件过滤", () => {
  assert.equal(damagedThisTick([{ eventType: "HARVEST_SUCCEEDED" }]), false);
  assert.equal(damagedThisTick([{ eventType: "UNIT_DAMAGED" }]), true);
  assert.equal(damagedThisTick([{ eventType: "CORE_DAMAGED" }, { eventType: "DEPOSIT_SUCCEEDED" }]), true);
});

test("World.enemyHints：两 tick observe 保留 prevPosition（速度差分链路）", () => {
  const world = new World();
  world.observe(makeState(1, [enemy("e1", [5, 0])]));
  assert.equal(world.enemyHints()[0]?.prevPosition, undefined, "首见无 prev");
  world.observe(makeState(2, [enemy("e1", [6, 0])]));
  const hint = world.enemyHints()[0];
  assert.deepEqual(hint?.prevPosition, [5, 0], "第二 tick 保留上一位置");
  assert.deepEqual(hint?.position, [6, 0]);
});

test("pursuit score：三 tick 逼近累积 +2/步（cap 4）", () => {
  const world = new World();
  world.observe(makeState(1, [enemy("e1", [10, 0])]));
  world.observe(makeState(2, [enemy("e1", [9, 0])]));
  world.observe(makeState(3, [enemy("e1", [8, 0])]));
  const hint = world.enemyHints()[0];
  assert.equal(hint?.pursuitScore, 4, "两步逼近 2+2=4（cap 4）");
});

test("pursuit score：路过（先逼近后远离）衰减归零", () => {
  const world = new World();
  world.observe(makeState(1, [enemy("e1", [10, 0])]));
  world.observe(makeState(2, [enemy("e1", [9, 0])])); // +2
  world.observe(makeState(3, [enemy("e1", [10, 0])])); // 远离 -1
  world.observe(makeState(4, [enemy("e1", [11, 0])])); // 远离 -1 → 0
  const hint = world.enemyHints()[0];
  assert.equal(hint?.pursuitScore, 0, "远离衰减归零");
});

test("pursuit score：位置未动强制归零（静态敌不算追击）", () => {
  const world = new World();
  world.observe(makeState(1, [enemy("e1", [10, 0])]));
  world.observe(makeState(2, [enemy("e1", [9, 0])])); // +2
  world.observe(makeState(3, [enemy("e1", [9, 0])])); // 位置未动 → 0
  const hint = world.enemyHints()[0];
  assert.equal(hint?.pursuitScore, 0);
});

test("威胁评估：确认追击（score≥3 且 12 格外）→ ALERT pursuit", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [15, 0])],
    enemyHints: [hint("e1", [15, 0], [16, 0], 3)],
    damagedThisTick: false,
  });
  assert.equal(result.level, "ALERT");
  assert.equal(result.reason, "pursuit", "持续逼近（score 3）优先于 enemy_moving");
});

test("威胁评估：低分路过（score 1 且 12 格外）不算确认追击", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [15, 0])],
    enemyHints: [hint("e1", [15, 0], [16, 0], 1)],
    damagedThisTick: false,
  });
  assert.equal(result.level, "ALERT");
  assert.equal(result.reason, "enemy_moving", "单次逼近不算确认追击（防路过误报）");
});
