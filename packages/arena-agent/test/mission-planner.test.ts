/** worker-mission-v1 使命层测试（值层置信 / 门槛距离过滤 / SURVEYOR 角色 / 测绘期）。 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import type { PlanningSnapshot } from "../src/planning/planning-snapshot.ts";
import { extractPlanningSnapshot } from "../src/planning/planning-snapshot.ts";
import {
  DEFAULT_MISSION_CONFIG,
  isCollectable,
  surveyorIds,
  targetConfidence,
  type MissionConfig,
} from "../src/planning/mission-planner.ts";
import { WorkerTaskPlanner, type WorkerTaskPlan } from "../src/planning/worker-task-planner.ts";

const CORE = { id: "core-1", position: [0, 0] as const, hp: 5, shield: 4, ownerUsername: "buding" };

function worker(id: string, x: number, y: number, hp = 5, cargo = 0) {
  return { id, position: [x, y] as const, hp, unitType: "WORKER" as const, cargo };
}

const MISSION: MissionConfig = {
  collectionValueFloor: -30,
  maxCollectionDistance: 24,
  surveyWorkerCap: 3,
  surveyBurstTicks: 100,
  surveyWorkerFloor: 3,
  visibleBonus: 0.3,
  seedAgeDecay: 0.02,
  refillLookahead: 0,
  refillBonus: 0,
  deadMineOverdueTicks: 0,
  migrationScout: false,
};

/** 造快照：资源格可带置信元数据（visible/lastSeenTick/seeded）。 */
function makeSnapshot(
  units: ReturnType<typeof worker>[],
  cells: ReadonlyArray<{ key: string; visible?: boolean; lastSeenTick?: number; seeded?: boolean }>,
  tick = 1000,
): PlanningSnapshot {
  const turn: TurnLike = {
    tick,
    resources: 3,
    resourceCapacity: 10,
    resourceSpace: 7,
    units,
    workers: units,
    vanguards: [],
    rangers: [],
    core: CORE,
    visibleEnemies: [],
    obstacleCells: new Set(),
    resourceCells: new Set(cells.filter((c) => c.visible === true).map((c) => c.key)),
    beacon: { position: [8, 8] as const, status: "GROUND", carrier_id: null },
    events: [],
    state: { status: "ACTIVE", population: units.length, objects: [] },
  };
  const snapshot = extractPlanningSnapshot(reduceTurn(turn));
  const resourceCells = new Map(snapshot.resourceCells);
  for (const cell of cells) {
    if (cell.visible === true) continue; // 快照已标注
    resourceCells.set(cell.key, {
      position: cell.key.split(",").map(Number) as [number, number],
      visible: false,
      lastSeenTick: cell.lastSeenTick,
      seeded: cell.seeded,
    });
  }
  return { ...snapshot, resourceCells };
}

test("mission: targetConfidence 可见新鲜 > 陈旧种子，且随龄单调衰减", () => {
  const visible = targetConfidence({ visible: true, lastSeenTick: 1000 }, 1000, MISSION);
  const freshSeed = targetConfidence({ visible: false, seeded: true, lastSeenTick: 995 }, 1000, MISSION);
  const oldSeed = targetConfidence({ visible: false, seeded: true, lastSeenTick: 900 }, 1000, MISSION);
  assert.ok(visible > freshSeed, "可见格加成应高于新鲜种子");
  assert.ok(freshSeed > oldSeed, "种子应随龄衰减");
  assert.equal(targetConfidence({ visible: false, seeded: true, lastSeenTick: 995 }, 1000, MISSION), -0.1);
  // 缺省配置 = 零贡献（零回归）
  assert.equal(targetConfidence({ visible: true }, 1000, DEFAULT_MISSION_CONFIG), 0);
});

test("mission: isCollectable 门槛 + 距离过滤", () => {
  const w = worker("w1", 0, 0);
  assert.equal(isCollectable(0.5, w, [3, 3], MISSION), true); // score 达标且距离内
  assert.equal(isCollectable(-35, w, [3, 3], MISSION), false); // 低于门槛
  assert.equal(isCollectable(0.5, w, [30, 0], MISSION), false); // 超距
  // 缺省配置 = 全放行（零回归）
  assert.equal(isCollectable(-100, w, [30, 0], DEFAULT_MISSION_CONFIG), true);
});

