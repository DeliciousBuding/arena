/** Hungarian 求解器单测（生产回流 99b4ba2，min-cost-assignment 契约）。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { minimumCostAssignment } from "../src/algorithms/min-cost-assignment.ts";

test("Hungarian: defeats local greedy trap", () => {
  // Greedy takes row0->col0 (1), forcing row1->col1 (4) = 5. Global optimum = 2 + 1 = 3.
  assert.deepEqual(minimumCostAssignment([[1, 2], [1, 4]]), [1, 0]);
});

test("Hungarian: rectangular matrix + deterministic tie", () => {
  assert.deepEqual(minimumCostAssignment([[1, 1, 9], [1, 1, 9]]), [0, 1]);
  assert.deepEqual(minimumCostAssignment([[4, 1, 3], [2, 0, 5]]), [1, 0]);
});

test("Hungarian: validates matrix", () => {
  assert.throws(() => minimumCostAssignment([[1], [2]]), /rows <= columns/);
  assert.throws(() => minimumCostAssignment([[1, Number.POSITIVE_INFINITY]]), /finite/);
});

test("Hungarian: deterministic across repeated runs (same input, same output)", () => {
  const matrix = [[3, 8, 1, 9], [7, 2, 6, 4], [5, 1, 4, 2]];
  const first = minimumCostAssignment(matrix);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(minimumCostAssignment(matrix), first);
  }
  // 3 rows x 4 cols: 每行映射到有效列索引，且列不重复（每列至多一行）。
  assert.deepEqual(new Set(first).size, first.length);
  assert.ok(first.every((column) => column >= 0 && column < 4));
});

test("Hungarian: empty matrix returns empty assignment", () => {
  assert.deepEqual(minimumCostAssignment([]), []);
});
