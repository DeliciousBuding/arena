/**
 * 纯工具/几何/回放插值测试（2026-08-08）：utils.ts 抽取的 mapEngine 纯函数——
 * 缩放桶、网格步长、屏幕线段保底、回放 trail 插值。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bucketScale, gridStepFor, extendScreen, replayInterp } from "../src/engine/utils.ts";

test("bucket-scale: 2 的半档幂桶（2^(round(log2(s)*2)/2)）", () => {
  assert.equal(bucketScale(8), 8);      // 2^3
  assert.equal(bucketScale(4), 4);      // 2^2
  assert.ok(Math.abs(bucketScale(6) - Math.pow(2, 2.5)) < 1e-9, "6 → 2^2.5≈5.657");
  assert.ok(Math.abs(bucketScale(2) - 2) < 1e-9);
  assert.ok(Math.abs(bucketScale(0.1) - Math.pow(2, Math.round(Math.log2(0.1) * 2) / 2)) < 1e-9, "低缩放半档");
  // 单调：更大缩放 → 桶不减
  assert.ok(bucketScale(16) >= bucketScale(8));
  // 边界：输入钳到 [0.05, 64]，输出有限且落在 2^±5 内（输入钳位不保证输出下界）
  assert.ok(Number.isFinite(bucketScale(0.001)) && bucketScale(0.001) > 0);
  assert.ok(bucketScale(999) <= 64);
});

test("grid-step: 2 的幂步长满足 step*s ≥ targetPx", () => {
  assert.equal(gridStepFor(8, 22), 4);   // 4*8=32 ≥ 22
  assert.equal(gridStepFor(4, 22), 8);   // 4*4=16 <22 → 8*4=32
  assert.equal(gridStepFor(2, 22), 16);  // 16*2=32
  assert.equal(gridStepFor(1, 22), 32);  // 32 ≥ 22
  assert.ok(gridStepFor(0.1, 22) <= 2048, "步长有 2048 上限");
});

test("extend-screen: 短线段按方向拉长到 minLen", () => {
  const a = { sx: 0, sy: 0 }, b = { sx: 3, sy: 4 }; // len 5
  const e = extendScreen(a, b, 20);
  assert.ok(Math.abs(Math.hypot(e.sx - a.sx, e.sy - a.sy) - 20) < 1e-9, "拉长到 minLen");
  assert.ok(Math.abs(e.sx / e.sy - 3 / 4) < 1e-9, "方向不变");
  // 足够长的线段原样返回
  const c = { sx: 30, sy: 40 };
  assert.equal(extendScreen(a, c, 20), c);
  // 零长度返回原 b
  assert.equal(extendScreen(a, a, 20), a);
});

test("replay-interp: trail 帧间线性插值", () => {
  const obj = { trail: [{ x: 0, y: 0, hp: 4, shield: 0, cargo: 0, t: 1 }, { x: 10, y: 10, hp: 3, shield: 1, cargo: 2, t: 2 }] };
  const mid = replayInterp(obj, 1, 0.5);
  assert.ok(mid, "mid 不应为 null");
  assert.equal(mid!.x, 5);
  assert.equal(mid!.y, 5);
  assert.equal(mid!.hp, 3, "hp 取 b（目标帧）");
  assert.equal(mid!.shield, 1);
  assert.equal(mid!.cargo, 2);
  assert.equal(replayInterp(obj, 0, 0.5)!.x, 0, "frame 0 用 a=b 起始");
  assert.equal(replayInterp({ trail: [] }, 1, 0.5), null, "空 trail 返回 null");
  assert.equal(replayInterp({}, 1, 0.5), null, "无 trail 返回 null");
  assert.equal(replayInterp(obj, 99, 1)!.x, 10, "frame 超界钳到末尾");
});
