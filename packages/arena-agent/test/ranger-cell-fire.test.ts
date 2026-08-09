/**
 * Ranger cell-fire 预判射击测试（2026-08-08）：
 * 官方规则移动只有四方向（UP/DOWN/LEFT/RIGHT，无斜向），而旧
 * predictedEnemyCell 按八方向（米字）切比雪夫步进预测敌人下一步——
 * 斜向敌人（如相对偏移 (4,4)）被预测到 (3,3)，但敌人一步只能走
 * (3,4)/(4,3)，永远到不了预测格 → 空枪 SHOT_MISSED。
 * 修复：预测改为主轴卡向一步（|dx|>=|dy| 走 x，否则走 y），配合
 * canShoot 的八方向射击线过滤——斜向敌人单步落点不在射击线上 →
 * 不再预判开火（杜绝射空气）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { cellKey } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import {
  canShoot,
  predictedEnemyCell,
} from "../src/strategies/safety-planner-helpers.ts";

function enemyVanguard(id: string, position: Position): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 4, unitType: "VANGUARD" };
}

/** 单个 Ranger 场景：Ranger 在 [0,0]，Core 在 [20,0]（远，不干扰军事决策）。 */
function makeState(tick: number, enemies: VisibleEntity[], obstacleCells: ReadonlySet<string> = new Set()): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: [20, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [{ id: "r1", position: [0, 0], hp: 2, unitType: "RANGER", cargo: 0 }],
    workers: [],
    vanguards: [],
    rangers: [{ id: "r1", position: [0, 0], hp: 2, unitType: "RANGER", cargo: 0 }],
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells,
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

const CONFIG = { ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" as const };

// ---------------------------------------------------------------------------
// predictedEnemyCell：四方向主轴预测（核心修复）
// ---------------------------------------------------------------------------

test("predictedEnemyCell：横线 4 格外敌人 → 沿 x 轴逼近一格", () => {
  assert.deepEqual(predictedEnemyCell([0, 0], [4, 0]), [3, 0]);
  assert.deepEqual(predictedEnemyCell([0, 0], [-4, 0]), [-3, 0]);
});

test("predictedEnemyCell：竖线 4 格外敌人 → 沿 y 轴逼近一格", () => {
  assert.deepEqual(predictedEnemyCell([0, 0], [0, 4]), [0, 3]);
  assert.deepEqual(predictedEnemyCell([0, 0], [0, -4]), [0, -3]);
});

test("predictedEnemyCell：斜向敌人 → 只沿主轴走一步（不再斜跳）", () => {
  // 旧实现返回 (3,3)（米字斜步，敌人永远到不了）；新实现 |dx|>=|dy| 走 x → (3,4)
  assert.deepEqual(predictedEnemyCell([0, 0], [4, 4]), [3, 4]);
  assert.deepEqual(predictedEnemyCell([0, 0], [4, 2]), [3, 2]);
  assert.deepEqual(predictedEnemyCell([0, 0], [2, 4]), [2, 3]);
});

test("predictedEnemyCell：同格（已在身边）→ null", () => {
  assert.equal(predictedEnemyCell([0, 0], [0, 0]), null);
});

// ---------------------------------------------------------------------------
// canShoot：射程 1-3、横/竖/正斜线、障碍遮挡（官方 v0.13 语义）
// ---------------------------------------------------------------------------

test("canShoot：射程边界——(3,3) 合法、(4,0) 超程、同格非法", () => {
  assert.ok(canShoot([0, 0], [3, 3], new Set()), "(3,3) 正斜线距离 3 可射");
  assert.ok(canShoot([0, 0], [3, 0], new Set()), "(3,0) 横线距离 3 可射");
  assert.ok(canShoot([0, 0], [0, 1], new Set()), "(0,1) 竖线距离 1 可射");
  assert.ok(!canShoot([0, 0], [4, 0], new Set()), "(4,0) 距离 4 超程");
  assert.ok(!canShoot([0, 0], [0, 0], new Set()), "同格不可射（距离 0）");
});

test("canShoot：非八方向线 (2,1) 非法", () => {
  assert.ok(!canShoot([0, 0], [2, 1], new Set()), "(2,1) 非横/竖/正斜线");
});

test("canShoot：中间格障碍遮挡——线挡不可射，端点障碍不挡", () => {
  assert.ok(!canShoot([0, 0], [3, 0], new Set([cellKey([2, 0])])), "中间格 [2,0] 障碍 → 遮挡");
  assert.ok(!canShoot([0, 0], [3, 3], new Set([cellKey([1, 1])])), "斜线中间格 [1,1] 障碍 → 遮挡");
  assert.ok(canShoot([0, 0], [3, 0], new Set([cellKey([3, 0])])), "目标格自身的障碍不挡（无遮挡弹道）");
});

// ---------------------------------------------------------------------------
// 集成：SafetyPlanner decide 的 shoot_cell 分支
// ---------------------------------------------------------------------------

test("shoot_cell：斜向 4 格外敌人 → 不再射空气（旧实现打 (3,3) 必空）", () => {
  const planner = new SafetyPlanner(CONFIG);
  // 敌 Vanguard [4,4]：斜向 4 格，超射程。旧预测 (3,3)（米字斜步）→ 空枪；
  // 新预测 (3,4) 不在射击线上 → canShoot 拒绝 → 不开预判枪。
  const plan = planner.decide({
    state: makeState(1, [enemyVanguard("e1", [4, 4])]),
    policy: AGGRESSIVE_POLICY,
  });
  assert.notEqual(plan.intents["r1"], "shoot_cell", "斜向敌人不预判开火");
  const action = plan.unitActions["r1"];
  assert.ok(action.type !== "SHOOT", "斜向敌人不出 SHOOT（不射空气）");
});

test("shoot_cell：横线 4 格外敌人朝我逼近 → 预判下一格并开火", () => {
  const planner = new SafetyPlanner(CONFIG);
  // 敌 Vanguard [4,0] 横线 4 格：预测 (3,0)（敌下一步若逼近即命中）
  const plan = planner.decide({
    state: makeState(1, [enemyVanguard("e1", [4, 0])]),
    policy: AGGRESSIVE_POLICY,
  });
  assert.equal(plan.intents["r1"], "shoot_cell");
  assert.deepEqual(plan.unitActions["r1"], { type: "SHOOT", targetId: null, expectedCell: [3, 0] });
});

test("shoot_cell：竖线 4 格外敌人 → 预判沿 y 轴逼近", () => {
  const planner = new SafetyPlanner(CONFIG);
  const plan = planner.decide({
    state: makeState(1, [enemyVanguard("e1", [0, 4])]),
    policy: AGGRESSIVE_POLICY,
  });
  assert.equal(plan.intents["r1"], "shoot_cell");
  assert.deepEqual(plan.unitActions["r1"], { type: "SHOOT", targetId: null, expectedCell: [0, 3] });
});

test("shoot_cell：预测格弹道被障碍遮挡 → 不预判开火", () => {
  const planner = new SafetyPlanner(CONFIG);
  // 敌 [4,0]，预测 (3,0)，但中间格 [2,0] 有障碍 → 弹道遮挡 → 不开预判枪
  const plan = planner.decide({
    state: makeState(1, [enemyVanguard("e1", [4, 0])], new Set([cellKey([2, 0])])),
    policy: AGGRESSIVE_POLICY,
  });
  assert.notEqual(plan.intents["r1"], "shoot_cell", "弹道被障碍遮挡不预判");
  const action = plan.unitActions["r1"];
  assert.ok(action.type !== "SHOOT", "障碍遮挡不出 SHOOT");
});

test("shoot_cell：预测格本身是障碍 → 不开预判枪、走位接敌（t1 生产 79857 实证）", () => {
  const planner = new SafetyPlanner(CONFIG);
  // 敌 [4,0] 横线 4 格外：预测 (3,0)，但 (3,0) 本身就是障碍格——敌人一步
  // 永远走不进去（t1 生产：敌 WORKER [-538,-80] 被障碍列 [-539,-80] 隔开，
  // 游侠群连开 320+ 枪全 SHOT_MISSED 且被 shoot_cell 提前 return 钉死原地）。
  // canShoot 只查弹道中间格不查终点，此场景旧实现必然空枪。
  const plan = planner.decide({
    state: makeState(1, [enemyVanguard("e1", [4, 0])], new Set([cellKey([3, 0])])),
    policy: AGGRESSIVE_POLICY,
  });
  assert.notEqual(plan.intents["r1"], "shoot_cell", "预测格是障碍不预判开火");
  const action = plan.unitActions["r1"];
  assert.ok(action.type !== "SHOOT", "预测格是障碍不出 SHOOT（不打障碍）");
  assert.equal(action.type, "MOVE", "跳过空枪后游侠走位接敌（不再钉死原地）");
});

test("shoot_cell：斜向预测格是障碍 → 不开预判枪（生产镜像：敌 (4,3) 隔障碍列）", () => {
  const planner = new SafetyPlanner(CONFIG);
  // 生产实况镜像：Ranger [-542,-83] vs 敌 WORKER [-538,-80]（相对 (4,3)），
  // 预测 (3,3) = [-539,-80] 障碍列——敌无法踏入，旧实现每 tick 空枪。
  const plan = planner.decide({
    state: makeState(1, [enemyVanguard("e1", [4, 3])], new Set([cellKey([3, 3])])),
    policy: AGGRESSIVE_POLICY,
  });
  assert.notEqual(plan.intents["r1"], "shoot_cell", "斜向预测格是障碍不预判开火");
  const action = plan.unitActions["r1"];
  assert.ok(action.type !== "SHOOT", "斜向预测格是障碍不出 SHOOT");
  assert.equal(action.type, "MOVE", "斜向障碍场景同样走位接敌");
});

test("shoot_cell：射程内可见敌 → 优先 precision shoot（不抢预判）", () => {
  const planner = new SafetyPlanner(CONFIG);
  // 敌 Vanguard [2,0] 在射程（横线 2 格）→ precision shoot 打当前位置
  const plan = planner.decide({
    state: makeState(1, [enemyVanguard("e1", [2, 0])]),
    policy: AGGRESSIVE_POLICY,
  });
  assert.equal(plan.intents["r1"], "shoot");
  assert.deepEqual(plan.unitActions["r1"], { type: "SHOOT", targetId: "e1", expectedCell: [2, 0] });
});

// ---------------------------------------------------------------------------
// C1 修复测试（2026-08-10）：静止敌人不预判开火
// 生产实证 shoot_cell 367 发 → 360 SHOT_MISSED（98% 空枪率），根因是敌方
// WORKER 站在资源格采集不动，预判格永远空。修复后：敌人在资源格上或
// enemyHints 确认静止（prevPosition === position）时跳过 cell fire。
// ---------------------------------------------------------------------------

test("shoot_cell C1：敌人在资源格上 → 不预判开火（采集 WORKER 不动）", () => {
  const planner = new SafetyPlanner(CONFIG);
  // 敌 Vanguard [4,0] 横线 4 格，预测 (3,0)——但敌人在资源格上（采集中
  // 不动），预判格永远空 → 不应预判开火。
  const state = makeState(1, [enemyVanguard("e1", [4, 0])]);
  // 在敌人格上放资源格
  const stateWithResource = { ...state, resourceCells: new Set([cellKey([4, 0])]) };
  const plan = planner.decide({
    state: stateWithResource,
    policy: AGGRESSIVE_POLICY,
  });
  assert.notEqual(plan.intents["r1"], "shoot_cell", "敌人在资源格上不预判开火");
  const action = plan.unitActions["r1"];
  assert.ok(action.type !== "SHOOT", "资源格上敌人不出 SHOOT（不射空气）");
  assert.equal(action.type, "MOVE", "跳过空枪后游侠走位接敌");
});

test("shoot_cell C1：确认静止敌人（二次目击同位置）→ 不预判开火", () => {
  const planner = new SafetyPlanner(CONFIG);
  // 第一次 decide：敌 Vanguard [4,0] 横线 4 格 → 首次目击（无 prevPosition）
  // → 允许预判开火（无证据反证其移动）。同时 world.observe 会记录敌情。
  const state1 = makeState(1, [enemyVanguard("e1", [4, 0])]);
  planner.decide({ state: state1, policy: AGGRESSIVE_POLICY });

  // 第二次 decide：敌仍在 [4,0]（静止）→ prevPosition === position
  // → 确认静止 → 不预判开火。
  const state2 = makeState(2, [enemyVanguard("e1", [4, 0])]);
  const plan = planner.decide({ state: state2, policy: AGGRESSIVE_POLICY });
  assert.notEqual(plan.intents["r1"], "shoot_cell", "确认静止敌人不预判开火");
  const action = plan.unitActions["r1"];
  assert.ok(action.type !== "SHOOT", "静止敌人不出 SHOOT（不射空气）");
  assert.equal(action.type, "MOVE", "跳过空枪后游侠走位接敌");
});

test("shoot_cell C1 零回归：首次目击移动方向未知 → 仍允许预判开火", () => {
  const planner = new SafetyPlanner(CONFIG);
  // 敌 Vanguard [4,0] 横线 4 格，无资源格、无 enemyHints 记忆 → 首次目击
  // → 允许预判（无证据反证其移动）。
  const plan = planner.decide({
    state: makeState(1, [enemyVanguard("e1", [4, 0])]),
    policy: AGGRESSIVE_POLICY,
  });
  assert.equal(plan.intents["r1"], "shoot_cell", "首次目击允许预判开火");
  assert.deepEqual(plan.unitActions["r1"], { type: "SHOOT", targetId: null, expectedCell: [3, 0] });
});
