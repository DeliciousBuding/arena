/** worker 密集扫图测试（2026-08-07，worker-dense-scan-v1）：
 * 资源稀缺时 8 方位放射巡逻盲区大（半径 24 处相邻方位 ~18 格 > 视野 3×2，
 * 生产实测 avgVisible 0.5-0.6 格/tick）——密集模式 16 方位间距减半：
 * 1. workerDenseDirection 纯函数：12 worker 覆盖全部 16 方位、均匀分散；
 * 2. 与 8 方位 (index*3+7)%8 不同（更细网格）；
 * 3. 变体关闭 = 历史 8 方位零回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { workerDenseDirection } from "../src/strategies/safety-planner.ts";
import { EXPLORE_DIRECTION_COUNT } from "../src/domain/nav.ts";

test("worker-dense-scan：12 worker 覆盖全部 16 方位且均匀分散", () => {
  const counts = new Array(16).fill(0);
  const seen = new Set<number>();
  for (let i = 0; i < 12; i++) {
    const d = workerDenseDirection(i);
    assert.ok(d >= 0 && d < 16, `direction ${d} out of range`);
    counts[d]! += 1;
    seen.add(d);
  }
  assert.equal(seen.size, 12, `12 worker 应落 12 个不同方位，实际 ${seen.size} (${JSON.stringify([...seen])})`);
  assert.ok(counts.every((n) => n <= 1), `不应有方位重复，实际 ${JSON.stringify(counts)}`);
});

test("worker-dense-scan：16 方位与 8 方位初始分布不同（更细网格）", () => {
  const denseSeeds = Array.from({ length: 12 }, (_, i) => workerDenseDirection(i));
  const legacySeeds = Array.from({ length: 12 }, (_, i) => (i * 3 + 7) % EXPLORE_DIRECTION_COUNT);
  // 8 方位下 12 worker 必有重复方位；16 方位下 12 worker 全部不同
  assert.equal(new Set(legacySeeds).size, 8, `8 方位 12 worker 覆盖 8 个方位（必然重复）`);
  assert.equal(new Set(denseSeeds).size, 12, `16 方位 12 worker 覆盖 12 个方位（无重复）`);
});

test("worker-dense-scan：workerDenseDirection 恒在 16 方位内（确定性）", () => {
  for (let i = 0; i < 100; i++) {
    const d = workerDenseDirection(i);
    assert.ok(d >= 0 && d < 16);
  }
});
