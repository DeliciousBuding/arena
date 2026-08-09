/** P0 采矿止血（2026-08-09）：collectionValueFloor 不得再当"当前可见矿"的隐式距离门。
 *
 * 生产实证（t1）：mission.collectionValueFloor=-20（t1.json 覆盖，注册表默认 -30）
 * 把可见矿可采半径压到 ~10 格——netValue = 1.0 + visibleBonus(0.3) − travel − return，
 * dist 11 即 −20.7 < −20 → isCollectable 判 forbidden → GO_RESOURCE 变 EXPLORE
 * （worker_survey），"Web 可见近矿也不采"。
 *
 * 修复语义（写此文件时未实现，先红后绿）：
 * - 当前可见格（cell.visible === true，快照来自 state.resourceCells）只受
 *   maxCollectionDistance / 敌占 / 路径等硬约束，不受历史/价值 floor 限制；
 * - 不可见 memory/seed 格（visible=false）仍必须过 floor/置信/陈旧惩罚；
 * - 一矿一 worker Hungarian 唯一分配、sticky/hysteresis、强制任务语义保持。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import { extractPlanningSnapshot, type PlanningSnapshot } from "../src/planning/planning-snapshot.ts";
import { DEFAULT_MISSION_CONFIG, isCollectable, type MissionConfig } from "../src/planning/mission-planner.ts";
import { WorkerTaskPlanner, type WorkerTaskPlan } from "../src/planning/worker-task-planner.ts";

const CORE = { id: "core-1", position: [0, 0] as const, hp: 5, shield: 4, ownerUsername: "buding" };

function worker(id: string, x: number, y: number, hp = 5, cargo = 0) {
  return { id, position: [x, y] as const, hp, unitType: "WORKER" as const, cargo };
}

function makeTurn(units: readonly ReturnType<typeof worker>[] = [], extra: Partial<TurnLike> = {}): TurnLike {
  return {
    tick: 1000,
    resources: 3,
    resourceCapacity: 10,
    resourceSpace: 7,
    units,
    workers: units.filter((u) => u.unitType === "WORKER"),
    vanguards: [],
    rangers: [],
    core: CORE,
    visibleEnemies: [],
    obstacleCells: new Set(),
    resourceCells: new Set(),
    beacon: { position: [8, 8] as const, status: "GROUND" as const, carrier_id: null },
    events: [],
    state: { status: "ACTIVE" as const, population: units.length, objects: [] },
    ...extra,
  };
}

function snapshotOf(turn: TurnLike): PlanningSnapshot {
  return extractPlanningSnapshot(reduceTurn(turn));
}

/** 注入不可见 memory/seed 格（等价 deterministic-planner harvest-memory-mine 合并
 *  路径：visible=false + lastSeenTick + seeded）。 */
function withInvisibleCells(
  snapshot: PlanningSnapshot,
  cells: ReadonlyArray<{ key: string; lastSeenTick: number; seeded?: boolean }>,
): PlanningSnapshot {
  const resourceCells = new Map(snapshot.resourceCells);
  for (const cell of cells) {
    const [x, y] = cell.key.split(",").map(Number) as [number, number];
    resourceCells.set(cell.key, {
      position: [x, y],
      visible: false,
      lastSeenTick: cell.lastSeenTick,
      seeded: cell.seeded ?? false,
    });
  }
  return { ...snapshot, resourceCells };
}

/** t1 等效使命配置（t1.json 只覆盖 collectionValueFloor=-20，其余吃注册表
 *  worker-mission-v1 默认：maxCollectionDistance=24 / visibleBonus=0.3 /
 *  seedAgeDecay=0.02 / alwaysSurvey=true / surveyOnSupplyGap=true / switchThreshold=1.5）。 */
function t1Mission(overrides: Partial<MissionConfig> = {}): MissionConfig {
  return {
    ...DEFAULT_MISSION_CONFIG,
    collectionValueFloor: -20,
    maxCollectionDistance: 24,
    surveyWorkerCap: 3,
    surveyBurstTicks: 100,
    surveyWorkerFloor: 3,
    visibleBonus: 0.3,
    seedAgeDecay: 0.02,
    refillLookahead: 0,
    refillBonus: 0,
    deadMineOverdueTicks: Number.POSITIVE_INFINITY,
    migrationScout: true,
    alwaysSurvey: true,
    switchThreshold: 1.5,
    surveyOnSupplyGap: true,
    ...overrides,
  };
}

function tasksOf(plan: WorkerTaskPlan) {
  return plan.assignments.map((a) => a.task);
}

