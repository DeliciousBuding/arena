/**
 * 路径规划测试（v0.2.7 生产死锁回归）：
 * 满载 Worker 回仓路线被敌方单位群挡路时，旧扩框 BFS 要么走出包围盒、
 * 要么给出必被容量拒绝的 MOVE（capacity_wait:DEPOSIT 死锁）。
 * stepTowardPath 是半径受限确定性 BFS：局部绕行、不走进障碍、预算内终止。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { cellKey, type Direction, type Position } from "../src/domain/model.ts";
import { adaptivePathOptions, DEFAULT_PATH_SEARCH_OPTIONS, move, stepToward, stepTowardPath } from "../src/domain/nav.ts";

function obstaclesOf(cells: readonly Position[]): Set<string> {
  return new Set(cells.map((cell) => cellKey(cell)));
}

test("开阔地回归：直线路径第一步与旧行为一致", () => {
  assert.equal(stepTowardPath([0, 0], [5, 0], new Set()), "RIGHT");
  assert.equal(stepTowardPath([0, 0], [0, 5], new Set()), "DOWN");
  // |dy| > |dx|：y 轴优先（与旧 orderedDirections tie-break 一致）
  assert.equal(stepTowardPath([0, 0], [-3, -4], new Set()), "UP");
  assert.equal(stepToward([0, 0], [5, 0], new Set()), "RIGHT");
});

test("直线墙绕行：墙挡住直路时绕行而非 WAIT，且路径可达", () => {
  const wall = obstaclesOf(([1, 2, 3, 4] as const).map((x) => [x, 0] as Position));
  const start: Position = [0, 0];
  const target: Position = [5, 0];
  const first = stepTowardPath(start, target, wall);
  assert.notEqual(first, null, "必须给出绕行方向");
  assert.notEqual(first, "RIGHT", "直走方向被墙挡，不得选它");
  // 沿 BFS 输出逐步走到目标（每步用当前状态重算，验证路径可达）
  let cursor: Position = start;
  let steps = 0;
  while (cursor[0] !== target[0] || cursor[1] !== target[1]) {
    const direction = stepTowardPath(cursor, target, wall);
    assert.notEqual(direction, null, `tick ${steps}: 不得卡死`);
    cursor = move(cursor, direction as Direction);
    assert.ok(!wall.has(cellKey(cursor)), "不得走进障碍");
    steps += 1;
    assert.ok(steps < 50, "绕行路径不应过长");
  }
});

test("生产场景复刻：满载 Worker 被敌方 Worker 群三面围堵时绕行（不 capacity_wait）", () => {
  // 生产实测坐标：w1 在 [-316,57]，Core 在 [-332,41]，敌方 Worker 群在
  // [-317,57]/[-315,57]/[-316,58] 三面围住（上方 [-316,56] 空）。
  const start: Position = [-316, 57];
  const target: Position = [-332, 41];
  const enemyCells = obstaclesOf([[-317, 57], [-315, 57], [-316, 58]]);
  const first = stepTowardPath(start, target, enemyCells);
  assert.equal(first, "UP", "唯一出口是上方 [-316,56]，必须向上绕行");
  const next = move(start, first as Direction);
  assert.ok(!enemyCells.has(cellKey(next)), "不得走入敌方格");
});

test("四面围死：目标不可达时返回 null（WAIT 是正确行为）", () => {
  const start: Position = [-316, 57];
  const target: Position = [-332, 41];
  const encircle = obstaclesOf([[-317, 57], [-315, 57], [-316, 58], [-316, 56]]);
  assert.equal(stepTowardPath(start, target, encircle), null, "四面围死必须返回 null");
  assert.equal(stepToward(start, target, encircle), null, "回退链也找不到路");
});

test("fail-safe 不横跳：接近方向被墙挡时返回 null（WAIT）而非走远离方向的格", () => {
  // 生产实测：w1 在敌区边缘（接近方向被敌群墙挡死、远离方向空）——旧 fail-safe
  // 每 tick 走一格远离方向 → 在墙前左右横跳（12↔16 格徘徊）不接近目标。
  // 修复：fail-safe 只走"离目标更近"的格，否则 WAIT（敌群/障碍会移动）。
  const start: Position = [0, 0];
  const target: Position = [5, 0];
  // 接近方向（RIGHT/UP/DOWN）与目标格全被墙挡，只有 LEFT（远离）空——
  // BFS 短路（目标被占）、扩框 BFS 无路，落到 fail-safe：不得横跳 LEFT。
  const wall = obstaclesOf([[1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [0, -1], [0, 1]]);
  assert.equal(stepToward(start, target, wall), null, "无接近方向时必须 WAIT 而非横跳远离");
});

test("4 向契约：move() 每步恰好一个轴向一格（引擎只支持 4 向）", () => {
  assert.deepEqual(move([3, -2], "RIGHT"), [4, -2]);
  assert.deepEqual(move([3, -2], "LEFT"), [2, -2]);
  assert.deepEqual(move([3, -2], "DOWN"), [3, -1]);
  assert.deepEqual(move([3, -2], "UP"), [3, -3]);
});

test("4 向契约：逐步走向目标时每步位移均为轴向一格（无对角步/穿角）", () => {
  // 引擎 START_MOVE/MOVE 只有 4 向；nav 输出方向必须保证每步位移 = 恰好 1 格轴向。
  const wall = obstaclesOf([
    [1, 0], [2, 0], [3, 0], [4, 0], [5, 0],
    [2, -1], [2, 1], [-1, 0],
  ]);
  const start: Position = [0, 0];
  const target: Position = [7, -4];
  let cursor: Position = start;
  let steps = 0;
  while (cursor[0] !== target[0] || cursor[1] !== target[1]) {
    const direction = stepTowardPath(cursor, target, wall);
    assert.notEqual(direction, null, `tick ${steps}: 不得卡死`);
    const next = move(cursor, direction as Direction);
    const dx = Math.abs(next[0] - cursor[0]);
    const dy = Math.abs(next[1] - cursor[1]);
    assert.equal(dx + dy, 1, `每步必须恰好轴向 1 格: ${JSON.stringify(cursor)} → ${JSON.stringify(next)}`);
    assert.ok(!wall.has(cellKey(next)), "不得走进障碍");
    cursor = next;
    steps += 1;
    assert.ok(steps < 100, "路径不应过长");
  }
});

test("目标格本身被占：提前短路返回 null", () => {
  const start: Position = [0, 0];
  const target: Position = [5, 0];
  const occupiedTarget = obstaclesOf([target]);
  assert.equal(stepTowardPath(start, target, occupiedTarget), null);
});

test("确定性：同输入两次结果一致", () => {
  const wall = obstaclesOf(([1, 2, 3] as const).map((x) => [x, 0] as Position));
  const inputs = [
    [[0, 0], [5, 0]],
    [[-316, 57], [-332, 41]],
    [[10, 10], [-10, -10]],
  ] as const;
  for (const [start, target] of inputs) {
    const obstacles = new Set(wall);
    if (start[0] < 0) obstacles.add(cellKey([-317, 57]));
    const first = stepTowardPath(start as Position, target as Position, obstacles);
    const second = stepTowardPath(start as Position, target as Position, obstacles);
    assert.equal(second, first);
  }
});

test("性能上限：100 组随机路径在预算内快速返回（无长尾）", () => {
  let total = 0;
  const started = performance.now();
  for (let index = 0; index < 100; index += 1) {
    const start: Position = [index % 20, (index * 7) % 20];
    const target: Position = [(index * 13) % 20, (index * 3) % 20];
    const obstacles = new Set<string>();
    for (let cell = 0; cell < 10; cell += 1) {
      obstacles.add(cellKey([(index + cell) % 20, (index * 2 + cell) % 20]));
    }
    if (stepTowardPath(start, target, obstacles) !== null) total += 1;
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `100 组路径应 <200ms，实际 ${elapsed.toFixed(1)}ms`);
  assert.ok(total > 0, "随机场景至少部分可达");
});
