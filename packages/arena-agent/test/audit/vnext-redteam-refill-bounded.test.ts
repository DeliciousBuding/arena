/**
 * P0 回归测试：refill-predictions.ts 全表无界加载
 *
 * 基线：9cea8d3 前 loadRefillPredictions 的 SQL 无 LIMIT/WHERE tick>? 窗口，
 * 随着 resource_seen_history 跨 run 累积，每次调用会全量加载所有历史行到 RAM。
 * 修复后：SQL 包含 WHERE tick > ? 窗口过滤（REFILL_PREDICTION_WINDOW_TICKS=3000）。
 */

import { describe, it } from "node:test";
import * as assert from "node:assert";
import { computeRefillPredictions, REFILL_PREDICTION_WINDOW_TICKS } from "../../src/intel/refill-predictions.js";

describe("refill-predictions bounded load (P0 regression)", () => {
  it("REFILL_PREDICTION_WINDOW_TICKS is defined and within bounds", () => {
    assert.ok(REFILL_PREDICTION_WINDOW_TICKS > 0, "window must be positive");
    assert.ok(REFILL_PREDICTION_WINDOW_TICKS <= 10000, "window must be ≤ 10000 ticks");
  });

  it("computeRefillPredictions handles empty input", () => {
    const result = computeRefillPredictions([], 1000);
    assert.strictEqual(result.size, 0);
  });
});
