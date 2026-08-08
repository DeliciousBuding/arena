/** Planning 骨架测试：PlanningSnapshot 提取 / 强制任务 / 全局分配（唯一性硬约束）。 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import {
  buildThreatMap,
  extractPlanningSnapshot,
  type PlanningSnapshot,
} from "../src/planning/planning-snapshot.ts";
import { canDeposit, forcedTaskFor, type Task } from "../src/planning/task.ts";
import {
  applyStickyBonus,
  cellKey,
  WorkerTaskPlanner,
  type Assignment,
  type WorkerTaskPlan,
} from "../src/planning/worker-task-planner.ts";

const CORE = { id: "core-1", position: [0, 0] as const, hp: 5, shield: 4, ownerUsername: "buding" };

function worker(id: string, x: number, y: number, hp = 5, cargo = 0) {
  return { id, position: [x, y] as const, hp, unitType: "WORKER" as const, cargo };
}

function vanguard(id: string, x: number, y: number) {
  return { id, position: [x, y] as const, hp: 3, unitType: "VANGUARD" as const, cargo: 0 };
}

type UnitFixture = ReturnType<typeof worker> | ReturnType<typeof vanguard>;

function makeTurn(units: readonly UnitFixture[] = [], extra: Partial<TurnLike> = {}): TurnLike {
  return {
    tick: 10,
    resources: 3,
    resourceCapacity: 10,
    resourceSpace: 7,
    units,
    workers: units.filter((u) => u.unitType === "WORKER"),
    vanguards: units.filter((u) => u.unitType === "VANGUARD"),
    rangers: [],
    core: CORE,
    visibleEnemies: [],
    obstacleCells: new Set(),
    resourceCells: new Set(),
    beacon: { position: [8, 8] as const, status: "GROUND", carrier_id: null },
    events: [],
    state: { status: "ACTIVE", population: units.length, objects: [] },
    ...extra,
  };
}

function snapshotOf(turn: TurnLike): PlanningSnapshot {
  return extractPlanningSnapshot(reduceTurn(turn));
}

/** 分配结果中所有带目标格的资源格键（用于唯一性校验）。 */
function resourceTargets(plan: WorkerTaskPlan): string[] {
  return plan.assignments
    .map((a) => a.task.targetCellKey)
    .filter((key): key is string => key !== undefined);
}

function assertUniqueCells(plan: WorkerTaskPlan): void {
  const targets = resourceTargets(plan);
  assert.equal(new Set(targets).size, targets.length, `资源格重复分配: ${targets.join(", ")}`);
}

test("extractPlanningSnapshot：字段齐全（含威胁图衰减）", () => {
  const turn = makeTurn(
    [worker("w1", 1, 0, 2, 1), vanguard("v1", 2, 2)],
    {
      resources: 7,
      resourceCapacity: 15,
      resourceCells: new Set(["1,0", "5,5"]),
      obstacleCells: new Set(["2,2"]),
      visibleEnemies: [
        { id: "e-unit", kind: "UNIT" as const, position: [3, 3] as const, hp: 2, unit_type: "RANGER" as const },
        { id: "e-core", kind: "CORE" as const, position: [9, 9] as const, hp: 5 },
      ],
      beacon: { position: [8, 8] as const, status: "GROUND" as const, carrier_id: null },
      state: { status: "ACTIVE" as const, population: 2, objects: [] },
    },
  );
  const snap = snapshotOf(turn);

  assert.equal(snap.tick, 10);
  assert.equal(snap.resources, 7);
  assert.equal(snap.resourceCapacity, 15);
  assert.equal(snap.population, 2);
  // 受控单位快照（worker + vanguard 全量）
  assert.equal(snap.units.length, 2);
  const w1 = snap.units.find((u) => u.id === "w1");
  assert.deepEqual(w1?.position, [1, 0]);
  assert.equal(w1?.hp, 2);
  assert.equal(w1?.cargo, 1);
  assert.equal(w1?.unitType, "WORKER");
  // 资源格/障碍格键转换（TickState 的 Set<string> → Map/Set，键格式不变）
  assert.equal(snap.resourceCells.size, 2);
  assert.deepEqual(snap.resourceCells.get("1,0")?.position, [1, 0]);
  assert.deepEqual(snap.resourceCells.get("5,5")?.position, [5, 5]);
  assert.equal(snap.obstacleCells.has("2,2"), true);
  // 敌方：只收 kind=UNIT，不收敌方 CORE
  assert.equal(snap.enemyUnits.length, 1);
  assert.deepEqual(snap.enemyUnits[0].position, [3, 3]);
  assert.equal(snap.enemyUnits[0].unitType, "RANGER");
  // Core 与信标
  assert.deepEqual(snap.corePosition, [0, 0]);
  assert.equal(snap.coreHp, 5);
  assert.deepEqual(snap.beacon.position, [8, 8]);
  assert.equal(snap.beacon.status, "GROUND");
  assert.equal(snap.beacon.carrierId, null);
  // 威胁图：距离倒数衰减（自身格 1，距离 1 → 0.5，距离 3 → 0.25，半径外查不到）
  assert.equal(snap.threatMap.get("3,3"), 1);
  assert.equal(snap.threatMap.get("4,3"), 0.5);
  assert.equal(snap.threatMap.get("3,6"), 0.25);
  assert.equal(snap.threatMap.get("0,0"), undefined);
});

