/**
 * Core 迁移 approach 记忆持续测试（2026-08-07，B9 竞品 "approach memory
 * expires" / "Preserve migration through short visibility loss" 对照）：
 * coreEvadePersist——closing/TTR 触发迁移后敌人消失时，迁移意图从固定
 * 2 tick 扩展为"approach 记忆未过期"（enemyHints(6) 非空 = 6 tick 内
 * 曾见任何敌），防"敌人被击退出 12 格 → 2 tick 恢复 → 敌人折返 → 再
 * 触发"的迁移抖动。默认关闭 = 历史 2 tick 行为零回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

function makeState(tick: number, enemies: VisibleEntity[]): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [],
    workers: [],
    vanguards: [],
    rangers: [],
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

function enemy(id: string, position: readonly [number, number]): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 2, unitType: "VANGUARD" };
}

const EVADE_CONFIG = { ...DEFAULT_SAFETY_CONFIG, coreEvade: true };
const PERSIST_CONFIG = { ...DEFAULT_SAFETY_CONFIG, coreEvade: true, coreEvadePersist: true };

test("coreEvadePersist 默认关闭：敌人消失后 2 tick 即恢复（历史行为钉定）", () => {
  const planner = new SafetyPlanner(EVADE_CONFIG);
  // tick1：12 格内敌 [8,0] → closing 触发迁移（preemptiveEvadeUntilTick=3）
  assert.equal(planner.decide({ state: makeState(1, [enemy("e1", [8, 0])]) }).coreAction?.type, "START_MOVE");
  // tick2/3：敌人消失，2 tick persist 内仍迁移
  assert.equal(planner.decide({ state: makeState(2, []) }).coreAction?.type, "START_MOVE", "tick2 仍迁移");
  assert.equal(planner.decide({ state: makeState(3, []) }).coreAction?.type, "START_MOVE", "tick3 仍迁移");
  // tick4：persist 过期 → 恢复生产
  const plan = planner.decide({ state: makeState(4, []) });
  assert.notEqual(plan.coreAction?.type, "START_MOVE", "tick4 恢复（不再迁移）");
});

test("coreEvadePersist 开启：敌人消失后 approach 记忆（6 tick）内仍迁移", () => {
  const planner = new SafetyPlanner(PERSIST_CONFIG);
  planner.decide({ state: makeState(1, [enemy("e1", [8, 0])]) });
  // tick2-7：enemyHints(6) 记忆有效（lastSeenTick=1，1+6=7）→ 持续迁移
  for (let tick = 2; tick <= 7; tick += 1) {
    const plan = planner.decide({ state: makeState(tick, []) });
    assert.equal(plan.coreAction?.type, "START_MOVE", `tick${tick} 记忆未过期仍迁移`);
  }
  // tick8：记忆过期 → 恢复
  const plan = planner.decide({ state: makeState(8, []) });
  assert.notEqual(plan.coreAction?.type, "START_MOVE", "tick8 记忆过期恢复");
});

test("coreEvadePersist 开启：从未见敌 → 不迁移（零回归）", () => {
  const planner = new SafetyPlanner(PERSIST_CONFIG);
  const plan = planner.decide({ state: makeState(1, []) });
  assert.notEqual(plan.coreAction?.type, "START_MOVE", "无任何敌记忆不迁移");
});

test("coreEvadePersist 开启：12 格外敌（无 closing）→ 不迁移", () => {
  const planner = new SafetyPlanner(PERSIST_CONFIG);
  const plan = planner.decide({ state: makeState(1, [enemy("e1", [20, 0])]) });
  assert.notEqual(plan.coreAction?.type, "START_MOVE", "远敌不触发（无逼近积分）");
});

test("coreEvadePersist 开启：敌人重新出现（closing）→ 正常迁移（记忆窗口顺延）", () => {
  const planner = new SafetyPlanner(PERSIST_CONFIG);
  planner.decide({ state: makeState(1, [enemy("e1", [8, 0])]) });
  planner.decide({ state: makeState(2, []) });
  // tick3：敌人折返 12 格内 → closing 直接触发
  const plan = planner.decide({ state: makeState(3, [enemy("e1", [9, 0])]) });
  assert.equal(plan.coreAction?.type, "START_MOVE", "折返敌人触发迁移");
  assert.equal(plan.intents.core, "core_evade");
});
