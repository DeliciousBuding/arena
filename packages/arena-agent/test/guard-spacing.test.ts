/**
 * 守卫外环守位测试（guard-spacing-v1，2026-08-09 用户裁决"守卫隔开拱卫，
 * 不堵死核心四邻"）：核心 4 邻格是核心移动通道 + worker 卸货通道——守卫
 * 站位优先核心外环（Chebyshev 2-3，四角优先），4 邻让给通道；外环全堵
 * 才回退历史 homeCell 四邻（零回归兜底）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { cellKey } from "../src/domain/model.ts";
import { chebyshev } from "../src/domain/nav.ts";
import { guardHomeCell } from "../src/strategies/safety-planner-helpers.ts";

test("外环守位：默认站位在 Chebyshev 2-5 外环，绝不占核心 4 邻（通道格）", () => {
  const core: readonly [number, number] = [0, 0];
  const obstacles = new Set<string>();
  for (let index = 0; index < 16; index += 1) {
    const post = guardHomeCell(core, obstacles, index);
    assert.notEqual(post, null, `index ${index} 应有外环守位`);
    const distance = chebyshev(core, post!);
    assert.ok(distance >= 2 && distance <= 5, `守位应在 2-5 外环: ${JSON.stringify(post)}`);
    // 4 邻通道格（Chebyshev 1 的上下左右）必须空
    assert.ok(
      !(post![0] === 0 && Math.abs(post![1]) === 1) && !(post![1] === 0 && Math.abs(post![0]) === 1),
      `守位不得占核心 4 邻通道格: ${JSON.stringify(post)}`,
    );
  }
});

test("密度疏散：2-3 环全被占 → 4-5 环仍有位置（迁移期 14 单位挤核心场景）", () => {
  const core: readonly [number, number] = [0, 0];
  const obstacles = new Set<string>();
  // 占满 Cheb 2-3 环（16 格）——t1 生产实证单位密度
  for (let x = -3; x <= 3; x += 1) {
    for (let y = -3; y <= 3; y += 1) {
      const d = Math.max(Math.abs(x), Math.abs(y));
      if (d >= 2 && d <= 3) obstacles.add(cellKey([x, y]));
    }
  }
  const post = guardHomeCell(core, obstacles, 0);
  assert.notEqual(post, null, "2-3 环全堵应疏散到 4-5 环");
  const distance = chebyshev(core, post!);
  assert.ok(distance === 4 || distance === 5, `疏散位应在 4-5 环: ${JSON.stringify(post)}`);
});

test("四角优先：index 0 首选对角外环格（拱卫四角）", () => {
  const core: readonly [number, number] = [0, 0];
  const post = guardHomeCell(core, new Set(), 0);
  assert.deepEqual(post, [-2, -2], "index 0 应首选左上对角外环（确定性）");
});

test("疏散环全被占满（Cheb 2-5）→ 回退历史 homeCell 四邻（零回归兜底）", () => {
  const core: readonly [number, number] = [0, 0];
  const obstacles = new Set<string>();
  for (let x = -5; x <= 5; x += 1) {
    for (let y = -5; y <= 5; y += 1) {
      if (Math.max(Math.abs(x), Math.abs(y)) >= 2) obstacles.add(cellKey([x, y]));
    }
  }
  const post = guardHomeCell(core, obstacles, 0);
  assert.notEqual(post, null, "疏散环全堵应回退 4 邻");
  assert.equal(chebyshev(core, post!), 1, "回退站 4 邻（homeCell 历史行为）");
});