test("buildThreatMap：多敌人同格累加", () => {
  const threat = buildThreatMap([
    { id: "e1", position: [0, 0] as const, unitType: "RANGER" },
    { id: "e2", position: [0, 0] as const },
  ]);
  assert.equal(threat.get("0,0"), 2); // 两个敌人在同一格
  assert.equal(threat.get("1,0"), 1); // 距离 1 → 0.5 × 2
});

test("forcedTask：cargo>0 且 Core 在位 → DEPOSIT（canDeposit 同步校验）", () => {
  const snap = snapshotOf(makeTurn([worker("w1", 3, 3, 2, 1)]));
  const unit = snap.units[0];
  assert.equal(canDeposit(unit, snap), true);
  const task = forcedTaskFor(unit, snap);
  assert.equal(task?.type, "DEPOSIT");
  assert.deepEqual(task?.target, [0, 0]);
  // Core 不在位：canDeposit false，强制任务退回 null（走代价矩阵）
  const noCore = snapshotOf(makeTurn([worker("w1", 3, 3, 2, 1)], { core: null }));
  assert.equal(canDeposit(noCore.units[0], noCore), false);
  assert.equal(forcedTaskFor(noCore.units[0], noCore), null);
  // planner 层面：直接指派 DEPOSIT
  const plan = new WorkerTaskPlanner().plan(snap);
  assert.equal(plan.assignments[0].task.type, "DEPOSIT");
});

test("forcedTask：已站资源格且 cargo=0 → HARVEST_CURRENT", () => {
  const snap = snapshotOf(
    makeTurn([worker("w1", 1, 0)], { resourceCells: new Set(["1,0"]) }),
  );
  const task = forcedTaskFor(snap.units[0], snap);
  assert.equal(task?.type, "HARVEST_CURRENT");
  assert.equal(task?.targetCellKey, "1,0");
  assert.deepEqual(task?.target, [1, 0]);
});

test("forcedTask：hp≤1 且可安全回家 → RETURN_FOR_HEAL", () => {
  const snap = snapshotOf(makeTurn([worker("w1", 4, 4, 1, 0)]));
  const task = forcedTaskFor(snap.units[0], snap);
  assert.equal(task?.type, "RETURN_FOR_HEAL");
  assert.deepEqual(task?.target, [0, 0]);
  // Core 不在位 → 无家可回 → 不走强制
  const noCore = snapshotOf(makeTurn([worker("w1", 4, 4, 1, 0)], { core: null }));
  assert.equal(forcedTaskFor(noCore.units[0], noCore), null);
  // hp 正常（>1）不触发
  const healthy = snapshotOf(makeTurn([worker("w1", 4, 4, 5, 0)]));
  assert.equal(forcedTaskFor(healthy.units[0], healthy), null);
});

test("唯一性硬约束：两个 Worker 一个资源格 → 只分配一个", () => {
  const snap = snapshotOf(
    makeTurn([worker("w1", 0, 0), worker("w2", 2, 0)], { resourceCells: new Set(["1,0"]) }),
  );
  const plan = new WorkerTaskPlanner().plan(snap);
  const goResource = plan.assignments.filter((a) => a.task.type === "GO_RESOURCE");
  assert.equal(goResource.length, 1);
  assert.equal(plan.assignments.filter((a) => a.task.type === "WAIT").length, 1);
  assertUniqueCells(plan);
});

test("三个 Worker 两个资源格 → 两个 GO_RESOURCE + 一个 WAIT（vanguard 不参与分配）", () => {
  const snap = snapshotOf(
    makeTurn([worker("w1", 0, 0), worker("w2", 4, 0), worker("w3", 8, 0), vanguard("v1", 0, 5)], {
      resourceCells: new Set(["1,0", "2,0"]),
    }),
  );
  const plan = new WorkerTaskPlanner().plan(snap);
  const goResource = plan.assignments.filter((a) => a.task.type === "GO_RESOURCE");
  assert.equal(goResource.length, 2);
  assert.equal(plan.assignments.filter((a) => a.task.type === "WAIT").length, 1);
  assert.equal(plan.assignments.some((a) => a.unitId === "v1"), false);
  assertUniqueCells(plan);
});

