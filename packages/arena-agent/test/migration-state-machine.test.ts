/**
 * 迁移状态机测试（migration-system-v1 §2，评审 P0-4 纳入）：
 * 全转移表 + 非法转移 no-op（fail-closed）+ 恢复中止优先。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { transition, type MigrationEvent, type MigrationPhase } from "../src/migration/state-machine.ts";

const ev = <T extends MigrationEvent["type"]>(type: T): MigrationEvent => ({ type } as MigrationEvent);

test("状态机：IDLE → PLAN → LEG_MOVE ⇄ LEG_SETTLE → ARRIVED → IDLE 主链", () => {
  let s: MigrationPhase = "IDLE";
  s = transition(s, ev("INTENT_ACCEPTED")).phase;
  assert.equal(s, "PLAN");
  s = transition(s, ev("PLAN_AUDITED")).phase;
  assert.equal(s, "LEG_MOVE");
  s = transition(s, ev("LEG_BURST_DONE")).phase;
  assert.equal(s, "LEG_SETTLE");
  s = transition(s, { type: "LEG_SETTLE_DONE", lastLeg: false }).phase;
  assert.equal(s, "LEG_MOVE");
  s = transition(s, ev("LEG_BURST_DONE")).phase;
  assert.equal(s, "LEG_SETTLE");
  s = transition(s, { type: "LEG_SETTLE_DONE", lastLeg: true }).phase;
  assert.equal(s, "ARRIVED");
  s = transition(s, ev("ARRIVED_SETTLE_DONE")).phase;
  assert.equal(s, "IDLE");
});

test("状态机：审计拒绝 → ABORT → CLEANED → IDLE", () => {
  let s: MigrationPhase = "PLAN";
  s = transition(s, ev("PLAN_REJECTED")).phase;
  assert.equal(s, "ABORT");
  s = transition(s, ev("CLEANED")).phase;
  assert.equal(s, "IDLE");
});

test("状态机：受击 → DEFENSIVE_HOLD（滞回清除回 SETTLE；升级/重审分流）", () => {
  for (const from of ["LEG_MOVE", "LEG_SETTLE"] as const) {
    let s: MigrationPhase = from;
    s = transition(s, ev("CORE_DAMAGED")).phase;
    assert.equal(s, "DEFENSIVE_HOLD", `from ${from}`);
  }
  // 滞回清除 → 回 SETTLE
  assert.equal(transition("DEFENSIVE_HOLD", ev("THREAT_CLEARED")).phase, "LEG_SETTLE");
  // 活跃敌核贴脸持续 → ABORT
  assert.equal(transition("DEFENSIVE_HOLD", ev("THREAT_ESCALATED")).phase, "ABORT");
  // 重复进入/走廊偏离 → REPLAN（回 PLAN 重审）
  assert.equal(transition("DEFENSIVE_HOLD", ev("REPLAN_REQUESTED")).phase, "PLAN");
});

test("状态机：CORE_DESTROYED / 代际变化 → RECOVERY_ABORT（任何进行中状态）", () => {
  for (const from of ["PLAN", "LEG_MOVE", "LEG_SETTLE", "DEFENSIVE_HOLD"] as const) {
    assert.equal(transition(from, ev("CORE_DESTROYED")).phase, "RECOVERY_ABORT", `destroy from ${from}`);
    assert.equal(
      transition(from, ev("CORE_GENERATION_CHANGED")).phase,
      "RECOVERY_ABORT",
      `generation from ${from}`,
    );
  }
  // 恢复完成 → IDLE（重新 PLAN 新 operation，不续旧路线）
  assert.equal(transition("RECOVERY_ABORT", ev("RECOVERY_DONE")).phase, "IDLE");
  // 终态下 CORE_DESTROYED 不生效（no-op）
  assert.equal(transition("IDLE", ev("CORE_DESTROYED")).applied, false);
});

test("状态机：CANCEL 在任何非终态生效 → ABORT", () => {
  for (const from of ["PLAN", "LEG_MOVE", "LEG_SETTLE", "DEFENSIVE_HOLD", "ARRIVED"] as const) {
    const result = transition(from, ev("CANCEL"));
    if (from === "ARRIVED") {
      assert.equal(result.applied, false, "ARRIVED 已是终态，取消 no-op");
    } else {
      assert.equal(result.phase, "ABORT", `cancel from ${from}`);
    }
  }
});

test("状态机：非法转移一律 no-op（applied=false，fail-closed）", () => {
  assert.equal(transition("IDLE", ev("PLAN_AUDITED")).applied, false);
  assert.equal(transition("LEG_MOVE", ev("INTENT_ACCEPTED")).applied, false);
  assert.equal(transition("LEG_SETTLE", ev("LEG_BURST_DONE")).applied, false);
  assert.equal(transition("DEFENSIVE_HOLD", ev("LEG_BURST_DONE")).applied, false);
  assert.equal(transition("ABORT", ev("THREAT_CLEARED")).applied, false);
  assert.equal(transition("RECOVERY_ABORT", ev("PLAN_AUDITED")).applied, false);
  // no-op 保持原状态
  assert.equal(transition("LEG_MOVE", ev("INTENT_ACCEPTED")).phase, "LEG_MOVE");
});
