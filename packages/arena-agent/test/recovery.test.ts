/**
 * C2 RECOVERY 测试（2026-08-07，竞品 lifecycle overlay 对照）：
 * Core 重生（全新 UUID 替换，引擎 P12 respawn）后清**相对 Core** 的战场
 * 记忆——敌追击积分/单位巡逻扇区基于旧 Core 坐标系，重生后失真；绝对
 * 坐标地图事实（障碍/资源/chunk）保留。正常对局 Core id 不变 → 零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

function enemy(id: string, position: Position): VisibleEntity {
  return { id, kind: "UNIT", position, hp: 2, unitType: "VANGUARD" };
}

function makeState(
  tick: number,
  coreId: string,
  corePosition: Position,
  enemies: VisibleEntity[] = [],
  obstacleCells: readonly string[] = [],
): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: coreId, position: corePosition, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [],
    workers: [],
    vanguards: [],
    rangers: [],
    visibleEnemies: enemies,
    resourceCells: new Set(["8,0"]),
    obstacleCells: new Set(obstacleCells),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

test("C2 RECOVERY：正常对局 Core id 不变 → 记忆保留、不触发清空（零回归）", () => {
  const planner = new SafetyPlanner();
  planner.decide({ state: makeState(1, "c1", [0, 0], [enemy("e1", [5, 0])]) });
  planner.decide({ state: makeState(2, "c1", [0, 0], [enemy("e1", [4, 0])]) });
  // 追击积分累积（两 tick 逼近）→ 记忆保留
  const hints = planner.world.enemyHints();
  assert.equal(hints.length, 1);
  assert.equal(hints[0]?.pursuitScore, 2, "逼近 +2 累积");
  assert.equal(planner.coreRecoveryCount, 0, "正常对局不触发 RECOVERY");
  assert.equal(planner.recoveryLog.length, 0);
});

test("C2 RECOVERY：Core 重生（id 变化）→ 清战场记忆 + 新坐标系重建", () => {
  const planner = new SafetyPlanner();
  // tick1：旧 Core [0,0]，敌 e1 [1,0]（coreDistance 1）
  planner.decide({ state: makeState(1, "c1", [0, 0], [enemy("e1", [1, 0])]) });
  assert.equal(planner.world.enemyHints().length, 1);
  // tick2：Core 重生（全新 UUID "c2"）到 [20,0]，敌 e1 [21,0]
  planner.decide({ state: makeState(2, "c2", [20, 0], [enemy("e1", [21, 0])]) });
  // 清空后 observe 用新 Core 坐标系重建记忆
  const hints = planner.world.enemyHints();
  assert.equal(hints.length, 1);
  assert.equal(hints[0]?.coreDistance, 1, "coreDistance 相对新 Core [20,0]");
  assert.equal(hints[0]?.prevPosition, undefined, "旧坐标系 prevPosition 已清（差分从零开始）");
  assert.equal(hints[0]?.pursuitScore, 0, "旧追击积分已清");
  assert.equal(planner.coreRecoveryCount, 1);
  assert.equal(planner.recoveryLog.length, 1);
  assert.match(planner.recoveryLog[0] ?? "", /c1.*c2/);
});

test("C2 RECOVERY：绝对坐标地图事实保留（障碍/资源不受重生影响）", () => {
  const planner = new SafetyPlanner();
  planner.decide({ state: makeState(1, "c1", [0, 0], [], ["5,0"]) });
  planner.decide({ state: makeState(2, "c2", [20, 0], [enemy("e1", [21, 0])], ["5,0"]) });
  // 障碍记忆保留（绝对坐标地图事实）
  assert.equal(planner.world.obstacles().has("5,0"), true, "障碍记忆不随 Core 重生清除");
  // 资源记忆保留
  assert.deepEqual(planner.world.resourceHints(), [[8, 0]]);
});

test("C2 RECOVERY：Core 消失（RESPAWNING 中）不误触发；恢复后新 id 才触发", () => {
  const planner = new SafetyPlanner();
  planner.decide({ state: makeState(1, "c1", [0, 0], [enemy("e1", [1, 0])]) });
  // Core 消失（重生延迟重试中）
  const noCore = makeState(2, "c1", [0, 0]);
  planner.decide({ state: { ...noCore, core: null } });
  assert.equal(planner.coreRecoveryCount, 0, "Core 消失不触发（lastCoreId 保持）");
  // 重生完成（新 id）
  planner.decide({ state: makeState(3, "c3", [25, 0], [enemy("e1", [26, 0])]) });
  assert.equal(planner.coreRecoveryCount, 1, "新 id 出现才触发 RECOVERY");
  const hints = planner.world.enemyHints();
  assert.equal(hints[0]?.coreDistance, 1, "新坐标系记忆");
});

test("C2 RECOVERY：重生后单位巡逻扇区重置（unitMemories 清空）", () => {
  const planner = new SafetyPlanner();
  // 先建立 worker 巡逻记忆
  const workerState = makeState(1, "c1", [0, 0]);
  const withWorker = {
    ...workerState,
    population: 2,
    units: [{ id: "w1", position: [3, 0] as Position, hp: 2, unitType: "WORKER" as const, cargo: 0 }],
    workers: [{ id: "w1", position: [3, 0] as Position, hp: 2, unitType: "WORKER" as const, cargo: 0 }],
  };
  planner.decide({ state: withWorker });
  const memoryBefore = planner.world.unitMemory("w1");
  memoryBefore.patrolRing = 3; // 推进巡逻环
  assert.equal(planner.world.unitMemory("w1").patrolRing, 3, "巡逻记忆建立");
  // 重生
  planner.decide({ state: makeState(2, "c2", [20, 0]) });
  assert.equal(planner.world.unitMemory("w1").patrolRing, 0, "重生后巡逻扇区重置（从 0 重新探索）");
});
