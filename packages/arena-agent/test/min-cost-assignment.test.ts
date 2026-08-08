import test from "node:test";
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