test("mission: surveyorIds 上限 + 测绘期地板 + 确定性", () => {
  const workers = [worker("w1", 0, 0), worker("w2", 0, 1), worker("w3", 0, 2), worker("w4", 0, 3), worker("w5", 0, 4)];
  const cap = surveyorIds(workers, MISSION, false);
  assert.equal(cap.size, 3); // cap=3
  assert.deepEqual([...cap].sort(), ["w1", "w2", "w3"]); // id 升序前 3（确定性）
  const burst = surveyorIds(workers, MISSION, true);
  assert.equal(burst.size, 3); // floor=3 ≤ cap=3 → max = 3
  const burstConfig = { ...MISSION, surveyWorkerFloor: 5 };
  assert.equal(surveyorIds(workers, burstConfig, true).size, 5); // floor 高于 cap → 取 floor
  assert.equal(surveyorIds(workers, DEFAULT_MISSION_CONFIG, true).size, 0); // 缺省关闭
});

test("mission: WorkerTaskPlanner 陈旧种子低于门槛 → 转 EXPLORE（SURVEYOR），不再空跑", () => {
  const workers = [worker("w1", 0, 0), worker("w2", 0, 1), worker("w3", 0, 2), worker("w4", 0, 3)];
  // 3 个陈旧种子（龄 300、远距 20+ 格）+ 1 个可见新鲜矿：可见矿必被采，
  // 陈旧种子 score（−45 以下）低于门槛 −30 → 不派，转勘探
  const snapshot = makeSnapshot(
    workers,
    [
      { key: "5,0", visible: true, lastSeenTick: 1000 },
      { key: "20,0", visible: false, seeded: true, lastSeenTick: 700 },
      { key: "20,20", visible: false, seeded: true, lastSeenTick: 700 },
      { key: "-20,0", visible: false, seeded: true, lastSeenTick: 700 },
    ],
    1000,
  );
  const planner = new WorkerTaskPlanner({ mission: MISSION });
  const plan = planner.plan(snapshot, []);
  const byType = (type: string) => plan.assignments.filter((a) => a.task.type === type);
  assert.equal(byType("GO_RESOURCE").length, 1, "只有可见新鲜矿可采");
  assert.equal(byType("GO_RESOURCE")[0]?.task.targetCellKey, "5,0");
  assert.equal(byType("EXPLORE").length, 3, "剩余 3 worker 转勘探（cap=3）");
});

test("mission: 默认配置（缺省）行为与现架构一致——剩余 worker 全部 WAIT", () => {
  const workers = [worker("w1", 0, 0), worker("w2", 0, 1)];
  const snapshot = makeSnapshot(
    workers,
    [
      { key: "5,0", visible: true, lastSeenTick: 10 },
      { key: "100,0", visible: false, seeded: true, lastSeenTick: 5 },
    ],
    10,
  );
  const planner = new WorkerTaskPlanner(); // 缺省 = 现行为
  const plan = planner.plan(snapshot, []);
  const byType = (type: string) => plan.assignments.filter((a) => a.task.type === type);
  assert.equal(byType("GO_RESOURCE").length, 2, "缺省：陈旧种子也照采（与现架构一致）");
  assert.equal(byType("EXPLORE").length, 0);
  assert.equal(byType("WAIT").length, 0);
});

test("mission: 测绘期（surveyBurstActive）保证 floor 个勘探者", () => {
  const workers = [worker("w1", 0, 0), worker("w2", 0, 1), worker("w3", 0, 2), worker("w4", 0, 3)];
  const snapshot = makeSnapshot(
    workers,
    [
      { key: "5,0", visible: true, lastSeenTick: 1000 },
      { key: "6,0", visible: true, lastSeenTick: 1000 },
      { key: "7,0", visible: true, lastSeenTick: 1000 },
    ],
    1000,
  );
  const planner = new WorkerTaskPlanner({ mission: MISSION });
  const plan = planner.plan(snapshot, [], { surveyBurstActive: true });
  const byType = (type: string) => plan.assignments.filter((a) => a.task.type === type);
  assert.equal(byType("EXPLORE").length, 3, "测绘期保证 3 个勘探者（floor）");
  assert.equal(byType("GO_RESOURCE").length, 1);
});

test("mission: 结果确定性——同快照两次 plan 输出一致", () => {
  const workers = [worker("w1", 0, 0), worker("w2", 0, 1), worker("w3", 0, 2)];
  const snapshot = makeSnapshot(
    workers,
    [
      { key: "5,0", visible: true, lastSeenTick: 1000 },
      { key: "10,0", visible: false, seeded: true, lastSeenTick: 700 },
    ],
    1000,
  );
  const planner = new WorkerTaskPlanner({ mission: MISSION });
  const serialize = (plan: WorkerTaskPlan) =>
    JSON.stringify(plan.assignments.map((a) => [a.unitId, a.task.type, a.task.targetCellKey]));
  assert.equal(serialize(planner.plan(snapshot, [])), serialize(planner.plan(snapshot, [])));
});

export {};
