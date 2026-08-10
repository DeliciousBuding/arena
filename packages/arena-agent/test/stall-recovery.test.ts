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

// === 2026-08-10 B6 修复测试：分 kind 成功判据 ===
// 盲点：军事类死锁触发 recovering 后，经济正常（delta>0）立即假成功——
// focusRegion=null 对军事互堵/空枪/迁移/spawn 死锁无意义。修复后军事类
// 用"对应失败事件归零"判成功。以下测试验证不误判 + 正确成功。

test("StallRecovery B6: military_interlock 经济正常不假成功（UNIT_MOVE_FAILED 未归零）", () => {
  const recovery = new StallRecovery({ recoveryTicks: 128 });
  recovery.observe([event("military_interlock", 100)], { tick: 100, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(recovery.stateOf(), "recovering");
  assert.equal(recovery.kindOf(), "military_interlock");

  // 经济正常（有采集）但军事互堵未解除（UNIT_MOVE_FAILED 仍有）→ 不应成功
  const stillStuck = recovery.observe(noEvents(), {
    tick: 101,
    coreResourceDelta: 5,
    harvestCount: 2,
    depositCount: 1,
    failedEventCounts: { UNIT_MOVE_FAILED: 3 },
    shotHitCount: 0,
  });
  assert.equal(stillStuck, null, "军事互堵未解除，不提前退出");
  assert.equal(recovery.stateOf(), "recovering", "仍在 recovering");
});

test("StallRecovery B6: military_interlock UNIT_MOVE_FAILED 归零 → 成功", () => {
  const recovery = new StallRecovery({ recoveryTicks: 128 });
  recovery.observe([event("military_interlock", 200)], { tick: 200, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });

  // 互堵解除（UNIT_MOVE_FAILED=0）→ 成功退出（即使经济 delta=0）
  const recovered = recovery.observe(noEvents(), {
    tick: 201,
    coreResourceDelta: 0,
    harvestCount: 0,
    depositCount: 0,
    failedEventCounts: {},
    shotHitCount: 0,
  });
  assert.equal(recovered?.state, "idle");
  assert.equal(recovered?.outcome, "recovered");
  assert.equal(recovery.stateOf(), "idle");
});

test("StallRecovery B6: shot_missed_spiral 经济正常不假成功", () => {
  const recovery = new StallRecovery({ recoveryTicks: 128 });
  recovery.observe([event("shot_missed_spiral", 300)], { tick: 300, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });

  // 经济正常但仍在空枪（SHOT_MISSED>0 且 shotHit=0）→ 不应成功
  const stillMissing = recovery.observe(noEvents(), {
    tick: 301,
    coreResourceDelta: 3,
    harvestCount: 1,
    depositCount: 0,
    failedEventCounts: { SHOT_MISSED: 2 },
    shotHitCount: 0,
  });
  assert.equal(stillMissing, null);
  assert.equal(recovery.stateOf(), "recovering");
});

test("StallRecovery B6: shot_missed_spiral shotHitCount>0 → 成功（即使仍有 miss）", () => {
  const recovery = new StallRecovery({ recoveryTicks: 128 });
  recovery.observe([event("shot_missed_spiral", 400)], { tick: 400, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });

  // 有命中（shotHitCount>0）→ 空枪螺旋已破 → 成功（即使 SHOT_MISSED 仍有）
  const recovered = recovery.observe(noEvents(), {
    tick: 401,
    coreResourceDelta: 0,
    harvestCount: 0,
    depositCount: 0,
    failedEventCounts: { SHOT_MISSED: 1 },
    shotHitCount: 2,
  });
  assert.equal(recovered?.state, "idle");
  assert.equal(recovered?.outcome, "recovered");
});

test("StallRecovery B6: shot_missed_spiral SHOT_MISSED 归零 → 成功", () => {
  const recovery = new StallRecovery({ recoveryTicks: 128 });
  recovery.observe([event("shot_missed_spiral", 500)], { tick: 500, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });

  const recovered = recovery.observe(noEvents(), {
    tick: 501,
    coreResourceDelta: 0,
    harvestCount: 0,
    depositCount: 0,
    failedEventCounts: {},
    shotHitCount: 0,
  });
  assert.equal(recovered?.state, "idle");
  assert.equal(recovered?.outcome, "recovered");
});

test("StallRecovery B6: migration_stall CORE_MOVE_START_FAILED 归零 → 成功", () => {
  const recovery = new StallRecovery({ recoveryTicks: 128 });
  recovery.observe([event("migration_stall", 600)], { tick: 600, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });

  // 经济正常但迁移仍失败 → 不成功
  const stillFailing = recovery.observe(noEvents(), {
    tick: 601,
    coreResourceDelta: 4,
    harvestCount: 2,
    depositCount: 1,
    failedEventCounts: { CORE_MOVE_START_FAILED: 1 },
  });
  assert.equal(stillFailing, null);
  assert.equal(recovery.stateOf(), "recovering");

  // 迁移不再失败 → 成功
  const recovered = recovery.observe(noEvents(), {
    tick: 602,
    coreResourceDelta: 0,
    harvestCount: 0,
    depositCount: 0,
    failedEventCounts: {},
  });
  assert.equal(recovered?.state, "idle");
  assert.equal(recovered?.outcome, "recovered");
});

test("StallRecovery B6: spawn_stall CORE_SPAWN_FAILED 归零 → 成功", () => {
  const recovery = new StallRecovery({ recoveryTicks: 128 });
  recovery.observe([event("spawn_stall", 700)], { tick: 700, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });

  const stillFailing = recovery.observe(noEvents(), {
    tick: 701,
    coreResourceDelta: 2,
    harvestCount: 1,
    depositCount: 0,
    failedEventCounts: { CORE_SPAWN_FAILED: 1 },
  });
  assert.equal(stillFailing, null);
  assert.equal(recovery.stateOf(), "recovering");

  const recovered = recovery.observe(noEvents(), {
    tick: 702,
    coreResourceDelta: 0,
    harvestCount: 0,
    depositCount: 0,
    failedEventCounts: {},
  });
  assert.equal(recovered?.state, "idle");
  assert.equal(recovered?.outcome, "recovered");
});

test("StallRecovery B6 零回归: 经济类 kind 仍用 economyRecovered（无 failedEventCounts 兼容）", () => {
  // focus_exile（经济类）不传 failedEventCounts → 回退到 economyRecovered
  const recovery = new StallRecovery({ recoveryTicks: 128 });
  recovery.observe([event("focus_exile", 800)], { tick: 800, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });

  // 经济恢复 → 成功（不传 failedEventCounts，兼容旧调用方）
  const recovered = recovery.observe(noEvents(), {
    tick: 801,
    coreResourceDelta: 1,
    harvestCount: 0,
    depositCount: 0,
  });
  assert.equal(recovered?.state, "idle");
  assert.equal(recovered?.outcome, "recovered");
});

test("StallRecovery C8: failureRounds 在 recovered 时归零（不累积到 escalating）", () => {
  // 场景：第一轮失败 → 第二轮成功恢复 → 后续 stall 不应一轮即 escalating
  const recovery = new StallRecovery({ recoveryTicks: 10, escalateAfterFailures: 2, cooldownTicks: 0 });

  // 第一轮：focus_exile 触发 → 10 tick 未恢复 → 失败（failureRounds=1）
  recovery.observe([event("focus_exile", 1000)], { tick: 1000, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  for (let tick = 1001; tick < 1010; tick += 1) {
    recovery.observe(noEvents(), { tick, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  }
  const firstFail = recovery.observe(noEvents(), { tick: 1010, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(firstFail?.outcome, "failed");
  assert.equal(recovery.stateOf(), "idle");

  // 第二轮：再次触发 → 成功恢复（failureRounds 应归零）
  recovery.observe([event("focus_exile", 1011)], { tick: 1011, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  const recovered = recovery.observe(noEvents(), { tick: 1012, coreResourceDelta: 2, harvestCount: 1, depositCount: 0 });
  assert.equal(recovered?.outcome, "recovered");

  // 第三轮：触发 → 失败一次 → 不应 escalating（failureRounds=1 < 2）
  recovery.observe([event("focus_exile", 1013)], { tick: 1013, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  for (let tick = 1014; tick < 1023; tick += 1) {
    recovery.observe(noEvents(), { tick, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  }
  const thirdFail = recovery.observe(noEvents(), { tick: 1023, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(thirdFail?.state, "idle", "第三轮失败一次不应 escalating（failureRounds 已归零）");
  assert.equal(thirdFail?.outcome, "failed");
  assert.equal(recovery.stateOf(), "idle");
});

// === 2026-08-10 GAP 1.1 测试：per-kind 定向恢复策略 + 副作用 ===

test("StallRecovery GAP 1.1: military_interlock → aggressive posture + focusRegion=null", () => {
  const recovery = new StallRecovery();
  recovery.observe([event("military_interlock", 100)], { tick: 100, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(recovery.stateOf(), "recovering");
  const policy = recovery.policyFor(BASE);
  assert.equal(policy.posture, "aggressive", "军事互堵 → aggressive 鼓励接战");
  assert.equal(policy.focusRegion, null, "focusRegion=null 让单位散开");
  assert.equal(policy.workerTarget, BASE.workerTarget, "workerTarget 不变");
});

test("StallRecovery GAP 1.1: shot_missed_spiral → balanced posture（不硬射）", () => {
  const recovery = new StallRecovery();
  recovery.observe([event("shot_missed_spiral", 200)], { tick: 200, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(recovery.stateOf(), "recovering");
  const policy = recovery.policyFor(BASE);
  assert.equal(policy.posture, "balanced", "空枪螺旋 → balanced 降低接战冲动");
  assert.equal(policy.focusRegion, null);
});

test("StallRecovery GAP 1.1: spawn_stall → workerTarget 减 2（减轻产兵压力）", () => {
  const recovery = new StallRecovery();
  recovery.observe([event("spawn_stall", 300)], { tick: 300, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(recovery.stateOf(), "recovering");
  const policy = recovery.policyFor(BASE);
  assert.equal(policy.posture, "balanced");
  assert.equal(policy.workerTarget, BASE.workerTarget - 2, "降 workerTarget 减轻产兵压力");
  assert.equal(policy.focusRegion, null);
});

test("StallRecovery GAP 1.1: economy kind → focusRegion=null（原行为不变）", () => {
  const recovery = new StallRecovery();
  recovery.observe([event("cargo_blocked", 400)], { tick: 400, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(recovery.stateOf(), "recovering");
  const policy = recovery.policyFor(BASE);
  assert.equal(policy.posture, BASE.posture, "经济类不改 posture");
  assert.equal(policy.focusRegion, null);
  assert.equal(policy.workerTarget, BASE.workerTarget);
});

test("StallRecovery GAP 1.1: recoverySideEffect 对 shot_missed_spiral 返回 clear_enemy_core_memory", () => {
  const recovery = new StallRecovery();
  // idle 状态 → null
  assert.equal(recovery.recoverySideEffect(), null);
  recovery.observe([event("shot_missed_spiral", 500)], { tick: 500, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  // recovering 首次 → clear_enemy_core_memory
  assert.equal(recovery.recoverySideEffect(), "clear_enemy_core_memory");
  // 再次调用 → null（一次性触发）
  assert.equal(recovery.recoverySideEffect(), null);
});

test("StallRecovery GAP 1.1: recoverySideEffect 对 migration_stall 返回 trigger_migration_replan", () => {
  const recovery = new StallRecovery();
  recovery.observe([event("migration_stall", 600)], { tick: 600, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(recovery.recoverySideEffect(), "trigger_migration_replan");
  assert.equal(recovery.recoverySideEffect(), null, "一次性触发");
});

test("StallRecovery GAP 1.1: recoverySideEffect 对 spawn_stall 返回 trigger_worker_yield", () => {
  const recovery = new StallRecovery();
  recovery.observe([event("spawn_stall", 700)], { tick: 700, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(recovery.recoverySideEffect(), "trigger_worker_yield");
  assert.equal(recovery.recoverySideEffect(), null, "一次性触发");
});

test("StallRecovery GAP 1.1: economy kind → recoverySideEffect 返回 null", () => {
  const recovery = new StallRecovery();
  recovery.observe([event("no_production", 800)], { tick: 800, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(recovery.recoverySideEffect(), null, "经济类无副作用");
});

test("StallRecovery GAP 1.1: 副作用在恢复后重置（可再次触发）", () => {
  const recovery = new StallRecovery({ recoveryTicks: 128, cooldownTicks: 0 });
  // 第一次 shot_missed_spiral
  recovery.observe([event("shot_missed_spiral", 1000)], { tick: 1000, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(recovery.recoverySideEffect(), "clear_enemy_core_memory");
  assert.equal(recovery.recoverySideEffect(), null, "一次性");
  // 恢复
  recovery.observe(noEvents(), { tick: 1001, coreResourceDelta: 0, harvestCount: 0, depositCount: 0, failedEventCounts: {}, shotHitCount: 1 });
  assert.equal(recovery.stateOf(), "idle");
  assert.equal(recovery.recoverySideEffect(), null, "idle 时返回 null");
  // 第二次触发 → 副作用可再次触发
  recovery.observe([event("shot_missed_spiral", 1002)], { tick: 1002, coreResourceDelta: 0, harvestCount: 0, depositCount: 0 });
  assert.equal(recovery.recoverySideEffect(), "clear_enemy_core_memory", "新 recovering 周期可再次触发");
});
