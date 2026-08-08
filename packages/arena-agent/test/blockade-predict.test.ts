/**
 * 锁阵预判纯函数测试（2026-08-08，blockade-tactics-v1 阶段 0）：
 * enemyReturnPath（敌方回程路径预测）/ chokepointLockPoint（环境瓶颈锁点）/
 * suspectedBlocked（疑似被锁检测）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chokepointLockPoint,
  enemyReturnPath,
  suspectedBlocked,
  type EnemyReturnPrediction,
} from "../src/strategies/blockade-predict.ts";
import type { CoreHuntTarget, EnemyMemory } from "../src/domain/world.ts";

function hint(overrides: Partial<EnemyMemory> & { id: string }): EnemyMemory {
  return {
    position: [0, 0],
    prevPosition: [0, 1],
    prevSeenTick: 90,
    pursuitScore: 0,
    kind: "UNIT",
    unitType: "WORKER",
    lastSeenTick: 100,
    ...overrides,
  };
}

const coreTarget = (position: [number, number]): CoreHuntTarget => ({
  position,
  lastSeenTick: 100,
  source: "CORE",
});

test("enemyReturnPath：朝敌核心移动 → 预测 nextCells + targetCore", () => {
  // 敌 worker 从 (0,1) 移到 (0,0)（UP），敌核心在 (0,-4)
  const result = enemyReturnPath(
    [hint({ id: "e1", position: [0, 0], prevPosition: [0, 1], unitType: "WORKER" })],
    [coreTarget([0, -4])],
    new Set(),
  );
  assert.equal(result.length, 1);
  const prediction = result[0];
  assert.equal(prediction.enemyId, "e1");
  assert.equal(prediction.direction, "UP");
  assert.deepEqual(prediction.nextCells, [[0, -1], [0, -2], [0, -3], [0, -4]]);
  assert.deepEqual(prediction.targetCore, [0, -4]);
});

test("enemyReturnPath：斜跳/原地不算移动中", () => {
  // 斜跳（dx=1,dy=1）：不算一步卡向移动
  const diagonal = enemyReturnPath(
    [hint({ id: "e1", position: [1, 1], prevPosition: [0, 0] })],
    [coreTarget([10, 10])],
    new Set(),
  );
  assert.equal(diagonal.length, 0);
  // 原地（无 prevPosition 差分）
  const stationary = enemyReturnPath(
    [hint({ id: "e2", position: [0, 0], prevPosition: [0, 0] })],
    [coreTarget([10, 10])],
    new Set(),
  );
  assert.equal(stationary.length, 0);
});

test("enemyReturnPath：预测遇障碍中断", () => {
  const result = enemyReturnPath(
    [hint({ id: "e1", position: [0, 0], prevPosition: [0, 1] })],
    [coreTarget([0, -10])],
    new Set(["0,-2"]), // 第二格是障碍
  );
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].nextCells, [[0, -1]]); // 只预测到障碍前
});

test("enemyReturnPath：移动方向不朝敌核心 → targetCore=null 但仍有预测", () => {
  // 敌 worker 朝 UP 走但敌核心在正下方（DOWN 方向）→ 无 targetCore
  const result = enemyReturnPath(
    [hint({ id: "e1", position: [0, 0], prevPosition: [0, 1] })],
    [coreTarget([0, 10])],
    new Set(),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].targetCore, null);
  assert.equal(result[0].nextCells.length, 4);
});

test("chokepointLockPoint：敌核心邻格优先", () => {
  const point = chokepointLockPoint(
    [0, 0],
    [[10, 10]],
    new Set(),
    new Set(),
  );
  assert.ok(point !== null);
  assert.equal(point.kind, "enemy_core_adjacent");
  assert.ok(
    (point.cell[0] === 1 && point.cell[1] === 0) || // RIGHT
    (point.cell[0] === -1 && point.cell[1] === 0) || // LEFT
    (point.cell[0] === 0 && point.cell[1] === 1) || // DOWN
    (point.cell[0] === 0 && point.cell[1] === -1),   // UP
    "锁点必须是敌核心四邻格",
  );
});

test("chokepointLockPoint：敌核心四邻全堵 → 资源旁", () => {
  const point = chokepointLockPoint(
    [0, 0],
    [[10, 0]],
    new Set(["0,1", "1,0", "0,-1", "-1,0"]), // 核心四邻全障碍
    new Set(),
  );
  assert.ok(point !== null);
  assert.equal(point.kind, "resource_adjacent");
  assert.deepEqual(point.cell, [10, -1]); // 资源 (10,0) 的第一个空邻格（UP = y-1）
});

test("chokepointLockPoint：资源旁也堵 → 障碍窄通道", () => {
  const point = chokepointLockPoint(
    null,
    [],
    new Set(["0,1", "0,2", "1,1", "2,1"]), // (1,1) 有 3 侧障碍、(0,2)/(1,1) 邻 2 侧
    new Set(),
  );
  assert.ok(point !== null);
  assert.equal(point.kind, "obstacle_pass");
  // 合法通道格：邻 ≥2 侧障碍（(1,2) 邻 (1,1)+(0,2)、(1,0) 邻 (1,1)+(2,1) 等）
  assert.ok(
    (point.cell[0] === 1 && point.cell[1] === 2) ||
    (point.cell[0] === 1 && point.cell[1] === 0),
    `expected a 2-side-blocked pass cell, got ${JSON.stringify(point.cell)}`,
  );
});

test("chokepointLockPoint：无可锁环境点返回 null", () => {
  // 无敌核心、无资源、无障碍 → 无环境锁点
  assert.equal(chokepointLockPoint(null, [], new Set(), new Set()), null);
  // 敌核心四邻全占（障碍或占用）+ 无资源 + 无通道 → null
  assert.equal(
    chokepointLockPoint(
      [0, 0],
      [],
      new Set(["0,1", "1,0", "0,-1", "-1,0", "5,1", "5,-1", "4,0", "6,0"]),
      new Set(["1,1", "-1,1", "1,-1", "-1,-1", "4,1", "4,-1", "3,0", "7,0", "5,0", "6,1", "6,-1"]),
    ),
    null,
  );
});

test("suspectedBlocked：连续失败 ≥3 且位置未变 = 被锁", () => {
  assert.equal(
    suspectedBlocked(new Map([["u1", 3]]), "u1", [0, 0], [0, 0]),
    true,
  );
  // 失败但位置变了（在移动）= 不算被锁
  assert.equal(
    suspectedBlocked(new Map([["u1", 3]]), "u1", [0, 1], [0, 0]),
    false,
  );
  // 失败次数不足
  assert.equal(
    suspectedBlocked(new Map([["u1", 2]]), "u1", [0, 0], [0, 0]),
    false,
  );
  // 无历史位置
  assert.equal(
    suspectedBlocked(new Map([["u1", 5]]), "u1", [0, 0], undefined),
    false,
  );
  // 自定义阈值
  assert.equal(
    suspectedBlocked(new Map([["u1", 5]]), "u1", [0, 0], [0, 0], 6),
    false,
  );
});
