/** 威胁方向侦察测试（2026-08-07，t2 生产实证）：worker 巡逻方位向已知敌核心
 * 方向加权——前 4 个 worker 覆盖威胁扇区 ±1，保证威胁来路（如 t2 NE=jerkman）
 * 始终有 ≥3 worker 侦察，小股进攻更早目击触发预警。无 CORE 目击 = 均匀零回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { threatWeightedDirection } from "../src/strategies/safety-planner.ts";
import { EXPLORE_DIRECTION_COUNT } from "../src/domain/nav.ts";

function distribution(threatSector: number | null, workers = 12): number[] {
  const counts = new Array(EXPLORE_DIRECTION_COUNT).fill(0);
  for (let i = 0; i < workers; i++) {
    const d = threatWeightedDirection(i, threatSector);
    counts[d]! += 1;
  }
  return counts;
}

test("threat-sector-scout：NE 威胁方向(7) + 12 worker → 威胁扇区(6/7/0)覆盖 ≥4", () => {
  const counts = distribution(7);
  const covered = counts[7]! + counts[6]! + counts[0]!;
  assert.ok(covered >= 4, `威胁扇区(7/6/0)应有 ≥4 worker，实际 ${covered} (分布 ${JSON.stringify(counts)})`);
  // 威胁方向本身 ≥1
  assert.ok(counts[7]! >= 1, `威胁方向 7 应有 worker，实际 ${counts[7]}`);
});

test("threat-sector-scout：无威胁方向(null) → 均匀分布每方位 1-2（零回归）", () => {
  const counts = distribution(null);
  assert.ok(counts.every((n) => n >= 1 && n <= 2), `均匀分布每方位 1-2，实际 ${JSON.stringify(counts)}`);
});

test("threat-sector-scout：威胁方向在 S(2) 时同样加权（通用性）", () => {
  const counts = distribution(2);
  const covered = counts[2]! + counts[1]! + counts[3]!;
  assert.ok(covered >= 4, `S 威胁扇区(1/2/3)应有 ≥4 worker，实际 ${JSON.stringify(counts)}`);
});

test("threat-sector-scout：worker 数少（5）时威胁方向仍有覆盖", () => {
  const counts = distribution(7, 5);
  assert.ok(counts[7]! >= 1, `5 worker 时威胁方向 7 应有 ≥1，实际 ${JSON.stringify(counts)}`);
});