test("isCollectable: 当前可见格不受 floor 限制（只受距离硬约束）", () => {
  const w = worker("w1", 0, 0);
  const m = t1Mission();
  // visible=true：floor 放行——dist 11/24（maxCollectionDistance 边界）均可采
  assert.equal(isCollectable(-20.7, w, [11, 0], m, undefined, true), true);
  assert.equal(isCollectable(-46.7, w, [24, 0], m, undefined, true), true);
  // visible=true 仍受 maxCollectionDistance 硬约束
  assert.equal(isCollectable(-48.7, w, [25, 0], m, undefined, true), false);
  // 不可见（visible=false）与未标注（缺省）：floor 照常生效（旧行为零回归）
  assert.equal(isCollectable(-20.7, w, [11, 0], m, undefined, false), false);
  assert.equal(isCollectable(-20.7, w, [11, 0], m, undefined), false);
});

test("plan: t1 配置下可见矿 dist 10（floor 边界内）照采（基线）", () => {
  const snap = snapshotOf(makeTurn([worker("w1", 0, 0)], { resourceCells: new Set(["10,0"]) }));
  const plan = new WorkerTaskPlanner({ mission: t1Mission() }).plan(snap);
  const task = plan.assignments.find((a) => a.unitId === "w1")?.task;
  assert.equal(task?.type, "GO_RESOURCE", "dist 10 可见矿应采");
  assert.equal(task?.targetCellKey, "10,0");
});

test("plan: t1 配置下可见矿 dist 11-24 全部 GO_RESOURCE（floor 不再当距离门）", () => {
  for (const d of [11, 15, 24]) {
    const snap = snapshotOf(makeTurn([worker("w1", 0, 0)], { resourceCells: new Set([`${d},0`]) }));
    const plan = new WorkerTaskPlanner({ mission: t1Mission() }).plan(snap);
    const task = plan.assignments.find((a) => a.unitId === "w1")?.task;
    assert.equal(task?.type, "GO_RESOURCE", `dist ${d} 可见矿应 GO_RESOURCE`);
    assert.equal(task?.targetCellKey, `${d},0`);
  }
});

test("plan: 可见矿 dist 25 > maxCollectionDistance=24 → 不采（硬距离门保留）", () => {
  const snap = snapshotOf(makeTurn([worker("w1", 0, 0)], { resourceCells: new Set(["25,0"]) }));
  const plan = new WorkerTaskPlanner({ mission: t1Mission() }).plan(snap);
  const task = plan.assignments.find((a) => a.unitId === "w1")?.task;
  assert.equal(task?.type, "EXPLORE", "超距可见矿不采，转勘探（alwaysSurvey）");
});

test("plan: 同距离 seeded/invisible 仍被 floor 拒绝（floor 只对不可见生效）", () => {
  const snap = withInvisibleCells(snapshotOf(makeTurn([worker("w1", 0, 0)], { tick: 1000 })), [
    { key: "11,0", seeded: true, lastSeenTick: 700 }, // age 300：陈旧 seed，dist 11
  ]);
  const plan = new WorkerTaskPlanner({ mission: t1Mission() }).plan(snap);
  const task = plan.assignments.find((a) => a.unitId === "w1")?.task;
  assert.equal(task?.type, "EXPLORE", "陈旧 seed（age 300 / dist 11）应被 floor 拒绝转勘探");
});

test("plan: 一名重生/起步 worker + 单个可见矿（dist 11）必须采", () => {
  const snap = snapshotOf(makeTurn([worker("w1", 0, 0)], { tick: 77000, resourceCells: new Set(["11,0"]) }));
  const plan = new WorkerTaskPlanner({ mission: t1Mission() }).plan(snap);
  const task = plan.assignments.find((a) => a.unitId === "w1")?.task;
  assert.equal(task?.type, "GO_RESOURCE", "重生/起步 worker 面对单个可见矿必须采");
  assert.equal(task?.targetCellKey, "11,0");
});

test("plan: 多 worker 单矿唯一分配（只有一人领取）", () => {
  const snap = snapshotOf(makeTurn(
    [worker("w1", 0, 0), worker("w2", 0, 1), worker("w3", 0, 2)],
    { resourceCells: new Set(["11,0"]) },
  ));
  const plan = new WorkerTaskPlanner({ mission: t1Mission() }).plan(snap);
  const go = plan.assignments.filter((a) => a.task.type === "GO_RESOURCE");
  assert.equal(go.length, 1, "一矿一 worker 唯一分配（Hungarian）");
  assert.equal(go[0]?.task.targetCellKey, "11,0");
  const rest = plan.assignments.filter((a) => a.task.type !== "GO_RESOURCE");
  assert.equal(rest.length, 2, "其余 worker 不得抢同一矿");
  assert.ok(rest.every((a) => a.task.type === "EXPLORE"), "其余 worker 转勘探（alwaysSurvey）");
});

export {};
