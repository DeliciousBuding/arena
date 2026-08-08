import assert from "node:assert/strict";
import { test } from "node:test";

import { SafetyPlanner, DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";


test("SafetyPlanner.recoverWorker: 清经济目标/巡逻状态并旋转探索方向", () => {
  const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  const memory = planner.world.unitMemory("w1", 2);
  memory.workerMode = "go_harvest";
  memory.harvestTarget = [40, 40];
  memory.patrolRing = 3;
  memory.patrolStarted = true;
  memory.patrolReturning = true;

  const recovery = planner.recoverWorker("w1");
  assert.equal(recovery.previousDirection, 2);
  assert.equal(recovery.nextDirection, 5);
  assert.equal(memory.workerMode, "patrol");
  assert.equal(memory.harvestTarget, null);
  assert.equal(memory.patrolRing, 0);
  assert.equal(memory.patrolStarted, false);
  assert.equal(memory.patrolReturning, false);
});

test("SafetyPlanner.recoverWorker: dense 16 方位使用互质步长 5", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, workerDenseScan: true });
  const memory = planner.world.unitMemory("w1", 14);
  const recovery = planner.recoverWorker("w1");
  assert.equal(recovery.nextDirection, 3);
});