test("贪心选最近：Worker[0,0] 在 [1,0] 与 [10,10] 之间选 [1,0]", () => {
  const snap = snapshotOf(
    makeTurn([worker("w1", 0, 0)], { resourceCells: new Set(["1,0", "10,10"]) }),
  );
  const plan = new WorkerTaskPlanner().plan(snap);
  const task = plan.assignments[0].task;
  assert.equal(task.type, "GO_RESOURCE");
  assert.equal(task.targetCellKey, "1,0");
  assert.deepEqual(task.target, [1, 0]);
});

test("最小费用匹配：避免 greedy 局部最优导致第二 Worker 跨图", () => {
  // greedy 按稳定顺序会先拿 w1-r1（cost 1），w2 被迫去 r2（cost 4），总代价 5；
  // Hungarian 应给 w1-r2 + w2-r1，总代价 3（w1 去 [-2,0] 只要 2 步）。
  const snap = snapshotOf(makeTurn([worker("w1", 0, 0), worker("w2", 2, 0)], {
    resourceCells: new Set(["1,0", "-2,0"]),
    core: null,
  }));
  const plan = new WorkerTaskPlanner().plan(snap);
  const byWorker = new Map(plan.assignments.map((a) => [a.unitId, a.task] as const));
  assert.equal(byWorker.get("w1")?.targetCellKey, "-2,0");
  assert.equal(byWorker.get("w2")?.targetCellKey, "1,0");
  assertUniqueCells(plan);
});

test("sticky：上一 Tick 同目标格给净收益加成后改变选择（防抖动机制）", () => {
  const snap = snapshotOf(
    makeTurn([worker("w1", 0, 0)], { resourceCells: new Set(["1,1", "2,0"]) }),
  );
  // 两个格代价相同（travel 2 + return 2）：无 sticky 时按字典序选 "1,1"
  const planner = new WorkerTaskPlanner();
  assert.equal(planner.plan(snap).assignments[0].task.targetCellKey, "1,1");
  // 上一 Tick 目标是 "2,0" → sticky +0.5 → 翻转到 "2,0"
  const previous: Assignment[] = [
    { unitId: "w1", task: { type: "GO_RESOURCE", target: [2, 0], targetCellKey: "2,0" } },
  ];
  assert.equal(planner.plan(snap, previous).assignments[0].task.targetCellKey, "2,0");
  // applyStickyBonus 机制本身：匹配给 amount，不匹配给 0
  assert.equal(applyStickyBonus("w1", "2,0", previous, 0.5), 0.5);
  assert.equal(applyStickyBonus("w1", "1,1", previous, 0.5), 0);
  assert.equal(applyStickyBonus("other", "2,0", previous, 0.5), 0);
});

test("反向验证：无资源格时全部 WAIT（唯一性不是靠凑数）", () => {
  const snap = snapshotOf(makeTurn([worker("w1", 0, 0), worker("w2", 4, 4)]));
  const plan = new WorkerTaskPlanner().plan(snap);
  assert.equal(plan.assignments.length, 2);
  assert.ok(plan.assignments.every((a) => a.task.type === "WAIT"));
});

test("强制 HARVEST_CURRENT 占用的资源格不再进入代价矩阵（唯一性延伸到强制任务）", () => {
  const snap = snapshotOf(
    makeTurn([worker("w1", 1, 0), worker("w2", 0, 0)], { resourceCells: new Set(["1,0"]) }),
  );
  const plan = new WorkerTaskPlanner().plan(snap);
  // w1 站在资源格上（cargo=0）→ HARVEST_CURRENT 独占 "1,0"；w2 无格可去 → WAIT
  assert.equal(plan.assignments.length, 2);
  const harvest = plan.assignments.find((a) => a.task.type === "HARVEST_CURRENT");
  assert.equal(harvest?.unitId, "w1");
  assert.equal(harvest?.task.targetCellKey, "1,0");
  assert.equal(plan.assignments.filter((a) => a.task.type === "GO_RESOURCE").length, 0);
  assertUniqueCells(plan);
});

test("cellKey 导出格式：'x,y'", () => {
  assert.equal(cellKey(3, 5), "3,5");
  assert.equal(cellKey(-1, 0), "-1,0");
});

test("Task 类型枚举完整（类型级快照）", () => {
  const types = ["HARVEST_CURRENT", "GO_RESOURCE", "DEPOSIT", "EXPLORE", "PICKUP_BEACON", "RETURN_FOR_HEAL", "WAIT"] as const;
  const snap = snapshotOf(makeTurn([worker("w1", 0, 0)], { resourceCells: new Set(["1,0"]) }));
  const planner = new WorkerTaskPlanner();
  const planTypes = planner.plan(snap).assignments.map((a) => a.task.type);
  const allTypes = new Set<string>(types);
  const usedTypes = new Set<string>(planTypes);
  for (const t of usedTypes) {
    assert.ok(allTypes.has(t), `未知任务类型: ${t}`);
  }
  // 编译期校验：Task.type 必须属于 TaskType
  const sample: Task = { type: "WAIT" };
  assert.equal(sample.type, "WAIT");
});
