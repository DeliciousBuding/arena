/**
 * StallRecovery 单元测试：死循环自动跳出状态机（触发覆盖 → 恢复验证 →
 * 连续失败升级 all-in 军事 → 冷却防抖动）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { MacroPolicy } from "../src/runtime/macro-policy.ts";
import { StallRecovery } from "../src/runtime/stall-recovery.ts";
import type { StallEvent, StallKind } from "../src/runtime/stall-detector.ts";

const BASE: MacroPolicy = {
  posture: "balanced",
  workerTarget: 8,
  militaryRatio: 0.3,
  focusRegion: [100, 100],
  attackPriority: null,
};

function event(kind: StallKind, tick: number): StallEvent {
  return { kind, tick, streak: 16, detail: {} };
}

function noEvents(): readonly StallEvent[] {
  return [];
}

test("StallRecovery: 事件触发 → recovering，policyFor 清除 focusRegion", () => {
  const recovery = new StallRecovery();
  // 触发前 policyFor 原样
  assert.equal(recovery.stateOf(), "idle");
  assert.deepEqual(recovery.policyFor(BASE), BASE);

  const transition = recovery.observe([event("focus_exile", 1000)], { tick: 1000, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(transition?.state, "recovering");
  assert.equal(transition?.kind, "focus_exile");
  assert.equal(recovery.stateOf(), "recovering");

  // 覆盖：仅 focusRegion=null，其余保留（最小干预）
  const overridden = recovery.policyFor(BASE);
  assert.equal(overridden.focusRegion, null);
  assert.equal(overridden.workerTarget, BASE.workerTarget);
  assert.equal(overridden.militaryRatio, BASE.militaryRatio);
});

test("StallRecovery: 经济恢复 → 提前退出（success）", () => {
  const recovery = new StallRecovery();
  recovery.observe([event("no_production", 1000)], { tick: 1000, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(recovery.stateOf(), "recovering");

  const exited = recovery.observe(noEvents(), { tick: 1001, coreResourceDelta: 2, harvestCount: 1, depositCount: 0 });
  assert.equal(exited?.state, "idle");
  assert.equal(exited?.kind, "no_production");
  assert.equal(recovery.stateOf(), "idle");
  assert.deepEqual(recovery.policyFor(BASE), BASE, "退出后恢复原 policy");
});

test("StallRecovery: 到期未恢复 → 记失败；连续失败达上限 → escalating all-in 军事", () => {
  const recovery = new StallRecovery({ recoveryTicks: 10, escalateAfterFailures: 2 });
  // 第一轮：触发 → 10 tick 未恢复 → 失败回 idle
  recovery.observe([event("focus_exile", 1000)], { tick: 1000, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  for (let tick = 1001; tick < 1010; tick += 1) {
    const t = recovery.observe(noEvents(), { tick, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
    assert.equal(t, null, "干预中无迁移");
    assert.equal(recovery.stateOf(), "recovering");
    assert.equal(recovery.policyFor(BASE).focusRegion, null, "干预中持续覆盖");
  }
  const firstFail = recovery.observe(noEvents(), { tick: 1010, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(firstFail?.state, "idle");
  assert.equal(recovery.stateOf(), "idle");

  // 第二轮：冷却期内同类事件不触发（focus_exile 冷却 64 tick）
  const cooled = recovery.observe([event("focus_exile", 1020)], { tick: 1020, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(cooled, null, "冷却期内同类事件不触发");
  assert.equal(recovery.stateOf(), "idle");

  // 冷却结束（tick >= 1010 + 64 = 1074）再触发 → 第二轮失败 → escalating
  recovery.observe([event("focus_exile", 1075)], { tick: 1075, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  for (let tick = 1076; tick < 1085; tick += 1) {
    recovery.observe(noEvents(), { tick, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  }
  const escalate = recovery.observe(noEvents(), { tick: 1085, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(escalate?.state, "escalating");
  assert.equal(recovery.stateOf(), "escalating");

  const allIn = recovery.policyFor(BASE);
  assert.equal(allIn.posture, "aggressive");
  assert.equal(allIn.militaryRatio, 1);
  assert.equal(allIn.attackPriority, "core");
  assert.equal(allIn.focusRegion, null);
});

test("StallRecovery: escalating 到期回 idle（带 escalated 标记）", () => {
  const recovery = new StallRecovery({ recoveryTicks: 5, escalateAfterFailures: 1, escalationTicks: 8 });
  recovery.observe([event("patrol_only", 1000)], { tick: 1000, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  for (let tick = 1001; tick < 1005; tick += 1) {
    recovery.observe(noEvents(), { tick, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  }
  const escalate = recovery.observe(noEvents(), { tick: 1005, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(escalate?.state, "escalating");

  const exited = recovery.observe(noEvents(), { tick: 1013, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(exited?.state, "idle");
  assert.equal(exited?.escalated, true, "escalating 结束带标记");
  assert.equal(recovery.stateOf(), "idle");
  assert.deepEqual(recovery.policyFor(BASE), BASE);
});

test("StallRecovery: 迁移结局 outcome 标记（recovered/failed/expired）", () => {
  // 经济恢复 → recovered
  const success = new StallRecovery({ recoveryTicks: 128 });
  success.observe([event("cargo_blocked", 500)], { tick: 500, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  const recovered = success.observe(noEvents(), { tick: 502, coreResourceDelta: 2, harvestCount: 1, depositCount: 0 });
  assert.equal(recovered?.state, "idle");
  assert.equal(recovered?.outcome, "recovered");

  // 到期未恢复 → failed（升级 escalating 时同标 failed）
  const failing = new StallRecovery({ recoveryTicks: 10, escalateAfterFailures: 2, cooldownTicks: 0 });
  failing.observe([event("focus_exile", 600)], { tick: 600, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  for (let tick = 601; tick < 610; tick += 1) {
    failing.observe(noEvents(), { tick, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  }
  const firstFail = failing.observe(noEvents(), { tick: 610, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(firstFail?.outcome, "failed");
  failing.observe([event("focus_exile", 611)], { tick: 611, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  for (let tick = 612; tick < 621; tick += 1) {
    failing.observe(noEvents(), { tick, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  }
  const escalate = failing.observe(noEvents(), { tick: 621, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(escalate?.state, "escalating");
  assert.equal(escalate?.outcome, "failed");

  // escalating 到期 → expired
  const escalationTicks = 8;
  const exiting = new StallRecovery({ recoveryTicks: 5, escalateAfterFailures: 1, escalationTicks, cooldownTicks: 0 });
  exiting.observe([event("patrol_only", 700)], { tick: 700, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  for (let tick = 701; tick < 705; tick += 1) {
    exiting.observe(noEvents(), { tick, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  }
  exiting.observe(noEvents(), { tick: 705, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  const expired = exiting.observe(noEvents(), { tick: 705 + escalationTicks, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(expired?.state, "idle");
  assert.equal(expired?.outcome, "expired");
});
