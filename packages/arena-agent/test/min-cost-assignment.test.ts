import { test } from "node:test";
import assert from "node:assert/strict";
import { minimumCostAssignment } from "../src/algorithms/min-cost-assignment.ts";

test("hungarian: 空矩阵 → 空分配", () => {
  assert.deepEqual(minimumCostAssignment([]), []);
});

test("hungarian: 单行单列 → 唯一分配", () => {
  assert.deepEqual(minimumCostAssignment([[5]]), [0]);
});

test("hungarian: 2x2 最优解（非贪心）", () => {
  // 贪心会取 (0,0)=1 + (1,1)=100；最优是 (0,1)=2 + (1,0)=3
  const matrix = [
    [1, 2],
    [3, 100],
  ];
  const assignment = minimumCostAssignment(matrix);
  assert.deepEqual([...assignment].sort(), [0, 1]);
  const cost = assignment.reduce((sum, col, row) => sum + matrix[row]![col]!, 0);
  assert.equal(cost, 5);
});

test("hungarian: 矩形矩阵（列 > 行）用 dummy 列吸收", () => {
  const matrix = [
    [1, 2, 3],
    [4, 5, 6],
  ];
  const assignment = minimumCostAssignment(matrix);
  assert.equal(assignment.length, 2);
  const cost = assignment.reduce((sum, col, row) => sum + matrix[row]![col]!, 0);
  // 最优 (0,0)=1 + (1,1)=5
  assert.equal(cost, 6);
});

test("hungarian: 大值惩罚列（不可行 bid）自然跳过", () => {
  const matrix = [
    [1_000_000, 1_000_000, 0], // 两个任务都不可行 → 落 dummy
  ];
  const assignment = minimumCostAssignment(matrix);
  assert.equal(assignment[0], 2);
});

test("hungarian: 3x3 置换矩阵", () => {
  const matrix = [
    [9, 8, 7],
    [6, 5, 4],
    [3, 2, 1],
  ];
  const assignment = minimumCostAssignment(matrix);
  assert.deepEqual([...assignment].sort(), [0, 1, 2]);
  const cost = assignment.reduce((sum, col, row) => sum + matrix[row]![col]!, 0);
  assert.equal(cost, 15); // 对角 9+5+1
});
