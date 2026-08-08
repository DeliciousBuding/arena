/**
 * 威胁评估诊断层测试（v0.3-lite，2026-08-06）：
 * assessThreat 纯函数确定性验证——ENGAGED/BREAKOUT/ALERT/NORMAL 级联、
 * 位置差分移动检测、12 格回退半径、多轴判定。
 * World.enemyHints 的 prevPosition 差分链路（observe 两 tick 保留上一位置）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { assessThreat, coreDamagedThisTick, damagedThisTick } from "../src/domain/threat.ts";
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
  const result = assessThreat({ core: CORE, visibleEnemies: [], enemyHints: [], coreDamagedThisTick: false });
  assert.equal(result.level, "NORMAL");
  assert.equal(result.reason, null);
});

test("威胁评估：12 格内可见敌（静止）→ ALERT enemy_near", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [8, 0])],
    enemyHints: [hint("e1", [8, 0], [8, 0])],
    coreDamagedThisTick: false,
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
    coreDamagedThisTick: false,
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
    coreDamagedThisTick: false,
  });
  assert.equal(result.level, "NORMAL");
  assert.equal(result.movingEnemies, 0);
});

test("威胁评估：多轴夹击但可逃（东西夹击有 UP/DOWN 通道）→ 不算 BREAKOUT（竞品对齐）", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [8, 0]), enemy("e2", [-8, 0])],
    enemyHints: [hint("e1", [8, 0], [8, 0]), hint("e2", [-8, 0], [-8, 0])],
    coreDamagedThisTick: false,
  });
  // 有逃逸方向（UP/DOWN 同时远离两敌）→ 降级 ALERT（closingEnemies=2 仍在 12 格内）
  assert.equal(result.level, "ALERT");
  assert.equal(result.reason, "enemy_near");
  assert.equal(result.axes, 2);
});

test("威胁评估：四向邻接包围（无逃逸方向、投影伤害>0）→ BREAKOUT", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [1, 0]), enemy("e2", [-1, 0]), enemy("e3", [0, 1]), enemy("e4", [0, -1])],
    enemyHints: [
      hint("e1", [1, 0], [1, 0]),
      hint("e2", [-1, 0], [-1, 0]),
      hint("e3", [0, 1], [0, 1]),
      hint("e4", [0, -1], [0, -1]),
    ],
    coreDamagedThisTick: false,
  });
  // 四邻全被敌占（无逃逸）且邻接 Vanguard 投影伤害 4 → BREAKOUT
  assert.equal(result.level, "BREAKOUT");
  assert.equal(result.reason, "multi_axis");
  assert.equal(result.axes, 4);
});

test("威胁评估：三角邻接夹击（三轴无逃逸）→ BREAKOUT", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [1, 0]), enemy("e2", [-1, 1]), enemy("e3", [-1, -1])],
    enemyHints: [
      hint("e1", [1, 0], [1, 0]),
      hint("e2", [-1, 1], [-1, 1]),
      hint("e3", [-1, -1], [-1, -1]),
    ],
    coreDamagedThisTick: false,
  });
  // 邻接 Vanguard 投影伤害 3 >0，任一候选方向都至少靠近某敌 → BREAKOUT
  assert.equal(result.level, "BREAKOUT");
  assert.equal(result.reason, "multi_axis");
});

test("威胁评估：四向 8 格包围但打不到 → 不算 BREAKOUT（C5 投影伤害前提）", () => {
  // 2026-08-07 C5 对齐：BREAKOUT 前提 = 当前格投影伤害 >0（至少一敌能合法
  // 攻击 Core）。8 格外的 Vanguard 射程 1 打不到 Core——远处包围只是 ALERT，
  // 不再高估为 BREAKOUT（旧判定只看"12 格内"）。
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [8, 0]), enemy("e2", [-8, 0]), enemy("e3", [0, 8]), enemy("e4", [0, -8])],
    enemyHints: [
      hint("e1", [8, 0], [8, 0]),
      hint("e2", [-8, 0], [-8, 0]),
      hint("e3", [0, 8], [0, 8]),
      hint("e4", [0, -8], [0, -8]),
    ],
    coreDamagedThisTick: false,
  });
  assert.equal(result.level, "ALERT");
  assert.equal(result.reason, "enemy_near");
  assert.equal(result.axes, 4);
});

test("威胁评估：Ranger 直线 3 格四向包围 → BREAKOUT（C5 射程覆盖）", () => {
  // Ranger 射程 3（八方向直线无遮挡）→ 3 格包围投影伤害 4 >0 且无逃逸 → BREAKOUT。
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [
      enemy("r1", [3, 0], "RANGER"),
      enemy("r2", [-3, 0], "RANGER"),
      enemy("r3", [0, 3], "RANGER"),
      enemy("r4", [0, -3], "RANGER"),
    ],
    enemyHints: [
      hint("r1", [3, 0], [3, 0]),
      hint("r2", [-3, 0], [-3, 0]),
      hint("r3", [0, 3], [0, 3]),
      hint("r4", [0, -3], [0, -3]),
    ],
    coreDamagedThisTick: false,
  });
  assert.equal(result.level, "BREAKOUT");
  assert.equal(result.reason, "multi_axis");
});

test("威胁评估：逃逸方向被障碍堵住 → BREAKOUT（C5 障碍硬块）", () => {
  // 东西邻接夹击本可逃（UP/DOWN 同时远离两敌）；[0,1]/[0,-1] 为障碍格后
  // 唯一逃逸通道被封 → 被包围（竞品 "Obstacles remain hard blocks"）。
  const noObstacle = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [1, 0]), enemy("e2", [-1, 0])],
    enemyHints: [hint("e1", [1, 0], [1, 0]), hint("e2", [-1, 0], [-1, 0])],
    coreDamagedThisTick: false,
    obstacles: new Set(),
  });
  assert.equal(noObstacle.level, "ALERT", "无障碍时可沿 UP/DOWN 逃逸 → 不算包围");

  const walled = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [1, 0]), enemy("e2", [-1, 0])],
    enemyHints: [hint("e1", [1, 0], [1, 0]), hint("e2", [-1, 0], [-1, 0])],
    coreDamagedThisTick: false,
    obstacles: new Set(["0,1", "0,-1"]),
  });
  assert.equal(walled.level, "BREAKOUT", "UP/DOWN 被封 → 无逃逸方向");
});

test("威胁评估：逃逸方向被资源格堵住 → BREAKOUT（C5 资源硬块）", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [1, 0]), enemy("e2", [-1, 0])],
    enemyHints: [hint("e1", [1, 0], [1, 0]), hint("e2", [-1, 0], [-1, 0])],
    coreDamagedThisTick: false,
    resourceCells: new Set(["0,1", "0,-1"]),
  });
  assert.equal(result.level, "BREAKOUT", "资源格（Core 不可入）同样构成硬块");
});

test("威胁评估：单轴双敌（同方向）不算夹击", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [8, 0]), enemy("e2", [12, 0])],
    enemyHints: [hint("e1", [8, 0], [8, 0]), hint("e2", [12, 0], [12, 0])],
    coreDamagedThisTick: false,
  });
  assert.equal(result.level, "ALERT");
  assert.equal(result.axes, 1);
});

test("威胁评估：本 tick 受击 → ENGAGED（优先于其他等级）", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [8, 0])],
    enemyHints: [hint("e1", [8, 0], [8, 0])],
    coreDamagedThisTick: true,
  });
  assert.equal(result.level, "ENGAGED");
  assert.equal(result.reason, "damaged");
});

test("威胁评估：仅单位受击不升级 Core 级 ENGAGED（recent_attack 分账）", () => {
  // 2026-08-07 C9 对齐：远程 worker 被摸是单位级受击，不得升级为 Core 级
  // ENGAGED（ENGAGED 只由 CORE_DAMAGED/CORE_DESTROYED 触发）。
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [8, 0])],
    enemyHints: [hint("e1", [8, 0], [8, 0])],
    coreDamagedThisTick: false,
  });
  assert.notEqual(result.level, "ENGAGED", "单位受击不应升级 Core 级");
  assert.equal(result.level, "ALERT");
});

test("威胁评估：确认追击（远距 score≥3）→ confirmedPursuit=true", () => {
  // 2026-08-07 B3 对齐：score≥3 持续逼近的远距敌（>12 格）也确认追击——
  // 供 decideCore 消费（远距确认追击也触发 Core 迁移）。
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [20, 0])],
    enemyHints: [hint("e1", [20, 0], [22, 0], 3)],
    coreDamagedThisTick: false,
  });
  assert.equal(result.confirmedPursuit, true);
  assert.equal(result.level, "ALERT");
  assert.equal(result.reason, "pursuit");
});

test("coreDamagedThisTick：仅 Core 受击事件过滤", () => {
  assert.equal(coreDamagedThisTick([{ eventType: "UNIT_DAMAGED" }]), false);
  assert.equal(coreDamagedThisTick([{ eventType: "CORE_DAMAGED" }]), true);
  assert.equal(coreDamagedThisTick([{ eventType: "CORE_DESTROYED" }]), true);
  assert.equal(coreDamagedThisTick([{ eventType: "HARVEST_SUCCEEDED" }]), false);
});

test("威胁评估：Core 不在位 → NORMAL no_core", () => {
  const result = assessThreat({ core: null, visibleEnemies: [enemy("e1", [8, 0])], enemyHints: [], coreDamagedThisTick: false });
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
    coreDamagedThisTick: false,
  });
  assert.equal(result.level, "ALERT");
  assert.equal(result.reason, "pursuit", "持续逼近（score 3）优先于 enemy_moving");
});

test("威胁评估：低分路过（score 1 且 12 格外）不算确认追击", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [15, 0])],
    enemyHints: [hint("e1", [15, 0], [16, 0], 1)],
    coreDamagedThisTick: false,
  });
  assert.equal(result.level, "ALERT");
  assert.equal(result.reason, "enemy_moving", "单次逼近不算确认追击（防路过误报）");
});

test("威胁评估：无可见敌但近核观察有战斗单位 → ALERT invasion_watch（长 TTL 入侵观察）", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [],
    enemyHints: [],
    coreDamagedThisTick: false,
    coreWatch: [
      { id: "e-camp", position: [4, 4], kind: "UNIT", unitType: "VANGUARD", stationary: true, coreDistance: 4, lastSeenTick: 10 },
    ],
  });
  assert.equal(result.level, "ALERT");
  assert.equal(result.reason, "invasion_watch");
  assert.equal(result.closingEnemies, 1);
});

test("威胁评估：近核观察只有 WORKER → 不升级 ALERT（由 Vanguard 回访清剿，非 Core 级威胁）", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [],
    enemyHints: [],
    coreDamagedThisTick: false,
    coreWatch: [
      { id: "w-camp", position: [2, 0], kind: "UNIT", unitType: "WORKER", stationary: true, coreDistance: 2, lastSeenTick: 10 },
    ],
  });
  assert.equal(result.level, "NORMAL");
});

test("威胁评估：可见敌存在时近核观察不覆盖（可见敌路径优先）", () => {
  const result = assessThreat({
    core: CORE,
    visibleEnemies: [enemy("e1", [15, 0])], // 12 格外、静止 → 走 NORMAL，观察内战斗单位不重复升级
    enemyHints: [hint("e1", [15, 0], [15, 0])],
    coreDamagedThisTick: false,
    coreWatch: [
      { id: "e-camp", position: [4, 4], kind: "UNIT", unitType: "VANGUARD", stationary: true, coreDistance: 4, lastSeenTick: 10 },
    ],
  });
  // 可见敌静止 12 格外 + 观察战斗单位 → ALERT（入侵观察仍生效：家边有战斗单位盘踞）
  assert.equal(result.level, "ALERT");
  assert.equal(result.reason, "invasion_watch");
});
