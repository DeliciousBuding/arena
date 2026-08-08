/**
 * 人机协同冲突审计测试（2026-08-08）：
 * - applied/rejected 计数 + 拒绝率；
 * - 拒绝原因 top（share 占比）；
 * - 手操类型构成（goal/clear/delete）；
 * - 空输入兜底。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateHumanConflict, type HumanConflictPayload } from "../lib/human-conflict.ts";
import type { HumanAuditEntry } from "../lib/human-audit.ts";

test("human-conflict: 拒绝原因 top + 手操构成", () => {
  const o = [
    JSON.stringify({ tick: 100, humanOverride: { applied: ["u1"], rejected: [{ unitId: "u2", reason: "Core is already moving" }] } }),
    JSON.stringify({ tick: 101, humanOverride: { applied: [], rejected: [{ unitId: "u2", reason: "Core is already moving" }] } }),
    JSON.stringify({ tick: 102, humanOverride: { applied: ["u3"], rejected: [{ unitId: "u4", reason: "stale goal" }] } }),
    JSON.stringify({ tick: 103, humanOverride: { applied: ["u5"], rejected: [] } }),
  ];
  const audit: HumanAuditEntry[] = [
    { at: "", tenant: "t3", kind: "goal", unitId: "u2", action: "goto [0,0]" },
    { at: "", tenant: "t3", kind: "goal", unitId: "u2", action: "goto [0,1]" },
    { at: "", tenant: "t3", kind: "clear" },
    { at: "", tenant: "t1", kind: "delete" },
  ];
  const a: HumanConflictPayload = aggregateHumanConflict("t3", 4, o, audit);
  assert.equal(a.applied, 3);
  assert.equal(a.rejected, 3);
  assert.equal(a.rejectedRate, 0.5, "3/(3+3)");
  assert.equal(a.currentTick, 103);
  assert.equal(a.topRejectedReasons.length, 2);
  assert.equal(a.topRejectedReasons[0]?.reason, "Core is already moving");
  assert.equal(a.topRejectedReasons[0]?.count, 2);
  assert.equal(a.topRejectedReasons[0]?.share, 0.667);
  assert.deepEqual(a.commandKinds, { goal: 2, clear: 1 }, "只统计本租户");
});

test("human-conflict: 空输入兜底", () => {
  const a = aggregateHumanConflict("t4", 3, [], []);
  assert.equal(a.applied, 0);
  assert.equal(a.rejected, 0);
  assert.equal(a.rejectedRate, null);
  assert.equal(a.topRejectedReasons.length, 0);
  assert.deepEqual(a.commandKinds, {});
  assert.equal(a.currentTick, null);
});
