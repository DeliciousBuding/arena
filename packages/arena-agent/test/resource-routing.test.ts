import test from "node:test";
import assert from "node:assert/strict";
import type { PlanningSnapshot, ResourceCellInfo } from "../src/planning/planning-snapshot.ts";
import {
  PRODUCTION_MEMORY_VERIFICATION_RATIO,
  WorkerTaskPlanner,
} from "../src/planning/worker-task-planner.ts";
import { shortestPathDistances } from "../src/domain/nav.ts";
import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DeterministicPlanner } from "../src/planning/deterministic-planner.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

function snapshot(
  resources: readonly [string, ResourceCellInfo][],
  obstacles: readonly string[] = [],
): PlanningSnapshot {
  return {
    tick: 100, resources: 10, resourceCapacity: 50, resourceSpace: 40, population: 1,
    units: [{ id: "w1", unitType: "WORKER", position: [0, 0], hp: 2, cargo: 0 }],
    resourceCells: new Map(resources), obstacleCells: new Set(obstacles), enemyCells: new Set(), enemyUnits: [],
    corePosition: null, coreHp: null, coreState: null,
    beacon: { position: [100, 100], status: "GROUND", carrierId: null }, threatMap: new Map(),
  };
}

test("multi-target BFS: known wall detour returns true shortest path distances", () => {
  const distances = shortestPathDistances([0, 0], [[2, 0], [0, 3]], new Set(["1,0"]));
  assert.equal(distances.get("2,0"), 4);
  assert.equal(distances.get("0,3"), 3);
});

test("WorkerTaskPlanner: obstacle-aware cost can reverse Manhattan-nearest choice", () => {
  const plan = new WorkerTaskPlanner().plan(snapshot([
    ["2,0", { position: [2, 0], visible: true, lastSeenTick: 100 }],
    ["0,3", { position: [0, 3], visible: true, lastSeenTick: 100 }],
  ], ["1,0"]));
  assert.equal(plan.assignments[0]!.task.targetCellKey, "0,3", "2,0 Manhattan 更近，但绕墙实际 4 步 > 0,3 的 3 步");
});

test("WorkerTaskPlanner: equally distant stale/seeded memory loses to fresh visible resource", () => {
  const plan = new WorkerTaskPlanner().plan(snapshot([
    ["0,2", { position: [0, 2], visible: false, lastSeenTick: 80, seeded: true }],
    ["2,0", { position: [2, 0], visible: true, lastSeenTick: 100, seeded: false }],
  ]));
  assert.equal(plan.assignments[0]!.task.targetCellKey, "2,0");
});

test("WorkerTaskPlanner: memory target beyond historical 40-cell active-mining bound becomes WAIT", () => {
  const plan = new WorkerTaskPlanner().plan(snapshot([
    ["50,0", { position: [50, 0], visible: false, lastSeenTick: 100, seeded: true }],
  ]));
  assert.equal(plan.assignments[0]!.task.type, "WAIT");
});

test("WorkerTaskPlanner: production memory budget 只让 25% Worker 验证历史矿，其余留给巡逻", () => {
  const resources = Array.from({ length: 12 }, (_, i) => [
    `10,${i}`,
    { position: [10, i] as Position, visible: false, lastSeenTick: 80, seeded: true },
  ] as [string, ResourceCellInfo]);
  const base = snapshot(resources);
  const many: PlanningSnapshot = {
    ...base,
    population: 12,
    units: Array.from({ length: 12 }, (_, i) => ({
      id: `w${String(i).padStart(2, "0")}`,
      unitType: "WORKER" as const,
      position: [0, i] as Position,
      hp: 2,
      cargo: 0,
    })),
  };
  const plan = new WorkerTaskPlanner({
    memoryVerificationRatio: PRODUCTION_MEMORY_VERIFICATION_RATIO,
  }).plan(many);
  assert.equal(plan.assignments.filter((a) => a.task.type === "GO_RESOURCE").length, 3);
  assert.equal(plan.assignments.filter((a) => a.task.type === "WAIT").length, 9);
});

test("WorkerTaskPlanner: production memory budget 不限流当前可见矿", () => {
  const resources = Array.from({ length: 4 }, (_, i) => [
    `5,${i}`,
    { position: [5, i] as Position, visible: true, lastSeenTick: 100, seeded: false },
  ] as [string, ResourceCellInfo]);
  const base = snapshot(resources);
  const many: PlanningSnapshot = {
    ...base,
    population: 4,
    units: Array.from({ length: 4 }, (_, i) => ({
      id: `w${i}`,
      unitType: "WORKER" as const,
      position: [0, i] as Position,
      hp: 2,
      cargo: 0,
    })),
  };
  const plan = new WorkerTaskPlanner({
    memoryVerificationRatio: PRODUCTION_MEMORY_VERIFICATION_RATIO,
  }).plan(many);
  assert.equal(plan.assignments.filter((a) => a.task.type === "GO_RESOURCE").length, 4);
});

function worker(id: string, position: Position) {
  return { id, position, hp: 2, unitType: "WORKER" as const, cargo: 0 };
}
function state(tick: number, workers: readonly ReturnType<typeof worker>[], enemies: readonly VisibleEntity[] = []): TickState {
  return {
    tick, status: "ACTIVE", resources: 10, resourceCapacity: 50, resourceSpace: 40, population: workers.length,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "me" },
    units: [...workers], workers: [...workers], vanguards: [], rangers: [], visibleEnemies: [...enemies],
    resourceCells: new Set(), obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null }, events: [],
  };
}

