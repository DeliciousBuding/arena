/**
 * 核心移动中守卫测试（2026-08-08，人机协同）：
 * - 核心移动中 + 目标是核心 → blocked（409 拦截）；
 * - 目标非核心 / 核心静止 / 核心数据缺失 → 放行；
 * - 快照不可用兜底（loadCoreMovingGuard 不抛）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCoreMovingGuard, loadCoreMovingGuard } from "../lib/human-command-guard.ts";

test("core-guard: 移动中核心指令拦截", () => {
  const moving = evaluateCoreMovingGuard({ id: "core-1", moving: true }, "core-1");
  assert.deepEqual(moving, { blocked: true, coreId: "core-1" });
});

test("core-guard: 放行场景", () => {
  // 目标非核心
  assert.deepEqual(evaluateCoreMovingGuard({ id: "core-1", moving: true }, "worker-9"), { blocked: false, coreId: "core-1" });
  // 核心静止
  assert.deepEqual(evaluateCoreMovingGuard({ id: "core-1", moving: false }, "core-1"), { blocked: false, coreId: "core-1" });
  // moving 未知（undefined）
  assert.deepEqual(evaluateCoreMovingGuard({ id: "core-1", moving: undefined }, "core-1"), { blocked: false, coreId: "core-1" });
  // 无核心数据
  assert.deepEqual(evaluateCoreMovingGuard(null, "core-1"), { blocked: false, coreId: null });
  assert.deepEqual(evaluateCoreMovingGuard(undefined, "core-1"), { blocked: false, coreId: null });
  assert.deepEqual(evaluateCoreMovingGuard({}, "core-1"), { blocked: false, coreId: null });
});

test("core-guard: 快照不可用不抛", () => {
  const r = loadCoreMovingGuard("zz-not-a-tenant", "u1");
  assert.equal(r.blocked, false);
});