test("DeterministicPlanner: Worker 到达 seeded 历史矿但当前确认无矿 → 不再 GO_RESOURCE 假活（t4 live 回归）", () => {
  const config = { ...DEFAULT_SAFETY_CONFIG, harvestMemoryMine: true };
  const fallback = new SafetyPlanner(config);
  const patrol = new SafetyPlanner(config);
  fallback.world.seedResourceMemory([[2, 0]], 0);
  patrol.world.seedResourceMemory([[2, 0]], 0);
  const planner = new DeterministicPlanner(new WorkerTaskPlanner(), fallback, patrol);

  // Core 与 Worker 都能看清 [2,0]，raw state 无 RESOURCE。旧实现会永久输出
  // intent=GO_RESOURCE + action=WAIT；修复后该 seed 先被 World 强反证失效。
  const plan = planner.decide({ state: state(68000, [worker("w1", [2, 0])]) });
  assert.notEqual(plan.intents.w1, "GO_RESOURCE");
  assert.equal(fallback.world.resourceCandidates().length, 0);
});

test("DeterministicPlanner: visible+memory resources use one global assignment authority", () => {
  const config = { ...DEFAULT_SAFETY_CONFIG, harvestMemoryMine: true };
  const fallback = new SafetyPlanner(config);
  const patrol = new SafetyPlanner(config);
  fallback.world.seedResourceMemory([[8, 0], [0, 8]], 100);
  patrol.world.seedResourceMemory([[8, 0], [0, 8]], 100);
  const planner = new DeterministicPlanner(new WorkerTaskPlanner(), fallback, patrol);
  const plan = planner.decide({ state: state(100, [worker("w1", [1, 0]), worker("w2", [0, 1])]) });
  assert.equal(plan.intents.w1, "GO_RESOURCE");
  assert.equal(plan.intents.w2, "GO_RESOURCE");
  const targets = [fallback.world.unitMemory("w1").harvestTarget, fallback.world.unitMemory("w2").harvestTarget]
    .map((target) => target === null ? "null" : `${target[0]},${target[1]}`)
    .sort();
  assert.deepEqual(targets, ["0,8", "8,0"]);
  assert.equal(patrol.config.harvestMemoryMine, false, "patrol fallback 不得拥有第二套 memory-mine 分配权");
});

test("DeterministicPlanner: unassigned workers patrol instead of bypassing Hungarian through patrol memory", () => {
  const config = { ...DEFAULT_SAFETY_CONFIG, harvestMemoryMine: true };
  const fallback = new SafetyPlanner(config);
  const patrol = new SafetyPlanner(config);
  fallback.world.seedResourceMemory([[8, 0]], 100);
  patrol.world.seedResourceMemory([[8, 0]], 100);
  const planner = new DeterministicPlanner(new WorkerTaskPlanner(), fallback, patrol);
  const plan = planner.decide({ state: state(100, [worker("w1", [1, 0]), worker("w2", [0, 1]), worker("w3", [-1, 0])]) });
  const resourceOwners = Object.values(plan.intents ?? {}).filter((intent) => intent === "GO_RESOURCE").length;
  assert.equal(resourceOwners, 1);
  assert.equal(Object.values(plan.intents ?? {}).some((intent) => intent === "go_harvest_mem"), false);
});

test("DeterministicPlanner: Safety evacuation veto cannot be overwritten by resource assignment", () => {
  const config = { ...DEFAULT_SAFETY_CONFIG, harvestMemoryMine: true, scoutEvade: true };
  const fallback = new SafetyPlanner(config);
  const patrol = new SafetyPlanner(config);
  fallback.world.seedResourceMemory([[8, 0]], 100);
  patrol.world.seedResourceMemory([[8, 0]], 100);
  const planner = new DeterministicPlanner(new WorkerTaskPlanner(), fallback, patrol);
  const enemy: VisibleEntity = { id: "e1", kind: "UNIT", position: [6, 1], hp: 4, unitType: "VANGUARD" };
  const plan = planner.decide({ state: state(100, [worker("w1", [6, 0])], [enemy]) });
  assert.equal(plan.intents.w1, "worker_evade_return");
  assert.notEqual(plan.intents.w1, "GO_RESOURCE");
});

test("DeterministicPlanner: threat recall filters far resources before economic matching", () => {
  const config = { ...DEFAULT_SAFETY_CONFIG, harvestMemoryMine: true, threatRecall: true };
  const fallback = new SafetyPlanner(config);
  const patrol = new SafetyPlanner(config);
  fallback.world.seedResourceMemory([[10, 0]], 100);
  const planner = new DeterministicPlanner(new WorkerTaskPlanner(), fallback, patrol);
  const enemy: VisibleEntity = { id: "e1", kind: "UNIT", position: [1, 0], hp: 4, unitType: "VANGUARD" };
  const plan = planner.decide({ state: state(100, [worker("w1", [0, 3])], [enemy]) });
  assert.notEqual(plan.intents.w1, "GO_RESOURCE");
  assert.notEqual(plan.intents.w1, "go_harvest_mem");
});
